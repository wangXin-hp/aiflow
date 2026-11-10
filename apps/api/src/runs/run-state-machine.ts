import type {
  NodeRunStatus,
  WorkflowRunStatus,
} from "../generated/prisma/client.js";

const runTransitions: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> =
  {
    QUEUED: ["RUNNING", "CANCELLING", "CANCELLED", "INTERRUPTED"],
    RUNNING: ["CANCELLING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"],
    CANCELLING: ["CANCELLED", "INTERRUPTED"],
    SUCCEEDED: [],
    FAILED: [],
    CANCELLED: [],
    INTERRUPTED: [],
  };
const nodeTransitions: Record<NodeRunStatus, readonly NodeRunStatus[]> = {
  PENDING: ["RUNNING", "SKIPPED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  SKIPPED: [],
  CANCELLED: [],
};

/** 纯状态规则用于拒绝倒退；数据库条件更新还需验证预期源状态。 */
export function canTransitionRun(
  from: WorkflowRunStatus,
  to: WorkflowRunStatus,
): boolean {
  return runTransitions[from].includes(to);
}

/** DAG 节点首期最多执行一次，终态不得再次迁移。 */
export function canTransitionNode(
  from: NodeRunStatus,
  to: NodeRunStatus,
): boolean {
  return nodeTransitions[from].includes(to);
}

/** 仓储条件更新从同一迁移表推导来源，避免纯规则与 SQL 写入规则分叉。 */
export function nodeTransitionSources(to: NodeRunStatus): NodeRunStatus[] {
  return (Object.keys(nodeTransitions) as NodeRunStatus[]).filter((from) =>
    canTransitionNode(from, to),
  );
}
