import { workflowV2Schema, type WorkflowV2 } from "@aiflow/contracts";

/** Mapper 只依赖公开字段所需的最小结构，允许仓储记录携带关系和内部列。 */
export interface WorkflowRecordForResponse {
  id: string;
  name: string;
  description: string;
  definition: unknown;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Task 2 会把该结构绑定到共享的 HTTP WorkflowResponse 契约。 */
export interface MappedWorkflowResponse {
  id: string;
  name: string;
  description: string;
  definition: WorkflowV2;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 将数据库记录转换为公开响应，并在信任边界重新解析 JSON。
 * 若存量数据损坏会直接抛出 ZodError，禁止未经校验的定义继续流向 API 或执行器。
 */
export function toWorkflowResponse(
  record: WorkflowRecordForResponse,
): MappedWorkflowResponse {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    definition: workflowV2Schema.parse(record.definition),
    revision: record.revision,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
