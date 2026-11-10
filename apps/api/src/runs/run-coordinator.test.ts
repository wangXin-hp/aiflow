import { describe, expect, it, vi } from "vitest";
import { RunCoordinator } from "./run-coordinator.js";
import { createDatabaseTestContext } from "../test/database-test-context.js";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventWriter } from "./run-event-writer.js";
import { PrismaRunExecutionStore } from "./run-execution.store.js";
import { NodeRegistryV2, runWorkflowV2 } from "@aiflow/workflow-engine";
import { afterAll, afterEach, beforeAll } from "vitest";

const graph = {
  schemaVersion: 2 as const,
  nodes: [
    { id: "start", type: "start" as const, position: { x: 0, y: 0 } },
    {
      id: "end",
      type: "end" as const,
      position: { x: 1, y: 0 },
      config: { values: {} },
    },
  ],
  edges: [
    {
      id: "edge",
      source: "start",
      sourcePort: "output" as const,
      target: "end",
      targetPort: "input" as const,
    },
  ],
};

describe("RunCoordinator", () => {
  it("uses persisted id and drains asynchronous log writes before terminal transition", async () => {
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const trace: string[] = [];
    const engine = vi.fn(async (_definition, _input, options) => {
      options.onLog({
        runId: "engine-id",
        code: "node.succeeded",
        nodeId: "start",
        level: "info",
        timestamp: new Date().toISOString(),
      });
      return { status: "succeeded", output: {}, nodes: [] };
    });
    const coordinator = new RunCoordinator(
      {
        load: async () => ({
          id: runId,
          ownerId: runId,
          status: "QUEUED",
          definitionSnapshot: graph,
          input: {},
        }),
        start: async () => true,
        log: async (id) => {
          await Promise.resolve();
          trace.push(`log:${id}`);
        },
        finish: async (id) => {
          trace.push(`finish:${id}`);
          return true;
        },
        requestCancel: async () => "RUNNING",
      },
      { run: engine, registry: () => undefined },
      { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
    );
    await coordinator.execute(runId);
    expect(trace).toEqual([`log:${runId}`, `finish:${runId}`]);
  });

  it("lets cancellation win a completion race with one terminal write", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let state = "QUEUED";
    const terminal: string[] = [];
    const coordinator = new RunCoordinator(
      {
        load: async () => ({
          id,
          ownerId: id,
          status: "QUEUED",
          definitionSnapshot: graph,
          input: {},
        }),
        start: async () => {
          state = "RUNNING";
          return true;
        },
        log: async () => {},
        finish: async (_id, target) => {
          if (target === "SUCCEEDED" && state !== "RUNNING") return false;
          if (target === "CANCELLED" && state !== "CANCELLING") return false;
          state = target;
          terminal.push(target);
          return true;
        },
        requestCancel: async () => {
          state = "CANCELLING";
          return "CANCELLING";
        },
      },
      {
        run: async () => {
          await gate;
          return {
            runId: "engine",
            status: "succeeded",
            startedAt: "",
            finishedAt: "",
            nodes: [],
            logs: [],
            output: {},
          };
        },
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
    );
    const executing = coordinator.execute(id);
    await vi.waitFor(() => expect(state).toBe("RUNNING"));
    await coordinator.cancel(id, id);
    release();
    await executing;
    expect(terminal).toEqual(["CANCELLED"]);
  });

  it("keeps a completed terminal state when cancellation arrives later", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    let state = "QUEUED";
    const terminal: string[] = [];
    const coordinator = new RunCoordinator(
      {
        load: async () => ({
          id,
          ownerId: id,
          status: "QUEUED",
          definitionSnapshot: graph,
          input: {},
        }),
        start: async () => {
          state = "RUNNING";
          return true;
        },
        log: async () => {},
        finish: async (_id, target) => {
          state = target;
          terminal.push(target);
          return true;
        },
        requestCancel: async () => state as "SUCCEEDED",
      },
      {
        run: async () => ({
          runId: "engine",
          status: "succeeded",
          startedAt: "",
          finishedAt: "",
          nodes: [],
          logs: [],
          output: {},
        }),
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
    );
    await coordinator.execute(id);
    expect(await coordinator.cancel(id, id)).toBe("SUCCEEDED");
    expect(terminal).toEqual(["SUCCEEDED"]);
  });

  it("persists a total timeout as a failed terminal result", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const finishes: Array<{ status: string; code?: string }> = [];
    const coordinator = new RunCoordinator(
      {
        load: async () => ({
          id,
          ownerId: id,
          status: "QUEUED",
          definitionSnapshot: graph,
          input: {},
        }),
        start: async () => true,
        log: async () => {},
        finish: async (_id, status, result) => {
          finishes.push({ status, code: result?.error?.code });
          return true;
        },
        requestCancel: async () => "RUNNING",
      },
      {
        run: async (_definition, _input, options) =>
          new Promise((resolve) => {
            options.signal?.addEventListener(
              "abort",
              () =>
                resolve({
                  runId: "engine",
                  status: "cancelled",
                  startedAt: "",
                  finishedAt: "",
                  nodes: [],
                  logs: [],
                }),
              { once: true },
            );
          }),
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 10, nodeTimeoutMs: 1000 },
    );
    await coordinator.execute(id);
    expect(finishes).toEqual([{ status: "FAILED", code: "run_timeout" }]);
  });

  it("finishes at the deadline when an adapter ignores abort and ignores late logs", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const writes: string[] = [];
    let lateLog!: () => void;
    const coordinator = new RunCoordinator(
      {
        load: async () => ({
          id,
          ownerId: id,
          status: "QUEUED",
          definitionSnapshot: graph,
          input: {},
        }),
        start: async () => true,
        log: async () => {
          writes.push("log");
        },
        finish: async (_id, status) => {
          writes.push(status);
          return true;
        },
        requestCancel: async () => "RUNNING",
      },
      {
        run: async (_definition, _input, options) => {
          lateLog = () =>
            options.onLog?.({
              runId: "engine-id",
              code: "node.started",
              nodeId: "start",
              level: "info",
              timestamp: new Date().toISOString(),
            });
          return new Promise(() => {});
        },
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 10, nodeTimeoutMs: 1000 },
    );
    await Promise.race([
      coordinator.execute(id),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("deadline hung")), 200),
      ),
    ]);
    lateLog();
    await Promise.resolve();
    expect(writes).toEqual(["FAILED"]);
  });

  it("persists an engine exception without exposing its message as an event", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const finishes: Array<{ status: string; code?: string; message?: string }> =
      [];
    const coordinator = new RunCoordinator(
      {
        load: async () => ({
          id,
          ownerId: id,
          status: "QUEUED",
          definitionSnapshot: graph,
          input: {},
        }),
        start: async () => true,
        log: async () => {},
        finish: async (_id, status, result) => {
          finishes.push({
            status,
            code: result?.error?.code,
            message: result?.error?.message,
          });
          return true;
        },
        requestCancel: async () => "RUNNING",
      },
      {
        run: async () => {
          throw new Error("secret prompt and API key");
        },
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
    );
    await coordinator.execute(id);
    expect(finishes).toEqual([
      {
        status: "FAILED",
        code: "run_execution_failed",
        message: "Run execution failed",
      },
    ]);
  });

  it("rejects oversized model output before storing it", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    const finishes: Array<{ status: string; code?: string; output?: unknown }> =
      [];
    const coordinator = new RunCoordinator(
      {
        load: async () => ({
          id,
          ownerId: id,
          status: "QUEUED",
          definitionSnapshot: graph,
          input: {},
        }),
        start: async () => true,
        log: async () => {},
        finish: async (_id, status, result) => {
          finishes.push({
            status,
            code: result?.error?.code,
            output: result?.output,
          });
          return true;
        },
        requestCancel: async () => "RUNNING",
      },
      {
        run: async () => ({
          runId: "engine",
          status: "succeeded",
          startedAt: "",
          finishedAt: "",
          nodes: [],
          logs: [],
          output: { text: "a".repeat(2_100_000) },
        }),
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
    );
    await coordinator.execute(id);
    expect(finishes).toEqual([
      { status: "FAILED", code: "run_output_too_large", output: undefined },
    ]);
  });
});

describe("RunCoordinator (real PostgreSQL)", () => {
  const db = createDatabaseTestContext();
  let coordinator: RunCoordinator;
  beforeAll(async () => {
    await db.connect();
    const store = new PrismaRunExecutionStore(
      db.prisma,
      new RunEventWriter(db.prisma, new RunEventHub()),
    );
    coordinator = new RunCoordinator(
      store,
      { run: runWorkflowV2, registry: () => new NodeRegistryV2() },
      { totalTimeoutMs: 5000, nodeTimeoutMs: 1000 },
    );
  });
  afterEach(async () => {
    await db.cleanup();
  });
  afterAll(async () => {
    await db.close();
  });

  it("persists node and run transitions and a single terminal event", async () => {
    const user = await db.createUser("coordinator-success");
    const workflow = await db.prisma.workflow.create({
      data: { ownerId: user.id, name: "test", definition: graph },
    });
    const run = await db.prisma.workflowRun.create({
      data: {
        ownerId: user.id,
        workflowId: workflow.id,
        definitionSnapshot: graph,
        input: {},
        nodes: {
          create: graph.nodes.map((node) => ({
            nodeId: node.id,
            nodeType: node.type,
          })),
        },
      },
    });
    await coordinator.execute(run.id);
    expect(
      (await db.prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
    ).toBe("SUCCEEDED");
    expect(
      (await db.prisma.nodeRun.findMany({ where: { runId: run.id } })).map(
        (node) => node.status,
      ),
    ).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    expect(
      await db.prisma.runEvent.count({
        where: { runId: run.id, type: "run.succeeded" },
      }),
    ).toBe(1);
    await coordinator.execute(run.id);
    expect(
      await db.prisma.runEvent.count({
        where: { runId: run.id, type: "run.succeeded" },
      }),
    ).toBe(1);
  });

  it("cancels a queued run idempotently without starting the engine", async () => {
    const user = await db.createUser("coordinator-cancel");
    const workflow = await db.prisma.workflow.create({
      data: { ownerId: user.id, name: "test", definition: graph },
    });
    const run = await db.prisma.workflowRun.create({
      data: {
        ownerId: user.id,
        workflowId: workflow.id,
        definitionSnapshot: graph,
        input: {},
        nodes: {
          create: graph.nodes.map((node) => ({
            nodeId: node.id,
            nodeType: node.type,
          })),
        },
      },
    });
    expect(await coordinator.cancel(user.id, run.id)).toBe("CANCELLED");
    expect(await coordinator.cancel(user.id, run.id)).toBe("CANCELLED");
    await coordinator.execute(run.id);
    expect(
      await db.prisma.runEvent.count({
        where: { runId: run.id, type: "run.cancelled" },
      }),
    ).toBe(1);
    expect(
      (await db.prisma.nodeRun.findMany({ where: { runId: run.id } })).every(
        (node) => node.status === "CANCELLED",
      ),
    ).toBe(true);
  });

  it("stores engine duration as public elapsedMs metadata", async () => {
    const user = await db.createUser("coordinator-duration");
    const workflow = await db.prisma.workflow.create({
      data: { ownerId: user.id, name: "test", definition: graph },
    });
    const run = await db.prisma.workflowRun.create({
      data: {
        ownerId: user.id,
        workflowId: workflow.id,
        definitionSnapshot: graph,
        input: {},
        nodes: {
          create: graph.nodes.map((node) => ({
            nodeId: node.id,
            nodeType: node.type,
          })),
        },
      },
    });
    const store = new PrismaRunExecutionStore(
      db.prisma,
      new RunEventWriter(db.prisma, new RunEventHub()),
    );
    await store.start(run.id);
    await store.log(run.id, {
      runId: "engine-id",
      nodeId: "start",
      code: "node.started",
      level: "info",
      timestamp: new Date().toISOString(),
      durationMs: 13.8,
    });
    const event = await db.prisma.runEvent.findFirstOrThrow({
      where: { runId: run.id, type: "node.started" },
    });
    expect(event.payload).toMatchObject({ elapsedMs: 13, status: "RUNNING" });
  });
});
