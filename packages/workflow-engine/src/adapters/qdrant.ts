import type { KnowledgeAdapterV2 } from "../v2/nodes.js";
import { createHybridKnowledgeAdapter } from "./knowledge.js";
import { readBoundedText } from "./response.js";

type Query = Parameters<KnowledgeAdapterV2["retrieve"]>[0];
type Hit = Awaited<ReturnType<KnowledgeAdapterV2["retrieve"]>>[number];
type Point = {
  id: string | number;
  score?: number;
  payload: {
    knowledgeBaseId: string;
    documentId: string;
    content: string;
    chunkId?: string;
    chunkIndex?: number;
  };
};
/** Ollama 嵌入与 Qdrant 分离；全文扫描有上限，超限显式报错而非伪装成完整结果。 */
export function createQdrantKnowledgeAdapter(options: {
  baseUrl: string;
  collection: string;
  embed: (text: string, signal: AbortSignal) => Promise<number[]>;
  fetch?: typeof fetch;
  apiKey?: string;
  maxScan?: number;
  maxResponseBytes?: number;
}): KnowledgeAdapterV2 {
  const base = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    !options.collection.trim()
  )
    throw new TypeError("Invalid Qdrant configuration");
  const root = new URL(
    `collections/${encodeURIComponent(options.collection)}/points/`,
    base.href.endsWith("/") ? base : `${base.href}/`,
  );
  const maxScan = options.maxScan ?? 1000;
  if (!Number.isInteger(maxScan) || maxScan < 1 || maxScan > 100_000)
    throw new RangeError("Invalid Qdrant scan limit");
  async function post(
    path: string,
    body: object,
    signal: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (options.apiKey) headers["api-key"] = options.apiKey;
    const response = await (options.fetch ?? fetch)(new URL(path, root), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`Qdrant request failed with status ${response.status}`);
    return JSON.parse(
      await readBoundedText(response, options.maxResponseBytes ?? 4_194_304),
    ) as unknown;
  }
  const filter = (q: Query) => ({
    must: [{ key: "knowledgeBaseId", match: { any: q.knowledgeBaseIds } }],
  });
  function mapPoints(points: unknown, q: Query): Hit[] {
    if (!Array.isArray(points))
      throw new Error("Invalid Qdrant points response");
    return points.map((raw: unknown) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        !("id" in raw) ||
        !("payload" in raw) ||
        !raw.payload ||
        typeof raw.payload !== "object"
      )
        throw new Error("Invalid Qdrant point");
      const point = raw as Point;
      const payload = point.payload;
      if (
        !q.knowledgeBaseIds.includes(payload.knowledgeBaseId) ||
        typeof payload.documentId !== "string" ||
        typeof payload.content !== "string" ||
        (payload.chunkId !== undefined &&
          (typeof payload.chunkId !== "string" || !payload.chunkId)) ||
        (payload.chunkIndex !== undefined &&
          (!Number.isSafeInteger(payload.chunkIndex) ||
            payload.chunkIndex < 0)) ||
        !["string", "number"].includes(typeof point.id)
      )
        throw new Error("Invalid Qdrant point payload");
      if (
        point.score !== undefined &&
        (typeof point.score !== "number" || !Number.isFinite(point.score))
      )
        throw new Error("Invalid Qdrant score");
      return {
        documentId: payload.documentId,
        knowledgeBaseId: payload.knowledgeBaseId,
        ...(payload.chunkIndex === undefined
          ? {}
          : { chunkIndex: payload.chunkIndex }),
        chunkId: payload.chunkId ?? String(point.id),
        content: payload.content,
        score: point.score ?? 0,
      };
    });
  }
  async function vectorSearch(q: Query): Promise<Hit[]> {
    const vector = await options.embed(q.query, q.signal);
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      !vector.every(Number.isFinite)
    )
      throw new Error("Invalid query vector");
    const data = await post(
      "query",
      {
        query: vector,
        filter: filter(q),
        limit: q.topK,
        score_threshold: q.threshold ?? 0,
        with_payload: true,
      },
      q.signal,
    );
    if (
      !data ||
      typeof data !== "object" ||
      !("result" in data) ||
      !data.result ||
      typeof data.result !== "object" ||
      !("points" in data.result)
    )
      throw new Error("Invalid Qdrant response");
    return mapPoints(data.result.points, q);
  }
  async function textSearch(q: Query): Promise<Hit[]> {
    const terms = q.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    if (!terms.length) return [];
    const found: Hit[] = [];
    let offset: string | number | undefined;
    let scanned = 0;
    for (;;) {
      const data = await post(
        "scroll",
        {
          filter: filter(q),
          limit: Math.min(100, maxScan - scanned),
          with_payload: true,
          with_vector: false,
          ...(offset === undefined ? {} : { offset }),
        },
        q.signal,
      );
      if (
        !data ||
        typeof data !== "object" ||
        !("result" in data) ||
        !data.result ||
        typeof data.result !== "object" ||
        !("points" in data.result) ||
        !("next_page_offset" in data.result)
      )
        throw new Error("Invalid Qdrant scroll response");
      const points = mapPoints(data.result.points, q);
      scanned += points.length;
      for (const point of points) {
        const content = point.content.toLocaleLowerCase();
        const score =
          terms.filter((term) => content.includes(term)).length / terms.length;
        if (score > 0) found.push({ ...point, score });
      }
      const next: unknown = data.result.next_page_offset;
      if (next === null || next === undefined) break;
      if (
        scanned >= maxScan ||
        points.length === 0 ||
        (typeof next !== "string" && typeof next !== "number") ||
        next === offset
      )
        throw new Error("Qdrant fulltext scan limit or invalid pagination");
      offset = next;
    }
    return found.sort((a, b) => b.score - a.score).slice(0, q.topK);
  }
  return createHybridKnowledgeAdapter({ vectorSearch, textSearch });
}
