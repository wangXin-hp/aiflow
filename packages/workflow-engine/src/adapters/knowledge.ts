import type { KnowledgeAdapterV2 } from "../v2/nodes.js";

type Query = Parameters<KnowledgeAdapterV2["retrieve"]>[0];
type Hit = Awaited<ReturnType<KnowledgeAdapterV2["retrieve"]>>[number];
type Search = (query: Query) => Promise<Hit[]>;
/** 组合向量和全文检索；混合模式以倒数排名融合，不把不同来源的原始分数直接相加。 */
export function createHybridKnowledgeAdapter(options: {
  vectorSearch: Search;
  textSearch: Search;
}): KnowledgeAdapterV2 {
  return {
    async retrieve(query) {
      if (query.mode === "vector")
        return (await options.vectorSearch(query))
          .filter((hit) => hit.score >= (query.threshold ?? 0))
          .slice(0, query.topK);
      if (query.mode === "fulltext")
        return (await options.textSearch(query))
          .filter((hit) => hit.score >= (query.threshold ?? 0))
          .slice(0, query.topK);
      // 融合前扩大候选集合，否则两路共同命中的低排名结果无法进入融合。
      const candidates = { ...query, topK: Math.min(query.topK * 3, 300) };
      const [vector, text] = await Promise.all([
        options.vectorSearch(candidates),
        options.textSearch(candidates),
      ]);
      const combined = new Map<string, Hit>();
      for (const list of [vector, text])
        list
          .filter((hit) => hit.score >= (query.threshold ?? 0))
          .forEach((hit, index) => {
            const key = JSON.stringify([hit.documentId, hit.chunkId]);
            const prior = combined.get(key);
            combined.set(key, {
              ...hit,
              score: (prior?.score ?? 0) + 1 / (60 + index + 1),
            });
          });
      return [...combined.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, query.topK);
    },
  };
}
