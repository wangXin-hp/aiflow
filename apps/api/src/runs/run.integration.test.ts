import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { hash } from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkflowV2 } from "@aiflow/contracts";
import { configureHttpApplication } from "../common/http-application.js";
import { loadEnvironment, type Environment } from "../config/environment.js";
import { createDatabaseTestContext } from "../test/database-test-context.js";
import { RunRecoveryService } from "./run-recovery.service.js";

const origin = "http://127.0.0.1:5173";
const secret = "run-integration-test-secret-32-characters";
const marker = "private-input-must-not-enter-events";
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
      config: { values: { answer: { kind: "literal", value: "original" } } },
    },
  ],
  edges: [
    {
      id: "start-end",
      source: "start",
      sourcePort: "output",
      target: "end",
      targetPort: "input",
    },
  ],
};

describe("authenticated workflow persistence and SSE replay (real PostgreSQL)", () => {
  const database = createDatabaseTestContext();
  let app: INestApplication;
  let ownerCookie: string;
  let otherCookie: string;
  let connected = false;

  beforeAll(async () => {
    await database.connect();
    connected = true;
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
      // 共享测试库中的并行套件由自身清理；启动恢复另有独立集成测试。
      .overrideProvider(RunRecoveryService)
      .useValue({ onModuleInit() {} })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureHttpApplication(app);
    await app.init();
    const owner = await database.createUser("full-run-owner");
    const other = await database.createUser("full-run-other");
    const password = "full-run-test-password-123";
    await database.prisma.user.updateMany({
      where: { id: { in: [owner.id, other.id] } },
      data: { passwordHash: await hash(password, 12) },
    });
    // 通过真实登录接口领取 HttpOnly Cookie，后续请求走完整认证守卫。
    for (const [user, setCookie] of [
      [owner, (value: string) => (ownerCookie = value)],
      [other, (value: string) => (otherCookie = value)],
    ] as const) {
      const login = await request(app.getHttpServer())
        .post("/api/auth/login")
        .set("Origin", origin)
        .send({ email: user.email, password });
      expect(login.status).toBe(200);
      const cookie = login.headers["set-cookie"] as unknown as string[];
      setCookie(cookie[0]!.split(";")[0]!);
    }
  }, 20_000);

  afterAll(async () => {
    try {
      await app?.close();
      if (connected) await database.cleanup();
    } finally {
      await database.close();
    }
  });

  it("keeps a fixed snapshot and replays the exact persisted event order", async () => {
    const created = await request(app.getHttpServer())
      .post("/api/workflows")
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ name: "snapshot integration", definition });
    expect(created.status).toBe(201);
    const workflowId = created.body.data.id as string;

    const started = await request(app.getHttpServer())
      .post(`/api/workflows/${workflowId}/runs`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ input: { prompt: marker } });
    expect(started.status).toBe(202);
    const runId = started.body.data.id as string;

    const changed: WorkflowV2 = structuredClone(definition);
    changed.nodes[1]!.config.values.answer = {
      kind: "literal",
      value: "changed",
    };
    const update = await request(app.getHttpServer())
      .patch(`/api/workflows/${workflowId}`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ revision: 1, definition: changed });
    expect(update.status).toBe(200);

    await vi.waitFor(
      async () => {
        const run = await database.prisma.workflowRun.findUniqueOrThrow({
          where: { id: runId },
        });
        expect(run.status).toBe("SUCCEEDED");
      },
      { timeout: 10_000 },
    );
    const stored = await database.prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(stored.definitionSnapshot).toEqual(definition);
    expect(stored.output).toMatchObject({ answer: "original" });
    const detail = await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set("Cookie", ownerCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.data.definitionSnapshot).toEqual(definition);
    const foreign = await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set("Cookie", otherCookie);
    expect(foreign.status).toBe(404);

    const persisted = await database.prisma.runEvent.findMany({
      where: { runId },
      orderBy: { id: "asc" },
    });
    expect(persisted.length).toBeGreaterThan(2);
    const firstId = persisted[0]!.id.toString();
    const replay = await request(app.getHttpServer())
      .get(`/api/runs/${runId}/events`)
      .set("Cookie", ownerCookie)
      .set("Last-Event-ID", firstId);
    expect(replay.status).toBe(200);
    expect(replay.headers["content-type"]).toContain("text/event-stream");
    // 事件 ID 来自持久化 BigInt 游标；心跳和重连均不得插入合成 ID。
    const replayIds = [...replay.text.matchAll(/^id: (\d+)$/gm)].map(
      (match) => match[1],
    );
    expect(replayIds).toEqual(
      persisted.slice(1).map((event) => event.id.toString()),
    );
    const replayData = [...replay.text.matchAll(/^data: (.+)$/gm)].map(
      (match) =>
        JSON.parse(match[1]!) as { id: string; type: string; payload: unknown },
    );
    expect(
      replayData.map(({ id, type, payload }) => ({ id, type, payload })),
    ).toEqual(
      persisted.slice(1).map((event) => ({
        id: event.id.toString(),
        type: event.type,
        payload: event.payload,
      })),
    );
    expect(replay.text).not.toContain(marker);
    expect(replay.text).toMatch(/event: run\.succeeded/u);
  }, 20_000);
});
