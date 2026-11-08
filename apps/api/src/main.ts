import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";
import type { Environment } from "./config/environment.js";

/** 配置校验在模块初始化时完成，监听地址和端口仅使用校验后的值。 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const configuration = app.get(ConfigService<Environment, true>);
  app.setGlobalPrefix("api");
  await app.listen(
    configuration.get("API_PORT", { infer: true }),
    configuration.get("API_HOST", { infer: true }),
  );
}
void bootstrap();
