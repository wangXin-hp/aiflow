/** 领域内部用户；哈希只可用于认证流程，必须经公开投影后再返回调用方。 */
export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  avatarUrl: string | null;
  emailVerifiedAt: Date | null;
  verificationTokenHash: string | null;
  verificationTokenExpiresAt: Date | null;
  createdAt: Date;
}

/** 创建用户时只接收规范化身份及哈希，明文凭据不得进入持久化接口。 */
export interface CreateAuthUser {
  email: string;
  name: string | null;
  passwordHash: string;
  verificationTokenHash: string;
  verificationTokenExpiresAt: Date;
}

/** 抽象类同时作为 Nest 注入标识；实现必须保证消费与旋转的条件更新是原子的。 */
export abstract class AuthUserRepository {
  abstract create(input: CreateAuthUser): Promise<AuthUser>;
  abstract findByEmail(email: string): Promise<AuthUser | null>;
  abstract findById(id: string): Promise<AuthUser | null>;
  /** 仅未验证账号允许旋转；并发验证已成功时返回 false。 */
  abstract rotateVerificationToken(
    id: string,
    hash: string,
    expiresAt: Date,
  ): Promise<boolean>;
  /** 仅匹配未验证且未过期的哈希；消费后清空哈希，重复或并发消费返回 false。 */
  abstract consumeVerificationToken(hash: string, now: Date): Promise<boolean>;
}

/** 密码端口保留原始字符串，调用方禁止 trim 或大小写变换。 */
export abstract class PasswordHasher {
  abstract hash(password: string): Promise<string>;
  abstract verify(password: string, hash: string): Promise<boolean>;
}

/** 明文 token 仅用于发信，hash 和 expiresAt 用于数据库存储。 */
export interface VerificationToken {
  token: string;
  hash: string;
  expiresAt: Date;
}

/** 验证码端口负责安全随机生成和不可逆哈希；不持有数据库状态。 */
export abstract class VerificationTokenManager {
  abstract generate(): VerificationToken;
  abstract hash(token: string): string;
}

/** 会话签发端口；会话令牌只交给 HTTP 层设置 Cookie，不放入公开响应。 */
export abstract class SessionTokenManager {
  abstract issue(userId: string): Promise<string>;
}

/** 邮件实现只在发送边界接触明文 token；失败必须 reject，由领域确定公开行为。 */
export abstract class VerificationEmailSender {
  abstract sendVerificationEmail(input: {
    to: string;
    token: string;
  }): Promise<void>;
}

const authErrorMessages = {
  EMAIL_ALREADY_EXISTS: "该邮箱已注册",
  PASSWORD_INCORRECT: "邮箱或密码错误",
  EMAIL_NOT_VERIFIED: "请先验证邮箱",
  INVALID_VERIFY_TOKEN: "验证链接无效或已过期",
  USER_NOT_FOUND: "用户不存在",
  EMAIL_DELIVERY_FAILED: "验证邮件发送失败，请稍后重发",
  AUTH_UNAVAILABLE: "认证服务暂时不可用",
} as const;

/** 稳定的领域错误码；所有基础设施异常必须在适配器边界转换，禁止暴露数据库或 SMTP 详情。 */
export type AuthErrorCode = keyof typeof authErrorMessages;
export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode) {
    super(authErrorMessages[code]);
    this.name = "AuthError";
  }
}
