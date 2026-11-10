import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER } from "@nestjs/core";
import { resolve } from "node:path";
import { loadEnvironment } from "./config/environment.js";
import { PrismaModule } from "./database/prisma.module.js";
import { HealthController } from "./health.js";
import { AuthModule } from "./auth/auth.module.js";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { WorkflowModule } from "./workflows/workflow.module.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // API 的工作目录可为仓库根目录或 apps/api，始终读取根目录配置。
      envFilePath: resolve(import.meta.dirname, "../../../.env"),
      validate: loadEnvironment,
      skipProcessEnv: true,
    }),
    PrismaModule,
    AuthModule,
    WorkflowModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
