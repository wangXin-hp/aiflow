import {
  RunDetailResponseSchema,
  RunResponseSchema,
  type RunDetailResponse,
  type RunResponse,
} from "@aiflow/contracts";
import type { NodeRun, WorkflowRun } from "../generated/prisma/client.js";

/** 公开字段白名单重新校验快照；存量 JSON 损坏时不得进入执行器。 */
export function toRunResponse(row: WorkflowRun): RunResponse {
  return RunResponseSchema.parse({
    id: row.id,
    workflowId: row.workflowId,
    workflowVersionId: row.workflowVersionId,
    status: row.status,
    definitionSnapshot: row.definitionSnapshot,
    input: row.input,
    output: row.output,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  });
}

/** 详情显式列出持久化节点字段，避免 Prisma 新增列意外进入受保护接口。 */
export function toRunDetailResponse(
  row: WorkflowRun & { nodes: NodeRun[] },
): RunDetailResponse {
  const graph = RunResponseSchema.shape.definitionSnapshot.parse(
    row.definitionSnapshot,
  );
  const positions = new Map(graph.nodes.map((node, index) => [node.id, index]));
  return RunDetailResponseSchema.parse({
    ...toRunResponse(row),
    // 以快照中的图顺序返回，详情在重试和恢复后仍保持可预测的节点排列。
    nodes: [...row.nodes]
      .sort(
        (left, right) =>
          (positions.get(left.nodeId) ?? Number.MAX_SAFE_INTEGER) -
          (positions.get(right.nodeId) ?? Number.MAX_SAFE_INTEGER),
      )
      .map((node) => ({
        id: node.id,
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        status: node.status,
        input: node.input,
        output: node.output,
        errorCode: node.errorCode,
        errorMessage: node.errorMessage,
        startedAt: node.startedAt?.toISOString() ?? null,
        finishedAt: node.finishedAt?.toISOString() ?? null,
        elapsedMs: node.elapsedMs,
      })),
  });
}
