import "reflect-metadata";
import { type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ApiExceptionFilter } from "../common/api-exception.filter.js";
import { PrismaService } from "../database/prisma.service.js";
import { RunCoordinator } from "./run-coordinator.js";
import { RunController } from "./run.controller.js";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventStreamService } from "./run-event-stream.service.js";
import { RunService } from "./run.service.js";

const runId = randomUUID();
const ownerId = randomUUID();

async function testApp(prisma: unknown): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    controllers: [RunController],
    providers: [
      RunEventStreamService,
      { provide: PrismaService, useValue: prisma },
      { provide: RunEventHub, useValue: new RunEventHub() },
      { provide: RunService, useValue: {} },
      { provide: RunCoordinator, useValue: {} },
    ],
  }).compile();
  const app: INestApplication = module.createNestApplication({ logger: false });
  app.use((req: Request, _res: Response, next: NextFunction) => {
    Object.assign(req, {
      user: {
        id: ownerId,
        email: "wire@example.com",
        name: null,
        avatarUrl: null,
        emailVerifiedAt: null,
        createdAt: "2026-11-11T00:00:00.000Z",
      },
    });
    next();
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
  return app;
}

describe("Nest SSE wire format", () => {
  it("ends after a post-open database error without a synthetic error event ID", async () => {
    let ownershipReads = 0;
    const prisma = {
      workflowRun: {
        findFirst: async () => {
          ownershipReads++;
          if (ownershipReads > 2) throw new Error("database unavailable");
          return { id: runId, status: "RUNNING" };
        },
      },
      runEvent: {
        findMany: async () => [
          {
            id: 9007199254740993n,
            runId,
            nodeId: null,
            type: "run.started",
            level: "info",
            payload: { status: "RUNNING" },
            createdAt: new Date("2026-11-11T00:00:00.000Z"),
          },
        ],
      },
    };
    const app = await testApp(prisma);
    try {
      const response = await request(app.getHttpServer()).get(
        `/runs/${runId}/events`,
      );
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.text.match(/^id: /gm)).toEqual(["id: "]);
      expect(response.text).toContain("id: 9007199254740993");
      expect(response.text).not.toContain("event: error");
    } finally {
      await app.close();
    }
  });

  it("returns the stable HTTP error if the first event query fails before SSE headers", async () => {
    const app = await testApp({
      workflowRun: { findFirst: async () => ({ id: runId }) },
      runEvent: {
        findMany: async () => {
          throw new Error("database unavailable");
        },
      },
    });
    try {
      const response = await request(app.getHttpServer()).get(
        `/runs/${runId}/events`,
      );
      expect(response.status).toBe(500);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).toEqual({
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用",
      });
    } finally {
      await app.close();
    }
  });

  it("returns the stable HTTP error if ownership fails on subscription before SSE headers", async () => {
    let reads = 0;
    const app = await testApp({
      workflowRun: {
        findFirst: async () => {
          reads++;
          if (reads === 2) throw new Error("database unavailable");
          return { id: runId };
        },
      },
      runEvent: { findMany: async () => [] },
    });
    try {
      const response = await request(app.getHttpServer()).get(
        `/runs/${runId}/events`,
      );
      expect(response.status).toBe(500);
      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.body).toEqual({
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用",
      });
      expect(reads).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("returns owner-scoped 404 if the run disappears before subscription", async () => {
    let reads = 0;
    const app = await testApp({
      workflowRun: {
        findFirst: async () => {
          reads++;
          return reads === 1 ? { id: runId } : null;
        },
      },
      runEvent: { findMany: async () => [] },
    });
    try {
      const response = await request(app.getHttpServer()).get(
        `/runs/${runId}/events`,
      );
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        code: "RUN_NOT_FOUND",
        message: "运行不存在",
      });
      expect(reads).toBe(2);
    } finally {
      await app.close();
    }
  });
});
