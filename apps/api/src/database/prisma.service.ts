import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PoolConfig } from "pg";
import type { Environment } from "../config/environment.js";
import { PrismaClient, type Prisma } from "../generated/prisma/client.js";

/** 数据库适配器工厂只创建连接边界；PrismaService 统一持有和释放客户端。 */
export const PRISMA_ADAPTER_FACTORY = Symbol("PRISMA_ADAPTER_FACTORY");
export type PrismaAdapterFactory = (
  options: PoolConfig,
) => NonNullable<Prisma.PrismaClientOptions["adapter"]>;

/** 全局唯一的 Prisma 客户端；禁止业务模块再次注册或自行创建客户端。 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(
    @Inject(ConfigService) configuration: ConfigService<Environment, true>,
    @Inject(PRISMA_ADAPTER_FACTORY) adapterFactory: PrismaAdapterFactory,
  ) {
    super({
      // pg 连接池使用已校验的数值；适配器拥有内部池，断开客户端时一并释放。
      adapter: adapterFactory({
        connectionString: configuration.get("DATABASE_URL", { infer: true }),
        max: configuration.get("DATABASE_POOL_MAX", { infer: true }),
        connectionTimeoutMillis: configuration.get(
          "DATABASE_CONNECTION_TIMEOUT_MS",
          { infer: true },
        ),
        idleTimeoutMillis: configuration.get("DATABASE_IDLE_TIMEOUT_MS", {
          infer: true,
        }),
      }),
    });
  }

  /** 适配器初始化失败向上抛出；pg 池会在首次查询时建立实际数据库连接。 */
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  /** Nest 关闭应用或收到关闭信号后，释放客户端及其连接池。 */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
