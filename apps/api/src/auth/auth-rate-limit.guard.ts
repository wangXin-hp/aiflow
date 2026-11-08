import {
  applyDecorators,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { SkipThrottle, ThrottlerGuard } from "@nestjs/throttler";
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { Environment } from "../config/environment.js";
import { ApiError } from "../common/api-error.js";

type RateKind = "login" | "resend";
const RATE_KIND = Symbol("AUTH_RATE_KIND");

/** IP 由 Nest ThrottlerGuard 限制；额外按端点及规范化邮箱计数，防止切换来源 IP 绕过。 */
export function AuthRateLimit(kind: RateKind) {
  return applyDecorators(
    SetMetadata(RATE_KIND, kind),
    SkipThrottle({ login: kind !== "login", resend: kind !== "resend" }),
    UseGuards(ThrottlerGuard, AuthEmailRateLimitGuard),
  );
}

/** 两个限流器均为进程内状态，重启会清空，多实例部署前必须换成共享存储。 */
@Injectable()
export class AuthEmailRateLimitGuard implements CanActivate {
  private readonly counters = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService)
    private readonly configuration: ConfigService<Environment, true>,
  ) {}
  canActivate(context: ExecutionContext): boolean {
    const kind = this.reflector.get<RateKind>(RATE_KIND, context.getHandler());
    const request = context.switchToHttp().getRequest<Request>();
    const body = request.body as { email?: unknown } | undefined;
    // 非字符串邮箱仍由 IP 配额约束，并交给共享请求契约返回安全校验错误。
    if (!kind || typeof body?.email !== "string") return true;
    const now = Date.now();
    for (const [key, entry] of this.counters)
      if (entry.expiresAt <= now) this.counters.delete(key);
    const prefix = kind === "login" ? "AUTH_LOGIN" : "AUTH_RESEND";
    const limit = this.configuration.get(`${prefix}_RATE_LIMIT`, {
      infer: true,
    });
    const windowMs = this.configuration.get(`${prefix}_RATE_WINDOW_MS`, {
      infer: true,
    });
    // 哈希键不保留邮箱明文；邮箱规范化必须和输入契约保持一致。
    const key = createHash("sha256")
      .update(`${kind}:${body.email.trim().toLowerCase()}`)
      .digest("hex");
    const entry = this.counters.get(key) ?? {
      count: 0,
      expiresAt: now + windowMs,
    };
    this.counters.set(key, entry);
    if (entry.count >= limit) {
      context
        .switchToHttp()
        .getResponse<Response>()
        .setHeader("Retry-After", Math.ceil((entry.expiresAt - now) / 1000));
      throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试");
    }
    entry.count++;
    return true;
  }
}
