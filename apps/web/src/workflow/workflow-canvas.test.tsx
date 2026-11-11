import type { WorkflowV2 } from "@aiflow/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Position, type HandleProps, type ReactFlowProps } from "@xyflow/react";
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
  Handle: ({
    role,
    tabIndex,
    "aria-label": label,
    "aria-pressed": pressed,
    onClick,
    onKeyDown,
  }: HandleProps) => (
    <div
      role={role}
      tabIndex={tabIndex}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      onKeyDown={onKeyDown}
    />
  ),
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

  it("拖拽到同方向端口时提示，拖到空白取消时清除旧提示", () => {
    const { onChange } = setup();
    const from = {
      nodeId: "start",
      id: "output",
      type: "source",
      position: Position.Right,
      width: 10,
      height: 10,
      x: 0,
      y: 0,
    } as const;
    const to = { ...from, nodeId: "llm-1" };
    const start = flow.nodes![0]!;
    const fromNode = {
      ...start,
      measured: { width: 192, height: 54 },
      internals: { positionAbsolute: start.position, z: 0, userNode: start },
    };
    const release = (toHandle: typeof to | null, isValid: false | null) => {
      act(() =>
        flow.onConnectEnd?.(new MouseEvent("mouseup"), {
          isValid,
          from: { x: 0, y: 0 },
          fromHandle: from,
          fromNode,
          fromPosition: from.position,
          to: { x: 40, y: 0 },
          toHandle,
          toNode: null,
          toPosition: toHandle?.position ?? null,
          pointer: { x: 40, y: 0 },
        }),
      );
    };
    release(to, false);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "无法连接这两个节点的端口",
    );
    release(null, null);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("点击同方向端口时显示错误", () => {
    const definition = createStarterDefinition();
    definition.nodes.push({
      id: "transform-1",
      type: "transform",
      position: { x: 100, y: 50 },
      config: { values: {} },
    });
    const { onChange } = setup(definition);
    fireEvent.click(screen.getByRole("button", { name: "开始 start 输出" }));
    fireEvent.click(
      screen.getByRole("button", { name: "数据转换 transform-1 输出" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "无法连接这两个节点的端口",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("通过可聚焦的输出和输入端口完成键盘连线", async () => {
    const definition = createStarterDefinition();
    definition.edges = [];
    const { onChange } = setup(definition);
    const user = userEvent.setup();
    const output = screen.getByRole("button", { name: "开始 start 输出" });
    const input = screen.getByRole("button", { name: "结束 end 输入" });
    expect(output).toHaveAttribute("tabindex", "0");
    expect(input).toHaveAttribute("tabindex", "0");
    output.focus();
    await user.keyboard("{Enter}");
    expect(output).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{Escape}");
    expect(output).toHaveAttribute("aria-pressed", "false");
    await user.keyboard("{Enter}");
    input.focus();
    await user.keyboard(" ");
    expect(onChange.mock.calls[0]?.[0].edges).toEqual([
      {
        id: "edge-1",
        source: "start",
        sourcePort: "output",
        target: "end",
        targetPort: "input",
      },
    ]);
    expect(output).toHaveAttribute("aria-pressed", "false");
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
