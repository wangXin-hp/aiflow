import {
  UpdateWorkflowRequestSchema,
  workflowV2Schema,
  type WorkflowNodeV2,
  type WorkflowResponse,
  type WorkflowV2,
} from "@aiflow/contracts";
import { useRef, useState } from "react";
import { ApiClientError } from "../auth/auth-api";
import { findDanglingReferences } from "./graph";
import { workflowApi } from "./workflow-api";

type DraftIssue = {
  message: string;
  nodeId?: string;
  reauthenticate?: boolean;
};
type AdvancedConfig = { text: string; error?: string };
type DraftState = {
  draft: WorkflowResponse;
  version: number;
  savedVersion: number;
  saving: boolean;
  conflict: boolean;
  issues: DraftIssue[];
  advanced: ReadonlyMap<string, AdvancedConfig>;
};

function graphIssue(
  code: unknown,
  message: string,
  definition: WorkflowV2,
): DraftIssue {
  // 图引擎用稳定的错误代码标识详情，消息中的节点或边 ID 可用于定位。
  if (code === "unreachable_node") {
    return {
      message: `节点 ${message} 不在从开始到结束的路径上`,
      nodeId: message,
    };
  }
  if (code === "duplicate_node_id")
    return { message: `节点 ID 重复：${message}`, nodeId: message };
  if (
    code === "unknown_endpoint" ||
    code === "invalid_direction" ||
    code === "duplicate_connection" ||
    code === "duplicate_edge_id"
  ) {
    const edge = definition.edges.find(({ id }) => id === message);
    const nodeId = [edge?.source, edge?.target].find((id) =>
      definition.nodes.some((node) => node.id === id),
    );
    return { message: `连线 ${message} 无效（${code}）`, nodeId };
  }
  if (
    code === "missing_branch" ||
    code === "invalid_default" ||
    code === "invalid_reference" ||
    code === "unsafe_reference"
  ) {
    // 节点 ID 本身可能包含冒号，取最长的现存节点前缀。
    const nodeId = definition.nodes.reduce<string | undefined>(
      (found, { id }) =>
        message.startsWith(`${id}:`) && (!found || id.length > found.length)
          ? id
          : found,
      undefined,
    );
    const labels = {
      missing_branch: "分支缺少连线",
      invalid_default: "输入默认值与类型不匹配",
      invalid_reference: "绑定来源不是上游节点",
      unsafe_reference: "引用可能被跳过，请配置回退值",
    };
    return { message: `${labels[code]}（${message}）`, nodeId };
  }
  return { message };
}

function serverIssues(error: unknown, definition: WorkflowV2): DraftIssue[] {
  if (!(error instanceof ApiClientError))
    return [{ message: "保存失败，请稍后重试" }];
  if (error.status === 409)
    return [
      { message: "服务器上已有更新。本地改动已保留，可重新载入服务器版本。" },
    ];
  if (error.status === 401) {
    return [
      {
        message: "会话需要恢复。本地改动已保留，恢复会话后可重新保存。",
        reauthenticate: true,
      },
    ];
  }
  const issues: DraftIssue[] = [{ message: error.message }];
  if (Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (
        detail &&
        typeof detail === "object" &&
        "message" in detail &&
        typeof detail.message === "string"
      ) {
        issues.push(
          error.code === "WORKFLOW_GRAPH_INVALID"
            ? graphIssue(
                "code" in detail ? detail.code : undefined,
                detail.message,
                definition,
              )
            : { message: detail.message },
        );
      }
    }
  }
  return issues;
}

/** 草稿按本地编辑序号保存。只有该次请求覆盖当前序号时才返回 true，可安全启动调试。 */
export function useWorkflowDraft(initial: WorkflowResponse) {
  const [state, setState] = useState<DraftState>(() => ({
    draft: initial,
    version: 0,
    savedVersion: 0,
    saving: false,
    conflict: false,
    issues: [],
    advanced: new Map(),
  }));
  const latest = useRef(state);

  function publish(next: DraftState) {
    // 事件与异步响应读取同一快照，避免 React 批处理期间重复保存或漏掉编辑。
    latest.current = next;
    setState(next);
  }

  function edit(draft: WorkflowResponse, advanced = latest.current.advanced) {
    const current = latest.current;
    publish({
      ...current,
      draft,
      advanced,
      version: current.version + 1,
      issues: current.conflict
        ? current.issues
        : current.issues.filter(({ reauthenticate }) => reauthenticate),
    });
  }

  function setName(name: string) {
    edit({ ...latest.current.draft, name });
  }

  function setDefinition(definition: WorkflowV2) {
    const { draft, advanced } = latest.current;
    if (advanced.size === 0) {
      edit({ ...draft, definition });
      return;
    }
    const present = new Set(definition.nodes.map(({ id }) => id));
    edit(
      { ...draft, definition },
      new Map([...advanced].filter(([id]) => present.has(id))),
    );
  }

  function setNode(node: WorkflowNodeV2) {
    const { draft, advanced } = latest.current;
    const next = new Map(advanced);
    next.delete(node.id);
    edit(
      {
        ...draft,
        definition: {
          ...draft.definition,
          nodes: draft.definition.nodes.map((current) =>
            current.id === node.id
              ? { ...node, position: current.position }
              : current,
          ),
        },
      },
      next,
    );
  }

  function setAdvanced(nodeId: string, text: string) {
    const { draft, advanced } = latest.current;
    const node = draft.definition.nodes.find(({ id }) => id === nodeId);
    if (!node) return;
    const next = new Map(advanced);
    // 保留无法解析的输入，切换节点后仍可修正；画布继续使用最后一个合法配置。
    let definition = draft.definition;
    try {
      const config: unknown = JSON.parse(text);
      const result = workflowV2Schema.safeParse({
        schemaVersion: 2,
        nodes: [{ ...node, config }],
        edges: [],
      });
      if (!result.success)
        throw new Error(
          result.error.issues
            .map(({ path, message }) =>
              `${path.slice(2).join(".")} ${message}`.trim(),
            )
            .join("；"),
        );
      const updatedNode = result.data.nodes[0]!;
      definition = {
        ...definition,
        nodes: definition.nodes.map((current) =>
          current.id === nodeId ? updatedNode : current,
        ),
      };
      next.set(nodeId, { text });
    } catch (error) {
      next.set(nodeId, {
        text,
        error:
          error instanceof SyntaxError
            ? "请输入有效的 JSON"
            : error instanceof Error
              ? error.message
              : "节点配置无效",
      });
    }
    edit({ ...draft, definition }, next);
  }

  async function save(): Promise<boolean> {
    const submitted = latest.current;
    if (submitted.saving || submitted.conflict) return false;
    if (submitted.version === submitted.savedVersion) return true;
    const { id, revision, name, definition } = submitted.draft;
    const issues: DraftIssue[] = [];
    for (const [nodeId, config] of submitted.advanced) {
      if (config.error)
        issues.push({ nodeId, message: `节点 ${nodeId} 的高级配置无效` });
    }
    for (const { nodeId, sourceNodeId } of findDanglingReferences(definition)) {
      issues.push({
        nodeId,
        message: `节点 ${nodeId} 引用了已不存在的节点 ${sourceNodeId}`,
      });
    }
    const request = UpdateWorkflowRequestSchema.safeParse({
      revision,
      name,
      definition,
    });
    if (!request.success) {
      for (const { path, message } of request.error.issues) {
        const nodeId =
          path[0] === "definition" &&
          path[1] === "nodes" &&
          typeof path[2] === "number"
            ? definition.nodes[path[2]]?.id
            : undefined;
        issues.push({
          nodeId,
          message:
            path[0] === "name"
              ? "工作流名称须为 1 至 100 个字符"
              : `${nodeId ?? "工作流"}：${path.slice(nodeId ? 3 : 0).join(".")} ${message}`,
        });
      }
      publish({ ...submitted, issues });
      return false;
    }
    if (issues.length > 0) {
      publish({ ...submitted, issues });
      return false;
    }

    publish({ ...submitted, saving: true, issues: [] });
    try {
      const saved = await workflowApi.update(id, request.data);
      const current = latest.current;
      const covered = current.version === submitted.version;
      publish({
        ...current,
        // 只更新持久化版本，迟到的响应不能覆盖期间产生的新编辑。
        draft: covered
          ? saved
          : {
              ...current.draft,
              revision: saved.revision,
              updatedAt: saved.updatedAt,
            },
        savedVersion: submitted.version,
        saving: false,
      });
      return covered;
    } catch (error) {
      const current = latest.current;
      const status = error instanceof ApiClientError ? error.status : undefined;
      // 401 交给用户恢复会话，认证路由重载会卸载编辑器。400 仅适用于提交时的草稿。
      const obsoleteValidation =
        status === 400 && current.version !== submitted.version;
      publish({
        ...current,
        saving: false,
        conflict: status === 409,
        issues: obsoleteValidation
          ? current.issues
          : serverIssues(error, definition),
      });
      return false;
    }
  }

  return {
    draft: state.draft,
    dirty: state.version !== state.savedVersion,
    saving: state.saving,
    conflict: state.conflict,
    issues: state.issues,
    advanced: state.advanced,
    setName,
    setDefinition,
    setNode,
    setAdvanced,
    save,
  };
}
