import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseTestContext } from "../test/database-test-context.js";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventStreamService } from "./run-event-stream.service.js";

describe("terminal SSE replay race (real PostgreSQL)", () => {
  const db = createDatabaseTestContext();
  beforeAll(async () => db.connect());
  afterEach(async () => db.cleanup());
  afterAll(async () => db.close());

  it("delivers a terminal event committed after the old page snapshot without a hub notification", async () => {
    const user = await db.createUser("stream-terminal-race");
    const definition = { schemaVersion: 2, nodes: [], edges: [] };
    const workflow = await db.prisma.workflow.create({
      data: { ownerId: user.id, name: "terminal race", definition },
    });
    const run = await db.prisma.workflowRun.create({
      data: {
        ownerId: user.id,
        workflowId: workflow.id,
        definitionSnapshot: definition,
        input: {},
        status: "RUNNING",
      },
    });
    const initial = await db.prisma.runEvent.create({
      data: {
        runId: run.id,
        type: "run.started",
        level: "info",
        payload: { status: "RUNNING" },
      },
    });
    let ownedReads = 0;
    let terminalId: bigint | undefined;
    const prisma = {
      workflowRun: {
        findFirst: async (
          args: Parameters<typeof db.prisma.workflowRun.findFirst>[0],
        ) => {
          ownedReads++;
          if (ownedReads === 2) {
            // 上一页已经读完，终态事务才提交；通知故意延迟到断言之后。
            const [, terminal] = await db.prisma.$transaction([
              db.prisma.workflowRun.update({
                where: { id: run.id },
                data: { status: "SUCCEEDED", finishedAt: new Date() },
              }),
              db.prisma.runEvent.create({
                data: {
                  runId: run.id,
                  type: "run.succeeded",
                  level: "info",
                  payload: { status: "SUCCEEDED" },
                },
              }),
            ]);
            terminalId = terminal.id;
          }
          return db.prisma.workflowRun.findFirst(args);
        },
      },
      runEvent: {
        findMany: (args: Parameters<typeof db.prisma.runEvent.findMany>[0]) =>
          db.prisma.runEvent.findMany(args),
      },
    };
    const service = new RunEventStreamService(
      prisma as never,
      new RunEventHub(),
    );
    const received = await new Promise<string[]>((resolve, reject) => {
      const ids: string[] = [];
      service.stream(user.id, run.id).subscribe({
        next: (message) => {
          if (message.id) ids.push(message.id);
        },
        error: reject,
        complete: () => resolve(ids),
      });
    });
    expect(received).toEqual([initial.id.toString(), terminalId?.toString()]);
    expect(new Set(received).size).toBe(2);
    expect(ownedReads).toBeGreaterThanOrEqual(2);
  });
});
