import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  CreateRunRequestSchema,
  decodeWorkflowCursor,
  encodeWorkflowCursor,
  workflowV2Schema,
  type JsonObject,
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
import { toRunResponse } from "./run.mapper.js";
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

/** 运行输入仅使用启动快照声明的字段，默认值先补齐再保存，执行与详情共享同一份值。 */
function validateStartInput(graph: WorkflowV2, input: JsonObject): JsonObject {
  const start = graph.nodes.find((node) => node.type === "start");
  const fields = start?.config?.inputs ?? [];
  const names = new Set(fields.map((field) => field.name));
  if (Object.keys(input).some((key) => !names.has(key)))
    throw new ApiError(400, "RUN_INPUT_INVALID", "运行输入字段无效");
  const normalized: JsonObject = { ...input };
  for (const field of fields) {
    const value = normalized[field.name] ?? field.defaultValue;
    if (value === undefined) {
      if (field.required)
        throw new ApiError(400, "RUN_INPUT_INVALID", "运行输入缺少必填字段");
      continue;
    }
    if (!matchesType(value, field.type))
      throw new ApiError(400, "RUN_INPUT_INVALID", "运行输入字段类型无效");
    normalized[field.name] = value;
  }
  return normalized;
}

@Injectable()
export class RunService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    private readonly events: RunEventWriter,
    @Inject(RUN_ENQUEUER) private readonly enqueuer: RunEnqueuer,
  ) {}

  /** 先校验、后事务；只有运行/节点/初始事件全部提交后才通知并排队执行。 */
  async createDebugRun(
    ownerId: string,
    workflowId: string,
    body: unknown,
  ): Promise<RunResponse> {
    const request = CreateRunRequestSchema.parse(body);
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
    if (!row) throw missing();
    const response = toRunResponse(row);
    this.events.notifyCommitted(id);
    this.enqueuer.enqueue(id);
    return response;
  }

  async get(ownerId: string, runId: string): Promise<RunResponse> {
    const row = await this.runs.findOwned(ownerId, runId);
    if (!row) throw new ApiError(404, "RUN_NOT_FOUND", "运行不存在");
    return toRunResponse(row);
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
