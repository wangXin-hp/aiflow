import { describe, expect, it, vi } from "vitest";
import { RunRecoveryService } from "./run-recovery.service.js";
import { PrismaRunExecutionStore } from "./run-execution.store.js";
import { RunEventWriter } from "./run-event-writer.js";
import { RunEventHub } from "./run-event-hub.js";
import { createDatabaseTestContext } from "../test/database-test-context.js";
import { afterAll, afterEach, beforeAll } from "vitest";

describe("RunRecoveryService", () => {
  it("interrupts queued, running and cancelling runs on startup", async () => {
    const recover = vi.fn().mockResolvedValue(3);
    const service = new RunRecoveryService({ recover });
    await service.onModuleInit();
    expect(recover).toHaveBeenCalledOnce();
  });
});

describe("startup recovery (real PostgreSQL)", () => {
  const db = createDatabaseTestContext();
  beforeAll(async () => {
    await db.connect();
  });
  afterEach(async () => {
    await db.cleanup();
  });
  afterAll(async () => {
    await db.close();
  });

  it("interrupts inherited active runs once and cancels unfinished nodes", async () => {
    const user = await db.createUser("recovery");
    const workflow = await db.prisma.workflow.create({
      data: {
        ownerId: user.id,
        name: "test",
        definition: { schemaVersion: 2, nodes: [], edges: [] },
      },
    });
    const ids: string[] = [];
    for (const status of ["QUEUED", "RUNNING", "CANCELLING"] as const) {
      const run = await db.prisma.workflowRun.create({
        data: {
          ownerId: user.id,
          workflowId: workflow.id,
          status,
          definitionSnapshot: { schemaVersion: 2, nodes: [], edges: [] },
          input: {},
          nodes: {
            create: {
              nodeId: "start",
              nodeType: "start",
              status: status === "QUEUED" ? "PENDING" : "RUNNING",
            },
          },
        },
      });
      ids.push(run.id);
    }
    const store = new PrismaRunExecutionStore(
      db.prisma,
      new RunEventWriter(db.prisma, new RunEventHub()),
    );
    // 并行测试共用测试库；恢复断言只触碰本用例创建的运行。
    const service = new RunRecoveryService({
      recover: () => store.recover(ids),
    });
    await service.onModuleInit();
    await service.onModuleInit();
    expect(
      (
        await db.prisma.workflowRun.findMany({ where: { id: { in: ids } } })
      ).every((run) => run.status === "INTERRUPTED" && run.finishedAt),
    ).toBe(true);
    expect(
      (
        await db.prisma.nodeRun.findMany({ where: { runId: { in: ids } } })
      ).every((node) => node.status === "CANCELLED"),
    ).toBe(true);
    expect(
      await db.prisma.runEvent.count({
        where: { runId: { in: ids }, type: "run.interrupted" },
      }),
    ).toBe(3);
  });
});
