import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { loadEnvironment, type Environment } from "../config/environment.js";
import type { PrismaService } from "../database/prisma.service.js";
import { RunAdaptersFactory } from "./run-adapters.factory.js";

describe("RunAdaptersFactory", () => {
  it("runs owner-scoped fulltext retrieval without Ark embeddings", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            points: [
              {
                id: "chunk",
                payload: {
                  knowledgeBaseId: "owned",
                  documentId: "doc",
                  content: "private answer",
                },
              },
            ],
            next_page_offset: null,
          },
        }),
        { status: 200 },
      ),
    );
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: "owned", qdrantCollection: "owned_collection" },
      ]);
    const factory = new RunAdaptersFactory(
      new ConfigService<Environment, true>(
        loadEnvironment({
          NODE_ENV: "test",
          JWT_SECRET: "test-secret-at-least-thirty-two-characters",
        }),
      ),
      { knowledgeBase: { findMany } } as unknown as PrismaService,
    );
    const node = {
      id: "knowledge",
      type: "knowledge" as const,
      position: { x: 0, y: 0 },
      config: {
        knowledgeBaseIds: ["owned"],
        retrievalMode: "fulltext" as const,
        topK: 3,
        values: {},
      },
    };
    try {
      const result = await factory
        .registry("owner")
        .get("knowledge")
        .execute(
          node,
          { query: "answer" },
          { signal: new AbortController().signal },
        );
      expect(result.output.results).toMatchObject([
        { documentId: "doc", knowledgeBaseId: "owned" },
      ]);
      expect(findMany).toHaveBeenCalledWith({
        where: { id: { in: ["owned"] }, ownerId: "owner" },
        select: { id: true, qdrantCollection: true },
      });
      expect(send).toHaveBeenCalledOnce();
      expect(String(send.mock.calls[0]?.[0])).toContain("/points/scroll");
      findMany.mockResolvedValue([]);
      await expect(
        factory
          .registry("owner")
          .get("knowledge")
          .execute(
            node,
            { query: "answer" },
            { signal: new AbortController().signal },
          ),
      ).rejects.toThrow("not available");
      expect(send).toHaveBeenCalledOnce();
      findMany.mockResolvedValue([
        { id: "owned", qdrantCollection: "owned_collection" },
      ]);
      for (const retrievalMode of ["vector", "hybrid"] as const) {
        await expect(
          factory
            .registry("owner")
            .get("knowledge")
            .execute(
              { ...node, config: { ...node.config, retrievalMode } },
              { query: "answer" },
              { signal: new AbortController().signal },
            ),
        ).rejects.toThrow("embedding is not configured");
      }
      expect(send).toHaveBeenCalledOnce();
    } finally {
      send.mockRestore();
    }
  });

  it("requires an owned knowledge base before cloud embedding or Qdrant fetch", async () => {
    const send = vi.spyOn(globalThis, "fetch");
    const prisma = {
      knowledgeBase: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const config = new ConfigService<Environment, true>(
      loadEnvironment({
        NODE_ENV: "test",
        JWT_SECRET: "test-secret-at-least-thirty-two-characters",
        ARK_API_KEY: "fake-key",
        ARK_EMBEDDING_MODEL_ID: "embedding-model",
      }),
    );
    const factory = new RunAdaptersFactory(config, prisma);
    const node = {
      id: "knowledge",
      type: "knowledge" as const,
      position: { x: 0, y: 0 },
      config: {
        knowledgeBaseIds: ["other-base"],
        retrievalMode: "vector" as const,
        topK: 3,
        values: {},
      },
    };
    await expect(
      factory
        .registry("owner-1")
        .get("knowledge")
        .execute(
          node,
          { query: "private" },
          { signal: new AbortController().signal },
        ),
    ).rejects.toThrow("not available");
    expect(prisma.knowledgeBase.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["other-base"] }, ownerId: "owner-1" },
      select: { id: true, qdrantCollection: true },
    });
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });

  it("denies HTTP targets until an explicit host is configured", async () => {
    const config = new ConfigService<Environment, true>(
      loadEnvironment({
        NODE_ENV: "test",
        JWT_SECRET: "test-secret-at-least-thirty-two-characters",
      }),
    );
    const factory = new RunAdaptersFactory(config, {} as PrismaService);
    const node = {
      id: "http",
      type: "http" as const,
      position: { x: 0, y: 0 },
      config: { method: "GET" as const, values: {} },
    };
    await expect(
      factory
        .registry("owner")
        .get("http")
        .execute(
          node,
          { url: "http://127.0.0.1/private" },
          { signal: new AbortController().signal },
        ),
    ).rejects.toThrow("not allowed");
  });

  it("uses cloud embeddings and the owned knowledge base collection", async () => {
    const calls: string[] = [];
    const send = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/embeddings"))
          return new Response(
            JSON.stringify({ data: [{ embedding: [1, 0] }] }),
            { status: 200 },
          );
        return new Response(
          JSON.stringify({
            result: {
              points: [
                {
                  id: "chunk-1",
                  score: 0.9,
                  payload: {
                    knowledgeBaseId: "owned",
                    documentId: "doc",
                    content: "answer",
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      });
    try {
      const prisma = {
        knowledgeBase: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: "owned", qdrantCollection: "owned_collection" },
            ]),
        },
      } as unknown as PrismaService;
      const config = new ConfigService<Environment, true>(
        loadEnvironment({
          NODE_ENV: "test",
          JWT_SECRET: "test-secret-at-least-thirty-two-characters",
          ARK_API_KEY: "fake-key",
          ARK_EMBEDDING_MODEL_ID: "embedding-model",
        }),
      );
      const factory = new RunAdaptersFactory(config, prisma);
      const node = {
        id: "knowledge",
        type: "knowledge" as const,
        position: { x: 0, y: 0 },
        config: {
          knowledgeBaseIds: ["owned"],
          retrievalMode: "vector" as const,
          topK: 3,
          values: {},
        },
      };
      const result = await factory
        .registry("owner")
        .get("knowledge")
        .execute(
          node,
          { query: "question" },
          { signal: new AbortController().signal },
        );
      expect(result.output.results).toMatchObject([
        { knowledgeBaseId: "owned", documentId: "doc" },
      ]);
      expect(calls[0]).toContain("ark.cn-beijing.volces.com/api/v3/embeddings");
      expect(calls[1]).toContain("/collections/owned_collection/points/query");
    } finally {
      send.mockRestore();
    }
  });
});
