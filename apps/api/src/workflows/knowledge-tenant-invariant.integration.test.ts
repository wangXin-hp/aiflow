import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// PostgreSQL/Prisma 外键约束名使用固定的 fkey 后缀。
// cspell:ignore fkey

const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow_test";
if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("Integration test requires a dedicated test database");
}

describe("knowledge document tenant invariant (real PostgreSQL)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("wraps the foreign-key replacement migration in one transaction", () => {
    const migration = readFileSync(
      resolve(
        import.meta.dirname,
        "../../prisma/migrations/20261109105430_enforce_knowledge_document_tenant/migration.sql",
      ),
      "utf8",
    ).trim();

    expect(migration).toMatch(/^BEGIN;/);
    expect(migration).toMatch(/COMMIT;$/);
  });

  it("rejects a document owned by a different user than its knowledge base", async () => {
    const client = await pool.connect();
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const knowledgeBaseId = randomUUID();

    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt")
         VALUES ($1, $2, 'hash', NOW()), ($3, $4, 'hash', NOW())`,
        [
          ownerA,
          `tenant-a-${ownerA}@example.com`,
          ownerB,
          `tenant-b-${ownerB}@example.com`,
        ],
      );
      await client.query(
        `INSERT INTO "KnowledgeBase"
           ("id", "ownerId", "name", "qdrantCollection", "updatedAt")
         VALUES ($1, $2, 'B knowledge base', $3, NOW())`,
        [knowledgeBaseId, ownerB, `kb-${knowledgeBaseId}`],
      );

      // 数据库必须独立于应用层校验 ownerId 与 knowledgeBaseId 的租户一致性。
      await expect(
        client.query(
          `INSERT INTO "KnowledgeDocument"
             ("id", "ownerId", "knowledgeBaseId", "name", "updatedAt")
           VALUES ($1, $2, $3, 'cross-tenant document', NOW())`,
          [randomUUID(), ownerA, knowledgeBaseId],
        ),
      ).rejects.toMatchObject({
        code: "23503",
        constraint: "KnowledgeDocument_knowledgeBaseId_ownerId_fkey",
      });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("accepts a document whose owner matches its knowledge base", async () => {
    const client = await pool.connect();
    const ownerId = randomUUID();
    const knowledgeBaseId = randomUUID();

    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO "User" ("id", "email", "passwordHash", "updatedAt")
         VALUES ($1, $2, 'hash', NOW())`,
        [ownerId, `tenant-match-${ownerId}@example.com`],
      );
      await client.query(
        `INSERT INTO "KnowledgeBase"
           ("id", "ownerId", "name", "qdrantCollection", "updatedAt")
         VALUES ($1, $2, 'Matching knowledge base', $3, NOW())`,
        [knowledgeBaseId, ownerId, `kb-${knowledgeBaseId}`],
      );

      const result = await client.query(
        `INSERT INTO "KnowledgeDocument"
           ("id", "ownerId", "knowledgeBaseId", "name", "updatedAt")
         VALUES ($1, $2, $3, 'matching document', NOW())
         RETURNING "id"`,
        [randomUUID(), ownerId, knowledgeBaseId],
      );
      expect(result.rowCount).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
