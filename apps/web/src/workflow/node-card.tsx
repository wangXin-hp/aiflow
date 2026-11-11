import type { NodeRunResponse, WorkflowNodeV2 } from "@aiflow/contracts";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { useEffect } from "react";
import { nodeAppearance } from "./node-appearance";

export type StudioNode = Node<
  {
    node: WorkflowNodeV2;
    outputPorts: string[];
    status?: NodeRunResponse["status"];
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
  const { node, outputPorts, status } = data;
  const appearance = nodeAppearance[node.type];
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = JSON.stringify(outputPorts);

  // 意图配置可增删端口，端口行或状态变化后重新测量连线位置。
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, portSignature, status, updateNodeInternals]);

  return (
    <div className="studio-node" data-type={node.type} data-selected={selected}>
      {node.type !== "start" && (
        <Handle
          className="studio-handle"
          id="input"
          type="target"
          position={Position.Left}
          aria-label="输入"
        />
      )}
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
      {outputPorts.length === 1 && outputPorts[0] === "output" ? (
        <Handle
          className="studio-handle"
          id="output"
          type="source"
          position={Position.Right}
          aria-label="输出"
        />
      ) : (
        outputPorts.map((port) => {
          const label = node.type === "condition" ? portLabels[port] : port;
          return (
            <div className="studio-node-port" key={port}>
              {label}
              <Handle
                className="studio-handle"
                id={port}
                type="source"
                position={Position.Right}
                aria-label={label}
              />
            </div>
          );
        })
      )}
    </div>
  );
}
