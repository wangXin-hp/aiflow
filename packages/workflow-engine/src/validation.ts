import {
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from "@aiflow/contracts";

/** 单条校验问题；code 供调用方判断，message 用于说明具体原因。 */
export interface ValidationIssue {
  code: string;
  message: string;
}
/** 汇总结构校验与图约束校验的结果，不在校验失败时抛异常。 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

/**
 * 校验来自存储或外部调用方的工作流定义。
 * 先校验协议结构，再检查节点与连接构成的图；失败时返回问题列表。
 */
export function validateWorkflow(input: unknown): ValidationResult {
  return parseAndValidateWorkflow(input).validation;
}

/**
 * 内部共用入口：仅解析一次，返回通过结构解析的快照和图校验结果。
 * 执行时必须消费同一快照，避免原始对象在校验后变化导致校验与执行不一致。
 */
export function parseAndValidateWorkflow(input: unknown): {
  validation: ValidationResult;
  graph?: WorkflowDefinition;
} {
  const parsed = workflowDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      validation: {
        valid: false,
        errors: parsed.error.issues.map((issue) => ({
          code: "invalid_definition",
          message: `${issue.path.join(".") || "definition"}: ${issue.message}`,
        })),
      },
    };
  }
  return { validation: validateGraph(parsed.data), graph: parsed.data };
}

/** 检查结构合法后的业务图约束；尽量汇总错误，便于调用方一次展示。 */
function validateGraph(graph: WorkflowDefinition): ValidationResult {
  const errors: ValidationIssue[] = [];
  const add = (code: string, message: string) => {
    errors.push({ code, message });
  };
  // 以节点 ID 建索引；重复 ID 保留首个节点，继续检查其余可识别的问题。
  const nodes = new Map<string, WorkflowDefinition["nodes"][number]>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id))
      add("duplicate_node_id", `Duplicate node ID: ${node.id}`);
    else nodes.set(node.id, node);
  }
  const starts = graph.nodes.filter((node) => node.type === "start");
  const ends = graph.nodes.filter((node) => node.type === "end");
  if (starts.length !== 1)
    add("start_count", "Exactly one start node is required");
  if (ends.length !== 1) add("end_count", "Exactly one end node is required");

  // 分别建立正向和反向邻接表，后续用于环检测和双向可达性检查。
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of nodes.keys()) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  const edgeIds = new Set<string>();
  const connections = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id))
      add("duplicate_edge_id", `Duplicate edge ID: ${edge.id}`);
    edgeIds.add(edge.id);
    // 使用端点及端口的组合判断重复连线，避免仅比较边 ID 漏掉重复连接。
    const connection = JSON.stringify([
      edge.source,
      edge.sourcePort,
      edge.target,
      edge.targetPort,
    ]);
    if (connections.has(connection))
      add("duplicate_connection", `Duplicate connection: ${edge.id}`);
    connections.add(connection);
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      add("unknown_endpoint", `Unknown endpoint: ${edge.id}`);
      continue;
    }
    if (source.type === "end" || target.type === "start")
      add("invalid_direction", `Invalid edge direction: ${edge.id}`);
    outgoing.get(edge.source)?.push(edge.target);
    incoming.get(edge.target)?.push(edge.source);
  }
  // Kahn 拓扑遍历：持续移除入度为零的节点；剩余节点表示图中存在环。
  const degrees = new Map(
    [...incoming].map(([id, sources]) => [id, sources.length]),
  );
  const queue = [...degrees]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id);
  let visited = 0;
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    visited++;
    for (const target of outgoing.get(id) ?? []) {
      const degree = degrees.get(target)! - 1;
      degrees.set(target, degree);
      if (degree === 0) queue.push(target);
    }
  }
  if (visited !== nodes.size) add("cycle", "Graph must not contain a cycle");
  // 迭代遍历避免长链图造成递归栈溢出；邻接表决定正向或反向搜索。
  function reachable(
    start: string,
    adjacency: Map<string, string[]>,
  ): Set<string> {
    const seen = new Set<string>();
    const pending = [start];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(adjacency.get(id) ?? []));
    }
    return seen;
  }
  if (starts.length === 1 && ends.length === 1) {
    // 节点既要从开始可达，也要能到达结束，才能属于有效执行路径。
    const forward = reachable(starts[0]!.id, outgoing);
    const backward = reachable(ends[0]!.id, incoming);
    for (const id of nodes.keys()) {
      if (!forward.has(id) || !backward.has(id))
        add("unreachable_node", `Node is not on a start-to-end path: ${id}`);
    }
  }
  return { valid: errors.length === 0, errors };
}
