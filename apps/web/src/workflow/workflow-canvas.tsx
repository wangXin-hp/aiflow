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
  type ReactFlowInstance,
  type ReactFlowProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { NodeCard, type StudioNode, type StudioPort } from "./node-card";
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
const invalidPortsMessage = "无法连接这两个节点的端口";
type FlowProps = ReactFlowProps<StudioNode, Edge>;

/** 页面持有 V2 草稿与节点选择，画布只提交操作产生的新草稿。 */
export interface WorkflowCanvasProps {
  definition: WorkflowV2;
  onChange: (definition: WorkflowV2) => void;
  onSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  /** 每次问题定位传入一个新对象，可在用户平移后再次定位同一节点。 */
  focusRequest?: { nodeId: string };
  nodeStatuses?: Readonly<Partial<Record<string, NodeRunResponse["status"]>>>;
}

function canDelete(node: WorkflowNodeV2) {
  return node.type !== "start" && node.type !== "end";
}

function applyConnection(definition: WorkflowV2, connection: Connection) {
  if (connection.sourceHandle === null || connection.targetHandle !== "input") {
    throw new Error(invalidPortsMessage);
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
  focusRequest,
  nodeStatuses,
}: WorkflowCanvasProps) {
  const [flowInstance, setFlowInstance] =
    useState<ReactFlowInstance<StudioNode, Edge>>();
  const [connectionError, setConnectionError] = useState("");
  const [pendingPort, setPendingPort] = useState<StudioPort | null>(null);
  const draggedPort = useRef(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  useEffect(() => {
    if (!flowInstance || !focusRequest) return;
    const zoom = flowInstance.getZoom();
    // 单节点适应视图以其测量边界为中心，固定缩放级别只移动视口。
    void flowInstance.fitView({
      nodes: [{ id: focusRequest.nodeId }],
      minZoom: zoom,
      maxZoom: zoom,
      duration: 240,
    });
  }, [flowInstance, focusRequest]);
  const elements = useMemo(() => toFlowElements(definition), [definition]);
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
          error instanceof Error ? error.message : invalidPortsMessage,
        );
      }
    },
    [definition, onChange],
  );
  const cancelConnection = useCallback(() => {
    setPendingPort(null);
    setConnectionError("");
  }, []);
  const handleDragConnectionStart = useCallback(() => {
    draggedPort.current = true;
    cancelConnection();
  }, [cancelConnection]);
  const handleDragConnectionEnd = useCallback<
    NonNullable<FlowProps["onConnectEnd"]>
  >((_, connection) => {
    // 严格模式会拦截同方向端口，空白处松开则只是取消。
    if (connection.isValid !== true) {
      setConnectionError(connection.toHandle ? invalidPortsMessage : "");
    }
  }, []);
  const handlePortActivation = useCallback(
    (port: StudioPort, pointerClick: boolean) => {
      // 拖回起始端口松开时浏览器可能随后派发 click。
      if (pointerClick && draggedPort.current) return;
      if (!pendingPort) {
        setPendingPort(port);
        setConnectionError("");
        return;
      }
      setPendingPort(null);
      if (pendingPort.type === port.type) {
        const samePort =
          pendingPort.nodeId === port.nodeId &&
          pendingPort.handleId === port.handleId;
        setConnectionError(samePort ? "" : invalidPortsMessage);
        return;
      }
      const source = port.type === "source" ? port : pendingPort;
      const target = port.type === "target" ? port : pendingPort;
      handleConnect({
        source: source.nodeId,
        sourceHandle: source.handleId,
        target: target.nodeId,
        targetHandle: target.handleId,
      });
    },
    [handleConnect, pendingPort],
  );
  const nodes = useMemo<StudioNode[]>(
    () =>
      elements.nodes.map((node) => ({
        ...node,
        type: "workflow",
        selected: node.id === selectedNodeId,
        deletable: canDelete(node.data.node),
        ariaLabel: nodeAppearance[node.type].label + " " + node.id,
        data: {
          ...node.data,
          // 节点 ID 来自工作流定义，画布只展示实际收到的状态。
          status:
            nodeStatuses && Object.hasOwn(nodeStatuses, node.id)
              ? nodeStatuses[node.id]
              : undefined,
          activePort: pendingPort?.nodeId === node.id ? pendingPort : null,
          onActivatePort: handlePortActivation,
        },
      })),
    [
      elements.nodes,
      selectedNodeId,
      nodeStatuses,
      pendingPort,
      handlePortActivation,
    ],
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
      <div
        className="studio-canvas"
        onPointerDownCapture={() => {
          draggedPort.current = false;
        }}
        onKeyDownCapture={(event) => {
          if (event.key === "Escape" && pendingPort) {
            event.stopPropagation();
            cancelConnection();
          }
        }}
      >
        <ReactFlow<StudioNode, Edge>
          aria-label="工作流画布"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onInit={setFlowInstance}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={handleConnect}
          onDelete={handleDelete}
          onConnectStart={handleDragConnectionStart}
          onConnectEnd={handleDragConnectionEnd}
          connectOnClick={false}
          onPaneClick={cancelConnection}
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
        {pendingPort && (
          <p className="studio-connection-hint" role="status">
            {pendingPort.type === "source" ? "选择输入端口" : "选择输出端口"}
            ，按 Esc 取消连线
          </p>
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
