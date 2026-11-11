import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { hash } from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowV2 } from "@aiflow/contracts";
import { configureHttpApplication } from "../common/http-application.js";
import { loadEnvironment, type Environment } from "../config/environment.js";
import { createDatabaseTestContext } from "../test/database-test-context.js";
import { RunCoordinator } from "./run-coordinator.js";
import {
  RUN_EXECUTION_STORE,
  type RunExecutionStore,
} from "./run-execution.store.js";
import { RunRecoveryService } from "./run-recovery.service.js";
import { RUN_ENQUEUER } from "./run.service.js";

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
  let coordinator: RunCoordinator;
  const enqueued: string[] = [];

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
      // 暂缓自动执行，保证 PATCH 提交在真实协调器首次读取运行定义之前。
      .overrideProvider(RUN_ENQUEUER)
      .useValue({ enqueue: (runId: string) => enqueued.push(runId) })
      .compile();
    coordinator = module.get(RunCoordinator);
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
    expect(enqueued).toEqual([runId]);
    const pending = await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set("Cookie", ownerCookie);
    expect(pending.status).toBe(200);
    expect(pending.body.data.nodes).toMatchObject([
      {
        nodeId: "start",
        nodeType: "start",
        status: "PENDING",
        input: null,
        output: null,
      },
      {
        nodeId: "end",
        nodeType: "end",
        status: "PENDING",
        input: null,
        output: null,
      },
    ]);
    expect(Object.keys(pending.body.data.nodes[0]).sort()).toEqual([
      "elapsedMs",
      "errorCode",
      "errorMessage",
      "finishedAt",
      "id",
      "input",
      "nodeId",
      "nodeType",
      "output",
      "startedAt",
      "status",
    ]);
    expect(
      (
        await database.prisma.workflowRun.findUniqueOrThrow({
          where: { id: runId },
        })
      ).status,
    ).toBe("QUEUED");

    const changed: WorkflowV2 = structuredClone(definition);
    changed.nodes = [
      changed.nodes[0]!,
      {
        id: "middle",
        type: "transform",
        position: { x: 100, y: 0 },
        config: { values: { extra: { kind: "literal", value: "new node" } } },
      },
      {
        id: "end",
        type: "end",
        position: { x: 200, y: 0 },
        config: { values: { answer: { kind: "literal", value: "changed" } } },
      },
    ];
    changed.edges = [
      { ...changed.edges[0]!, id: "start-middle", target: "middle" },
      { ...changed.edges[0]!, id: "middle-end", source: "middle" },
    ];
    const update = await request(app.getHttpServer())
      .patch(`/api/workflows/${workflowId}`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ revision: 1, definition: changed });
    expect(update.status).toBe(200);
    expect(update.body.data.definition).toEqual(changed);
    await coordinator.execute(runId);
    const stored = await database.prisma.workflowRun.findUniqueOrThrow({
      where: { id: runId },
    });
    expect(stored.status).toBe("SUCCEEDED");
    expect(stored.definitionSnapshot).toEqual(definition);
    expect(stored.output).toMatchObject({ answer: "original" });
    // 新草稿包含 middle 节点；真实执行与预建节点行都只能来自启动快照。
    const nodes = await database.prisma.nodeRun.findMany({ where: { runId } });
    expect(nodes.map(({ nodeId }) => nodeId).sort()).toEqual(["end", "start"]);
    expect(nodes.every(({ status }) => status === "SUCCEEDED")).toBe(true);
    const detail = await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set("Cookie", ownerCookie);
    expect(detail.status).toBe(200);
    expect(detail.body.data.definitionSnapshot).toEqual(definition);
    expect(detail.body.data.nodes).toMatchObject([
      { nodeId: "start", status: "SUCCEEDED" },
      { nodeId: "end", status: "SUCCEEDED", output: { answer: "original" } },
    ]);
    const foreign = await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set("Cookie", otherCookie);
    expect(foreign.status).toBe(404);

    const persisted = await database.prisma.runEvent.findMany({
      where: { runId },
      orderBy: { id: "asc" },
    });
    expect(persisted.length).toBeGreaterThan(2);
    expect(
      persisted.every(
        ({ payload }) => !JSON.stringify(payload).includes(marker),
      ),
    ).toBe(true);
    const firstId = persisted[0]!.id.toString();
    const replay = await request(app.getHttpServer())
      .get(`/api/runs/${runId}/events`)
      .set("Cookie", ownerCookie)
      .set("Last-Event-ID", firstId)
      .timeout({ deadline: 5_000 });
    expect(replay.status).toBe(200);
    expect(replay.headers["content-type"]).toContain("text/event-stream");
    // 按帧核对游标、事件名和载荷，避免分别匹配整条响应而错配帧。
    const frames = replay.text
      .split(/\r?\n\r?\n/u)
      .map((frame) => frame.trim())
      .filter((frame) => frame.includes("id: "))
      .map((frame) => {
        const fields = Object.fromEntries(
          frame.split(/\r?\n/u).map((line) => {
            const separator = line.indexOf(": ");
            return [line.slice(0, separator), line.slice(separator + 2)];
          }),
        );
        const { id, type, payload } = JSON.parse(fields.data!) as {
          id: string;
          type: string;
          payload: unknown;
        };
        return {
          id: fields.id,
          event: fields.event,
          data: { id, type, payload },
        };
      });
    expect(frames).toEqual(
      persisted.slice(1).map((event) => ({
        id: event.id.toString(),
        event: event.type,
        data: {
          id: event.id.toString(),
          type: event.type,
          payload: event.payload,
        },
      })),
    );
    expect(replay.text).not.toContain(marker);
    expect(frames.at(-1)?.event).toBe("run.succeeded");
  }, 20_000);

  it("returns persisted intermediate output and recovered node state", async () => {
    const graph: WorkflowV2 = structuredClone(definition);
    graph.nodes.splice(1, 0, {
      id: "middle",
      type: "transform",
      position: { x: 50, y: 0 },
      config: {
        values: { evidence: { kind: "literal", value: "intermediate" } },
      },
    });
    graph.edges = [
      {
        id: "start-middle",
        source: "start",
        sourcePort: "output",
        target: "middle",
        targetPort: "input",
      },
      {
        id: "middle-end",
        source: "middle",
        sourcePort: "output",
        target: "end",
        targetPort: "input",
      },
    ];
    const created = await request(app.getHttpServer())
      .post("/api/workflows")
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ name: "intermediate detail", definition: graph });
    expect(created.status).toBe(201);
    const queued = await request(app.getHttpServer())
      .post(`/api/workflows/${created.body.data.id}/runs`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ input: { prompt: marker } });
    expect(queued.status).toBe(202);
    const runId = queued.body.data.id as string;
    await coordinator.execute(runId);
    const complete = await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set("Cookie", ownerCookie);
    expect(complete.status).toBe(200);
    expect(complete.body.data.nodes).toMatchObject([
      { nodeId: "start", status: "SUCCEEDED" },
      {
        nodeId: "middle",
        status: "SUCCEEDED",
        output: { evidence: "intermediate" },
      },
      { nodeId: "end", status: "SUCCEEDED" },
    ]);
    const foreign = await request(app.getHttpServer())
      .get(`/api/runs/${runId}`)
      .set("Cookie", otherCookie);
    expect(foreign.status).toBe(404);
    const inherited = await request(app.getHttpServer())
      .post(`/api/workflows/${created.body.data.id}/runs`)
      .set("Cookie", ownerCookie)
      .set("Origin", origin)
      .send({ input: { prompt: marker } });
    expect(inherited.status).toBe(202);
    const inheritedId = inherited.body.data.id as string;
    const store = app.get<RunExecutionStore>(RUN_EXECUTION_STORE);
    expect(await store.recover([inheritedId])).toBe(1);
    const recovered = await request(app.getHttpServer())
      .get(`/api/runs/${inheritedId}`)
      .set("Cookie", ownerCookie);
    expect(recovered.body.data.status).toBe("INTERRUPTED");
    expect(recovered.body.data.nodes).toMatchObject([
      { nodeId: "start", status: "CANCELLED" },
      { nodeId: "middle", status: "CANCELLED" },
      { nodeId: "end", status: "CANCELLED" },
    ]);
  }, 20_000);
});
