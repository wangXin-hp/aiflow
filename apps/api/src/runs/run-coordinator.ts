import { Inject, Injectable } from "@nestjs/common";
import type { WorkflowLogEntryV2, RunResultV2 } from "@aiflow/workflow-engine";
import { validateWorkflowV2 } from "@aiflow/workflow-engine";
import { workflowV2Schema } from "@aiflow/contracts";
import { ApiError } from "../common/api-error.js";
import { Prisma } from "../generated/prisma/client.js";
import { RunAdaptersFactory } from "./run-adapters.factory.js";
import { validateRunOutput } from "./run-output-validation.js";
import {
  RUN_EXECUTION_STORE,
  type RunExecutionStore,
} from "./run-execution.store.js";

export const RUN_EXECUTION_CONFIG = Symbol("RUN_EXECUTION_CONFIG");
export interface RunExecutionConfig {
  totalTimeoutMs: number;
  nodeTimeoutMs: number;
  maxConcurrent?: number;
  maxNodes?: number;
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
      if (!snapshot) return;
      if (snapshot.status === "CANCELLING") {
        await this.store.finish(runId, "CANCELLED");
        return;
      }
      if (snapshot.status !== "QUEUED") return;
      // 持久化 JSONB 是不可信边界；在领取前完成结构与图校验，避免损坏数据卡在 RUNNING。
      const definitionValid =
        workflowV2Schema.safeParse(snapshot.definitionSnapshot).success &&
        validateWorkflowV2(snapshot.definitionSnapshot).valid;
      if (!(await this.store.start(runId))) {
        if (controller.signal.aborted)
          await this.store.finish(runId, "CANCELLED");
        return;
      }
      if (!definitionValid) {
        await this.finishWithCancellationFallback(
          runId,
          "FAILED",
          this.failureResult(runId, "run_definition_invalid"),
        );
        return;
      }
      if (
        snapshot.definitionSnapshot.nodes.length > (this.config.maxNodes ?? 100)
      ) {
        await this.finishWithCancellationFallback(
          runId,
          "FAILED",
          this.failureResult(runId, "run_node_limit_exceeded"),
        );
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
      const outputValidation = validateRunOutput(result);
      const invalidOutput = outputValidation !== "valid";
      const terminal =
        timedOut || logError || invalidOutput
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
      const synthetic: RunResultV2 | undefined =
        failure || logError || timedOut || invalidOutput
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
                    : invalidOutput
                      ? outputValidation === "too_large"
                        ? "run_output_too_large"
                        : "run_output_invalid"
                      : "run_execution_failed",
                message: "Run execution failed",
              },
            }
          : undefined;
      const finalResult =
        timedOut || logError || invalidOutput
          ? synthetic
          : (result ?? synthetic);
      await this.persistTerminal(runId, terminal, finalResult);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.active.delete(runId);
    }
  }

  private async persistTerminal(
    runId: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    result?: RunResultV2,
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.finishWithCancellationFallback(runId, status, result);
        return;
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          // 事务冲突保留已验证结果重试；不能伪装成业务输出错误。
          if (error.code === "P2034" && attempt < 2) continue;
          if (
            error.code === "P2007" &&
            (result?.output !== undefined ||
              result?.nodes.some((node) => node.output !== undefined))
          ) {
            // JSONB 明确拒绝输出时，事务回滚后用无输出载荷收尾。
            await this.finishWithCancellationFallback(
              runId,
              "FAILED",
              this.failureResult(runId, "run_output_invalid"),
            );
            return;
          }
        }
        throw error;
      }
    }
  }

  private async finishWithCancellationFallback(
    runId: string,
    status: "SUCCEEDED" | "FAILED" | "CANCELLED",
    result?: RunResultV2,
  ): Promise<void> {
    if (
      !(await this.store.finish(runId, status, result)) &&
      status !== "CANCELLED"
    ) {
      // 取消赢得状态竞争后，仍使用已经校验的同一载荷。
      await this.store.finish(runId, "CANCELLED", result);
    }
  }

  private failureResult(runId: string, code: string): RunResultV2 {
    const now = new Date().toISOString();
    return {
      runId,
      status: "failed",
      startedAt: now,
      finishedAt: now,
      nodes: [],
      logs: [],
      error: { code, message: "Run execution failed" },
    };
  }
}
