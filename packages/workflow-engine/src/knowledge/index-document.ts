import { splitMarkdown, splitText, type ChunkingOptions } from "./chunking.js";
import type { VectorChunk, VectorStore } from "./store.js";

/** 切分并依次向量化，全部成功后一次写入；该操作不会自动删除已有的旧分块。 */
export async function indexKnowledgeDocument(
  options: ChunkingOptions & {
    knowledgeBaseId: string;
    documentId: string;
    content: string;
    format?: "text" | "markdown";
    embed: (text: string, signal: AbortSignal) => Promise<number[]>;
    store: VectorStore;
    signal: AbortSignal;
  },
): Promise<{ chunks: number }> {
  // 固定运行范围及依赖，防止异步向量化期间调用方改变当前索引任务。
  const {
    knowledgeBaseId,
    documentId,
    content,
    format,
    chunkSize,
    chunkOverlap,
    embed,
    store,
    signal,
  } = options;
  if (!knowledgeBaseId.trim() || !documentId.trim())
    throw new TypeError("Knowledge base and document IDs are required");
  const chunks =
    format === "markdown"
      ? splitMarkdown(content, { chunkSize, chunkOverlap })
      : splitText(content, { chunkSize, chunkOverlap });
  if (chunks.length > 1000)
    throw new RangeError("Document has too many chunks");
  const vectors: VectorChunk[] = [];
  let dimensions: number | undefined;
  for (const chunk of chunks) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const vector = await embed(chunk.content, signal);
    if (
      !Array.isArray(vector) ||
      !vector.length ||
      !vector.every(Number.isFinite) ||
      (dimensions !== undefined && vector.length !== dimensions)
    )
      throw new TypeError("Invalid embedding vector");
    dimensions = vector.length;
    vectors.push({
      knowledgeBaseId,
      documentId,
      chunkId: `${documentId}:${chunk.index}`,
      chunkIndex: chunk.index,
      content: chunk.content,
      vector: [...vector],
    });
  }
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  await store.upsert(vectors, signal);
  return { chunks: vectors.length };
}
