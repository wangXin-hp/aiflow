import type { WorkflowV2 } from "@aiflow/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactFlowProps } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import { createStarterDefinition } from "./graph";
import { type StudioNode } from "./node-card";
import { WorkflowCanvas } from "./workflow-canvas";

let flow: ReactFlowProps<StudioNode>;

// jsdom 无法测量画布坐标，通过画布库公开的回调模拟几何交互。
vi.mock("@xyflow/react", () => ({
  ReactFlow: (props: ReactFlowProps<StudioNode>) => {
    flow = props;
    return (
      <div>
        {props.nodes?.map((node) => {
          const Card = props.nodeTypes?.[node.type ?? ""];
          return (
            <div key={node.id}>
              <button
                type="button"
                onClick={() =>
                  props.onNodesChange?.([
                    { id: node.id, type: "select", selected: true },
                  ])
                }
              >
                选择{node.id === "start" ? "开始节点" : node.id}
              </button>
              {Card && (
                <Card
                  {...node}
                  data={node.data}
                  type={node.type ?? "workflow"}
                  selected={node.selected ?? false}
                  dragging={false}
                  draggable
                  selectable
                  deletable={node.deletable ?? true}
                  isConnectable
                  zIndex={0}
                  positionAbsoluteX={node.position.x}
                  positionAbsoluteY={node.position.y}
                />
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={(event) => {
            props.onNodesChange?.(
              (props.nodes ?? [])
                .filter((node) => node.selected)
                .map((node) => ({
                  id: node.id,
                  type: "select",
                  selected: false,
                })),
            );
            props.onPaneClick?.(event);
          }}
        >
          取消选择
        </button>
        <button
          type="button"
          onClick={() =>
            props.onConnect?.({
              source: "start",
              sourceHandle: "output",
              target: "end",
              targetHandle: "input",
            })
          }
        >
          验证连接
        </button>
        {props.children}
      </div>
    );
  },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Position: { Left: "left", Right: "right" },
  Handle: () => null,
  useUpdateNodeInternals: () => () => undefined,
}));

function setup(definition = createStarterDefinition()) {
  const onChange = vi.fn<(value: WorkflowV2) => void>();
  const onSelect = vi.fn();
  const props = { definition, onChange, onSelect, selectedNodeId: null };
  const view = render(<WorkflowCanvas {...props} />);
  return { ...props, ...view };
}

describe("WorkflowCanvas", () => {
  it("从节点库添加协议节点，并打开节点配置", () => {
    const { onChange, onSelect } = setup();
    fireEvent.click(screen.getByRole("button", { name: "大语言模型" }));
    expect(onChange.mock.calls[0]?.[0].nodes.at(-1)).toMatchObject({
      id: "llm-1",
      type: "llm",
    });
    expect(onSelect).toHaveBeenCalledWith("llm-1");
  });

  it("将节点移动转换为 V2 坐标", () => {
    const { onChange } = setup();
    flow.onNodesChange?.([
      { id: "start", type: "position", position: { x: 20, y: 40 } },
    ]);
    expect(onChange.mock.calls[0]?.[0].nodes[0]?.position).toEqual({
      x: 20,
      y: 40,
    });
  });

  it("使用协议端口连线并反馈重复连接", () => {
    const definition = createStarterDefinition();
    definition.edges = [];
    const { onChange, rerender, onSelect } = setup(definition);
    const connection = {
      source: "start",
      sourceHandle: "output",
      target: "end",
      targetHandle: "input",
    };
    flow.onConnect?.(connection);
    const connected = onChange.mock.calls[0]![0];
    expect(connected.edges[0]).toMatchObject({
      source: "start",
      sourcePort: "output",
      target: "end",
      targetPort: "input",
    });
    rerender(
      <WorkflowCanvas
        definition={connected}
        onChange={onChange}
        onSelect={onSelect}
        selectedNodeId={null}
      />,
    );
    // 端口方向合法的重复连线由图命令拒绝。
    fireEvent.click(screen.getByRole("button", { name: "验证连接" }));
    expect(screen.getByRole("alert")).toHaveTextContent("这两个端口已连接");
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("向页面报告节点选择和画布空白处取消选择", () => {
    const { definition, onChange, onSelect, rerender } = setup();
    fireEvent.click(screen.getByRole("button", { name: "选择开始节点" }));
    expect(onSelect).toHaveBeenLastCalledWith("start");
    rerender(
      <WorkflowCanvas
        definition={definition}
        onChange={onChange}
        onSelect={onSelect}
        selectedNodeId="start"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "取消选择" }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("删除选中的普通节点及其关联边", () => {
    const definition = createStarterDefinition();
    definition.nodes.push({
      id: "transform-1",
      type: "transform",
      position: { x: 100, y: 50 },
      config: { values: {} },
    });
    definition.edges[0]!.target = "transform-1";
    const { onChange, onSelect, rerender } = setup(definition);
    rerender(
      <WorkflowCanvas
        definition={definition}
        onChange={onChange}
        onSelect={onSelect}
        selectedNodeId="transform-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "删除节点" }));
    expect(onChange.mock.calls[0]?.[0].nodes.map(({ id }) => id)).toEqual([
      "start",
      "end",
    ]);
    expect(onChange.mock.calls[0]?.[0].edges).toEqual([]);
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("锁定唯一的开始和结束节点", () => {
    setup();
    expect(screen.queryByRole("button", { name: "开始" })).toBeNull();
    expect(screen.queryByRole("button", { name: "结束" })).toBeNull();
    expect(flow.nodes?.map(({ deletable }) => deletable)).toEqual([
      false,
      false,
    ]);
  });

  it("将外部选择和运行状态映射到对应节点", () => {
    const { rerender, definition, onChange, onSelect } = setup();
    rerender(
      <WorkflowCanvas
        definition={definition}
        onChange={onChange}
        onSelect={onSelect}
        selectedNodeId="end"
        nodeStatuses={{ end: "SUCCEEDED" }}
      />,
    );
    expect(screen.getByText("已成功")).toBeVisible();
    expect(flow.nodes?.[1]).toMatchObject({
      id: "end",
      selected: true,
      data: { status: "SUCCEEDED" },
    });
  });
});
