import { RunResponseSchema, type RunResponse } from "@aiflow/contracts";
import type { WorkflowRun } from "../generated/prisma/client.js";

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
