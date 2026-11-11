import type { NodeRunResponse, WorkflowNodeV2 } from "@aiflow/contracts";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type HandleType,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect } from "react";
import { nodeAppearance } from "./node-appearance";

/** 画布端口的协议标识及连接方向。 */
export interface StudioPort {
  nodeId: string;
  handleId: string;
  type: HandleType;
}

export type StudioNode = Node<
  {
    node: WorkflowNodeV2;
    outputPorts: string[];
    status?: NodeRunResponse["status"];
    activePort: StudioPort | null;
    onActivatePort: (port: StudioPort, pointerClick: boolean) => void;
  },
  "workflow"
>;

const statusLabels: Record<NodeRunResponse["status"], string> = {
  PENDING: "待执行",
  RUNNING: "运行中",
  SUCCEEDED: "已成功",
  FAILED: "失败",
  SKIPPED: "已跳过",
  CANCELLED: "已取消",
};

const portLabels: Record<string, string> = {
  true: "为真",
  false: "为假",
};

/** 端口 ID 直接使用协议值，显示名称不参与连线。 */
export function NodeCard({ id, data, selected }: NodeProps<StudioNode>) {
  const { node, outputPorts, status, activePort, onActivatePort } = data;
  const appearance = nodeAppearance[node.type];
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = JSON.stringify(outputPorts);

  // 意图配置可增删端口，端口行或状态变化后重新测量连线位置。
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, portSignature, status, updateNodeInternals]);

  function renderPort(handleId: string, type: HandleType, label: string) {
    const port = { nodeId: id, handleId, type };
    const pressed =
      activePort?.handleId === handleId && activePort.type === type;

    // Handle 保留拖拽命中区域，点击和键盘激活共用画布的连线命令。
    return (
      <Handle
        className="studio-handle"
        id={handleId}
        type={type}
        position={type === "target" ? Position.Left : Position.Right}
        role="button"
        tabIndex={0}
        aria-label={`${appearance.label} ${id} ${label}`}
        aria-pressed={pressed}
        onClick={(event) => {
          event.stopPropagation();
          onActivatePort(port, event.detail > 0);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) onActivatePort(port, false);
        }}
      />
    );
  }

  return (
    <div className="studio-node" data-type={node.type} data-selected={selected}>
      {node.type !== "start" && renderPort("input", "target", "输入")}
      <div className="studio-node-heading">
        <span className="studio-node-icon" aria-hidden="true">
          {appearance.icon}
        </span>
        <div className="studio-node-title">
          <strong>{appearance.label}</strong>
          <span>{id}</span>
        </div>
      </div>
      {status && (
        <span className="studio-node-status" data-status={status}>
          {statusLabels[status]}
        </span>
      )}
      {node.type !== "intent" &&
      outputPorts.length === 1 &&
      outputPorts[0] === "output"
        ? renderPort("output", "source", "输出")
        : outputPorts.map((port) => {
            const label = node.type === "condition" ? portLabels[port] : port;
            return (
              <div className="studio-node-port" key={port}>
                {label}
                {renderPort(port, "source", "输出 " + label)}
              </div>
            );
          })}
    </div>
  );
}
