import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import type { Environment } from "../config/environment.js";
import { ApiError } from "../common/api-error.js";
import { AuthService } from "./auth.service.js";
import { AuthError } from "./auth.types.js";
import type { AuthenticatedRequest } from "./current-user.decorator.js";
import { PUBLIC_ROUTE } from "./public.decorator.js";

export const SESSION_COOKIE = "aiflow_session";

/** 全局默认拒绝：公开标记仅跳过身份验证，不能绕过不可信浏览器来源。 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService)
    private readonly configuration: ConfigService<Environment, true>,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const hasSession =
      cookies !== undefined && Object.hasOwn(cookies, SESSION_COOKIE);
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const trustedOrigin = new URL(
        this.configuration.get("WEB_PUBLIC_URL", { infer: true }),
      ).origin;
      const suppliedOrigin = request.get("Origin");
      // 显式 Origin 代表浏览器来源，匿名登录同样可能建立/替换会话；只有无 Cookie、无 Origin 的 CLI 调用可跳过。
      if (
        (suppliedOrigin !== undefined && suppliedOrigin !== trustedOrigin) ||
        (hasSession && suppliedOrigin !== trustedOrigin)
      )
        throw new ApiError(403, "ORIGIN_FORBIDDEN", "请求来源无效");
    }
    if (
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    const token = cookies?.[SESSION_COOKIE];
    if (typeof token !== "string" || !token)
      throw new ApiError(401, "UNAUTHORIZED", "请先登录");
    let subject: string;
    try {
      const payload = await this.jwt.verifyAsync<{
        sub?: unknown;
        exp?: unknown;
      }>(token, {
        secret: this.configuration.get("JWT_SECRET", { infer: true }),
        algorithms: ["HS256"],
      });
      if (
        typeof payload.sub !== "string" ||
        !payload.sub ||
        typeof payload.exp !== "number"
      )
        throw new Error("Invalid session claims");
      subject = payload.sub;
    } catch {
      throw new ApiError(401, "UNAUTHORIZED", "请先登录");
    }
    try {
      // 每次请求都确认账号仍存在；不能让已删除账号继续使用尚未过期的 JWT。
      request.user = await this.auth.getCurrentUser(subject);
      if (!request.user.emailVerifiedAt)
        throw new ApiError(401, "UNAUTHORIZED", "请先登录");
    } catch (error) {
      if (error instanceof AuthError && error.code === "USER_NOT_FOUND")
        throw new ApiError(401, "UNAUTHORIZED", "请先登录");
      throw error;
    }
    return true;
  }
}
