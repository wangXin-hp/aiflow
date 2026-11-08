import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { resolve } from "node:path";
import { loadEnvironment } from "./config/environment.js";
import { HealthController } from "./health.js";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // API 的工作目录可为仓库根目录或 apps/api，始终读取根目录配置。
      envFilePath: resolve(import.meta.dirname, "../../../.env"),
      validate: loadEnvironment,
      skipProcessEnv: true,
    }),
  ],
  controllers: [HealthController],
})
export class AppModule {}
