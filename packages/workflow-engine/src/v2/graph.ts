import {
  workflowV2Schema,
  type WorkflowV2,
  type WorkflowNodeV2,
} from "@aiflow/contracts";
import type { ValidationIssue, ValidationResult } from "../validation.js";

/** 图校验同时返回拓扑顺序，使运行消费同一份解析快照。 */
export function prepare(input: unknown): {
  validation: ValidationResult;
  graph?: WorkflowV2;
  order?: string[];
} {
  const parsed = workflowV2Schema.safeParse(input);
  if (!parsed.success)
    return {
      validation: {
        valid: false,
        errors: parsed.error.issues.map((issue) => ({
          code: "invalid_definition",
          message: `${issue.path.join(".") || "definition"}: ${issue.message}`,
        })),
      },
    };
  // 协议解析时已复制字面量，异步运行期间不会受调用方修改影响。
  const graph = parsed.data;
  const errors: ValidationIssue[] = [];
  const issue = (code: string, message: string) => {
    errors.push({ code, message });
  };
  const nodes = new Map<string, WorkflowNodeV2>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) issue("duplicate_node_id", node.id);
    else nodes.set(node.id, node);
  }
  const starts = graph.nodes.filter((n) => n.type === "start");
  const ends = graph.nodes.filter((n) => n.type === "end");
  if (starts.length !== 1)
    issue("start_count", "Exactly one start node is required");
  if (ends.length !== 1) issue("end_count", "Exactly one end node is required");
  const incoming = new Map<string, string[]>(),
    outgoing = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    incoming.set(id, []);
    outgoing.set(id, []);
  }
  const ids = new Set<string>(),
    connections = new Set<string>();
  for (const e of graph.edges) {
    if (ids.has(e.id)) issue("duplicate_edge_id", e.id);
    ids.add(e.id);
    const key = JSON.stringify([
      e.source,
      e.sourcePort,
      e.target,
      e.targetPort,
    ]);
    if (connections.has(key)) issue("duplicate_connection", e.id);
    connections.add(key);
    const source = nodes.get(e.source),
      target = nodes.get(e.target);
    if (!source || !target) {
      issue("unknown_endpoint", e.id);
      continue;
    }
    if (
      target.type === "start" ||
      source.type === "end" ||
      (source.type === "condition"
        ? !["true", "false"].includes(e.sourcePort)
        : source.type === "intent"
          ? !source.config.intents.some((intent) => intent.id === e.sourcePort)
          : e.sourcePort !== "output")
    )
      issue("invalid_direction", e.id);
    outgoing.get(e.source)!.push(e.target);
    incoming.get(e.target)!.push(e.source);
  }
  for (const node of nodes.values()) {
    // 已知的默认值应在运行前与字段类型保持一致。
    if (node.type === "start" && node.config) {
      for (const field of node.config.inputs) {
        const value = field.defaultValue;
        if (value === undefined) continue;
        const valid =
          field.type === "array"
            ? Array.isArray(value)
            : field.type === "object"
              ? value !== null &&
                typeof value === "object" &&
                !Array.isArray(value)
              : typeof value === field.type;
        if (!valid) issue("invalid_default", `${node.id}:${field.name}`);
      }
    }
    if (node.type === "condition" || node.type === "intent") {
      const ports =
        node.type === "condition"
          ? ["true", "false"]
          : node.config.intents.map((intent) => intent.id);
      for (const port of ports)
        if (
          !graph.edges.some(
            (e) => e.source === node.id && e.sourcePort === port,
          )
        )
          issue("missing_branch", `${node.id}:${port}`);
    }
  }
  const degrees = new Map(
    [...incoming].map(([key, list]) => [key, list.length]),
  );
  const order = [...degrees].filter(([, n]) => n === 0).map(([key]) => key);
  for (let i = 0; i < order.length; i++)
    for (const target of outgoing.get(order[i]!) ?? []) {
      const n = degrees.get(target)! - 1;
      degrees.set(target, n);
      if (n === 0) order.push(target);
    }
  if (order.length !== nodes.size)
    issue("cycle", "Graph must not contain a cycle");
  const reachable = (from: string, adjacency: Map<string, string[]>) => {
    const seen = new Set<string>(),
      stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(adjacency.get(id) ?? []));
    }
    return seen;
  };
  if (starts.length === 1 && ends.length === 1) {
    const forward = reachable(starts[0]!.id, outgoing),
      backward = reachable(ends[0]!.id, incoming);
    for (const id of nodes.keys())
      if (!forward.has(id) || !backward.has(id)) issue("unreachable_node", id);
  }
  // 支配关系采用保守策略：被引用节点必须位于从开始到消费节点的每条路径上。
  // 这会拒绝某些无条件并行路径上的安全引用，但可避免必填引用指向被跳过的分支。
  const dominators = new Map<string, Set<string>>();
  if (starts.length === 1 && order.length === nodes.size) {
    for (const id of order) {
      const parents = incoming.get(id) ?? [];
      const first = parents[0];
      const common = first
        ? new Set(dominators.get(first) ?? [])
        : new Set<string>();
      for (const parent of parents.slice(1))
        for (const entry of common)
          if (!dominators.get(parent)?.has(entry)) common.delete(entry);
      common.add(id);
      dominators.set(id, common);
    }
  }
  // 引用必须指向严格上游及必经节点；字段是否存在仍在运行时检查。
  for (const node of nodes.values()) {
    const bindings =
      node.type === "condition"
        ? [node.config.value]
        : node.type !== "start"
          ? Object.values(node.config.values)
          : [];
    const upstream = reachable(node.id, incoming);
    upstream.delete(node.id);
    const references = bindings.flatMap((binding) =>
      binding.kind === "template"
        ? binding.parts.filter((part) => typeof part !== "string")
        : binding.kind === "reference"
          ? [binding]
          : [],
    );
    for (const binding of references) {
      if (!upstream.has(binding.nodeId))
        issue(
          "invalid_reference",
          `${node.id}:${binding.nodeId}.${binding.key}`,
        );
      else if (
        binding.fallback === undefined &&
        dominators.has(node.id) &&
        !dominators.get(node.id)!.has(binding.nodeId)
      )
        issue(
          "unsafe_reference",
          `${node.id}:${binding.nodeId}.${binding.key}`,
        );
    }
  }
  return { validation: { valid: errors.length === 0, errors }, graph, order };
}

/** 只读验证完整可执行图；草稿可以单独使用 workflowV2Schema。 */
export function validateWorkflowV2(input: unknown): ValidationResult {
  return prepare(input).validation;
}
