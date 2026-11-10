import { Injectable } from "@nestjs/common";
import {
  RunEventSchema,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
  type RunEvent,
} from "@aiflow/contracts";
import {
  Prisma,
  type RunEvent as RunEventRecord,
} from "../generated/prisma/client.js";
import { PrismaService } from "../database/prisma.service.js";
import { RunEventHub } from "./run-event-hub.js";
import { sanitizeRunEventPayload } from "./run-event-sanitizer.js";

export interface AppendRunEventInput {
  runId: string;
  nodeId?: string | null;
  type: string;
  level: "debug" | "info" | "warn" | "error";
  payload: unknown;
}

/** BigInt 与 Date 只在持久化边界转换，HTTP/SSE 从不接收 Prisma 原始记录。 */
function toPublicEvent(row: RunEventRecord): RunEvent {
  return RunEventSchema.parse({
    id: row.id.toString(),
    runId: row.runId,
    nodeId: row.nodeId,
    type: row.type,
    level: row.level,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  });
}

@Injectable()
export class RunEventWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: RunEventHub,
  ) {}

  /** 供创建运行的事务共用脱敏逻辑；调用方必须在事务提交后再通知。 */
  prepare(input: AppendRunEventInput): Prisma.RunEventUncheckedCreateInput {
    return {
      runId: input.runId,
      nodeId: input.nodeId ?? null,
      type: input.type,
      level: input.level,
      payload: sanitizeRunEventPayload(
        input.payload,
        MAX_RUN_EVENT_PAYLOAD_BYTES,
      ) as Prisma.InputJsonValue,
    };
  }

  /** 插入完成才发布无业务内容的通知，失败时订阅者不会看到幽灵事件。 */
  async append(input: AppendRunEventInput): Promise<RunEvent> {
    const row = await this.prisma.runEvent.create({
      data: this.prepare(input),
    });
    const event = toPublicEvent(row);
    this.hub.notify(input.runId);
    return event;
  }

  /** 事务内已写入事件时，只允许事务调用方在成功提交后触发。 */
  notifyCommitted(runId: string): void {
    this.hub.notify(runId);
  }
}
