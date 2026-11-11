import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  CreateRunRequestSchema,
  decodeWorkflowCursor,
  encodeWorkflowCursor,
  workflowV2Schema,
  type JsonObject,
  type RunDetailResponse,
  type RunResponse,
  type WorkflowV2,
} from "@aiflow/contracts";
import { validateWorkflowV2 } from "@aiflow/workflow-engine";
import { ApiError } from "../common/api-error.js";
import {
  WORKFLOW_REPOSITORY,
  type WorkflowRepository,
} from "../workflows/workflow.repository.js";
import { RunEventWriter } from "./run-event-writer.js";
import { toRunDetailResponse, toRunResponse } from "./run.mapper.js";
import { RUN_REPOSITORY, type RunRepository } from "./run.repository.js";

export interface RunEnqueuer {
  enqueue(runId: string): void;
}
export const RUN_ENQUEUER = Symbol("RUN_ENQUEUER");

const missing = () => new ApiError(404, "WORKFLOW_NOT_FOUND", "工作流不存在");

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "array") return Array.isArray(value);
  if (expected === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === expected;
}

/** PostgreSQL JSONB 不接受 NUL；写库前检查键和值，避免把输入错误变成数据库 500。 */
function containsNul(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string" && current.includes("\0")) return true;
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (key.includes("\0")) return true;
      stack.push(child);
    }
  }
  return false;
}

/** 运行输入仅使用启动快照声明的字段，默认值先补齐再保存，执行与详情共享同一份值。 */
function validateStartInput(graph: WorkflowV2, input: JsonObject): JsonObject {
  const start = graph.nodes.find((node) => node.type === "start");
  const fields = start?.config?.inputs ?? [];
  const names = new Set(fields.map((field) => field.name));
  if (Object.keys(input).some((key) => !names.has(key)))
    throw new ApiError(400, "RUN_INPUT_INVALID", "运行输入字段无效");
  const normalized: JsonObject = Object.assign(Object.create(null), input);
  for (const field of fields) {
    // null 是调用者显式提供的值，只有真正缺失的字段才能使用默认值。
    const value = Object.hasOwn(normalized, field.name)
      ? normalized[field.name]
      : field.defaultValue;
    if (value === undefined) {
      if (field.required)
        throw new ApiError(400, "RUN_INPUT_INVALID", "运行输入缺少必填字段");
      continue;
    }
    if (!matchesType(value, field.type))
      throw new ApiError(400, "RUN_INPUT_INVALID", "运行输入字段类型无效");
    Object.defineProperty(normalized, field.name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return normalized;
}

@Injectable()
export class RunService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RunEventWriter) private readonly events: RunEventWriter,
    @Inject(RUN_ENQUEUER) private readonly enqueuer: RunEnqueuer,
  ) {}

  /** 先校验、后事务；只有运行/节点/初始事件全部提交后才通知并排队执行。 */
  async createDebugRun(
    ownerId: string,
    workflowId: string,
    body: unknown,
  ): Promise<RunResponse> {
    let request: ReturnType<typeof CreateRunRequestSchema.parse>;
    try {
      request = CreateRunRequestSchema.parse(body);
    } catch {
      throw new ApiError(400, "RUN_INPUT_INVALID", "运行输入格式无效");
    }
    const workflow = await this.workflows.findActiveById(ownerId, workflowId);
    if (!workflow) throw missing();
    let definition: WorkflowV2;
    try {
      definition = workflowV2Schema.parse(workflow.definition);
      if (!validateWorkflowV2(definition).valid)
        throw new Error("invalid stored graph");
    } catch {
      throw new ApiError(
        500,
        "WORKFLOW_DEFINITION_CORRUPT",
        "工作流定义已损坏",
      );
    }
    const input = validateStartInput(definition, request.input);
    // 默认值可能让最终输入超出请求上限；必须在开启事务前重走共享边界。
    if (containsNul(input))
      throw new ApiError(
        400,
        "RUN_INPUT_INVALID",
        "运行输入包含数据库不支持的字符",
      );
    try {
      CreateRunRequestSchema.parse({ input });
    } catch {
      throw new ApiError(
        400,
        "RUN_INPUT_INVALID",
        "运行输入超过限制或格式无效",
      );
    }
    const id = randomUUID();
    const row = await this.runs.createQueued({
      id,
      ownerId,
      workflowId,
      workflowRevision: workflow.revision,
      definitionSnapshot: definition,
      input,
      nodeRows: definition.nodes.map((node) => ({
        nodeId: node.id,
        nodeType: node.type,
      })),
      eventWriter: this.events,
    });
    if (!row) {
      // 提交前的条件锁发现 revision 已变；只对仍属当前用户的活动工作流公开冲突。
      const current = await this.workflows.findActiveById(ownerId, workflowId);
      if (current)
        throw new ApiError(
          409,
          "WORKFLOW_REVISION_CONFLICT",
          "工作流已更新，请重试运行",
        );
      throw missing();
    }
    const response = toRunResponse(row);
    this.events.notifyCommitted(id);
    this.enqueuer.enqueue(id);
    return response;
  }

  async get(ownerId: string, runId: string): Promise<RunDetailResponse> {
    const row = await this.runs.findOwned(ownerId, runId);
    if (!row) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
    return toRunDetailResponse(row);
  }

  /** 按创建时间和 ID 降序分页；游标只编码排序键，不接收任意查询条件。 */
  async list(ownerId: string, query: { limit?: number; cursor?: string } = {}) {
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(400, "VALIDATION_ERROR", "分页参数无效");
    let cursor: { createdAt: Date; id: string } | undefined;
    if (query.cursor) {
      try {
        const decoded = decodeWorkflowCursor(query.cursor);
        cursor = { createdAt: new Date(decoded.createdAt), id: decoded.id };
      } catch {
        throw new ApiError(400, "VALIDATION_ERROR", "分页游标无效");
      }
    }
    const rows = await this.runs.listOwned(ownerId, limit + 1, cursor);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(toRunResponse),
      nextCursor:
        rows.length > limit && last
          ? encodeWorkflowCursor({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }
}
