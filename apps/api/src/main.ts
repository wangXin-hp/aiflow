import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module.js";
import type { Environment } from "./config/environment.js";
import { configureHttpApplication } from "./common/http-application.js";

/** 配置校验在模块初始化时完成，监听地址和端口仅使用校验后的值。 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // 让进程关闭信号触发 PrismaService 的资源释放钩子。
  app.enableShutdownHooks();
  const configuration = app.get(ConfigService<Environment, true>);
  configureHttpApplication(app);
  await app.listen(
    configuration.get("API_PORT", { infer: true }),
    configuration.get("API_HOST", { infer: true }),
  );
}
void bootstrap();
