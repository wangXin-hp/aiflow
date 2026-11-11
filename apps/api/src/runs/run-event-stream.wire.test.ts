import "reflect-metadata";
import { Controller, Inject, Sse, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { PrismaService } from "../database/prisma.service.js";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventStreamService } from "./run-event-stream.service.js";

const runId = randomUUID();
const ownerId = randomUUID();

@Controller()
class WireController {
  constructor(
    @Inject(RunEventStreamService)
    private readonly events: RunEventStreamService,
  ) {}

  @Sse("events")
  stream() {
    return this.events.stream(ownerId, runId);
  }
}

describe("Nest SSE wire format", () => {
  it("ends after a post-open database error without a synthetic error event ID", async () => {
    let ownershipReads = 0;
    const prisma = {
      workflowRun: {
        findFirst: async () => {
          ownershipReads++;
          if (ownershipReads > 1) throw new Error("database unavailable");
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
    const module = await Test.createTestingModule({
      controllers: [WireController],
      providers: [
        RunEventStreamService,
        { provide: PrismaService, useValue: prisma },
        { provide: RunEventHub, useValue: new RunEventHub() },
      ],
    }).compile();
    const app: INestApplication = module.createNestApplication({
      logger: false,
    });
    try {
      await app.init();
      const response = await request(app.getHttpServer()).get("/events");
      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.text.match(/^id: /gm)).toEqual(["id: "]);
      expect(response.text).toContain("id: 9007199254740993");
      expect(response.text).not.toContain("event: error");
    } finally {
      await app.close();
    }
  });
});
