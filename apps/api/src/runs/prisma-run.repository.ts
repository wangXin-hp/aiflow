import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type WorkflowRun } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import type { QueueRunInput, RunRepository } from "./run.repository.js";

@Injectable()
export class PrismaRunRepository implements RunRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** 锁定工作流到事务结束，保证归档与启动不能在快照创建过程中交错。 */
  async createQueued(input: QueueRunInput): Promise<WorkflowRun | null> {
    return this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ revision: number }>>`
        SELECT "revision" FROM "Workflow"
        WHERE "id" = ${input.workflowId}::uuid AND "ownerId" = ${input.ownerId}::uuid
          AND "archivedAt" IS NULL FOR SHARE
      `;
      if (rows[0]?.revision !== input.workflowRevision) return null;
      const run = await transaction.workflowRun.create({
        data: {
          id: input.id,
          ownerId: input.ownerId,
          workflowId: input.workflowId,
          definitionSnapshot: input.definitionSnapshot as Prisma.InputJsonValue,
          input: input.input as Prisma.InputJsonValue,
          status: "QUEUED",
        },
      });
      await transaction.nodeRun.createMany({
        data: input.nodeRows.map((node) => ({
          runId: run.id,
          ...node,
          status: "PENDING" as const,
        })),
      });
      await transaction.runEvent.create({
        data: input.eventWriter.prepare({
          runId: run.id,
          type: "run.queued",
          level: "info",
          payload: { status: "QUEUED" },
        }),
      });
      return run;
    });
  }

  findOwned(ownerId: string, runId: string) {
    return this.prisma.workflowRun.findFirst({ where: { id: runId, ownerId } });
  }

  listOwned(
    ownerId: string,
    take: number,
    cursor?: { createdAt: Date; id: string },
  ) {
    return this.prisma.workflowRun.findMany({
      where: {
        ownerId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
    });
  }
}
