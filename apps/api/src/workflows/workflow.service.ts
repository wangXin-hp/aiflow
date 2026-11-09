import { Inject, Injectable } from "@nestjs/common";
import {
  CreateWorkflowRequestSchema,
  UpdateWorkflowRequestSchema,
  WorkflowListQuerySchema,
  decodeWorkflowCursor,
  encodeWorkflowCursor,
  workflowV2Schema,
  type WorkflowListResponse,
  type WorkflowResponse,
  type WorkflowV2,
} from "@aiflow/contracts";
import { validateWorkflowV2 } from "@aiflow/workflow-engine";
import { ApiError } from "../common/api-error.js";
import { toWorkflowResponse } from "./workflow.mapper.js";
import {
  WORKFLOW_REPOSITORY,
  type WorkflowRepository,
} from "./workflow.repository.js";

function notFound(): ApiError {
  return new ApiError(404, "WORKFLOW_NOT_FOUND", "工作流不存在");
}

/** 结构校验与可执行图校验缺一不可；失败详情只包含稳定的代码和短消息。 */
function parseExecutableDefinition(input: unknown): WorkflowV2 {
  const definition = workflowV2Schema.parse(input);
  const validation = validateWorkflowV2(definition);
  if (!validation.valid) {
    throw new ApiError(
      400,
      "WORKFLOW_GRAPH_INVALID",
      "工作流图无效",
      validation.errors.map(({ code, message }) => ({ code, message })),
    );
  }
  return definition;
}

@Injectable()
export class WorkflowService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY)
    private readonly repository: WorkflowRepository,
  ) {}

  async create(ownerId: string, input: unknown): Promise<WorkflowResponse> {
    const request = CreateWorkflowRequestSchema.parse(input);
    const definition = parseExecutableDefinition(request.definition);
    return toWorkflowResponse(
      await this.repository.create({ ...request, definition, ownerId }),
    );
  }

  async list(ownerId: string, query: unknown): Promise<WorkflowListResponse> {
    const request = WorkflowListQuerySchema.parse(query);
    const cursor = request.cursor
      ? decodeWorkflowCursor(request.cursor)
      : undefined;
    const rows = await this.repository.listActive({
      ownerId,
      take: request.limit + 1,
      ...(cursor
        ? { cursor: { createdAt: new Date(cursor.createdAt), id: cursor.id } }
        : {}),
    });
    const hasNextPage = rows.length > request.limit;
    const visibleRows = rows.slice(0, request.limit);
    const last = visibleRows.at(-1);
    return {
      items: visibleRows.map(toWorkflowResponse),
      nextCursor:
        hasNextPage && last
          ? encodeWorkflowCursor({
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  async get(ownerId: string, id: string): Promise<WorkflowResponse> {
    const record = await this.repository.findActiveById(ownerId, id);
    if (!record) throw notFound();
    return toWorkflowResponse(record);
  }

  async update(
    ownerId: string,
    id: string,
    input: unknown,
  ): Promise<WorkflowResponse> {
    const request = UpdateWorkflowRequestSchema.parse(input);
    const { revision, ...requestedChanges } = request;
    const changes = {
      ...requestedChanges,
      ...(requestedChanges.definition === undefined
        ? {}
        : {
            definition: parseExecutableDefinition(requestedChanges.definition),
          }),
    };

    // 单条条件写入保证任何字段都不会在 revision 过期时部分落库。
    const updated = await this.repository.updateActiveAtRevision({
      id,
      ownerId,
      revision,
      changes,
    });
    if (updated) return toWorkflowResponse(updated);

    // owner-scoped 查询只用于区分活动记录的版本冲突，不泄漏其他用户资源。
    const owned = await this.repository.findOwnedById(ownerId, id);
    if (!owned || owned.archivedAt) throw notFound();
    throw new ApiError(
      409,
      "WORKFLOW_REVISION_CONFLICT",
      "工作流已被其他修改覆盖，请刷新后重试",
    );
  }

  async archive(ownerId: string, id: string): Promise<void> {
    if (await this.repository.archiveActive(ownerId, id, new Date())) return;
    const owned = await this.repository.findOwnedById(ownerId, id);
    if (owned?.archivedAt) return;
    throw notFound();
  }
}
