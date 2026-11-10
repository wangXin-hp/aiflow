import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type WorkflowRunStatus } from "../generated/prisma/client.js";
import type { JsonObject, WorkflowV2 } from "@aiflow/contracts";
import type { RunResultV2, WorkflowLogEntryV2 } from "@aiflow/workflow-engine";
import { PrismaService } from "../database/prisma.service.js";
import { RunEventWriter } from "./run-event-writer.js";

export const RUN_EXECUTION_STORE = Symbol("RUN_EXECUTION_STORE");
export interface ExecutionSnapshot {
  id: string;
  ownerId: string;
  status: WorkflowRunStatus;
  definitionSnapshot: WorkflowV2;
  input: JsonObject;
}
export interface RunExecutionStore {
  load(id: string): Promise<ExecutionSnapshot | null>;
  start(id: string): Promise<boolean>;
  log(id: string, entry: WorkflowLogEntryV2): Promise<void>;
  finish(
    id: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    result?: RunResultV2,
  ): Promise<boolean>;
  requestCancel(ownerId: string, id: string): Promise<WorkflowRunStatus | null>;
  recover(onlyRunIds?: string[]): Promise<number>;
}

const activeStatuses: WorkflowRunStatus[] = ["QUEUED", "RUNNING", "CANCELLING"];
const activeNodeStatuses = ["PENDING", "RUNNING"] as const;

/** 状态和事件同事务提交；通知只在提交完成后发布。 */
@Injectable()
export class PrismaRunExecutionStore implements RunExecutionStore {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RunEventWriter) private readonly events: RunEventWriter,
  ) {}

  async load(id: string): Promise<ExecutionSnapshot | null> {
    const row = await this.prisma.workflowRun.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      ownerId: row.ownerId,
      status: row.status,
      definitionSnapshot: row.definitionSnapshot as WorkflowV2,
      input: row.input as JsonObject,
    };
  }

  async start(id: string): Promise<boolean> {
    const changed = await this.prisma.workflowRun.updateMany({
      where: { id, status: "QUEUED" },
      data: { status: "RUNNING", startedAt: new Date() },
    });
    return changed.count === 1;
  }

  async log(id: string, entry: WorkflowLogEntryV2): Promise<void> {
    if (entry.code.startsWith("run.") && entry.code !== "run.started") return;
    let committed = false;
    await this.prisma.$transaction(async (tx) => {
      const run = await tx.workflowRun.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!run || !activeStatuses.includes(run.status)) return;
      if (entry.nodeId) {
        const target =
          entry.code === "node.started"
            ? "RUNNING"
            : entry.code === "node.succeeded"
              ? "SUCCEEDED"
              : entry.code === "node.failed"
                ? "FAILED"
                : entry.code === "node.cancelled"
                  ? "CANCELLED"
                  : "SKIPPED";
        const source =
          target === "RUNNING" ? (["PENDING"] as const) : activeNodeStatuses;
        const changed = await tx.nodeRun.updateMany({
          where: {
            runId: id,
            nodeId: entry.nodeId,
            status: { in: [...source] },
          },
          data: {
            status: target,
            ...(target === "RUNNING"
              ? { startedAt: new Date(entry.timestamp) }
              : { finishedAt: new Date(entry.timestamp) }),
            ...(entry.durationMs === undefined
              ? {}
              : { elapsedMs: Math.max(0, Math.floor(entry.durationMs)) }),
            ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
          },
        });
        if (!changed.count) return;
      }
      await tx.runEvent.create({
        data: this.events.prepare({
          runId: id,
          nodeId: entry.nodeId,
          type: entry.code,
          level: entry.level,
          payload: {
            status:
              entry.code === "run.started"
                ? "RUNNING"
                : entry.code === "node.started"
                  ? "RUNNING"
                  : entry.code.split(".")[1]?.toUpperCase(),
            elapsedMs:
              entry.durationMs === undefined
                ? undefined
                : Math.max(0, Math.floor(entry.durationMs)),
            errorCode: entry.errorCode,
          },
        }),
      });
      committed = true;
    });
    if (committed) this.events.notifyCommitted(id);
  }

  async finish(
    id: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    result?: RunResultV2,
  ): Promise<boolean> {
    let committed = false;
    await this.prisma.$transaction(async (tx) => {
      const source =
        status === "CANCELLED"
          ? ["RUNNING", "CANCELLING", "QUEUED"]
          : ["RUNNING"];
      const changed = await tx.workflowRun.updateMany({
        where: { id, status: { in: source as WorkflowRunStatus[] } },
        data: {
          status,
          finishedAt: new Date(),
          ...(result?.output === undefined
            ? {}
            : { output: result.output as Prisma.InputJsonValue }),
          ...(result?.error
            ? { errorCode: result.error.code, errorMessage: "运行失败" }
            : {}),
        },
      });
      if (!changed.count) return;
      for (const node of result?.nodes ?? []) {
        await tx.nodeRun.updateMany({
          where: { runId: id, nodeId: node.nodeId },
          data: {
            ...(node.output === undefined
              ? {}
              : { output: node.output as Prisma.InputJsonValue }),
            ...(node.error
              ? { errorCode: node.error.code, errorMessage: "节点执行失败" }
              : {}),
          },
        });
      }
      if (status === "CANCELLED" || status === "FAILED")
        await tx.nodeRun.updateMany({
          where: { runId: id, status: { in: [...activeNodeStatuses] } },
          data: { status: "CANCELLED", finishedAt: new Date() },
        });
      await tx.runEvent.create({
        data: this.events.prepare({
          runId: id,
          type: `run.${status.toLowerCase()}`,
          level: status === "FAILED" ? "error" : "info",
          payload: { status, errorCode: result?.error?.code },
        }),
      });
      committed = true;
    });
    if (committed) this.events.notifyCommitted(id);
    return committed;
  }

  async requestCancel(
    ownerId: string,
    id: string,
  ): Promise<WorkflowRunStatus | null> {
    const changed = await this.prisma.workflowRun.updateMany({
      where: { id, ownerId, status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "CANCELLING" },
    });
    const row = await this.prisma.workflowRun.findFirst({
      where: { id, ownerId },
      select: { status: true },
    });
    return changed.count || row ? (row?.status ?? null) : null;
  }

  async recover(onlyRunIds?: string[]): Promise<number> {
    const rows = await this.prisma.workflowRun.findMany({
      where: {
        status: { in: activeStatuses },
        ...(onlyRunIds ? { id: { in: onlyRunIds } } : {}),
      },
      select: { id: true },
    });
    let count = 0;
    for (const row of rows) {
      let committed = false;
      await this.prisma.$transaction(async (tx) => {
        const changed = await tx.workflowRun.updateMany({
          where: { id: row.id, status: { in: activeStatuses } },
          data: {
            status: "INTERRUPTED",
            finishedAt: new Date(),
            errorCode: "process_interrupted",
          },
        });
        if (!changed.count) return;
        await tx.nodeRun.updateMany({
          where: {
            runId: row.id,
            status: { in: [...activeNodeStatuses] },
          },
          data: { status: "CANCELLED", finishedAt: new Date() },
        });
        await tx.runEvent.create({
          data: this.events.prepare({
            runId: row.id,
            type: "run.interrupted",
            level: "warn",
            payload: {
              status: "INTERRUPTED",
              errorCode: "process_interrupted",
            },
          }),
        });
        committed = true;
      });
      if (committed) {
        count++;
        this.events.notifyCommitted(row.id);
      }
    }
    return count;
  }
}
