import { Global, Module } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PRISMA_ADAPTER_FACTORY,
  PrismaService,
  type PrismaAdapterFactory,
} from "./prisma.service.js";

/** 仅在 AppModule 导入一次，业务模块复用导出的单例客户端。 */
@Global()
@Module({
  providers: [
    {
      provide: PRISMA_ADAPTER_FACTORY,
      useValue: ((options) =>
        new PrismaPg(options)) satisfies PrismaAdapterFactory,
    },
    PrismaService,
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
