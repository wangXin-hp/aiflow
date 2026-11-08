import { createQdrantKnowledgeAdapter } from "./adapters/qdrant.js";
import { NodeRegistryV2, runWorkflowV2 } from "./v2.js";
import { describe, expect, it, vi } from "vitest";
import {
  splitText,
  splitMarkdown,
  createQdrantVectorStore,
  indexKnowledgeDocument,
} from "./knowledge/index.js";

describe("文档切分", () => {
  it("按 Unicode 字符分块、保留重叠并提供原始字符串偏移", () => {
    const text = "甲😀乙丙丁";
    const chunks = splitText(text, { chunkSize: 3, chunkOverlap: 1 });
    expect(chunks.map((chunk) => chunk.content)).toEqual(["甲😀乙", "乙丙丁"]);
    for (const chunk of chunks)
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(
        chunk.content,
      );
  });
  it("空文本无分块并拒绝无效重叠", () => {
    expect(splitText("", { chunkSize: 2, chunkOverlap: 1 })).toEqual([]);
    expect(() => splitText("text", { chunkSize: 2, chunkOverlap: 2 })).toThrow(
      RangeError,
    );
  });
  it("在切分过程中限制重叠块数和超大文本", () => {
    expect(() =>
      splitText("x".repeat(1002), { chunkSize: 2, chunkOverlap: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      splitMarkdown("x".repeat(2_000_001), { chunkSize: 100, chunkOverlap: 0 }),
    ).toThrow(RangeError);
  });
  it("按 Markdown 标题分段并保留标题层级", () => {
    const text = "# 第一章\n内容\n## 小节\n更多内容";
    const chunks = splitMarkdown(text, { chunkSize: 100, chunkOverlap: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.headings).toEqual(["第一章"]);
    expect(chunks[1]?.headings).toEqual(["第一章", "小节"]);
    for (const chunk of chunks)
      expect(text.slice(chunk.startOffset, chunk.endOffset)).toBe(
        chunk.content,
      );
  });
  it("代码块内的井号不作为标题", () => {
    const text = "# 标题\n```txt\n# 不是标题\n```\n正文";
    expect(
      splitMarkdown(text, { chunkSize: 100, chunkOverlap: 0 }),
    ).toHaveLength(1);
  });
});

describe("向量入库", () => {
  it("创建缺失集合并拒绝已有集合维度不匹配", async () => {
    const send = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === "GET") return new Response("{}", { status: 404 });
        expect(JSON.parse(String(init?.body))).toEqual({
          vectors: { size: 2, distance: "Cosine" },
        });
        return new Response("{}", { status: 200 });
      },
    );
    const store = createQdrantVectorStore({
      baseUrl: "http://localhost:6333",
      collection: "chunks",
      fetch: send,
    });
    await store.ensureCollection(2, new AbortController().signal);
    expect(send).toHaveBeenCalledTimes(2);
    const mismatch = createQdrantVectorStore({
      baseUrl: "http://localhost:6333",
      collection: "chunks",
      fetch: async () =>
        new Response(
          JSON.stringify({
            result: {
              config: { params: { vectors: { size: 3, distance: "Cosine" } } },
            },
          }),
          { status: 200 },
        ),
    });
    await expect(
      mismatch.ensureCollection(2, new AbortController().signal),
    ).rejects.toThrow(/mismatch/);
  });
  it("写入错误不会被报告为成功", async () => {
    const store = createQdrantVectorStore({
      baseUrl: "http://localhost:6333",
      collection: "chunks",
      fetch: async () => new Response("error", { status: 500 }),
    });
    await expect(
      store.upsert(
        [
          {
            knowledgeBaseId: "kb",
            documentId: "d",
            chunkId: "c",
            content: "x",
            vector: [1],
          },
        ],
        new AbortController().signal,
      ),
    ).rejects.toThrow(/500/);
  });
  it("以稳定 ID 写入并按知识库和文档双条件删除", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const send = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(
          JSON.stringify({ result: { status: "completed" }, status: "ok" }),
          { status: 200 },
        );
      },
    );
    const store = createQdrantVectorStore({
      baseUrl: "http://localhost:6333",
      collection: "chunks",
      fetch: send,
    });
    const chunk = {
      knowledgeBaseId: "kb",
      documentId: "doc",
      chunkId: "chunk",
      content: "hello",
      vector: [0.1, 0.2],
    };
    const signal = new AbortController().signal;
    await store.upsert([chunk], signal);
    await store.upsert([chunk], signal);
    expect(
      (requests[0]?.body as { points: Array<{ id: string }> }).points[0]?.id,
    ).toBe(
      (requests[1]?.body as { points: Array<{ id: string }> }).points[0]?.id,
    );
    expect(requests[0]?.url).toContain("/collections/chunks/points?wait=true");
    await store.deleteDocument("kb", "doc", signal);
    expect(requests[2]?.body).toEqual({
      filter: {
        must: [
          { key: "knowledgeBaseId", match: { value: "kb" } },
          { key: "documentId", match: { value: "doc" } },
        ],
      },
    });
  });
  it("切分入库后可由工作流知识节点检索并输出来源", async () => {
    let points: Array<{ id: string; vector: number[]; payload: object }> = [];
    const send = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (init?.method === "PUT" && path.endsWith("/points")) {
          points = JSON.parse(String(init.body)).points;
          return new Response("{}", { status: 200 });
        }
        if (path.endsWith("/points/query"))
          return new Response(
            JSON.stringify({
              result: {
                points: points.map((point) => ({ ...point, score: 0.9 })),
              },
            }),
            { status: 200 },
          );
        throw new Error("Unexpected request");
      },
    );
    const embed = async () => [0.1, 0.2];
    const signal = new AbortController().signal;
    const store = createQdrantVectorStore({
      baseUrl: "http://localhost:6333",
      collection: "chunks",
      fetch: send,
    });
    await indexKnowledgeDocument({
      knowledgeBaseId: "kb",
      documentId: "doc",
      content: "豆包知识",
      chunkSize: 50,
      chunkOverlap: 0,
      signal,
      store,
      embed,
    });
    const knowledge = createQdrantKnowledgeAdapter({
      baseUrl: "http://localhost:6333",
      collection: "chunks",
      fetch: send,
      embed,
    });
    const pos = { x: 0, y: 0 };
    const graph = {
      schemaVersion: 2,
      nodes: [
        { id: "s", type: "start", position: pos },
        {
          id: "k",
          type: "knowledge",
          position: pos,
          config: {
            knowledgeBaseIds: ["kb"],
            retrievalMode: "vector",
            topK: 3,
            outputFormat: "text",
            values: {
              query: { kind: "reference", nodeId: "s", key: "question" },
            },
          },
        },
        {
          id: "e",
          type: "end",
          position: pos,
          config: {
            values: {
              answer: { kind: "reference", nodeId: "k", key: "output" },
            },
          },
        },
      ],
      edges: [
        {
          id: "a",
          source: "s",
          target: "k",
          sourcePort: "output",
          targetPort: "input",
        },
        {
          id: "b",
          source: "k",
          target: "e",
          sourcePort: "output",
          targetPort: "input",
        },
      ],
    };
    const result = await runWorkflowV2(
      graph,
      { question: "豆包" },
      { registry: new NodeRegistryV2({ knowledge }) },
    );
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ answer: "[1] 豆包知识" });
    expect(
      result.nodes.find((node) => node.nodeId === "k")?.output?.results,
    ).toEqual([
      {
        documentId: "doc",
        chunkId: "doc:0",
        content: "豆包知识",
        score: 0.9,
        knowledgeBaseId: "kb",
        chunkIndex: 0,
      },
    ]);
  });
  it("异步写入使用入口快照，不受调用方后续修改影响", async () => {
    let body:
      | { points: Array<{ payload: { documentId: string }; vector: number[] }> }
      | undefined;
    const store = createQdrantVectorStore({
      baseUrl: "http://localhost:6333",
      collection: "chunks",
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      },
    });
    const item = {
      knowledgeBaseId: "kb",
      documentId: "doc",
      chunkId: "chunk",
      content: "hello",
      vector: [1, 2],
    };
    const pending = store.upsert([item], new AbortController().signal);
    item.documentId = "changed";
    item.vector[0] = NaN;
    await pending;
    expect(body?.points[0]?.payload.documentId).toBe("doc");
    expect(body?.points[0]?.vector).toEqual([1, 2]);
  });
  it("超过分块数量限制时不调用向量化和存储", async () => {
    const embed = vi.fn(async () => [1]);
    const upsert = vi.fn(async () => {});
    const store = {
      upsert,
      deleteDocument: vi.fn(),
      ensureCollection: vi.fn(),
    };
    await expect(
      indexKnowledgeDocument({
        knowledgeBaseId: "kb",
        documentId: "doc",
        content: "x".repeat(1002),
        chunkSize: 2,
        chunkOverlap: 1,
        signal: new AbortController().signal,
        store,
        embed,
      }),
    ).rejects.toThrow(RangeError);
    expect(embed).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
  it("异步向量化期间固定文档范围并复制复用的向量", async () => {
    let release!: () => void;
    let entered!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const shared = [1, 2];
    let calls = 0;
    let written: Array<{
      knowledgeBaseId: string;
      documentId: string;
      vector: number[];
    }> = [];
    const store = {
      upsert: async (chunks: typeof written) => {
        written = chunks;
      },
      deleteDocument: vi.fn(),
      ensureCollection: vi.fn(),
    };
    const args = {
      knowledgeBaseId: "kb",
      documentId: "doc",
      content: "abcdef",
      chunkSize: 3,
      chunkOverlap: 0,
      signal: new AbortController().signal,
      store,
      embed: async () => {
        calls++;
        if (calls === 1) {
          entered();
          await wait;
        } else shared[0] = 9;
        return shared;
      },
    };
    const pending = indexKnowledgeDocument(args);
    await ready;
    args.knowledgeBaseId = "other";
    args.documentId = "changed";
    release();
    await pending;
    expect(
      written.map((chunk) => [
        chunk.knowledgeBaseId,
        chunk.documentId,
        chunk.vector,
      ]),
    ).toEqual([
      ["kb", "doc", [1, 2]],
      ["kb", "doc", [9, 2]],
    ]);
  });
  it("向量化成功后才写入，失败时不会提交部分文档", async () => {
    const upsert = vi.fn(async () => {});
    let calls = 0;
    const store = {
      upsert,
      deleteDocument: vi.fn(),
      ensureCollection: vi.fn(),
    };
    await expect(
      indexKnowledgeDocument({
        knowledgeBaseId: "kb",
        documentId: "doc",
        content: "abcdef",
        chunkSize: 3,
        chunkOverlap: 0,
        signal: new AbortController().signal,
        store,
        embed: async () => {
          if (++calls === 2) throw new Error("failed");
          return [1, 2];
        },
      }),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });
});
