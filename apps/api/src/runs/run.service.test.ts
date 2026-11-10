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
      runs.createDebugRun(owner.id, workflow.id, { input: { prompt: null } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await db.prisma.workflowRun.count()).toBe(0);
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
    await workflows.update(owner.id, workflow.id, {
      revision: 1,
      name: "changed",
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
    expect(await db.prisma.nodeRun.count()).toBe(0);
    expect(await db.prisma.runEvent.count()).toBe(0);
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
});
