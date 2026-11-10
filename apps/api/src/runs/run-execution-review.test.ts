import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { NodeRegistryV2 } from "@aiflow/workflow-engine";
import { createDatabaseTestContext } from "../test/database-test-context.js";
import { loadEnvironment } from "../config/environment.js";
import { RunCoordinator } from "./run-coordinator.js";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventWriter } from "./run-event-writer.js";
import { PrismaRunExecutionStore } from "./run-execution.store.js";

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

describe("execution review regressions (real PostgreSQL)", () => {
  const db = createDatabaseTestContext();
  let store: PrismaRunExecutionStore;
  beforeAll(async () => {
    await db.connect();
    store = new PrismaRunExecutionStore(
      db.prisma,
      new RunEventWriter(db.prisma, new RunEventHub()),
    );
  });
  afterEach(async () => db.cleanup());
  afterAll(async () => db.close());

  async function createRun(label: string) {
    const owner = await db.createUser(label);
    const workflow = await db.prisma.workflow.create({
      data: { ownerId: owner.id, name: label, definition: graph },
    });
    const run = await db.prisma.workflowRun.create({
      data: {
        ownerId: owner.id,
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
    return { owner, run };
  }

  function engineResult(output: unknown) {
    return {
      runId: randomUUID(),
      status: "succeeded" as const,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      nodes: [],
      logs: [],
      output: output as Record<string, string>,
    };
  }

  it("cancels during snapshot load with exactly one terminal event", async () => {
    const { owner, run } = await createRun("load-cancel");
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const coordinator = new RunCoordinator(
      {
        ...store,
        load: async (id) => {
          entered();
          await gate;
          return store.load(id);
        },
        start: (id) => store.start(id),
        log: (id, entry) => store.log(id, entry),
        finish: (id, status, result) => store.finish(id, status, result),
        requestCancel: (ownerId, id) => store.requestCancel(ownerId, id),
      },
      {
        run: async () => engineResult({}),
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
    );
    const execution = coordinator.execute(run.id);
    await readStarted;
    expect(await coordinator.cancel(owner.id, run.id)).toBe("CANCELLING");
    release();
    await execution;
    expect(
      (await db.prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
    ).toBe("CANCELLED");
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

  it("starts state and event in one transaction and ignores duplicate engine start", async () => {
    const { run } = await createRun("atomic-start");
    expect(await store.start(run.id)).toBe(true);
    expect(
      (await db.prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
    ).toBe("RUNNING");
    expect(
      await db.prisma.runEvent.count({
        where: { runId: run.id, type: "run.started" },
      }),
    ).toBe(1);
    expect(await store.start(run.id)).toBe(false);
    await store.log(run.id, {
      runId: "engine",
      code: "run.started",
      level: "info",
      timestamp: new Date().toISOString(),
    });
    expect(
      await db.prisma.runEvent.count({
        where: { runId: run.id, type: "run.started" },
      }),
    ).toBe(1);
  });

  it("rolls back the RUNNING claim when start-event preparation fails", async () => {
    const { run } = await createRun("start-rollback");
    const broken = new PrismaRunExecutionStore(db.prisma, {
      prepare: () => {
        throw new Error("event failed");
      },
      notifyCommitted: () => {},
    } as unknown as RunEventWriter);
    await expect(broken.start(run.id)).rejects.toThrow("event failed");
    expect(
      (await db.prisma.workflowRun.findUniqueOrThrow({ where: { id: run.id } }))
        .status,
    ).toBe("QUEUED");
    expect(await db.prisma.runEvent.count({ where: { runId: run.id } })).toBe(
      0,
    );
  });

  it("rejects forbidden node transitions without an event", async () => {
    const { run } = await createRun("node-transition");
    await store.start(run.id);
    const log = (code: string) =>
      store.log(run.id, {
        runId: "engine",
        nodeId: "start",
        code,
        level: "info",
        timestamp: new Date().toISOString(),
      });
    await log("node.succeeded");
    await log("node.failed");
    expect(
      (
        await db.prisma.nodeRun.findFirstOrThrow({
          where: { runId: run.id, nodeId: "start" },
        })
      ).status,
    ).toBe("PENDING");
    expect(
      await db.prisma.runEvent.count({
        where: { runId: run.id, nodeId: "start" },
      }),
    ).toBe(0);
    await log("node.started");
    await log("node.skipped");
    expect(
      (
        await db.prisma.nodeRun.findFirstOrThrow({
          where: { runId: run.id, nodeId: "start" },
        })
      ).status,
    ).toBe("RUNNING");
    expect(
      await db.prisma.runEvent.count({
        where: { runId: run.id, nodeId: "start" },
      }),
    ).toBe(1);
  });

  it("never stores oversized output when cancellation wins the terminal race", async () => {
    for (const [label, output] of [
      ["oversize-cancel", { text: "a".repeat(2_100_000) }],
      ["invalid-cancel", { text: "\ud800" }],
    ] as const) {
      const { owner, run } = await createRun(label);
      const coordinator = new RunCoordinator(
        {
          load: (id) => store.load(id),
          start: (id) => store.start(id),
          log: (id, entry) => store.log(id, entry),
          requestCancel: (ownerId, id) => store.requestCancel(ownerId, id),
          finish: async (id, status, result) => {
            if (status === "FAILED") await store.requestCancel(owner.id, id);
            return store.finish(id, status, result);
          },
        },
        {
          run: async () => engineResult(output),
          registry: () => new NodeRegistryV2(),
        },
        { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
      );
      await coordinator.execute(run.id);
      const saved = await db.prisma.workflowRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(saved.status).toBe("CANCELLED");
      expect(saved.output).toBeNull();
      expect(
        await db.prisma.runEvent.count({
          where: { runId: run.id, type: "run.cancelled" },
        }),
      ).toBe(1);
    }
  });

  it("fails safely for lone surrogate output but accepts literal escape text", async () => {
    for (const [label, output, expected] of [
      ["invalid-utf", { text: "\ud800" }, "FAILED"],
      ["invalid-key", { ["\udc00"]: "value" }, "FAILED"],
      ["invalid-nul", { text: "a\0b" }, "FAILED"],
      ["literal-escape", { text: "\\u0000" }, "SUCCEEDED"],
    ] as const) {
      const { run } = await createRun(label);
      const coordinator = new RunCoordinator(
        store,
        {
          run: async () => engineResult(output),
          registry: () => new NodeRegistryV2(),
        },
        { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
      );
      await coordinator.execute(run.id);
      const saved = await db.prisma.workflowRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      expect(saved.status).toBe(expected);
      expect(
        await db.prisma.runEvent.count({
          where: { runId: run.id, type: `run.${expected.toLowerCase()}` },
        }),
      ).toBe(1);
      if (expected === "FAILED")
        expect(saved.errorCode).toBe("run_output_invalid");
    }
  });

  it("retries a recoverable output write failure with a safe terminal payload", async () => {
    const { run } = await createRun("output-retry");
    let failed = false;
    const coordinator = new RunCoordinator(
      {
        load: (id) => store.load(id),
        start: (id) => store.start(id),
        log: (id, entry) => store.log(id, entry),
        requestCancel: (ownerId, id) => store.requestCancel(ownerId, id),
        finish: async (id, status, result) => {
          if (!failed && result?.output) {
            failed = true;
            throw new Error("simulated JSONB rejection");
          }
          return store.finish(id, status, result);
        },
      },
      {
        run: async () => engineResult({ text: "ok" }),
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
    );
    await coordinator.execute(run.id);
    const saved = await db.prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(saved.status).toBe("FAILED");
    expect(saved.errorCode).toBe("run_output_invalid");
    expect(
      await db.prisma.runEvent.count({
        where: { runId: run.id, type: "run.failed" },
      }),
    ).toBe(1);
  });

  it("enforces configured node count and rejects timer overflow", async () => {
    expect(() =>
      loadEnvironment({
        JWT_SECRET: "test-secret-at-least-thirty-two-characters",
        RUN_TOTAL_TIMEOUT_MS: "2147483648",
      }),
    ).toThrow();
    expect(() =>
      loadEnvironment({
        JWT_SECRET: "test-secret-at-least-thirty-two-characters",
        RUN_NODE_TIMEOUT_MS: "2147483648",
      }),
    ).toThrow();
    const { run } = await createRun("node-cap");
    const coordinator = new RunCoordinator(
      store,
      {
        run: async () => {
          throw new Error("engine should not execute");
        },
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 1000, nodeTimeoutMs: 1000, maxNodes: 1 },
    );
    await coordinator.execute(run.id);
    const saved = await db.prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(saved).toMatchObject({
      status: "FAILED",
      errorCode: "run_node_limit_exceeded",
    });
    expect(
      await db.prisma.runEvent.count({
        where: { runId: run.id, type: "run.failed" },
      }),
    ).toBe(1);
  });

  it("executes the fixed snapshot after the workflow draft changes", async () => {
    const { run } = await createRun("snapshot-fixed");
    await db.prisma.workflow.update({
      where: { id: run.workflowId },
      data: { definition: { schemaVersion: 2, nodes: [], edges: [] } },
    });
    const seen: unknown[] = [];
    const coordinator = new RunCoordinator(
      store,
      {
        run: async (definition) => {
          seen.push(definition);
          return engineResult({});
        },
        registry: () => new NodeRegistryV2(),
      },
      { totalTimeoutMs: 1000, nodeTimeoutMs: 1000 },
    );
    await coordinator.execute(run.id);
    expect(seen).toEqual([graph]);
  });
});
