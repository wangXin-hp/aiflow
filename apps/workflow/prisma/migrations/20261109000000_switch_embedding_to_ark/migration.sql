-- 切换嵌入服务提供商：Ollama -> 火山方舟（Ark）
ALTER TABLE "knowledge_bases" ALTER COLUMN "embeddingModel" SET DEFAULT 'doubao-embedding-large-text-240915';
ALTER TABLE "knowledge_bases" ALTER COLUMN "embeddingProvider" SET DEFAULT 'ark';

-- 更新已有知识库的嵌入配置
UPDATE "knowledge_bases"
SET "embeddingModel" = 'doubao-embedding-large-text-240915',
    "embeddingProvider" = 'ark';
