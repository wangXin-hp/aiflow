import "reflect-metadata";
import { type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkflowV2 } from "@aiflow/contracts";
import { configureHttpApplication } from "../common/http-application.js";
import { loadEnvironment, type Environment } from "../config/environment.js";
import { createDatabaseTestContext } from "../test/database-test-context.js";
import { RunRecoveryService } from "./run-recovery.service.js";

const origin = "http://127.0.0.1:5173";
const secret = "run-http-test-secret-32-characters";
const privateInput = "sse-private-input-marker-4f7a92";
const definition: WorkflowV2 = {
  schemaVersion: 2,
  nodes: [
    {
      id: "start",
      type: "start",
      position: { x: 0, y: 0 },
      config: { inputs: [{ name: "prompt", type: "string", required: true }] },
    },
    {
      id: "end",
      type: "end",
      position: { x: 100, y: 0 },
      config: { values: {} },
    },
  ],
  edges: [
    {
      id: "edge",
      source: "start",
      sourcePort: "output",
      target: "end",
      targetPort: "input",
    },
  ],
};

describe("run HTTP boundary (real PostgreSQL)", () => {
  const database = createDatabaseTestContext();
  let app: INestApplication;
  let ownerId: string;
  let otherId: string;
  let ownerCookie: string;
  let otherCookie: string;

  beforeAll(async () => {
    await database.connect();
    const { AppModule } = await import("../app.module.js");
    const config = new ConfigService<Environment, true>(
      loadEnvironment({
        NODE_ENV: "test",
        DATABASE_URL: database.databaseUrl,
        JWT_SECRET: secret,
        WEB_PUBLIC_URL: origin,
      }),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ConfigService)
      .useValue(config)
      // 测试库允许并行套件；恢复扫描由独立测试验证，不在本套件影响别人的运行。
      .overrideProvider(RunRecoveryService)
      .useValue({ onModuleInit() {} })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureHttpApplication(app);
    await app.init();
    ownerId = (await database.createUser("run-http-owner")).id;
    otherId = (await database.createUser("run-http-other")).id;
    const jwt = app.get(JwtService);
    ownerCookie = `aiflow_session=${await jwt.signAsync({ sub: ownerId }, { secret, expiresIn: 3600 })}`;
    otherCookie = `aiflow_session=${await jwt.signAsync({ sub: otherId }, { secret, expiresIn: 3600 })}`;
  }, 20_000);

  afterAll(async () => {
    try {
      await app?.close();
      await database.cleanup();
    } finally {
      await database.close();
    }
  });

  async function workflow() {
    const response = await request(app.getHttpServer())
      .post("/api/workflows")
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ name: `run-${randomUUID()}`, definition });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  it("requires authentication and hides another user's run", async () => {
    const id = await workflow();
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/workflows/${id}/runs`)
          .send({ input: {} })
      ).status,
    ).toBe(401);
    const created = await request(app.getHttpServer())
      .post(`/api/workflows/${id}/runs`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ input: { prompt: privateInput } });
    expect(created.status).toBe(202);
    const runId = created.body.data.id as string;
    const foreign = await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set("Cookie", otherCookie);
    const missing = await request(app.getHttpServer())
      .get(`/api/runs/${randomUUID()}`)
      .set("Cookie", otherCookie);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/runs/${runId}/events`)
          .set("Cookie", otherCookie)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app.getHttpServer())
          .post(`/api/runs/${runId}/cancel`)
          .set("Cookie", otherCookie)
          .set("Origin", origin)
      ).status,
    ).toBe(404);
  });

  it("creates a persisted run, serves detail and replays safe terminal SSE", async () => {
    const id = await workflow();
    const created = await request(app.getHttpServer())
      .post(`/api/workflows/${id}/runs`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ input: { prompt: privateInput } });
    expect(created.status).toBe(202);
    expect(created.body.data.status).toBe("QUEUED");
    const runId = created.body.data.id as string;
    const detail = await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set("Cookie", ownerCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.data.definitionSnapshot).toEqual(definition);
    expect(detail.body.data.input.prompt).toBe(privateInput);
    const rows = await database.prisma.runEvent.findMany({
      where: { runId },
      orderBy: { id: "asc" },
    });
    expect(rows[0]?.type).toBe("run.queued");
    // 回放测试先等确定性运行结束，失败时给出状态而非让 SSE 请求悬挂到超时。
    await vi.waitFor(
      async () => {
        const persisted = await database.prisma.workflowRun.findUniqueOrThrow({
          where: { id: runId },
          select: { status: true },
        });
        expect(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]).toContain(
          persisted.status,
        );
      },
      { timeout: 10_000 },
    );
    const replay = await request(app.getHttpServer())
      .get(`/api/runs/${runId}/events`)
      .set("Cookie", ownerCookie)
      .set("Last-Event-ID", "0");
    expect(replay.status).toBe(200);
    expect(replay.headers["content-type"]).toContain("text/event-stream");
    expect(replay.text).toContain(`id: ${rows[0]!.id.toString()}`);
    expect(replay.text).not.toContain(privateInput);
    expect(replay.text).not.toMatch(/authorization|cookie|apiKey|password/i);
    for (const line of replay.text.match(/^data: (.+)$/gm) ?? []) {
      const parsed = JSON.parse(line.slice(6)) as { payload: object };
      expect(
        Object.keys(parsed.payload).every((key) =>
          [
            "status",
            "elapsedMs",
            "startedAt",
            "finishedAt",
            "errorCode",
            "truncated",
          ].includes(key),
        ),
      ).toBe(true);
    }
    const later = await request(app.getHttpServer())
      .get(`/api/runs/${runId}/events`)
      .set("Cookie", ownerCookie)
      .set("Last-Event-ID", rows[0]!.id.toString());
    expect(later.status).toBe(200);
    expect(later.text).not.toContain(`id: ${rows[0]!.id.toString()}\n`);
    expect(later.text).toMatch(
      /event: run\.(succeeded|failed|cancelled|interrupted)/,
    );
    const invalid = await request(app.getHttpServer())
      .get(`/api/runs/${runId}/events`)
      .set("Cookie", ownerCookie)
      .set("Last-Event-ID", "9223372036854775808");
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("INVALID_EVENT_CURSOR");
    const firstCancel = await request(app.getHttpServer())
      .post(`/api/runs/${runId}/cancel`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin);
    const repeatCancel = await request(app.getHttpServer())
      .post(`/api/runs/${runId}/cancel`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin);
    expect(firstCancel.status).toBe(200);
    expect(repeatCancel.body).toEqual(firstCancel.body);
  }, 20_000);
});
