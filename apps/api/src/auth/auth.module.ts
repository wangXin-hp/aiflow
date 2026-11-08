import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import type { Environment } from "../config/environment.js";
import { MailModule } from "../mail/mail.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthEmailRateLimitGuard } from "./auth-rate-limit.guard.js";
import { AuthService } from "./auth.service.js";
import {
  AuthUserRepository,
  PasswordHasher,
  SessionTokenManager,
  VerificationTokenManager,
} from "./auth.types.js";
import { PasswordService } from "./password.service.js";
import { PrismaAuthUserRepository } from "./prisma-auth-user.repository.js";
import { SessionTokenService } from "./session-token.service.js";
import { VerificationTokenService } from "./verification-token.service.js";

/** 在组合根装配认证端口，并将默认拒绝 Guard 注册到整个应用而非单个 Controller。 */
@Module({
  imports: [
    ConfigModule,
    MailModule,
    JwtModule.register({}),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Environment, true>) => [
        {
          name: "login",
          limit: config.get("AUTH_LOGIN_RATE_LIMIT", { infer: true }),
          ttl: config.get("AUTH_LOGIN_RATE_WINDOW_MS", { infer: true }),
        },
        {
          name: "resend",
          limit: config.get("AUTH_RESEND_RATE_LIMIT", { infer: true }),
          ttl: config.get("AUTH_RESEND_RATE_WINDOW_MS", { infer: true }),
        },
      ],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    PrismaAuthUserRepository,
    SessionTokenService,
    VerificationTokenService,
    { provide: AuthUserRepository, useExisting: PrismaAuthUserRepository },
    { provide: PasswordHasher, useExisting: PasswordService },
    { provide: SessionTokenManager, useExisting: SessionTokenService },
    {
      provide: VerificationTokenManager,
      useExisting: VerificationTokenService,
    },
    ThrottlerGuard,
    AuthEmailRateLimitGuard,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}
