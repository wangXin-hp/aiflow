import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createStarterDefinition } from "./graph";
import { RunPanel } from "./run-panel";

it("运行表单解析开始节点的数字、布尔值和 JSON，省略有默认值的空字段", () => {
  const definition = createStarterDefinition();
  const start = definition.nodes.find((node) => node.type === "start")!;
  start.config = {
    inputs: [
      { name: "score", type: "number", required: true },
      { name: "flag", type: "boolean", required: true },
      { name: "items", type: "array", required: true },
      { name: "settings", type: "object", required: true },
      {
        name: "query",
        type: "string",
        required: true,
        defaultValue: "默认输入",
      },
    ],
  };
  const onRun = vi.fn();
  render(
    <RunPanel
      definition={definition}
      stream={{
        events: [],
        connection: "connecting",
        nodeStatuses: {},
        cancelling: false,
        refresh: vi.fn(),
        cancel: vi.fn(),
      }}
      busy={false}
      unavailable={false}
      onRun={onRun}
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "score" }), {
    target: { value: ".5" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "flag" }), {
    target: { value: "false" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "items" }), {
    target: { value: "[1]" },
  });
  const settings = screen.getByRole("textbox", { name: "settings" });
  fireEvent.change(settings, { target: { value: "[]" } });
  const submit = screen.getByRole("button", { name: "开始运行" });
  fireEvent.click(submit);
  expect(screen.getByRole("alert")).toHaveTextContent("settings");
  expect(onRun).not.toHaveBeenCalled();
  fireEvent.change(settings, { target: { value: '{"ready":true}' } });
  fireEvent.click(submit);
  expect(onRun).toHaveBeenCalledWith({
    input: { score: 0.5, flag: false, items: [1], settings: { ready: true } },
  });
});
