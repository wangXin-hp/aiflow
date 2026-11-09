import type { WorkflowV2 } from "@aiflow/contracts";

/** 仓储记录保留所有权和归档字段；公开响应必须经过 mapper 白名单投影。 */
export interface WorkflowRecord {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  definition: unknown;
  revision: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateWorkflowRecord {
  ownerId: string;
  name: string;
  description: string;
  definition: WorkflowV2;
}

export interface WorkflowCursor {
  createdAt: Date;
  id: string;
}

export interface ListWorkflowsInput {
  ownerId: string;
  cursor?: WorkflowCursor;
  take: number;
}

export interface UpdateWorkflowRecord {
  id: string;
  ownerId: string;
  revision: number;
  changes: {
    name?: string;
    description?: string;
    definition?: WorkflowV2;
  };
}

/**
 * 工作流持久化端口始终显式接收 ownerId。
 * `findOwnedById` 是历史/冲突分类专用内部能力，不代表公开详情可以读取归档记录。
 */
export interface WorkflowRepository {
  create(input: CreateWorkflowRecord): Promise<WorkflowRecord>;
  listActive(input: ListWorkflowsInput): Promise<WorkflowRecord[]>;
  findActiveById(ownerId: string, id: string): Promise<WorkflowRecord | null>;
  findOwnedById(ownerId: string, id: string): Promise<WorkflowRecord | null>;
  updateActiveAtRevision(
    input: UpdateWorkflowRecord,
  ): Promise<WorkflowRecord | null>;
  archiveActive(
    ownerId: string,
    id: string,
    archivedAt: Date,
  ): Promise<boolean>;
}

export const WORKFLOW_REPOSITORY = Symbol("WORKFLOW_REPOSITORY");
