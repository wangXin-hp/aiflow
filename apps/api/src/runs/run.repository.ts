import type { NodeRun, WorkflowRun } from "../generated/prisma/client.js";
import type { WorkflowV2, JsonObject } from "@aiflow/contracts";
import type { RunEventWriter } from "./run-event-writer.js";

export interface QueueRunInput {
  id: string;
  ownerId: string;
  workflowId: string;
  workflowRevision: number;
  definitionSnapshot: WorkflowV2;
  input: JsonObject;
  nodeRows: Array<{ nodeId: string; nodeType: string }>;
  eventWriter: RunEventWriter;
}

/** 所有运行读取显式限定 owner；queued 事件和节点创建属于同一个数据库事务。 */
export interface RunRepository {
  createQueued(input: QueueRunInput): Promise<WorkflowRun | null>;
  findOwned(
    ownerId: string,
    runId: string,
  ): Promise<(WorkflowRun & { nodes: NodeRun[] }) | null>;
  listOwned(
    ownerId: string,
    take: number,
    cursor?: { createdAt: Date; id: string },
  ): Promise<WorkflowRun[]>;
}

export const RUN_REPOSITORY = Symbol("RUN_REPOSITORY");
