import { Inject, Injectable, Logger, type MessageEvent } from "@nestjs/common";
import { RunEventCursorSchema, RunEventSchema } from "@aiflow/contracts";
import { Observable } from "rxjs";
import { ApiError } from "../common/api-error.js";
import { PrismaService } from "../database/prisma.service.js";
import { RunEventHub } from "./run-event-hub.js";

const pageSize = 100;
const heartbeatMs = 15_000;
const terminalEvents = new Set([
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
]);
const terminalStatuses = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);

/** SSE 通知只唤醒查询；游标、去重和补发全部以 PostgreSQL 的有序事件为准。 */
@Injectable()
export class RunEventStreamService {
  private readonly logger = new Logger(RunEventStreamService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RunEventHub) private readonly hub: RunEventHub,
  ) {}

  async assertOwned(ownerId: string, runId: string): Promise<void> {
    const owned = await this.prisma.workflowRun.findFirst({
      where: { id: runId, ownerId },
      select: { id: true },
    });
    if (!owned) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
  }

  /** 先订阅后查历史；通知与首次查询竞争时再读一次数据库，不会漏掉已提交事件。 */
  stream(
    ownerId: string,
    runId: string,
    afterId?: string,
  ): Observable<MessageEvent> {
    const parsed = RunEventCursorSchema.safeParse(afterId ?? "0");
    if (!parsed.success)
      throw new ApiError(400, "INVALID_EVENT_CURSOR", "事件游标无效");
    return new Observable<MessageEvent>((subscriber) => {
      let cursor = BigInt(parsed.data);
      let reading = false;
      let pending = false;
      let closed = false;
      // 通知可能先于异步归属校验到达；仅记录唤醒，不提前读取事件。
      let authorized = false;
      const wake = () => {
        if (closed || subscriber.closed) return;
        pending = true;
        if (authorized && !reading) void drain();
      };
      const notifications = this.hub.notifications(runId).subscribe(wake);
      const heartbeat = setInterval(() => {
        if (authorized && !subscriber.closed)
          // Nest 会给无 ID 的 data 帧自动编号；纯注释帧不会污染重连游标。
          subscriber.next({ comment: "heartbeat" });
      }, heartbeatMs);
      const finish = () => {
        closed = true;
        subscriber.complete();
      };
      const drain = async () => {
        if (reading || closed) return;
        reading = true;
        try {
          while (pending && !closed) {
            pending = false;
            let page;
            do {
              page = await this.prisma.runEvent.findMany({
                where: { runId, id: { gt: cursor } },
                orderBy: { id: "asc" },
                take: pageSize,
              });
              for (const row of page) {
                if (row.id <= cursor) continue;
                const event = RunEventSchema.parse({
                  id: row.id.toString(),
                  runId: row.runId,
                  nodeId: row.nodeId,
                  type: row.type,
                  level: row.level,
                  payload: row.payload,
                  createdAt: row.createdAt.toISOString(),
                });
                cursor = row.id;
                subscriber.next({
                  id: event.id,
                  type: event.type,
                  data: event,
                });
                if (terminalEvents.has(event.type)) {
                  finish();
                  return;
                }
              }
            } while (page.length === pageSize && !closed);
            if (!closed && page.length < pageSize) {
              // 已经消费过终态游标的重连也应结束；状态和终态事件在同一事务提交。
              const run = await this.prisma.workflowRun.findFirst({
                where: { id: runId, ownerId },
                select: { status: true },
              });
              if (!run) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
              if (terminalStatuses.has(run.status)) {
                // 状态查询可能看到比上一页更新的提交；再读一次游标后才能确认已消费终态。
                const finalPage = await this.prisma.runEvent.findMany({
                  where: { runId, id: { gt: cursor } },
                  orderBy: { id: "asc" },
                  take: pageSize,
                });
                if (finalPage.length > 0 || pending) {
                  pending = true;
                  continue;
                }
                finish();
                return;
              }
            }
          }
        } catch {
          // 响应头可能已经提交；错误交给 Nest 会产生合成 ID 的 error 帧。
          this.logger.warn("SSE 持久化读取失败，连接已关闭");
          finish();
        } finally {
          reading = false;
          // 查询正结束时的新通知仍须启动下一轮，且不能与本轮并发。
          if (pending && !closed) queueMicrotask(wake);
        }
      };
      // 鉴权在 HTTP 建流前执行，订阅时再查一次以保护直接使用服务的调用方。
      void this.assertOwned(ownerId, runId).then(
        () => {
          authorized = true;
          wake();
        },
        () => finish(),
      );
      return () => {
        closed = true;
        notifications.unsubscribe();
        clearInterval(heartbeat);
      };
    });
  }
}
