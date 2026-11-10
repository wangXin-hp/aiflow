import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import type { Environment } from "../config/environment.js";

/** 生产入口与 E2E 共用 HTTP 接线，确保 Cookie 和精确 CORS 白名单不会在测试中被遗漏。 */
export function configureHttpApplication(app: INestApplication): void {
  const configuration = app.get(ConfigService<Environment, true>);
  const origin = new URL(configuration.get("WEB_PUBLIC_URL", { infer: true }))
    .origin;
  app.setGlobalPrefix("api");
  app.use(cookieParser());
  app.enableCors({
    credentials: true,
    origin: (
      requestOrigin: string | undefined,
      callback: (error: Error | null, allow: boolean) => void,
    ) => callback(null, requestOrigin === origin),
  });
  // CORS 必须先于解析器；可信前端才能读取固定的 400/413 错误。2 MiB 限制单次图解析资源。
  (app as NestExpressApplication).useBodyParser("json", { limit: "2mb" });
}
