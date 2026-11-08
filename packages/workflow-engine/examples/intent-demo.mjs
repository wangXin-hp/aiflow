import { NodeRegistryV2, runWorkflowV2 } from "@aiflow/workflow-engine";

// 本地演示用固定响应替身；真实项目可换成 createOllamaModelAdapter。
const registry = new NodeRegistryV2({
  model: {
    async generate() {
      return { text: JSON.stringify({ intent: "sales", confidence: 0.9 }) };
    },
  },
});
const position = { x: 0, y: 0 };
const ref = (nodeId, key, fallback) => ({
  kind: "reference",
  nodeId,
  key,
  ...(fallback === undefined ? {} : { fallback }),
});
const edge = (id, source, target, sourcePort = "output") => ({
  id,
  source,
  target,
  sourcePort,
  targetPort: "input",
});
const definition = {
  schemaVersion: 2,
  nodes: [
    { id: "start", type: "start", position },
    {
      id: "route",
      type: "intent",
      position,
      config: {
        model: "demo",
        intents: [
          { id: "sales", description: "购买咨询" },
          { id: "support", description: "技术支持" },
        ],
        values: { text: ref("start", "question") },
      },
    },
    {
      id: "sales",
      type: "transform",
      position,
      config: { values: { reply: { kind: "literal", value: "已转交销售" } } },
    },
    {
      id: "support",
      type: "transform",
      position,
      config: { values: { reply: { kind: "literal", value: "已转交支持" } } },
    },
    {
      id: "end",
      type: "end",
      position,
      config: {
        values: {
          sales: ref("sales", "reply", "未选择"),
          support: ref("support", "reply", "未选择"),
        },
      },
    },
  ],
  edges: [
    edge("a", "start", "route"),
    edge("b", "route", "sales", "sales"),
    edge("c", "route", "support", "support"),
    edge("d", "sales", "end"),
    edge("e", "support", "end"),
  ],
};
const result = await runWorkflowV2(
  definition,
  { question: "如何购买？" },
  { registry },
);
globalThis.console.log(JSON.stringify(result, null, 2));
