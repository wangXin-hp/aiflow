import {
  RunDetailResponseSchema,
  RunResponseSchema,
  RunStatusSchema,
  WorkflowListResponseSchema,
  WorkflowResponseSchema,
  apiSuccessSchema,
  type ApiSuccess,
  type CreateRunRequest,
  type CreateWorkflowRequest,
  type UpdateWorkflowRequest,
} from "@aiflow/contracts";
import { z } from "zod";
import { parseApiError, requestFailed } from "../auth/auth-api";

const workflowPath = "/workflows";
const workflowById = (id: string) =>
  `${workflowPath}/${encodeURIComponent(id)}`;
const runById = (id: string) => `/runs/${encodeURIComponent(id)}`;
const cancelResponseSchema = z.strictObject({ status: RunStatusSchema });

/** HTTP 响应来自不可信边界，先校验共享包装和业务数据，再交给页面。 */
function request<T extends z.ZodType>(
  path: string,
  schema: T,
  init?: RequestInit,
): Promise<z.output<T>>;
function request(path: string, schema: null, init: RequestInit): Promise<void>;
async function request<T extends z.ZodType>(
  path: string,
  schema: T | null,
  init?: RequestInit,
): Promise<z.output<T> | void> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
  }).catch(() => {
    throw requestFailed();
  });

  // 归档成功以 204 为准，无需读取响应体。
  if (response.status === 204) {
    if (schema === null) return;
    throw requestFailed(response.status);
  }

  const body: unknown = await response.json().catch(() => {
    // 代理可能返回非 JSON，认证和冲突处理仍依赖原始 HTTP 状态。
    throw requestFailed(response.status);
  });
  if (!response.ok) throw parseApiError(body, response.status);
  if (schema === null) throw requestFailed(response.status);

  const result = apiSuccessSchema(schema).safeParse(body);
  if (!result.success) throw requestFailed(response.status);
  // Zod 泛型对象的条件可选键无法被 TS 收窄，完整包装已通过运行时校验。
  return (result.data as ApiSuccess<z.output<T>>).data;
}

function jsonRequest(
  method: "POST" | "PATCH",
  input: CreateWorkflowRequest | UpdateWorkflowRequest | CreateRunRequest,
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  };
}

/** 工作流草稿通过当前会话访问，分页沿用服务端提供的不透明游标。 */
export const workflowApi = {
  list: (cursor?: string) =>
    request(
      cursor === undefined
        ? workflowPath
        : `${workflowPath}?${new URLSearchParams({ cursor })}`,
      WorkflowListResponseSchema,
    ),
  create: (input: CreateWorkflowRequest) =>
    request(workflowPath, WorkflowResponseSchema, jsonRequest("POST", input)),
  get: (id: string) => request(workflowById(id), WorkflowResponseSchema),
  /** 服务端用 revision 判断写入冲突，调用方根据 409 决定是否重新载入。 */
  update: (id: string, input: UpdateWorkflowRequest) =>
    request(
      workflowById(id),
      WorkflowResponseSchema,
      jsonRequest("PATCH", input),
    ),
  archive: (id: string) =>
    request(workflowById(id), null, { method: "DELETE" }),
};

/** 调试运行从已保存的服务端草稿创建快照，详情包含受会话保护的节点数据。 */
export const runApi = {
  create: (workflowId: string, input: CreateRunRequest) =>
    request(
      `${workflowById(workflowId)}/runs`,
      RunResponseSchema,
      jsonRequest("POST", input),
    ),
  get: (id: string) => request(runById(id), RunDetailResponseSchema),
  cancel: (id: string) =>
    request(`${runById(id)}/cancel`, cancelResponseSchema, { method: "POST" }),
};
