import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type Workflow } from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import type {
  CreateWorkflowRecord,
  ListWorkflowsInput,
  UpdateWorkflowRecord,
  WorkflowRecord,
  WorkflowRepository,
} from "./workflow.repository.js";

function asRecord(workflow: Workflow): WorkflowRecord {
  return workflow;
}

function asJson(
  value: CreateWorkflowRecord["definition"],
): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** Prisma 适配器集中实现 owner、归档与稳定游标条件，服务层不拼数据库查询。 */
@Injectable()
export class PrismaWorkflowRepository implements WorkflowRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateWorkflowRecord): Promise<WorkflowRecord> {
    return asRecord(
      await this.prisma.workflow.create({
        data: { ...input, definition: asJson(input.definition) },
      }),
    );
  }

  async listActive(input: ListWorkflowsInput): Promise<WorkflowRecord[]> {
    const cursorWhere: Prisma.WorkflowWhereInput | undefined = input.cursor
      ? {
          OR: [
            { createdAt: { lt: input.cursor.createdAt } },
            {
              createdAt: input.cursor.createdAt,
              id: { lt: input.cursor.id },
            },
          ],
        }
      : undefined;
    const rows = await this.prisma.workflow.findMany({
      where: {
        ownerId: input.ownerId,
        archivedAt: null,
        ...cursorWhere,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.take,
    });
    return rows.map(asRecord);
  }

  async findActiveById(ownerId: string, id: string) {
    const row = await this.prisma.workflow.findFirst({
      where: { id, ownerId, archivedAt: null },
    });
    return row ? asRecord(row) : null;
  }

  async findOwnedById(ownerId: string, id: string) {
    const row = await this.prisma.workflow.findFirst({
      where: { id, ownerId },
    });
    return row ? asRecord(row) : null;
  }

  async updateActiveAtRevision(input: UpdateWorkflowRecord) {
    const data: Prisma.WorkflowUpdateManyMutationInput = {
      revision: { increment: 1 },
      ...(input.changes.name === undefined ? {} : { name: input.changes.name }),
      ...(input.changes.description === undefined
        ? {}
        : { description: input.changes.description }),
      ...(input.changes.definition === undefined
        ? {}
        : { definition: asJson(input.changes.definition) }),
    };

    // 条件更新与读取放在同一事务，返回值不会被紧随其后的并发写覆盖。
    return this.prisma.$transaction(async (transaction) => {
      const result = await transaction.workflow.updateMany({
        where: {
          id: input.id,
          ownerId: input.ownerId,
          revision: input.revision,
          archivedAt: null,
        },
        data,
      });
      if (result.count === 0) return null;
      const row = await transaction.workflow.findFirst({
        where: { id: input.id, ownerId: input.ownerId, archivedAt: null },
      });
      return row ? asRecord(row) : null;
    });
  }

  async archiveActive(ownerId: string, id: string, archivedAt: Date) {
    const result = await this.prisma.workflow.updateMany({
      where: { id, ownerId, archivedAt: null },
      data: { archivedAt },
    });
    return result.count === 1;
  }
}
