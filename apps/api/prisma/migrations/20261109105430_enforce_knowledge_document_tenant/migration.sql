-- 文档必须与知识库属于同一用户；保留 ownerId 可直接按租户过滤。
ALTER TABLE "KnowledgeDocument"
DROP CONSTRAINT "KnowledgeDocument_knowledgeBaseId_fkey";

DROP INDEX "KnowledgeDocument_knowledgeBaseId_createdAt_id_idx";

CREATE UNIQUE INDEX "KnowledgeBase_id_ownerId_key"
ON "KnowledgeBase"("id", "ownerId");

CREATE INDEX "KnowledgeDocument_knowledgeBaseId_ownerId_createdAt_id_idx"
ON "KnowledgeDocument"("knowledgeBaseId", "ownerId", "createdAt", "id");

ALTER TABLE "KnowledgeDocument"
ADD CONSTRAINT "KnowledgeDocument_knowledgeBaseId_ownerId_fkey"
FOREIGN KEY ("knowledgeBaseId", "ownerId")
REFERENCES "KnowledgeBase"("id", "ownerId")
ON DELETE RESTRICT ON UPDATE CASCADE;
