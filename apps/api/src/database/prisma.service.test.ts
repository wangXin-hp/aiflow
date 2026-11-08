import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import { loadEnvironment } from "../config/environment.js";
import { PrismaService, type PrismaAdapterFactory } from "./prisma.service.js";

function createAdapter() {
  // 仅替换数据库 I/O 边界，保留真实 PrismaClient 的连接和资源释放流程。
  const driver = {
    provider: "postgres" as const,
    adapterName: "lifecycle-test",
    queryRaw: vi.fn().mockRejectedValue(new Error("Unexpected query")),
    executeRaw: vi.fn().mockRejectedValue(new Error("Unexpected query")),
    executeScript: vi.fn().mockRejectedValue(new Error("Unexpected script")),
    startTransaction: vi
      .fn()
      .mockRejectedValue(new Error("Unexpected transaction")),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  const connect = vi.fn().mockResolvedValue(driver);
  const factory = vi.fn<PrismaAdapterFactory>(() => ({
    provider: "postgres",
    adapterName: "lifecycle-test",
    connect,
  }));
  return { factory, connect, dispose: driver.dispose };
}

function configuration(source: NodeJS.ProcessEnv = {}) {
  return new ConfigService(
    loadEnvironment({ JWT_SECRET: "a".repeat(32), ...source }),
  );
}

describe("PrismaService", () => {
  it("connects on module init and closes on shutdown exactly once", async () => {
    const adapter = createAdapter();
    const service = new PrismaService(configuration(), adapter.factory);

    expect(adapter.connect).not.toHaveBeenCalled();
    await service.onModuleInit();
    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(adapter.dispose).not.toHaveBeenCalled();

    await service.onApplicationShutdown();
    expect(adapter.connect).toHaveBeenCalledTimes(1);
    expect(adapter.dispose).toHaveBeenCalledTimes(1);
  });

  it("configures the adapter pool from validated environment values", () => {
    const adapter = createAdapter();
    new PrismaService(
      configuration({
        DATABASE_URL: "postgresql://test:test@localhost:5432/test",
        DATABASE_POOL_MAX: "4",
        DATABASE_CONNECTION_TIMEOUT_MS: "2000",
        DATABASE_IDLE_TIMEOUT_MS: "10000",
      }),
      adapter.factory,
    );

    expect(adapter.factory).toHaveBeenCalledExactlyOnceWith({
      connectionString: "postgresql://test:test@localhost:5432/test",
      max: 4,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 10000,
    });
  });

  it("propagates adapter connection failures during application initialization", async () => {
    const adapter = createAdapter();
    adapter.connect.mockRejectedValue(new Error("Database unavailable"));
    const service = new PrismaService(configuration(), adapter.factory);

    await expect(service.onModuleInit()).rejects.toThrow(
      "Database unavailable",
    );
    expect(adapter.connect).toHaveBeenCalledTimes(1);
  });
});
