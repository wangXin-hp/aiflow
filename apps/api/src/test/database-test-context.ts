import { PrismaPg } from "@prisma/adapter-pg";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { loadEnvironment, type Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";

const fallbackTestDatabaseUrl =
  "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow_test";

function requireTestDatabaseUrl(override?: string): string {
  const value =
    override ?? process.env.TEST_DATABASE_URL ?? fallbackTestDatabaseUrl;
  // pg 会把 NUL 解释为启动参数分隔符；在 URL 解析前拒绝编码和字面形式，避免伪造路径后缀。
  if (value.includes("\0") || /%00/iu.test(value)) {
    throw new Error("Database integration test URL must not contain NUL");
  }
  const url = new URL(value);
  const databaseName = decodeURIComponent(url.pathname.slice(1));
  // 测试清理会删除追踪用户的关联数据；数据库名必须显式以 _test 结尾，禁止误连开发或生产库。
  if (
    process.env.NODE_ENV === "production" ||
    !/^postgres(?:ql)?:$/u.test(url.protocol) ||
    !/^[a-z0-9][a-z0-9_]*_test$/u.test(databaseName) ||
    Buffer.byteLength(databaseName, "utf8") > 63
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
export function createDatabaseTestContext(databaseUrlOverride?: string) {
  const databaseUrl = requireTestDatabaseUrl(databaseUrlOverride);
  const configuration = new ConfigService<Environment, true>(
    loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      JWT_SECRET: "database-integration-test-secret-32-characters",
    }),
  );
  const rawPrisma = new PrismaService(
    configuration,
    (options) => new PrismaPg(options),
  );
  const userIds = new Set<string>();
  let verified = false;

  function requireVerifiedPrisma(): PrismaService {
    if (!verified) {
      throw new Error(
        "Database test context must verify current_database() before use",
      );
    }
    return rawPrisma;
  }

  return {
    /** HTTP E2E 与测试仓储必须连接同一条已预检的测试库 URL。 */
    databaseUrl,
    get prisma(): PrismaService {
      return requireVerifiedPrisma();
    },
    async connect(): Promise<void> {
      await rawPrisma.onModuleInit();
      try {
        const [actual] = await rawPrisma.$queryRaw<
          Array<{ databaseName: string }>
        >`SELECT current_database() AS "databaseName"`;
        const expected = decodeURIComponent(
          new URL(databaseUrl).pathname.slice(1),
        );
        if (actual?.databaseName !== expected) {
          throw new Error(
            `Database target mismatch: expected ${expected}, received ${actual?.databaseName ?? "unknown"}`,
          );
        }
        verified = true;
      } catch (error) {
        await rawPrisma.onApplicationShutdown();
        throw error;
      }
    },
    async createUser(label: string): Promise<DatabaseTestUser> {
      const prisma = requireVerifiedPrisma();
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
      const prisma = requireVerifiedPrisma();
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
      verified = false;
      await rawPrisma.onApplicationShutdown();
    },
  };
}
