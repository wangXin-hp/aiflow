import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { VerificationEmailSender } from "../auth/auth.types.js";
import type { Environment } from "../config/environment.js";
import {
  SMTP_TRANSPORT_FACTORY,
  VERIFICATION_MAIL_LOGGER,
  type MailLogger,
  type MailTransport,
  type SmtpTransportFactory,
} from "./mail.types.js";
import { verificationEmailHtml } from "./verification-email.js";

/** 邮件适配器不持有用户状态；传输失败向上 reject，由认证用例决定恢复和公开错误。 */
@Injectable()
export class MailService extends VerificationEmailSender {
  private readonly transport: MailTransport | undefined;

  constructor(
    @Inject(ConfigService)
    private readonly configuration: ConfigService<Environment, true>,
    @Inject(SMTP_TRANSPORT_FACTORY) factory: SmtpTransportFactory,
    @Inject(VERIFICATION_MAIL_LOGGER) private readonly logger: MailLogger,
  ) {
    super();
    if (configuration.get("AUTH_EMAIL_MODE", { infer: true }) === "smtp") {
      this.transport = factory({
        host: configuration.getOrThrow("SMTP_HOST", { infer: true }),
        port: configuration.get("SMTP_PORT", { infer: true }),
        secure: configuration.get("SMTP_SECURE", { infer: true }),
        auth: {
          user: configuration.getOrThrow("SMTP_USER", { infer: true }),
          pass: configuration.getOrThrow("SMTP_PASSWORD", { infer: true }),
        },
      });
    }
  }

  /** 明文令牌只进入一次发信；非生产 console 通道用可访问链接替代外部投递。 */
  async sendVerificationEmail(input: {
    to: string;
    token: string;
  }): Promise<void> {
    const url = new URL(
      "/account/verify",
      this.configuration.get("WEB_PUBLIC_URL", { infer: true }),
    );
    url.searchParams.set("token", input.token);

    // 即使被错误地传入未校验配置，生产环境也不能将完整令牌写入日志。
    if (
      this.configuration.get("AUTH_EMAIL_MODE", { infer: true }) ===
        "console" &&
      this.configuration.get("NODE_ENV", { infer: true }) !== "production"
    ) {
      this.logger.log(`[AIFlow] 邮箱验证链接：${url.toString()}`);
      return;
    }
    if (!this.transport) throw new Error("邮件通道不可用");
    // 不捕获或记录 SMTP 异常，避免其附带账号、密码或邮件正文进入日志。
    await this.transport.sendMail({
      from: this.configuration.getOrThrow("SMTP_FROM", { infer: true }),
      to: input.to,
      subject: "验证你的 AIFlow 邮箱",
      html: verificationEmailHtml({ to: input.to, url: url.toString() }),
    });
  }
}
