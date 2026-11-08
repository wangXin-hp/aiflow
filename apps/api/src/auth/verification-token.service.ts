import { createHash, randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  VerificationTokenManager,
  type VerificationToken,
} from "./auth.types.js";

/** 32 字节随机凭据有效 24 小时；数据库仅保存 SHA-256，泄露存储也不能直接复用链接。 */
@Injectable()
export class VerificationTokenService extends VerificationTokenManager {
  generate(): VerificationToken {
    const token = randomBytes(32).toString("base64url");
    return {
      token,
      hash: this.hash(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
  }

  hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}
