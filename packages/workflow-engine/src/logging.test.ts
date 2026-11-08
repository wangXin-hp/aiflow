import { describe, expect, it } from "vitest";
import {
  NodeRegistryV2,
  runWorkflowV2,
  type WorkflowLogEntryV2,
} from "./v2.js";
const pos = { x: 0, y: 0 };
const graph = {
  schemaVersion: 2,
  nodes: [
    { id: "s", type: "start", position: pos },
    {
      id: "e",
      type: "end",
      position: pos,
      config: {
        values: { answer: { kind: "reference", nodeId: "s", key: "text" } },
      },
    },
  ],
  edges: [
    {
      id: "a",
      source: "s",
      target: "e",
      sourcePort: "output",
      targetPort: "input",
    },
  ],
};
describe("结构化运行日志", () => {
  it("按顺序记录节点及运行状态并实时回调，不记录敏感输入输出", async () => {
    const observed: WorkflowLogEntryV2[] = [];
    const result = await runWorkflowV2(
      graph,
      { text: "private-secret-value" },
      {
        onLog: (entry) => {
          observed.push(entry);
        },
      },
    );
    expect(result.logs.map((entry) => entry.code)).toEqual([
      "run.started",
      "node.started",
      "node.succeeded",
      "node.started",
      "node.succeeded",
      "run.succeeded",
    ]);
    expect(observed).toEqual(result.logs);
    expect(result.logs.every((entry) => entry.runId === result.runId)).toBe(
      true,
    );
    expect(
      result.logs.find((entry) => entry.code === "node.succeeded")?.durationMs,
    ).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result.logs)).not.toContain("private-secret-value");
  });
  it("节点失败只记录错误码且日志回调失败不会中断执行", async () => {
    const registry = new NodeRegistryV2();
    registry.register("start", {
      async execute() {
        throw new Error("secret-provider-detail");
      },
    });
    const result = await runWorkflowV2(
      graph,
      { text: "x" },
      {
        registry,
        onLog: () => {
          throw new Error("observer");
        },
      },
    );
    expect(result.status).toBe("failed");
    expect(
      result.logs.find((entry) => entry.code === "node.failed")?.errorCode,
    ).toBe("node_execution_failed");
    expect(JSON.stringify(result.logs)).not.toContain("secret-provider-detail");
  });
});
