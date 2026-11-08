import {
  createArkModelAdapter,
  NodeRegistryV2,
  runWorkflowV2,
} from "@aiflow/workflow-engine";

// 只从当前进程环境读取配置；该示例会向所配置的云服务发送请求并可能产生费用。
const { ARK_BASE_URL, ARK_API_KEY, ARK_MODEL_ID } = globalThis.process.env;
if (!ARK_API_KEY || !ARK_MODEL_ID) {
  throw new Error("请设置 ARK_API_KEY 和 ARK_MODEL_ID");
}
const model = createArkModelAdapter({
  baseUrl: ARK_BASE_URL,
  apiKey: ARK_API_KEY,
});
const registry = new NodeRegistryV2({ model });
const position = { x: 0, y: 0 };
const ref = (nodeId, key) => ({ kind: "reference", nodeId, key });
const edge = (id, source, target) => ({
  id,
  source,
  target,
  sourcePort: "output",
  targetPort: "input",
});
const definition = {
  schemaVersion: 2,
  nodes: [
    { id: "start", type: "start", position },
    {
      id: "model",
      type: "llm",
      position,
      config: {
        model: ARK_MODEL_ID,
        values: { user: ref("start", "question") },
      },
    },
    {
      id: "end",
      type: "end",
      position,
      config: { values: { answer: ref("model", "output") } },
    },
  ],
  edges: [edge("a", "start", "model"), edge("b", "model", "end")],
};
const result = await runWorkflowV2(
  definition,
  { question: "请用一句话解释什么是工作流。" },
  { registry, nodeTimeoutMs: 120_000 },
);
if (result.status !== "succeeded")
  throw new Error(`工作流执行失败：${result.error?.code ?? result.status}`);
globalThis.console.log(JSON.stringify(result.output, null, 2));
