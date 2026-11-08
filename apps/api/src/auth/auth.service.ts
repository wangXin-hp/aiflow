import { Inject, Injectable } from "@nestjs/common";
import {
  LoginRequestSchema,
  RegisterRequestSchema,
  ResendVerificationRequestSchema,
  type AuthMessageResponse,
  type LoginRequest,
  type PublicUser,
  type RegisterRequest,
  type RegisterResponse,
  type ResendVerificationRequest,
} from "@aiflow/contracts";
import {
  AuthError,
  AuthUserRepository,
  PasswordHasher,
  SessionTokenManager,
  VerificationEmailSender,
  VerificationTokenManager,
  type AuthUser,
} from "./auth.types.js";

const resendMessage = "如果该邮箱已注册且未验证，我们已发送验证邮件";

/** 只按白名单序列化公开用户，避免新增持久化字段时意外泄露哈希。 */
function publicUser(user: AuthUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

/** 认证用例只依赖可注入端口，HTTP、Cookie、邮件传输与数据库细节由外层组合。 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(AuthUserRepository) private readonly users: AuthUserRepository,
    @Inject(PasswordHasher) private readonly passwords: PasswordHasher,
    @Inject(VerificationTokenManager)
    private readonly verification: VerificationTokenManager,
    @Inject(SessionTokenManager) private readonly sessions: SessionTokenManager,
    @Inject(VerificationEmailSender)
    private readonly mail: VerificationEmailSender,
  ) {}

  /** 身份在契约边界规范化；先保存再发信，邮件失败保留未验证账号以支持重发。 */
  async register(input: RegisterRequest): Promise<RegisterResponse> {
    const request = RegisterRequestSchema.parse(input);
    const token = this.verification.generate();
    const user = await this.users.create({
      email: request.email,
      name: request.name ?? null,
      passwordHash: await this.passwords.hash(request.password),
      verificationTokenHash: token.hash,
      verificationTokenExpiresAt: token.expiresAt,
    });
    try {
      await this.mail.sendVerificationEmail(user.email, token.token);
    } catch {
      throw new AuthError("EMAIL_DELIVERY_FAILED");
    }
    return { userId: user.id };
  }

  /** 条件消费由仓储一次性完成，禁止先读后写，以免并发请求重复验证成功。 */
  async verifyEmail(token: string): Promise<AuthMessageResponse> {
    if (
      !token ||
      !(await this.users.consumeVerificationToken(
        this.verification.hash(token),
        new Date(),
      ))
    ) {
      throw new AuthError("INVALID_VERIFY_TOKEN");
    }
    return { message: "邮箱验证成功，请登录" };
  }

  /** 所有账号状态及发送失败都返回同一消息；仅未验证用户旋转 token 并发信。 */
  async resendVerification(
    input: ResendVerificationRequest,
  ): Promise<AuthMessageResponse> {
    const request = ResendVerificationRequestSchema.parse(input);
    const user = await this.users.findByEmail(request.email);
    if (user && !user.emailVerifiedAt) {
      const token = this.verification.generate();
      if (
        await this.users.rotateVerificationToken(
          user.id,
          token.hash,
          token.expiresAt,
        )
      ) {
        try {
          await this.mail.sendVerificationEmail(user.email, token.token);
        } catch {
          // 不透出 SMTP 异常或账号存在性；持久化的未验证用户仍可再次请求重发。
        }
      }
    }
    return { message: resendMessage };
  }

  /** 未知邮箱和错密使用同码同消息；只有密码正确且已验证才能签发会话。 */
  async login(
    input: LoginRequest,
  ): Promise<{ user: PublicUser; sessionToken: string }> {
    const request = LoginRequestSchema.parse(input);
    const user = await this.users.findByEmail(request.email);
    if (
      !user ||
      !(await this.passwords.verify(request.password, user.passwordHash))
    ) {
      throw new AuthError("PASSWORD_INCORRECT");
    }
    if (!user.emailVerifiedAt) throw new AuthError("EMAIL_NOT_VERIFIED");
    return {
      user: publicUser(user),
      sessionToken: await this.sessions.issue(user.id),
    };
  }

  /** 根据会话中的用户 ID 读取最新公开资料；已删除的用户返回稳定领域错误。 */
  async getCurrentUser(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new AuthError("USER_NOT_FOUND");
    return publicUser(user);
  }
}
