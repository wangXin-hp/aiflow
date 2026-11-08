import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Environment } from "../config/environment.js";
import { SessionTokenManager } from "./auth.types.js";

/** 业务载荷只保存用户 ID；签名密钥和有效期取已校验配置，默认七天。 */
@Injectable()
export class SessionTokenService extends SessionTokenManager {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(ConfigService)
    private readonly configuration: ConfigService<Environment, true>,
  ) {
    super();
  }

  issue(userId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId },
      {
        secret: this.configuration.get("JWT_SECRET", { infer: true }),
        expiresIn: this.configuration.get("JWT_EXPIRES_IN_SECONDS", {
          infer: true,
        }),
        algorithm: "HS256",
      },
    );
  }
}
