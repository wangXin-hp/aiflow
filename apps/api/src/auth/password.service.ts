import { Injectable } from "@nestjs/common";
import { compare, hash } from "bcryptjs";
import { PasswordHasher } from "./auth.types.js";

/** 使用 bcrypt cost 12；不修剪密码，确保空白仍参与凭据校验。 */
@Injectable()
export class PasswordService extends PasswordHasher {
  hash(password: string): Promise<string> {
    return hash(password, 12);
  }

  verify(password: string, passwordHash: string): Promise<boolean> {
    return compare(password, passwordHash);
  }
}
