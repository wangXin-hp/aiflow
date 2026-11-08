import { readBoundedText } from "../adapters/response.js";

export interface VectorChunk {
  knowledgeBaseId: string;
  documentId: string;
  chunkId: string;
  content: string;
  vector: number[];
  chunkIndex?: number;
}
export interface VectorStore {
  upsert(chunks: VectorChunk[], signal: AbortSignal): Promise<void>;
  deleteDocument(
    knowledgeBaseId: string,
    documentId: string,
    signal: AbortSignal,
  ): Promise<void>;
  ensureCollection(dimensions: number, signal: AbortSignal): Promise<void>;
}
/** 稳定地将业务复合 ID 映射为 Qdrant 支持的 UUID，避免跨知识库覆盖。 */
async function pointId(chunk: VectorChunk): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([chunk.knowledgeBaseId, chunk.documentId, chunk.chunkId]),
  );
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", bytes),
  );
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
/** 对 Qdrant 的集合和点操作；删除文档必须同时限定知识库与文档。 */
export function createQdrantVectorStore(options: {
  baseUrl: string;
  collection: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): VectorStore {
  const base = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !options.collection.trim()
  )
    throw new TypeError("Invalid Qdrant configuration");
  const root = new URL(
    `collections/${encodeURIComponent(options.collection)}`,
    base.href.endsWith("/") ? base : `${base.href}/`,
  );
  const request = async (
    url: URL,
    method: string,
    body: object | undefined,
    signal: AbortSignal,
  ): Promise<Response> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (options.apiKey) headers["api-key"] = options.apiKey;
    return (options.fetch ?? fetch)(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
      redirect: "error",
    });
  };
  const pointsUrl = (suffix: string) =>
    new URL(`${root.pathname}/points${suffix}`, root.origin);
  const assertOk = (response: Response) => {
    if (!response.ok)
      throw new Error(`Qdrant request failed with status ${response.status}`);
  };
  return {
    async ensureCollection(dimensions, signal) {
      if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 65536)
        throw new RangeError("Invalid vector dimensions");
      const existing = await request(root, "GET", undefined, signal);
      if (existing.status === 404) {
        const created = await request(
          root,
          "PUT",
          { vectors: { size: dimensions, distance: "Cosine" } },
          signal,
        );
        assertOk(created);
        return;
      }
      assertOk(existing);
      let data: unknown;
      try {
        data = JSON.parse(await readBoundedText(existing, 1_048_576));
      } catch {
        throw new Error("Invalid Qdrant collection response");
      }
      const result = data as {
        result?: {
          config?: {
            params?: { vectors?: { size?: unknown; distance?: unknown } };
          };
        };
      };
      const vectors = result?.result?.config?.params?.vectors;
      if (
        !vectors ||
        vectors.size !== dimensions ||
        vectors.distance !== "Cosine"
      )
        throw new Error("Qdrant collection vector configuration mismatch");
    },
    async upsert(chunks, signal) {
      if (!chunks.length) return;
      // 在首个 await 前复制入参，保证校验、点 ID 和写入使用同一快照。
      const snapshot = structuredClone(chunks);
      const dimensions = snapshot[0]!.vector.length;
      if (
        !dimensions ||
        snapshot.length > 1000 ||
        snapshot.some(
          (chunk) =>
            !chunk.knowledgeBaseId.trim() ||
            !chunk.documentId.trim() ||
            !chunk.chunkId.trim() ||
            !chunk.content ||
            chunk.vector.length !== dimensions ||
            !chunk.vector.every(Number.isFinite),
        )
      )
        throw new TypeError("Invalid vector chunks");
      const ids = new Set<string>();
      const points = await Promise.all(
        snapshot.map(async (chunk) => {
          const id = await pointId(chunk);
          if (ids.has(id)) throw new TypeError("Duplicate vector chunk ID");
          ids.add(id);
          return {
            id,
            vector: chunk.vector,
            payload: {
              knowledgeBaseId: chunk.knowledgeBaseId,
              documentId: chunk.documentId,
              chunkId: chunk.chunkId,
              content: chunk.content,
              ...(chunk.chunkIndex === undefined
                ? {}
                : { chunkIndex: chunk.chunkIndex }),
            },
          };
        }),
      );
      const response = await request(
        pointsUrl("?wait=true"),
        "PUT",
        { points },
        signal,
      );
      assertOk(response);
    },
    async deleteDocument(knowledgeBaseId, documentId, signal) {
      if (!knowledgeBaseId.trim() || !documentId.trim())
        throw new TypeError("Knowledge base and document IDs are required");
      const response = await request(
        pointsUrl("/delete?wait=true"),
        "POST",
        {
          filter: {
            must: [
              { key: "knowledgeBaseId", match: { value: knowledgeBaseId } },
              { key: "documentId", match: { value: documentId } },
            ],
          },
        },
        signal,
      );
      assertOk(response);
    },
  };
}
