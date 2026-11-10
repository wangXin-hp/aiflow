import { Inject, Injectable } from "@nestjs/common";
import type { WorkflowLogEntryV2, RunResultV2 } from "@aiflow/workflow-engine";
import { ApiError } from "../common/api-error.js";
import { RunAdaptersFactory } from "./run-adapters.factory.js";
import {
  RUN_EXECUTION_STORE,
  type RunExecutionStore,
} from "./run-execution.store.js";

export const RUN_EXECUTION_CONFIG = Symbol("RUN_EXECUTION_CONFIG");
export interface RunExecutionConfig {
  totalTimeoutMs: number;
  nodeTimeoutMs: number;
  maxConcurrent?: number;
}
const maxStoredOutputBytes = 2 * 1024 * 1024;

function outputIsBounded(result: RunResultV2 | undefined): boolean {
  try {
    for (const value of [
      result?.output,
      ...(result?.nodes.map((node) => node.output) ?? []),
    ]) {
      if (value === undefined) continue;
      const serialized = JSON.stringify(value);
      if (
        !serialized ||
        serialized.includes("\\u0000") ||
        new TextEncoder().encode(serialized).byteLength > maxStoredOutputBytes
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** 单实例内每个运行持有一个取消信号；数据库仍是状态和事件的唯一真相源。 */
@Injectable()
export class RunCoordinator {
  private readonly active = new Map<string, AbortController>();
  private readonly queued: string[] = [];
  private pumping = 0;
  constructor(
    @Inject(RUN_EXECUTION_STORE) private readonly store: RunExecutionStore,
    @Inject(RunAdaptersFactory)
    private readonly adapters: Pick<RunAdaptersFactory, "run" | "registry">,
    @Inject(RUN_EXECUTION_CONFIG) private readonly config: RunExecutionConfig,
  ) {}

  enqueue(runId: string): void {
    // HTTP 返回不等待云模型；执行失败由持久化终态及事件表示。
    if (this.queued.includes(runId) || this.active.has(runId)) return;
    this.queued.push(runId);
    queueMicrotask(() => this.pump());
  }

  private pump(): void {
    while (
      this.pumping < (this.config.maxConcurrent ?? 4) &&
      this.queued.length
    ) {
      const id = this.queued.shift()!;
      this.pumping++;
      void this.execute(id)
        .catch(() => {})
        .finally(() => {
          this.pumping--;
          this.pump();
        });
    }
  }

  async cancel(ownerId: string, runId: string) {
    const status = await this.store.requestCancel(ownerId, runId);
    if (!status) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
    if (status === "CANCELLING") {
      const controller = this.active.get(runId);
      if (controller) controller.abort();
      else {
        await this.store.finish(runId, "CANCELLED");
        return "CANCELLED";
      }
    }
    return status;
  }

  async execute(runId: string): Promise<void> {
    if (this.active.has(runId)) return;
    const controller = new AbortController();
    this.active.set(runId, controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let acceptingLogs = true;
    let pending: Promise<void> = Promise.resolve();
    let logError: unknown;
    try {
      const snapshot = await this.store.load(runId);
      if (!snapshot || snapshot.status !== "QUEUED") return;
      if (!(await this.store.start(runId))) {
        if (controller.signal.aborted)
          await this.store.finish(runId, "CANCELLED");
        return;
      }
      // 外部适配器可能忽略 AbortSignal；截止 Promise 保证总超时仍能落库。
      const deadline = new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          acceptingLogs = false;
          controller.abort(new Error("run_timeout"));
          resolve(undefined);
        }, this.config.totalTimeoutMs);
      });
      /** 引擎不等待 onLog；链式写入保证节点事件先于终态提交。 */
      const onLog = (entry: WorkflowLogEntryV2) => {
        if (!acceptingLogs) return;
        pending = pending
          .then(() => this.store.log(runId, entry))
          .catch((error: unknown) => {
            logError ??= error;
            controller.abort(error);
          });
      };
      let result: RunResultV2 | undefined;
      let failure: unknown;
      try {
        result = await Promise.race([
          this.adapters.run(snapshot.definitionSnapshot, snapshot.input, {
            registry: this.adapters.registry(snapshot.ownerId),
            signal: controller.signal,
            nodeTimeoutMs: this.config.nodeTimeoutMs,
            onLog,
          }),
          deadline,
        ]);
      } catch (error) {
        failure = error;
      }
      if (timeout) clearTimeout(timeout);
      acceptingLogs = false;
      await pending;
      if (logError) failure ??= logError;
      const oversized = !outputIsBounded(result);
      const terminal =
        timedOut || logError || oversized
          ? "FAILED"
          : failure
            ? controller.signal.aborted
              ? "CANCELLED"
              : "FAILED"
            : controller.signal.aborted || result?.status === "cancelled"
              ? "CANCELLED"
              : result?.status === "failed"
                ? "FAILED"
                : "SUCCEEDED";
      const synthetic =
        failure || logError || timedOut || oversized
          ? {
              runId,
              status: "failed" as const,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              nodes: [],
              logs: [],
              error: {
                code: timedOut
                  ? "run_timeout"
                  : logError
                    ? "event_persistence_failed"
                    : oversized
                      ? "run_output_too_large"
                      : "run_execution_failed",
                message: "Run execution failed",
              },
            }
          : undefined;
      const finalResult =
        timedOut || logError || oversized ? synthetic : (result ?? synthetic);
      if (
        !(await this.store.finish(runId, terminal, finalResult)) &&
        terminal !== "CANCELLED"
      ) {
        // 取消若先把状态改成 CANCELLING，自然完成不得覆盖取消终态。
        await this.store.finish(runId, "CANCELLED", result);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      this.active.delete(runId);
    }
  }
}
