import { describe, expect, it, vi } from "vitest";
import {
  createOllamaModelAdapter,
  createFetchHttpAdapter,
  createHybridKnowledgeAdapter,
  createOllamaEmbeddingAdapter,
  createQdrantKnowledgeAdapter,
} from "./adapters/index.js";
describe("service adapters", () => {
  it("sends chat messages and returns actual Ollama token counts", async () => {
    const send = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "model",
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        });
        return new Response(
          JSON.stringify({
            message: { content: "hello" },
            prompt_eval_count: 4,
            eval_count: 3,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    const adapter = createOllamaModelAdapter({
      baseUrl: "http://localhost:11434",
      fetch: send,
    });
    expect(
      await adapter.generate({
        model: "model",
        user: "hi",
        signal: new AbortController().signal,
      }),
    ).toEqual({ text: "hello", tokens: 7 });
  });
  it("forwards model generation settings", async () => {
    const send = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body)).options).toEqual({
          temperature: 0.2,
          num_predict: 128,
        });
        return new Response(JSON.stringify({ message: { content: "ok" } }), {
          status: 200,
        });
      },
    );
    const adapter = createOllamaModelAdapter({
      baseUrl: "http://localhost:11434",
      fetch: send,
    });
    await adapter.generate({
      model: "m",
      user: "hi",
      temperature: 0.2,
      maxTokens: 128,
      signal: new AbortController().signal,
    });
  });
  it("rejects HTTP targets not explicitly allowed and does not follow redirects", async () => {
    const send = vi.fn(
      async () =>
        new Response("denied", {
          status: 302,
          headers: { location: "http://127.0.0.1" },
        }),
    );
    const adapter = createFetchHttpAdapter({
      allowUrl: (url) => url.hostname === "example.com",
      fetch: send,
    });
    await expect(
      adapter.request({
        method: "GET",
        url: "http://127.0.0.1",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    const result = await adapter.request({
      method: "GET",
      url: "https://example.com",
      signal: new AbortController().signal,
    });
    expect(result.status).toBe(302);
    expect(send.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
  it("applies the URL policy to the final query string", async () => {
    const send = vi.fn(async () => new Response("ok"));
    const adapter = createFetchHttpAdapter({
      allowUrl: (url) => !url.searchParams.has("secret"),
      fetch: send,
    });
    await expect(
      adapter.request({
        method: "GET",
        url: "https://example.com",
        params: { secret: "value" },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it("serializes HTTP query and URL-encoded body", async () => {
    const send = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://example.com/api?query=hello+world");
        expect(String(init?.body)).toBe("name=alice+bob");
        expect(new Headers(init?.headers).get("content-type")).toBe(
          "application/x-www-form-urlencoded;charset=UTF-8",
        );
        return new Response("ok", { status: 200 });
      },
    );
    const adapter = createFetchHttpAdapter({
      allowUrl: () => true,
      fetch: send,
    });
    await adapter.request({
      method: "POST",
      url: "https://example.com/api",
      params: { query: "hello world" },
      bodyType: "x-www-form-urlencoded",
      body: { name: "alice bob" },
      signal: new AbortController().signal,
    });
  });
  it("combines vector and text retrieval without duplicate chunks", async () => {
    const adapter = createHybridKnowledgeAdapter({
      vectorSearch: async () => [
        { documentId: "d", chunkId: "a", content: "one", score: 0.9 },
      ],
      textSearch: async () => [
        { documentId: "d", chunkId: "a", content: "one", score: 0.8 },
        { documentId: "d", chunkId: "b", content: "two", score: 0.7 },
      ],
    });
    const results = await adapter.retrieve({
      query: "hello",
      knowledgeBaseIds: ["kb"],
      mode: "hybrid",
      topK: 2,
      signal: new AbortController().signal,
    });
    expect(results.map((r) => r.chunkId)).toEqual(["a", "b"]);
  });
  it("expands candidates before hybrid rank fusion", async () => {
    const makeHit = (chunkId: string) => ({
      documentId: "d",
      chunkId,
      content: chunkId,
      score: 1,
    });
    const adapter = createHybridKnowledgeAdapter({
      vectorSearch: async (query) =>
        [makeHit("v"), makeHit("shared")].slice(0, query.topK),
      textSearch: async (query) =>
        [makeHit("t"), makeHit("shared")].slice(0, query.topK),
    });
    const results = await adapter.retrieve({
      query: "q",
      knowledgeBaseIds: ["kb"],
      mode: "hybrid",
      topK: 1,
      signal: new AbortController().signal,
    });
    expect(results[0]?.chunkId).toBe("shared");
  });
  it("embeds text through Ollama", async () => {
    const send = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "embed",
          input: "query",
        });
        return new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), {
          status: 200,
        });
      },
    );
    expect(
      await createOllamaEmbeddingAdapter({
        baseUrl: "http://localhost:11434",
        model: "embed",
        fetch: send,
      }).embed("query", new AbortController().signal),
    ).toEqual([0.1, 0.2]);
  });
  it("paginates Qdrant fulltext results with deterministic ranking", async () => {
    const send = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            result:
              request.offset === undefined
                ? {
                    points: [
                      {
                        id: "1",
                        payload: {
                          knowledgeBaseId: "kb",
                          documentId: "d",
                          content: "hello",
                        },
                      },
                    ],
                    next_page_offset: "2",
                  }
                : {
                    points: [
                      {
                        id: "2",
                        payload: {
                          knowledgeBaseId: "kb",
                          documentId: "d",
                          content: "hello world",
                        },
                      },
                    ],
                    next_page_offset: null,
                  },
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createQdrantKnowledgeAdapter({
      baseUrl: "http://localhost:6333",
      collection: "chunks",
      embed: async () => [1],
      fetch: send,
    });
    const hits = await adapter.retrieve({
      query: "hello world",
      knowledgeBaseIds: ["kb"],
      mode: "fulltext",
      topK: 2,
      signal: new AbortController().signal,
    });
    expect(hits.map((hit) => hit.chunkId)).toEqual(["2", "1"]);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("queries Qdrant with knowledge-base filtering and maps source metadata", async () => {
    const send = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          query: [0.1, 0.2],
          filter: {
            must: [{ key: "knowledgeBaseId", match: { any: ["kb"] } }],
          },
        });
        return new Response(
          JSON.stringify({
            result: {
              points: [
                {
                  id: "c",
                  score: 0.9,
                  payload: {
                    knowledgeBaseId: "kb",
                    documentId: "d",
                    content: "answer",
                    chunkId: "business-chunk",
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createQdrantKnowledgeAdapter({
      baseUrl: "http://localhost:6333",
      collection: "chunks",
      embed: async () => [0.1, 0.2],
      fetch: send,
    });
    expect(
      await adapter.retrieve({
        query: "query",
        knowledgeBaseIds: ["kb"],
        mode: "vector",
        topK: 3,
        signal: new AbortController().signal,
      }),
    ).toEqual([
      {
        documentId: "d",
        knowledgeBaseId: "kb",
        chunkId: "business-chunk",
        content: "answer",
        score: 0.9,
      },
    ]);
  });
});
