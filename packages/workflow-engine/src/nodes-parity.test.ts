import { describe, expect, it } from "vitest";
import { NodeRegistryV2, runWorkflowV2, validateWorkflowV2 } from "./v2.js";
const position = { x: 0, y: 0 };
const ref = (nodeId: string, key: string) => ({
  kind: "reference",
  nodeId,
  key,
});
const literal = (value: unknown) => ({ kind: "literal", value });
const edge = (
  id: string,
  source: string,
  target: string,
  sourcePort = "output",
) => ({ id, source, target, sourcePort, targetPort: "input" });
const makeGraph = (node: object, outputKey: string) => ({
  schemaVersion: 2,
  nodes: [
    { id: "start", type: "start", position },
    node,
    {
      id: "end",
      type: "end",
      position,
      config: { values: { result: ref("work", outputKey) } },
    },
  ],
  edges: [edge("a", "start", "work"), edge("b", "work", "end")],
});
describe("external nodes", () => {
  it("invokes the model through an injected adapter", async () => {
    const calls: unknown[] = [];
    const registry = new NodeRegistryV2({
      model: {
        async generate(request) {
          calls.push({ model: request.model, user: request.user });
          return { text: "hello", tokens: 7 };
        },
      },
    });
    const graph = makeGraph(
      {
        id: "work",
        type: "llm",
        position,
        config: { model: "test", values: { user: ref("start", "question") } },
      },
      "output",
    );
    const result = await runWorkflowV2(graph, { question: "hi" }, { registry });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ result: "hello" });
    expect(calls).toEqual([{ model: "test", user: "hi" }]);
  });
  it("rejects start input defaults that do not match their declared types", () => {
    const definition = makeGraph(
      { id: "work", type: "transform", position, config: { values: {} } },
      "count",
    );
    definition.nodes[0] = {
      id: "start",
      type: "start",
      position,
      config: {
        inputs: [{ name: "count", type: "number", defaultValue: "bad" }],
      },
    } as (typeof definition.nodes)[0];
    expect(validateWorkflowV2(definition).valid).toBe(false);
  });
  it("validates required start inputs and applies typed defaults", async () => {
    const graph = makeGraph(
      {
        id: "work",
        type: "transform",
        position,
        config: { values: { count: ref("start", "count") } },
      },
      "count",
    );
    graph.nodes[0] = {
      id: "start",
      type: "start",
      position,
      config: {
        inputs: [
          { name: "count", type: "number", required: false, defaultValue: 3 },
        ],
      },
    } as (typeof graph.nodes)[0];
    expect((await runWorkflowV2(graph, {})).output).toEqual({ result: 3 });
    expect((await runWorkflowV2(graph, { count: "wrong" })).error?.code).toBe(
      "invalid_node_input",
    );
    const required = {
      ...graph,
      nodes: [
        {
          id: "start",
          type: "start",
          position,
          config: {
            inputs: [{ name: "count", type: "number", required: true }],
          },
        },
        ...graph.nodes.slice(1),
      ],
    };
    expect((await runWorkflowV2(required, {})).error?.code).toBe(
      "invalid_node_input",
    );
  });
  it("renders model prompt templates using upstream values", async () => {
    const registry = new NodeRegistryV2({
      model: {
        async generate(request) {
          expect(request.user).toBe("请回答：为什么？");
          return { text: "好的" };
        },
      },
    });
    const graph = makeGraph(
      {
        id: "work",
        type: "llm",
        position,
        config: {
          model: "test",
          values: {
            user: {
              kind: "template",
              parts: ["请回答：", ref("start", "question")],
            },
          },
        },
      },
      "output",
    );
    expect(
      (await runWorkflowV2(graph, { question: "为什么？" }, { registry }))
        .output,
    ).toEqual({ result: "好的" });
  });
  it("records node input and elapsed duration for debugging", async () => {
    const registry = new NodeRegistryV2({
      model: {
        async generate() {
          return { text: "ok" };
        },
      },
    });
    const graph = makeGraph(
      {
        id: "work",
        type: "llm",
        position,
        config: { model: "test", values: { user: ref("start", "question") } },
      },
      "output",
    );
    const result = await runWorkflowV2(
      graph,
      { question: "hello" },
      { registry, captureInputs: true },
    );
    const node = result.nodes.find((entry) => entry.nodeId === "work");
    expect(node?.input).toEqual({ user: "hello" });
    expect(node?.durationMs).toBeGreaterThanOrEqual(0);
  });
  it("passes HTTP parameters to an injected transport", async () => {
    const registry = new NodeRegistryV2({
      http: {
        async request(request) {
          expect(request.method).toBe("POST");
          expect(request.url).toBe("https://example.com");
          expect(request.body).toEqual({ text: "hi" });
          return { status: 201, headers: {}, data: { id: 1 } };
        },
      },
    });
    const graph = makeGraph(
      {
        id: "work",
        type: "http",
        position,
        config: {
          method: "POST",
          values: {
            url: literal("https://example.com"),
            body: ref("start", "data"),
          },
        },
      },
      "status",
    );
    expect(
      (await runWorkflowV2(graph, { data: { text: "hi" } }, { registry }))
        .output,
    ).toEqual({ result: 201 });
  });
  it("passes knowledge query configuration to its retriever", async () => {
    const registry = new NodeRegistryV2({
      knowledge: {
        async retrieve(request) {
          expect(request.query).toBe("hi");
          expect(request.knowledgeBaseIds).toEqual(["kb"]);
          return [
            {
              documentId: "doc",
              chunkId: "chunk",
              content: "answer",
              score: 0.9,
            },
          ];
        },
      },
    });
    const graph = makeGraph(
      {
        id: "work",
        type: "knowledge",
        position,
        config: {
          knowledgeBaseIds: ["kb"],
          retrievalMode: "vector",
          topK: 3,
          values: { query: ref("start", "question") },
        },
      },
      "results",
    );
    expect(
      (await runWorkflowV2(graph, { question: "hi" }, { registry })).output,
    ).toEqual({
      result: [
        { documentId: "doc", chunkId: "chunk", content: "answer", score: 0.9 },
      ],
    });
  });
  it("formats retrieved chunks as text while keeping structured sources", async () => {
    const registry = new NodeRegistryV2({
      knowledge: {
        async retrieve() {
          return [
            {
              documentId: "d",
              chunkId: "c",
              content: "answer",
              score: 0.9,
              knowledgeBaseId: "kb",
              chunkIndex: 2,
            },
          ];
        },
      },
    });
    const graph = makeGraph(
      {
        id: "work",
        type: "knowledge",
        position,
        config: {
          knowledgeBaseIds: ["kb"],
          retrievalMode: "vector",
          topK: 3,
          outputFormat: "text",
          values: { query: ref("start", "question") },
        },
      },
      "output",
    );
    const result = await runWorkflowV2(graph, { question: "hi" }, { registry });
    expect(result.output).toEqual({ result: "[1] answer" });
    expect(
      result.nodes.find((node) => node.nodeId === "work")?.output?.results,
    ).toEqual([
      {
        documentId: "d",
        chunkId: "c",
        content: "answer",
        score: 0.9,
        knowledgeBaseId: "kb",
        chunkIndex: 2,
      },
    ]);
  });
  it("reports missing adapters instead of silently passing input through", async () => {
    const graph = makeGraph(
      {
        id: "work",
        type: "llm",
        position,
        config: { model: "test", values: { user: literal("hi") } },
      },
      "output",
    );
    expect((await runWorkflowV2(graph, {}, {})).error?.code).toBe(
      "adapter_not_configured",
    );
  });
  it("rejects a model response outside the configured intent list", async () => {
    const registry = new NodeRegistryV2({
      model: {
        async generate() {
          return { text: '{"intent":"unknown"}' };
        },
      },
    });
    const graph = {
      schemaVersion: 2,
      nodes: [
        { id: "start", type: "start", position },
        {
          id: "intent",
          type: "intent",
          position,
          config: {
            model: "test",
            intents: [{ id: "sales", description: "buy" }],
            values: { text: ref("start", "text") },
          },
        },
        { id: "end", type: "end", position, config: { values: {} } },
      ],
      edges: [
        edge("a", "start", "intent"),
        edge("b", "intent", "end", "sales"),
      ],
    };
    const result = await runWorkflowV2(graph, { text: "buy" }, { registry });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("invalid_intent_response");
  });
  it("routes a named intent and skips other branches", async () => {
    const registry = new NodeRegistryV2({
      model: {
        async generate() {
          return { text: '{"intent":"sales","confidence":0.9}' };
        },
      },
    });
    const graph = {
      schemaVersion: 2,
      nodes: [
        { id: "start", type: "start", position },
        {
          id: "intent",
          type: "intent",
          position,
          config: {
            model: "test",
            intents: [
              { id: "sales", description: "buy" },
              { id: "support", description: "help" },
            ],
            values: { text: ref("start", "text") },
          },
        },
        { id: "sales", type: "transform", position, config: { values: {} } },
        { id: "support", type: "transform", position, config: { values: {} } },
        { id: "end", type: "end", position, config: { values: {} } },
      ],
      edges: [
        edge("a", "start", "intent"),
        edge("b", "intent", "sales", "sales"),
        edge("c", "intent", "support", "support"),
        edge("d", "sales", "end"),
        edge("e", "support", "end"),
      ],
    };
    expect(validateWorkflowV2(graph).valid).toBe(true);
    const result = await runWorkflowV2(graph, { text: "buy" }, { registry });
    expect(result.status).toBe("succeeded");
    expect(result.nodes.find((n) => n.nodeId === "support")?.status).toBe(
      "skipped",
    );
  });
});
