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

/** 全局默认拒绝：公开标记仅跳过身份验证，不能绕过携带会话 Cookie 的 Origin 检查。 */
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
    // 即使 Cookie 为空或 JWT 无效，也必须先执行 CSRF 边界；非浏览器无 Cookie 调用保持可用。
    if (hasSession && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const trustedOrigin = new URL(
        this.configuration.get("WEB_PUBLIC_URL", { infer: true }),
      ).origin;
      if (request.get("Origin") !== trustedOrigin)
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
