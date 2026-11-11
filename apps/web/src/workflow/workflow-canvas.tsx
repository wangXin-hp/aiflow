import type {
  NodeRunResponse,
  WorkflowNodeV2,
  WorkflowV2,
} from "@aiflow/contracts";
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type ReactFlowProps,
} from "@xyflow/react";
import { useCallback, useMemo, useState } from "react";
import "@xyflow/react/dist/style.css";
import {
  addNode,
  connectNodes,
  disconnectEdge,
  moveNode,
  removeNode,
  toFlowElements,
} from "./graph";
import { nodeAppearance } from "./node-appearance";
import { NodeCard, type StudioNode } from "./node-card";
import "./studio.css";

type AddableNodeType = Exclude<WorkflowNodeV2["type"], "start" | "end">;
const addableTypes = [
  "transform",
  "condition",
  "llm",
  "http",
  "knowledge",
  "intent",
] satisfies AddableNodeType[];
const nodeTypes = { workflow: NodeCard };
type FlowProps = ReactFlowProps<StudioNode, Edge>;

/** 页面持有 V2 草稿与节点选择，画布只提交操作产生的新草稿。 */
export interface WorkflowCanvasProps {
  definition: WorkflowV2;
  onChange: (definition: WorkflowV2) => void;
  onSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  nodeStatuses?: Readonly<Partial<Record<string, NodeRunResponse["status"]>>>;
}

function canDelete(node: WorkflowNodeV2) {
  return node.type !== "start" && node.type !== "end";
}

function applyConnection(definition: WorkflowV2, connection: Connection) {
  if (connection.sourceHandle === null || connection.targetHandle !== "input") {
    throw new Error("无法连接这两个节点的端口");
  }
  return connectNodes(definition, {
    source: connection.source,
    sourcePort: connection.sourceHandle,
    target: connection.target,
  });
}

/** 将画布交互映射为图命令，视口、边选择及反馈只保留在画布。 */
export function WorkflowCanvas({
  definition,
  onChange,
  onSelect,
  selectedNodeId,
  nodeStatuses,
}: WorkflowCanvasProps) {
  const [connectionError, setConnectionError] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const elements = useMemo(() => toFlowElements(definition), [definition]);
  const nodes = useMemo<StudioNode[]>(
    () =>
      elements.nodes.map((node) => ({
        ...node,
        type: "workflow",
        selected: node.id === selectedNodeId,
        deletable: canDelete(node.data.node),
        ariaLabel: nodeAppearance[node.type].label + " " + node.id,
        data: { ...node.data, status: nodeStatuses?.[node.id] },
      })),
    [elements.nodes, selectedNodeId, nodeStatuses],
  );
  const edges = useMemo(
    () =>
      elements.edges.map((edge) => ({
        ...edge,
        selected: edge.id === selectedEdgeId,
      })),
    [elements.edges, selectedEdgeId],
  );

  const handleNodesChange = useCallback<
    NonNullable<FlowProps["onNodesChange"]>
  >(
    (changes) => {
      let next = definition;
      let selection = selectedNodeId;
      for (const change of changes) {
        if (change.type === "select") {
          if (change.selected) selection = change.id;
          else if (selection === change.id) selection = null;
          continue;
        }
        // 键盘移动和拖拽使用同一入口，忽略测量事件及无坐标变化的拖拽通知。
        if (change.type !== "position" || !change.position) continue;
        const current = next.nodes.find(({ id }) => id === change.id);
        if (
          current &&
          (current.position.x !== change.position.x ||
            current.position.y !== change.position.y)
        ) {
          next = moveNode(next, change.id, change.position);
        }
      }
      if (next !== definition) onChange(next);
      if (selection !== selectedNodeId) onSelect(selection);
    },
    [definition, onChange, onSelect, selectedNodeId],
  );
  const handleEdgesChange = useCallback<
    NonNullable<FlowProps["onEdgesChange"]>
  >((changes) => {
    for (const change of changes) {
      if (change.type === "select") {
        setSelectedEdgeId((id) =>
          change.selected ? change.id : id === change.id ? null : id,
        );
      }
    }
  }, []);
  const handleConnect = useCallback(
    (connection: Connection) => {
      try {
        onChange(applyConnection(definition, connection));
        setConnectionError("");
      } catch (error) {
        setConnectionError(
          error instanceof Error ? error.message : "无法连接这两个节点的端口",
        );
      }
    },
    [definition, onChange],
  );
  const handleDelete = useCallback<NonNullable<FlowProps["onDelete"]>>(
    ({ nodes: deletedNodes, edges: deletedEdges }) => {
      let next = definition;
      for (const { id, data } of deletedNodes) {
        if (canDelete(data.node)) next = removeNode(next, id);
      }
      for (const { id } of deletedEdges) {
        if (next.edges.some((edge) => edge.id === id)) {
          next = disconnectEdge(next, id);
        }
      }
      if (next !== definition) onChange(next);
      if (
        selectedNodeId &&
        !next.nodes.some(({ id }) => id === selectedNodeId)
      ) {
        onSelect(null);
      }
    },
    [definition, onChange, onSelect, selectedNodeId],
  );
  const clearConnectionError = useCallback(() => setConnectionError(""), []);

  function addFromLibrary(type: AddableNodeType) {
    // 模板节点在首行，新增节点依次放入其下方的空位。
    const position = { x: 0, y: 144 };
    while (
      definition.nodes.some(
        (node) =>
          Math.abs(node.position.x - position.x) < 208 &&
          Math.abs(node.position.y - position.y) < 112,
      )
    ) {
      position.x += 232;
    }
    const next = addNode(definition, type, position);
    onChange(next);
    onSelect(next.nodes.at(-1)!.id);
  }

  const selectedNode = nodes.find(({ id }) => id === selectedNodeId);

  return (
    <section className="studio-workspace" aria-label="工作流编排">
      <aside className="studio-library" aria-label="节点库">
        <h2>节点库</h2>
        <ul>
          {addableTypes.map((type) => (
            <li key={type}>
              <button
                type="button"
                data-type={type}
                onClick={() => addFromLibrary(type)}
              >
                <span className="studio-node-icon" aria-hidden="true">
                  {nodeAppearance[type].icon}
                </span>
                {nodeAppearance[type].label}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="studio-canvas">
        <ReactFlow<StudioNode, Edge>
          aria-label="工作流画布"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onDelete={handleDelete}
          onPaneClick={clearConnectionError}
          multiSelectionKeyCode={null}
          edgesReconnectable={false}
          deleteKeyCode={["Backspace", "Delete"]}
          minZoom={0.2}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
          ariaLabelConfig={{
            "controls.ariaLabel": "画布缩放",
            "controls.zoomIn.ariaLabel": "放大",
            "controls.zoomOut.ariaLabel": "缩小",
            "controls.fitView.ariaLabel": "适应视图",
            "minimap.ariaLabel": "工作流小地图",
          }}
        >
          <Background gap={18} size={1} color="#bac4d5" />
          <Controls className="studio-controls" showInteractive={false} />
          <MiniMap className="studio-minimap" pannable zoomable />
        </ReactFlow>
        {selectedNode?.deletable && (
          <button
            type="button"
            className="studio-delete"
            onClick={() => handleDelete({ nodes: [selectedNode], edges: [] })}
          >
            删除节点
          </button>
        )}
        {connectionError && (
          <p className="studio-connection-error" role="alert">
            {connectionError}
          </p>
        )}
      </div>
    </section>
  );
}
