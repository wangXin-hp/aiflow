import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  LoginRequestSchema,
  RegisterRequestSchema,
  ResendVerificationRequestSchema,
  VerifyEmailQuerySchema,
  type LoginRequest,
  type PublicUser,
  type RegisterRequest,
  type ResendVerificationRequest,
  type VerifyEmailQuery,
} from "@aiflow/contracts";
import type { CookieOptions, Response } from "express";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import type { Environment } from "../config/environment.js";
import { AuthService } from "./auth.service.js";
import { AuthRateLimit } from "./auth-rate-limit.guard.js";
import { SESSION_COOKIE } from "./auth.guard.js";
import { CurrentUser } from "./current-user.decorator.js";
import { Public } from "./public.decorator.js";

/** HTTP 只协调契约与 Cookie；认证业务规则始终委托 AuthService。 */
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ConfigService)
    private readonly configuration: ConfigService<Environment, true>,
  ) {}

  @Public()
  @Post("register")
  async register(
    @Body(new ZodValidationPipe(RegisterRequestSchema)) input: RegisterRequest,
  ) {
    return { success: true as const, data: await this.auth.register(input) };
  }
  @Public()
  @Get("verify")
  async verify(
    @Query(new ZodValidationPipe(VerifyEmailQuerySchema))
    input: VerifyEmailQuery,
  ) {
    return {
      success: true as const,
      data: await this.auth.verifyEmail(input.token),
    };
  }
  @Public()
  @Post("verification/resend")
  @HttpCode(200)
  @AuthRateLimit("resend")
  async resend(
    @Body(new ZodValidationPipe(ResendVerificationRequestSchema))
    input: ResendVerificationRequest,
  ) {
    return {
      success: true as const,
      data: await this.auth.resendVerification(input),
    };
  }
  @Public()
  @Post("login")
  @HttpCode(200)
  @AuthRateLimit("login")
  async login(
    @Body(new ZodValidationPipe(LoginRequestSchema)) input: LoginRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(input);
    // token 仅写 HttpOnly Cookie，绝不进入公开 response envelope。
    response.cookie(SESSION_COOKIE, result.sessionToken, {
      ...this.cookieOptions(),
      maxAge: 604800000,
    });
    return { success: true as const, data: { user: result.user } };
  }
  @Get("me")
  me(@CurrentUser() user: PublicUser) {
    return { success: true as const, data: { user } };
  }
  @Post("logout")
  @Public()
  @HttpCode(200)
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie(SESSION_COOKIE, this.cookieOptions());
    return { success: true as const, data: { message: "已退出登录" } };
  }
  /** 清除会话与写入会话共用作用域属性；清除时由框架设置过去的 expires。 */
  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure:
        this.configuration.get("NODE_ENV", { infer: true }) === "production",
    };
  }
}
