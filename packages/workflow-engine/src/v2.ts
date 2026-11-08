import type { JsonObject } from "@aiflow/contracts";
import type { ValidationIssue } from "./validation.js";
import { prepare } from "./v2/graph.js";
import { objectCopy, bindingsOutput, resolve } from "./v2/bindings.js";
import { ExecutionFailure } from "./v2/errors.js";
import { invokeNode } from "./v2/invoke.js";
import { NodeRegistryV2 } from "./v2/nodes.js";
export { validateWorkflowV2 } from "./v2/graph.js";
export { NodeRegistryV2 } from "./v2/nodes.js";
export type {
  NodeExecutorV2,
  NodeAdaptersV2,
  ModelAdapterV2,
  HttpAdapterV2,
  KnowledgeAdapterV2,
} from "./v2/nodes.js";

export type RunStatus = "succeeded" | "failed" | "cancelled";
export type NodeStatus = "succeeded" | "failed" | "skipped" | "cancelled";
export interface NodeResultV2 {
  nodeId: string;
  status: NodeStatus;
  startedAt?: string;
  finishedAt?: string;
  output?: JsonObject;
  /** 默认不保留节点输入，避免意外持久化敏感数据。 */
  input?: JsonObject;
  durationMs?: number;
  error?: { code: string; message: string };
}
/** 一条运行日志只包含执行元数据，默认不包含输入、输出或异常原文。 */
export interface WorkflowLogEntryV2 {
  runId: string;
  timestamp: string;
  code:
    | "run.started"
    | "run.succeeded"
    | "run.failed"
    | "run.cancelled"
    | "node.started"
    | "node.succeeded"
    | "node.failed"
    | "node.skipped"
    | "node.cancelled";
  level: "info" | "error";
  nodeId?: string;
  nodeType?: string;
  durationMs?: number;
  errorCode?: string;
}
export interface RunResultV2 {
  runId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  nodes: NodeResultV2[];
  logs: WorkflowLogEntryV2[];
  output?: JsonObject;
  error?: { code: string; message: string };
}
export interface WorkflowEventV2 {
  type: "run.started" | "node.started" | "node.finished" | "run.finished";
  runId: string;
  nodeId?: string;
  status?: NodeStatus | RunStatus;
  at: string;
}
export interface RunOptionsV2 {
  signal?: AbortSignal;
  /** 单节点最大等待时间，默认 30 秒；超时后通过节点信号通知执行器。 */
  nodeTimeoutMs?: number;
  /** 调试时显式开启，结果可能包含敏感数据。 */
  captureInputs?: boolean;
  onEvent?: (event: WorkflowEventV2) => void | Promise<void>;
  /** 实时读取日志；回调异常不会改变运行结果。 */
  onLog?: (entry: WorkflowLogEntryV2) => void | Promise<void>;
}

export interface RunOptionsWithRegistryV2 extends RunOptionsV2 {
  registry?: NodeRegistryV2;
}

/** 串行 DAG 调度；所有入边决议后执行，全部跳过的节点继续传播 skipped。 */
export async function runWorkflowV2(
  definition: unknown,
  input: unknown,
  options: RunOptionsWithRegistryV2 = {},
): Promise<RunResultV2> {
  const timeoutMs = options.nodeTimeoutMs ?? 30_000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  )
    throw new RangeError(
      "nodeTimeoutMs must be an integer between 1 and 2147483647",
    );
  const prepared = prepare(definition);
  if (!prepared.validation.valid || !prepared.graph || !prepared.order)
    throw new WorkflowV2ValidationError(prepared.validation.errors);
  const graph = prepared.graph,
    startInput = objectCopy(input),
    registry = options.registry ?? new NodeRegistryV2();
  const runId = globalThis.crypto.randomUUID(),
    startedAt = new Date().toISOString();
  const results: NodeResultV2[] = [],
    logs: WorkflowLogEntryV2[] = [],
    outputs = new Map<string, JsonObject>(),
    edgeState = new Map<string, "active" | "skipped">();
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  let status: RunStatus = "succeeded",
    failure: { code: string; message: string } | undefined,
    finalOutput: JsonObject | undefined;
  const emit = (
    type: WorkflowEventV2["type"],
    nodeId?: string,
    eventStatus?: NodeStatus | RunStatus,
  ) => {
    const nodeResult = nodeId
      ? results.find((item) => item.nodeId === nodeId)
      : undefined;
    const code =
      type === "run.finished"
        ? `run.${eventStatus}`
        : type === "node.finished"
          ? `node.${eventStatus}`
          : type;
    const log: WorkflowLogEntryV2 = {
      runId,
      timestamp: new Date().toISOString(),
      code: code as WorkflowLogEntryV2["code"],
      level: eventStatus === "failed" ? "error" : "info",
      ...(nodeId ? { nodeId, nodeType: nodes.get(nodeId)?.type } : {}),
      ...(nodeResult?.durationMs !== undefined
        ? { durationMs: nodeResult.durationMs }
        : {}),
      ...(nodeResult?.error ? { errorCode: nodeResult.error.code } : {}),
    };
    logs.push(log);
    try {
      const delivered = options.onLog?.({ ...log });
      if (delivered) void Promise.resolve(delivered).catch(() => {});
    } catch {
      /* 日志接收方异常不能影响运行。 */
    }
    try {
      const returned = options.onEvent?.({
        type,
        runId,
        nodeId,
        status: eventStatus,
        at: new Date().toISOString(),
      });
      if (returned) void Promise.resolve(returned).catch(() => {});
    } catch {
      /* 观察者失败不改变执行结果。 */
    }
  };
  emit("run.started");
  for (const id of prepared.order) {
    const node = nodes.get(id)!;
    const inbound = graph.edges.filter((e) => e.target === id),
      outbound = graph.edges.filter((e) => e.source === id);
    const skip =
      status !== "succeeded" ||
      (node.type !== "start" &&
        inbound.every((e) => edgeState.get(e.id) === "skipped"));
    if (skip || options.signal?.aborted) {
      if (options.signal?.aborted && status === "succeeded")
        status = "cancelled";
      const nodeStatus = status === "cancelled" ? "cancelled" : "skipped";
      results.push({ nodeId: id, status: nodeStatus });
      for (const e of outbound) edgeState.set(e.id, "skipped");
      emit("node.finished", id, nodeStatus);
      continue;
    }
    const nodeStarted = new Date().toISOString();
    const startedClock = performance.now();
    let capturedInput: JsonObject | undefined;
    emit("node.started", id);
    try {
      if (options.signal?.aborted)
        throw new ExecutionFailure("cancelled", "Run cancelled");
      const nodeInput =
        node.type === "start"
          ? objectCopy(startInput)
          : node.type === "condition"
            ? { value: resolve(node.config.value, outputs) }
            : bindingsOutput(node.config.values, outputs);
      if (options.captureInputs) capturedInput = objectCopy(nodeInput);
      const executed = await invokeNode(
        registry.get(node.type),
        structuredClone(node),
        objectCopy(nodeInput),
        timeoutMs,
        options.signal,
      );
      if (options.signal?.aborted) {
        status = "cancelled";
        results.push({
          nodeId: id,
          status: "cancelled",
          startedAt: nodeStarted,
          finishedAt: new Date().toISOString(),
          durationMs: performance.now() - startedClock,
          ...(capturedInput ? { input: capturedInput } : {}),
        });
        for (const e of outbound) edgeState.set(e.id, "skipped");
        emit("node.finished", id, "cancelled");
        continue;
      }
      if (
        (node.type === "condition" &&
          executed.branch !== "true" &&
          executed.branch !== "false") ||
        (node.type === "intent" &&
          !node.config.intents.some((intent) => intent.id === executed.branch))
      )
        throw new ExecutionFailure(
          "invalid_branch",
          "Branch executor must select a configured branch",
        );
      const output = objectCopy(executed.output);
      outputs.set(id, output);
      if (node.type === "end") finalOutput = objectCopy(output);
      results.push({
        nodeId: id,
        status: "succeeded",
        startedAt: nodeStarted,
        finishedAt: new Date().toISOString(),
        durationMs: performance.now() - startedClock,
        ...(capturedInput ? { input: capturedInput } : {}),
        output: objectCopy(output),
      });
      for (const e of outbound)
        edgeState.set(
          e.id,
          (node.type !== "condition" && node.type !== "intent") ||
            e.sourcePort === executed.branch
            ? "active"
            : "skipped",
        );
      emit("node.finished", id, "succeeded");
    } catch (error) {
      // 超时先于取消触发时保留超时结果，避免执行器的清理回调改写错误分类。
      if (
        options.signal?.aborted &&
        !(error instanceof ExecutionFailure && error.code === "node_timeout")
      ) {
        status = "cancelled";
        results.push({
          nodeId: id,
          status: "cancelled",
          startedAt: nodeStarted,
          finishedAt: new Date().toISOString(),
          durationMs: performance.now() - startedClock,
          ...(capturedInput ? { input: capturedInput } : {}),
        });
        for (const e of outbound) edgeState.set(e.id, "skipped");
        emit("node.finished", id, "cancelled");
        continue;
      }
      status = "failed";
      failure = {
        code:
          error instanceof ExecutionFailure
            ? error.code
            : "node_execution_failed",
        message:
          error instanceof Error ? error.message : "Node execution failed",
      };
      results.push({
        nodeId: id,
        status: "failed",
        startedAt: nodeStarted,
        finishedAt: new Date().toISOString(),
        durationMs: performance.now() - startedClock,
        ...(capturedInput ? { input: capturedInput } : {}),
        error: failure,
      });
      for (const e of outbound) edgeState.set(e.id, "skipped");
      emit("node.finished", id, "failed");
    }
  }
  emit("run.finished", undefined, status);
  return {
    runId,
    status,
    startedAt,
    finishedAt: new Date().toISOString(),
    nodes: results,
    logs,
    output: finalOutput,
    error: failure,
  };
}
export class WorkflowV2ValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super("Invalid V2 workflow definition");
    this.name = "WorkflowV2ValidationError";
  }
}
