import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowV2 } from "@aiflow/contracts";
import { createDatabaseTestContext } from "../test/database-test-context.js";
import { PrismaWorkflowRepository } from "./prisma-workflow.repository.js";
import { WorkflowService } from "./workflow.service.js";

const validDefinition: WorkflowV2 = {
  schemaVersion: 2,
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 } },
    {
      id: "end",
      type: "end",
      position: { x: 240, y: 0 },
      config: { values: {} },
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

const invalidGraph: WorkflowV2 = {
  schemaVersion: 2,
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 } },
    {
      id: "orphan",
      type: "end",
      position: { x: 240, y: 0 },
      config: { values: {} },
    },
  ],
  edges: [],
};

const alternateDefinition: WorkflowV2 = {
  ...validDefinition,
  nodes: validDefinition.nodes.map((node) =>
    node.id === "end"
      ? { ...node, position: { x: 480, y: 120 } }
      : structuredClone(node),
  ),
};

async function rejection(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject");
}

describe("workflow persistence (real PostgreSQL)", () => {
  const database = createDatabaseTestContext();
  let repository: PrismaWorkflowRepository;
  let service: WorkflowService;

  beforeAll(async () => {
    await database.connect();
    repository = new PrismaWorkflowRepository(database.prisma);
    service = new WorkflowService(repository);
  });

  afterEach(async () => {
    await database.cleanup();
  });

  afterAll(async () => {
    await database.close();
  });

  it("refuses a non-test database before creating a client", () => {
    expect(() =>
      createDatabaseTestContext(
        "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow",
      ),
    ).toThrow(/database ending in _test/u);
  });

  it.each([
    "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow%00application_name%00_test",
    "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow_test?application_name=fixture%00database%00aiflow",
    "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow_test?application_name=fixture\0database\0aiflow",
  ])("rejects NUL-smuggled database URLs before connecting: %s", (url) => {
    expect(() => createDatabaseTestContext(url)).toThrow(/NUL/u);
  });

  it("keeps unknown and cross-owner resources indistinguishable", async () => {
    const ownerA = await database.createUser("owner-a");
    const ownerB = await database.createUser("owner-b");
    const workflow = await service.create(ownerB.id, {
      name: "B workflow",
      definition: validDefinition,
    });

    const missingId = randomUUID();
    const errors = await Promise.all([
      rejection(service.get(ownerA.id, workflow.id)),
      rejection(service.get(ownerA.id, missingId)),
      rejection(
        service.update(ownerA.id, workflow.id, {
          revision: 1,
          name: "forbidden",
        }),
      ),
      rejection(
        service.update(ownerA.id, missingId, {
          revision: 1,
          name: "missing",
        }),
      ),
      rejection(service.archive(ownerA.id, workflow.id)),
      rejection(service.archive(ownerA.id, missingId)),
    ]);
    for (const error of errors)
      expect(error).toMatchObject({ status: 404, code: "WORKFLOW_NOT_FOUND" });
    expect((await service.list(ownerA.id, {})).items).toEqual([]);
    await expect(service.get(ownerB.id, workflow.id)).resolves.toMatchObject({
      id: workflow.id,
    });
  });

  it("updates one revision atomically and leaves every field unchanged on a stale write", async () => {
    const owner = await database.createUser("atomic-owner");
    const workflow = await service.create(owner.id, {
      name: "initial",
      description: "initial description",
      definition: validDefinition,
    });
    await service.update(owner.id, workflow.id, {
      revision: 1,
      name: "current",
    });

    const afterSuccess = await database.prisma.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
    });
    await expect(
      repository.updateActiveAtRevision({
        id: workflow.id,
        ownerId: owner.id,
        revision: 1,
        changes: {
          name: "stale",
          description: "must not persist",
          definition: alternateDefinition,
        },
      }),
    ).resolves.toBeNull();
    await expect(
      database.prisma.workflow.findUniqueOrThrow({
        where: { id: workflow.id },
      }),
    ).resolves.toEqual(afterSuccess);
    expect(afterSuccess).toMatchObject({
      name: "current",
      description: "initial description",
      definition: validDefinition,
      revision: 2,
    });
  });

  it("paginates identical timestamps by descending id without gaps or duplicates", async () => {
    const owner = await database.createUser("page-owner");
    const other = await database.createUser("page-other");
    const workflows = await Promise.all(
      ["A", "B", "C", "D", "E"].map((name) =>
        service.create(owner.id, { name, definition: validDefinition }),
      ),
    );
    await service.create(other.id, {
      name: "other tenant",
      definition: validDefinition,
    });
    const latestTime = new Date("2026-11-09T03:00:00.000Z");
    const earlierTime = new Date("2026-11-09T02:00:00.000Z");
    await database.prisma.workflow.updateMany({
      where: { id: { in: workflows.slice(0, 3).map(({ id }) => id) } },
      data: { createdAt: latestTime },
    });
    await database.prisma.workflow.updateMany({
      where: { id: { in: workflows.slice(3).map(({ id }) => id) } },
      data: { createdAt: earlierTime },
    });

    const first = await service.list(owner.id, { limit: 2 });
    const second = await service.list(owner.id, {
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await service.list(owner.id, {
      limit: 2,
      cursor: second.nextCursor,
    });
    const ids = [...first.items, ...second.items, ...third.items].map(
      ({ id }) => id,
    );
    expect(ids).toEqual([
      ...workflows
        .slice(0, 3)
        .map(({ id }) => id)
        .sort((left, right) => right.localeCompare(left)),
      ...workflows
        .slice(3)
        .map(({ id }) => id)
        .sort((left, right) => right.localeCompare(left)),
    ]);
    expect([
      first.items.length,
      second.items.length,
      third.items.length,
    ]).toEqual([2, 2, 1]);
    expect(new Set(ids).size).toBe(workflows.length);
    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).not.toBeNull();
    expect(third.nextCursor).toBeNull();
  });

  it("soft-archives idempotently and preserves the immutable version snapshot", async () => {
    const owner = await database.createUser("archive-owner");
    const other = await database.createUser("archive-other");
    const workflow = await service.create(owner.id, {
      name: "archivable",
      definition: validDefinition,
    });
    const version = await database.prisma.workflowVersion.create({
      data: {
        workflowId: workflow.id,
        version: 1,
        definitionSnapshot: validDefinition,
      },
    });

    await expect(
      service.archive(owner.id, workflow.id),
    ).resolves.toBeUndefined();
    const firstArchive = await database.prisma.workflow.findUniqueOrThrow({
      where: { id: workflow.id },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(
      service.archive(owner.id, workflow.id),
    ).resolves.toBeUndefined();
    await expect(
      database.prisma.workflow.findUniqueOrThrow({
        where: { id: workflow.id },
      }),
    ).resolves.toMatchObject({ archivedAt: firstArchive.archivedAt });
    await expect(service.get(owner.id, workflow.id)).rejects.toMatchObject({
      status: 404,
      code: "WORKFLOW_NOT_FOUND",
    });
    await expect(
      service.update(owner.id, workflow.id, { revision: 1, name: "hidden" }),
    ).rejects.toMatchObject({ status: 404, code: "WORKFLOW_NOT_FOUND" });
    const beforeForeignArchive =
      await database.prisma.workflow.findUniqueOrThrow({
        where: { id: workflow.id },
      });
    await expect(service.archive(other.id, workflow.id)).rejects.toMatchObject({
      status: 404,
      code: "WORKFLOW_NOT_FOUND",
    });
    await expect(
      database.prisma.workflow.findUniqueOrThrow({
        where: { id: workflow.id },
      }),
    ).resolves.toEqual(beforeForeignArchive);
    expect((await service.list(owner.id, {})).items).toEqual([]);

    await expect(
      database.prisma.workflowVersion.findUniqueOrThrow({
        where: { id: version.id },
        include: { workflow: true },
      }),
    ).resolves.toMatchObject({
      definitionSnapshot: validDefinition,
      workflow: { id: workflow.id, archivedAt: expect.any(Date) },
    });
  });

  it("rejects invalid graphs with zero writes and rolls back a failed fixture transaction", async () => {
    const owner = await database.createUser("rollback-owner");
    const countBefore = await database.prisma.workflow.count({
      where: { ownerId: owner.id },
    });
    await expect(
      service.create(owner.id, { name: "invalid", definition: invalidGraph }),
    ).rejects.toMatchObject({
      status: 400,
      code: "WORKFLOW_GRAPH_INVALID",
    });
    expect(
      await database.prisma.workflow.count({ where: { ownerId: owner.id } }),
    ).toBe(countBefore);

    for (const [label, definition] of [
      ["semantic", invalidGraph],
      ["structural", { schemaVersion: 2, nodes: "invalid", edges: [] }],
    ] as const) {
      const valid = await service.create(owner.id, {
        name: `valid-${label}`,
        description: "unchanged",
        definition: validDefinition,
      });
      const beforeUpdate = await database.prisma.workflow.findUniqueOrThrow({
        where: { id: valid.id },
      });
      const beforeUpdateCount = await database.prisma.workflow.count({
        where: { ownerId: owner.id },
      });
      await expect(
        service.update(owner.id, valid.id, {
          revision: 1,
          name: "must not persist",
          description: "must not persist",
          definition,
        }),
      ).rejects.toThrow();
      await expect(
        database.prisma.workflow.findUniqueOrThrow({ where: { id: valid.id } }),
      ).resolves.toEqual(beforeUpdate);
      expect(
        await database.prisma.workflow.count({ where: { ownerId: owner.id } }),
      ).toBe(beforeUpdateCount);
    }

    const rolledBackId = randomUUID();
    await expect(
      database.prisma.$transaction(async (transaction) => {
        await transaction.workflow.create({
          data: {
            id: rolledBackId,
            ownerId: owner.id,
            name: "rolled back",
            definition: validDefinition,
          },
        });
        throw new Error("forced invalid fixture");
      }),
    ).rejects.toThrow("forced invalid fixture");
    expect(
      await database.prisma.workflow.findUnique({
        where: { id: rolledBackId },
      }),
    ).toBeNull();
  });
});
