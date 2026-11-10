import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WorkflowV2 } from "@aiflow/contracts";
import { createDatabaseTestContext } from "../test/database-test-context.js";
import { PrismaWorkflowRepository } from "../workflows/prisma-workflow.repository.js";
import { WorkflowService } from "../workflows/workflow.service.js";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventWriter } from "./run-event-writer.js";
import { PrismaRunRepository } from "./prisma-run.repository.js";
import { RunService } from "./run.service.js";

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
      position: { x: 1, y: 0 },
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

describe("RunService (real PostgreSQL)", () => {
  const db = createDatabaseTestContext();
  let workflows: WorkflowService;
  let runs: RunService;
  let notify: ReturnType<typeof vi.spyOn>;
  const enqueued: string[] = [];

  beforeAll(async () => {
    await db.connect();
    workflows = new WorkflowService(new PrismaWorkflowRepository(db.prisma));
    const hub = new RunEventHub();
    notify = vi.spyOn(hub, "notify");
    runs = new RunService(
      new PrismaWorkflowRepository(db.prisma),
      new PrismaRunRepository(db.prisma),
      new RunEventWriter(db.prisma, hub),
      { enqueue: (id) => enqueued.push(id) },
    );
  });
  afterEach(async () => {
    await db.cleanup();
    notify.mockClear();
    enqueued.length = 0;
  });
  afterAll(async () => {
    await db.close();
  });

  it("rejects missing, foreign, archived workflow and invalid start input before writing", async () => {
    const owner = await db.createUser("run-owner");
    const other = await db.createUser("run-other");
    const workflow = await workflows.create(owner.id, {
      name: "flow",
      definition,
    });
    await expect(
      runs.createDebugRun(other.id, workflow.id, { input: { prompt: "x" } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      runs.createDebugRun(owner.id, randomUUID(), { input: { prompt: "x" } }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      runs.createDebugRun(owner.id, workflow.id, { input: {} }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      runs.createDebugRun(owner.id, workflow.id, { input: { prompt: "a\0b" } }),
    ).rejects.toMatchObject({ status: 400, code: "RUN_INPUT_INVALID" });
    await expect(
      runs.createDebugRun(owner.id, workflow.id, { input: { prompt: null } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await db.prisma.workflowRun.count({ where: { ownerId: owner.id } }),
    ).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    await workflows.archive(owner.id, workflow.id);
    await expect(
      runs.createDebugRun(owner.id, workflow.id, { input: { prompt: "x" } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("commits a fixed snapshot, pending nodes and queued event before notifications", async () => {
    const owner = await db.createUser("run-snapshot");
    const workflow = await workflows.create(owner.id, {
      name: "flow",
      definition,
    });
    const run = await runs.createDebugRun(owner.id, workflow.id, {
      input: { prompt: "hello" },
    });
    expect(run).toMatchObject({
      status: "QUEUED",
      definitionSnapshot: definition,
      input: { prompt: "hello" },
    });
    expect(
      (await db.prisma.nodeRun.findMany({ where: { runId: run.id } }))
        .map((row) => [row.nodeId, row.status])
        .sort(),
    ).toEqual([
      ["end", "PENDING"],
      ["start", "PENDING"],
    ]);
    const events = await db.prisma.runEvent.findMany({
      where: { runId: run.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "run.queued",
      payload: { status: "QUEUED" },
    });
    expect(notify).toHaveBeenCalledWith(run.id);
    expect(enqueued).toEqual([run.id]);
    await expect(runs.get(owner.id, run.id)).resolves.toMatchObject({
      id: run.id,
      status: "QUEUED",
    });
    const changedDefinition: WorkflowV2 = structuredClone(definition);
    const end = changedDefinition.nodes.find((node) => node.type === "end");
    if (!end || end.type !== "end") throw new Error("missing end");
    end.config.values = { result: { kind: "literal", value: "new" } };
    await workflows.update(owner.id, workflow.id, {
      revision: 1,
      definition: changedDefinition,
    });
    expect((await runs.get(owner.id, run.id)).definitionSnapshot).toEqual(
      definition,
    );
    await expect(
      runs.get((await db.createUser("run-foreign")).id, run.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rolls back run and node rows if the queued event insert fails", async () => {
    const owner = await db.createUser("run-rollback");
    const workflow = await workflows.create(owner.id, {
      name: "flow",
      definition,
    });
    const repository = new PrismaRunRepository(db.prisma);
    const brokenWriter = {
      prepare: () => ({
        runId: randomUUID(),
        type: "run.queued",
        level: "info",
        payload: { status: "QUEUED" },
      }),
    } as unknown as RunEventWriter;
    await expect(
      repository.createQueued({
        id: randomUUID(),
        ownerId: owner.id,
        workflowId: workflow.id,
        workflowRevision: 1,
        definitionSnapshot: definition,
        input: { prompt: "hello" },
        nodeRows: definition.nodes.map((node) => ({
          nodeId: node.id,
          nodeType: node.type,
        })),
        eventWriter: brokenWriter,
      }),
    ).rejects.toThrow();
    expect(
      await db.prisma.workflowRun.count({ where: { ownerId: owner.id } }),
    ).toBe(0);
    expect(
      await db.prisma.nodeRun.count({ where: { run: { ownerId: owner.id } } }),
    ).toBe(0);
    expect(
      await db.prisma.runEvent.count({ where: { run: { ownerId: owner.id } } }),
    ).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("lists only owned runs with a stable cursor", async () => {
    const owner = await db.createUser("run-page");
    const other = await db.createUser("run-page-other");
    const workflow = await workflows.create(owner.id, {
      name: "flow",
      definition,
    });
    const foreignWorkflow = await workflows.create(other.id, {
      name: "foreign",
      definition,
    });
    const created = await Promise.all(
      [1, 2, 3].map(() =>
        runs.createDebugRun(owner.id, workflow.id, { input: { prompt: "x" } }),
      ),
    );
    await runs.createDebugRun(other.id, foreignWorkflow.id, {
      input: { prompt: "x" },
    });
    const equalTime = new Date("2026-11-10T12:00:00.000Z");
    await db.prisma.workflowRun.updateMany({
      where: { id: { in: created.map(({ id }) => id) } },
      data: { createdAt: equalTime },
    });
    const first = await runs.list(owner.id, { limit: 2 });
    const second = await runs.list(owner.id, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect([...first.items, ...second.items].map(({ id }) => id)).toEqual(
      created.map(({ id }) => id).sort((a, b) => b.localeCompare(a)),
    );
    expect(second.nextCursor).toBeNull();
  });

  it("reports a same-owner active revision race as a conflict without creating a run", async () => {
    const owner = await db.createUser("run-race");
    const workflow = await workflows.create(owner.id, {
      name: "before",
      definition,
    });
    const repository = new PrismaRunRepository(db.prisma);
    const racing = new RunService(
      new PrismaWorkflowRepository(db.prisma),
      {
        createQueued: async (input) => {
          await workflows.update(owner.id, workflow.id, {
            revision: 1,
            name: "after",
          });
          return repository.createQueued(input);
        },
        findOwned: (ownerId, runId) => repository.findOwned(ownerId, runId),
        listOwned: (ownerId, take, cursor) =>
          repository.listOwned(ownerId, take, cursor),
      },
      new RunEventWriter(db.prisma, new RunEventHub()),
      { enqueue: (id) => enqueued.push(id) },
    );
    await expect(
      racing.createDebugRun(owner.id, workflow.id, { input: { prompt: "x" } }),
    ).rejects.toMatchObject({
      status: 409,
      code: "WORKFLOW_REVISION_CONFLICT",
    });
    expect(
      await db.prisma.workflowRun.count({ where: { ownerId: owner.id } }),
    ).toBe(0);
    expect(enqueued).toEqual([]);
  });

  it("rejects input that exceeds the shared limit after defaults before any write or notification", async () => {
    const owner = await db.createUser("run-default-limit");
    const largeDefinition: WorkflowV2 = structuredClone(definition);
    const start = largeDefinition.nodes.find((node) => node.type === "start");
    if (!start || start.type !== "start" || !start.config)
      throw new Error("missing start");
    start.config.inputs = [
      { name: "first", type: "string", required: true },
      {
        name: "second",
        type: "string",
        required: false,
        defaultValue: "b".repeat(1_100_000),
      },
    ];
    const workflow = await workflows.create(owner.id, {
      name: "large default",
      definition: largeDefinition,
    });
    await expect(
      runs.createDebugRun(owner.id, workflow.id, {
        input: { first: "a".repeat(1_100_000) },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await db.prisma.workflowRun.count({ where: { ownerId: owner.id } }),
    ).toBe(0);
    expect(
      await db.prisma.nodeRun.count({ where: { run: { ownerId: owner.id } } }),
    ).toBe(0);
    expect(
      await db.prisma.runEvent.count({ where: { run: { ownerId: owner.id } } }),
    ).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(enqueued).toEqual([]);
  });

  it("distinguishes missing from explicit null and supports safe special field names", async () => {
    const owner = await db.createUser("run-fields");
    const fieldsDefinition: WorkflowV2 = structuredClone(definition);
    const start = fieldsDefinition.nodes.find((node) => node.type === "start");
    if (!start || start.type !== "start" || !start.config)
      throw new Error("missing start");
    start.config.inputs = [
      { name: "constructor", type: "string", required: false },
      {
        name: "prompt",
        type: "string",
        required: true,
        defaultValue: "default",
      },
      { name: "__proto__", type: "object", required: false },
    ];
    const workflow = await workflows.create(owner.id, {
      name: "fields",
      definition: fieldsDefinition,
    });
    await expect(
      runs.createDebugRun(owner.id, workflow.id, { input: { prompt: null } }),
    ).rejects.toMatchObject({ status: 400 });
    const run = await runs.createDebugRun(owner.id, workflow.id, { input: {} });
    expect(run.input).toEqual({ prompt: "default" });
    expect(Object.hasOwn(run.input, "constructor")).toBe(false);
    expect(Object.hasOwn(run.input, "__proto__")).toBe(false);
    const given = await runs.createDebugRun(owner.id, workflow.id, {
      input: { prompt: "given", constructor: "own" },
    });
    expect(given.input).toEqual({ prompt: "given", constructor: "own" });
  });
});
