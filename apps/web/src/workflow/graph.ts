import type {
  ValueBinding,
  WorkflowNodeV2,
  WorkflowV2,
} from "@aiflow/contracts";

type Position = WorkflowNodeV2["position"];
type Connection = Pick<
  WorkflowV2["edges"][number],
  "source" | "sourcePort" | "target"
>;

/** 每次创建独立的可执行草稿，确保创建接口的完整图校验能够通过。 */
export function createStarterDefinition(): WorkflowV2 {
  return {
    schemaVersion: 2,
    nodes: [
      { id: "start", type: "start", position: { x: 0, y: 0 } },
      {
        id: "end",
        type: "end",
        position: { x: 240, y: 0 },
        config: { values: {} },
      },
    ],
    edges: [
      {
        id: "start-end",
        source: "start",
        sourcePort: "output",
        target: "end",
        targetPort: "input",
      },
    ],
  };
}

function nextId(prefix: string, occupied: Set<string>): string {
  let index = 1;
  while (occupied.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function createNode(
  type: Exclude<WorkflowNodeV2["type"], "start" | "end">,
  id: string,
  position: Position,
): WorkflowNodeV2 {
  const base = { id, position: fromFlowPosition(position) };
  // 占位值满足结构协议，模型、知识库及输入仍由用户在配置面板中设置。
  switch (type) {
    case "transform":
      return { ...base, type, config: { values: {} } };
    case "condition":
      return {
        ...base,
        type,
        config: { value: { kind: "literal", value: false } },
      };
    case "llm":
      return { ...base, type, config: { model: "model", values: {} } };
    case "http":
      return { ...base, type, config: { method: "GET", values: {} } };
    case "knowledge":
      return {
        ...base,
        type,
        config: {
          knowledgeBaseIds: ["knowledge-base"],
          retrievalMode: "vector",
          topK: 5,
          values: {},
        },
      };
    case "intent":
      return {
        ...base,
        type,
        config: {
          model: "model",
          intents: [{ id: "default", description: "" }],
          values: {},
        },
      };
  }
}

/** 添加可编辑节点，保留尚未修复的引用 ID，避免误绑定到新节点。 */
export function addNode(
  definition: WorkflowV2,
  type: WorkflowNodeV2["type"],
  position: Position,
): WorkflowV2 {
  if (type === "start" || type === "end") {
    throw new Error("开始和结束节点由模板提供");
  }
  const occupied = new Set(definition.nodes.map(({ id }) => id));
  for (const { sourceNodeId } of findDanglingReferences(definition)) {
    occupied.add(sourceNodeId);
  }
  const node = createNode(type, nextId(type, occupied), position);
  return { ...definition, nodes: [...definition.nodes, node] };
}

/** 只更新目标节点的协议坐标，保留历史草稿快照。 */
export function moveNode(
  definition: WorkflowV2,
  nodeId: string,
  position: Position,
): WorkflowV2 {
  return {
    ...definition,
    nodes: definition.nodes.map((node) =>
      node.id === nodeId
        ? { ...node, position: fromFlowPosition(position) }
        : node,
    ),
  };
}

/** 删除普通节点及关联边，保留其他节点的绑定以便用户修复。 */
export function removeNode(definition: WorkflowV2, nodeId: string): WorkflowV2 {
  const node = definition.nodes.find(({ id }) => id === nodeId);
  if (node?.type === "start" || node?.type === "end") {
    throw new Error("开始和结束节点不能删除");
  }
  return {
    ...definition,
    nodes: definition.nodes.filter(({ id }) => id !== nodeId),
    edges: definition.edges.filter(
      ({ source, target }) => source !== nodeId && target !== nodeId,
    ),
  };
}

/** 返回 V2 节点允许的输出端口 ID，用于画布渲染和连线检查。 */
export function getOutputPorts(node: WorkflowNodeV2): string[] {
  switch (node.type) {
    case "condition":
      return ["true", "false"];
    case "intent":
      return node.config.intents.map(({ id }) => id);
    case "end":
      return [];
    default:
      return ["output"];
  }
}

/** 拒绝无效端口、方向和重复连线；完整图语义由服务端校验。 */
export function connectNodes(
  definition: WorkflowV2,
  connection: Connection,
): WorkflowV2 {
  const { source, sourcePort, target } = connection;
  const sourceNode = definition.nodes.find(({ id }) => id === source);
  const targetNode = definition.nodes.find(({ id }) => id === target);
  if (
    !sourceNode ||
    !targetNode ||
    targetNode.type === "start" ||
    source === target ||
    !getOutputPorts(sourceNode).includes(sourcePort)
  ) {
    throw new Error("无法连接这两个节点的端口");
  }
  if (
    definition.edges.some(
      (edge) =>
        edge.source === source &&
        edge.sourcePort === sourcePort &&
        edge.target === target,
    )
  ) {
    throw new Error("这两个端口已连接");
  }
  const id = nextId("edge", new Set(definition.edges.map((edge) => edge.id)));
  return {
    ...definition,
    edges: [
      ...definition.edges,
      { id, source, sourcePort, target, targetPort: "input" },
    ],
  };
}

/** 移除指定边，保留其两端节点及配置。 */
export function disconnectEdge(
  definition: WorkflowV2,
  edgeId: string,
): WorkflowV2 {
  return {
    ...definition,
    edges: definition.edges.filter(({ id }) => id !== edgeId),
  };
}

function referencedNodeIds(binding: ValueBinding): string[] {
  switch (binding.kind) {
    case "reference":
      return [binding.nodeId];
    case "template":
      return binding.parts.flatMap((part) =>
        typeof part === "string" ? [] : [part.nodeId],
      );
    case "literal":
      return [];
  }
}

/** 定位来源节点已不存在的直接与模板引用，同一消费节点与来源只报告一次。 */
export function findDanglingReferences(
  definition: WorkflowV2,
): Array<{ nodeId: string; sourceNodeId: string }> {
  const existing = new Set(definition.nodes.map(({ id }) => id));
  return definition.nodes.flatMap((node) => {
    const bindings =
      node.type === "start"
        ? []
        : node.type === "condition"
          ? [node.config.value]
          : Object.values(node.config.values);
    const missing = new Set(
      bindings.flatMap(referencedNodeIds).filter((id) => !existing.has(id)),
    );
    return [...missing].map((sourceNodeId) => ({
      nodeId: node.id,
      sourceNodeId,
    }));
  });
}

/** 只保留协议坐标字段，隔离画布坐标对象。 */
export function fromFlowPosition({ x, y }: Position): Position {
  return { x, y };
}

/** 将协议节点、端口和边映射为画布所需字段。 */
export function toFlowElements(definition: WorkflowV2) {
  return {
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: fromFlowPosition(node.position),
      data: { node, outputPorts: getOutputPorts(node) },
    })),
    edges: definition.edges.map(
      ({ id, source, sourcePort, target, targetPort }) => ({
        id,
        source,
        sourceHandle: sourcePort,
        target,
        targetHandle: targetPort,
      }),
    ),
  };
}
