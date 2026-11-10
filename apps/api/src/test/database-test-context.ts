import { PrismaPg } from "@prisma/adapter-pg";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { loadEnvironment, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";

const fallbackTestDatabaseUrl =
  "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow_test";

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL ?? fallbackTestDatabaseUrl;
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  // 测试清理会删除追踪用户的关联数据；数据库名必须显式以 _test 结尾，禁止误连开发或生产库。
  if (
    process.env.NODE_ENV === "production" ||
    !/^postgres(?:ql)?:$/u.test(url.protocol) ||
    !databaseName.toLowerCase().endsWith("_test")
  ) {
    throw new Error(
      "Database integration tests require a PostgreSQL database ending in _test",
    );
  }
  return value;
}

export interface DatabaseTestUser {
  id: string;
  email: string;
}

/**
 * 为 PostgreSQL 集成测试提供真实 Prisma 生命周期与按用户清理。
 * helper 只删除自己创建并追踪的随机用户，避免全表清理影响并行测试。
 */
export function createDatabaseTestContext() {
  const databaseUrl = requireTestDatabaseUrl();
  const configuration = new ConfigService<Environment, true>(
    loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      JWT_SECRET: "database-integration-test-secret-32-characters",
    }),
  );
  const prisma = new PrismaService(
    configuration,
    (options) => new PrismaPg(options),
  );
  const userIds = new Set<string>();

  return {
    prisma,
    async connect(): Promise<void> {
      await prisma.onModuleInit();
    },
    async createUser(label: string): Promise<DatabaseTestUser> {
      const id = randomUUID();
      const email = `${label}-${id}@example.com`;
      const user = await prisma.user.create({
        data: {
          id,
          email,
          passwordHash: "integration-test-hash",
          emailVerifiedAt: new Date(),
        },
        select: { id: true, email: true },
      });
      userIds.add(user.id);
      return user;
    },
    async cleanup(): Promise<void> {
      const ids = [...userIds];
      if (ids.length === 0) return;
      // RESTRICT 外键要求从叶子向所有者删除；每个条件都限定为本 helper 追踪的 owner。
      await prisma.$transaction([
        prisma.workflowVersion.deleteMany({
          where: { workflow: { ownerId: { in: ids } } },
        }),
        prisma.workflow.deleteMany({ where: { ownerId: { in: ids } } }),
        prisma.knowledgeDocument.deleteMany({
          where: { ownerId: { in: ids } },
        }),
        prisma.knowledgeBase.deleteMany({ where: { ownerId: { in: ids } } }),
        prisma.user.deleteMany({ where: { id: { in: ids } } }),
      ]);
      userIds.clear();
    },
    async close(): Promise<void> {
      await prisma.onApplicationShutdown();
    },
  };
}
