import { describe, expect, it, vi } from "vitest";
import { NodeRegistryV2, runWorkflowV2 } from "./v2.js";
import {
  createOpenAICompatibleModelAdapter,
  createOpenAICompatibleEmbeddingAdapter,
} from "./adapters/index.js";

describe("云端模型适配", () => {
  it("调用兼容的 chat completions 地址并转发模型参数和信号", async () => {
    const signal = new AbortController().signal;
    const send = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://cloud.example/v1/chat/completions");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer test-key",
        );
        expect(init?.signal).toBe(signal);
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "model-name",
          stream: false,
          messages: [
            { role: "system", content: "system" },
            { role: "user", content: "hello" },
          ],
          temperature: 0.2,
          max_tokens: 100,
        });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "reply" } }],
            usage: { total_tokens: 12 },
          }),
          { status: 200 },
        );
      },
    );
    const model = createOpenAICompatibleModelAdapter({
      baseUrl: "https://cloud.example/v1",
      apiKey: "test-key",
      fetch: send,
    });
    expect(
      await model.generate({
        model: "model-name",
        system: "system",
        user: "hello",
        temperature: 0.2,
        maxTokens: 100,
        signal,
      }),
    ).toEqual({ text: "reply", tokens: 12 });
  });
  it("不把供应商错误响应中的敏感内容暴露给调用者", async () => {
    const model = createOpenAICompatibleModelAdapter({
      baseUrl: "https://cloud.example/v1/",
      apiKey: "test-key",
      fetch: async () =>
        new Response("secret-provider-detail", { status: 401 }),
    });
    await expect(
      model.generate({
        model: "m",
        user: "hi",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Cloud model request failed with status 401");
  });
  it("不泄露成功响应中的非法 JSON 原文", async () => {
    const adapter = createOpenAICompatibleModelAdapter({
      baseUrl: "https://cloud.example/v1",
      apiKey: "test-key",
      fetch: async () =>
        new Response("secret-provider-detail", { status: 200 }),
    });
    await expect(
      adapter.generate({
        model: "m",
        user: "hi",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/^Invalid cloud response JSON$/);
  });
  it("校验云端返回的文本和向量", async () => {
    const bad = createOpenAICompatibleModelAdapter({
      baseUrl: "https://cloud.example/v1",
      apiKey: "test-key",
      fetch: async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    });
    await expect(
      bad.generate({
        model: "m",
        user: "hi",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Invalid cloud model response");
    const embedding = createOpenAICompatibleEmbeddingAdapter({
      baseUrl: "https://cloud.example/v1",
      apiKey: "test-key",
      model: "embed-model",
      fetch: async (url, init) => {
        expect(String(url)).toBe("https://cloud.example/v1/embeddings");
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "embed-model",
          input: "query",
          encoding_format: "float",
        });
        return new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }),
          { status: 200 },
        );
      },
    });
    expect(
      await embedding.embed("query", new AbortController().signal),
    ).toEqual([0.1, 0.2]);
  });
  it("允许供应商使用 max_completion_tokens 参数", async () => {
    const model = createOpenAICompatibleModelAdapter({
      baseUrl: "https://cloud.example/v1",
      apiKey: "test-key",
      maxTokensField: "max_completion_tokens",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.max_completion_tokens).toBe(12);
        expect(body.max_tokens).toBeUndefined();
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        );
      },
    });
    await model.generate({
      model: "m",
      user: "hi",
      maxTokens: 12,
      signal: new AbortController().signal,
    });
  });
  it("LLM 节点和意图节点通过同一云端适配器执行", async () => {
    const send = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const content = body.messages.some((message: { content: string }) =>
          message.content.includes("Select exactly one intent"),
        )
          ? '{"intent":"sales","confidence":0.9}'
          : "云端回答";
        return new Response(
          JSON.stringify({ choices: [{ message: { content } }] }),
          { status: 200 },
        );
      },
    );
    const registry = new NodeRegistryV2({
      model: createOpenAICompatibleModelAdapter({
        baseUrl: "https://cloud.example/v1",
        apiKey: "test-key",
        fetch: send,
      }),
    });
    const position = { x: 0, y: 0 },
      ref = (nodeId: string, key: string) => ({
        kind: "reference",
        nodeId,
        key,
      });
    const edge = (
      id: string,
      source: string,
      target: string,
      sourcePort = "output",
    ) => ({ id, source, target, sourcePort, targetPort: "input" });
    const definition = {
      schemaVersion: 2,
      nodes: [
        { id: "s", type: "start", position },
        {
          id: "llm",
          type: "llm",
          position,
          config: { model: "cloud", values: { user: ref("s", "text") } },
        },
        {
          id: "intent",
          type: "intent",
          position,
          config: {
            model: "cloud",
            intents: [{ id: "sales", description: "购买" }],
            values: { text: ref("llm", "output") },
          },
        },
        {
          id: "e",
          type: "end",
          position,
          config: { values: { result: ref("intent", "intent") } },
        },
      ],
      edges: [
        edge("a", "s", "llm"),
        edge("b", "llm", "intent"),
        edge("c", "intent", "e", "sales"),
      ],
    };
    const result = await runWorkflowV2(
      definition,
      { text: "你好" },
      { registry },
    );
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ result: "sales" });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
