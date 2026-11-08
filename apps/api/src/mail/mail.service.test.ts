import "reflect-metadata";
import { Inject, Injectable, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { loadEnvironment } from "../config/environment.js";
import { VerificationEmailSender } from "../auth/auth.types.js";
import { MailModule } from "./mail.module.js";
import { MailService } from "./mail.service.js";
import type { SmtpTransportFactory } from "./mail.types.js";

const smtp = {
  AUTH_EMAIL_MODE: "smtp",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_SECURE: "false",
  SMTP_USER: "smtp-account",
  SMTP_PASSWORD: " smtp-password ",
  SMTP_FROM: "AIFlow <verify@example.com>",
};

function fixture(source: NodeJS.ProcessEnv = {}) {
  const configuration = new ConfigService(
    loadEnvironment({
      JWT_SECRET: "a".repeat(32),
      WEB_PUBLIC_URL: "https://aiflow.example/base?discard=1#discard",
      ...source,
    }),
  );
  // 仅替换外部 SMTP I/O，仍检查真实服务组装出的连接参数和邮件内容。
  const sendMail = vi.fn().mockResolvedValue(undefined);
  const factory = vi.fn<SmtpTransportFactory>(() => ({ sendMail }));
  const logger = { log: vi.fn() };
  const service = new MailService(configuration, factory, logger);
  return { service, factory, sendMail, logger };
}

describe("MailService", () => {
  it.each(["development", "production"])(
    "uses validated SMTP configuration and an encoded root verification URL in %s",
    async (NODE_ENV) => {
      const { service, factory, sendMail, logger } = fixture({
        ...smtp,
        NODE_ENV,
      });
      await service.sendVerificationEmail({
        to: "alice@example.com",
        token: "a+b/c?d=e&f# 空",
      });

      expect(factory).toHaveBeenCalledExactlyOnceWith({
        host: "smtp.example.com",
        port: 587,
        secure: false,
        auth: { user: "smtp-account", pass: " smtp-password " },
      });
      expect(sendMail).toHaveBeenCalledExactlyOnceWith({
        from: "AIFlow <verify@example.com>",
        to: "alice@example.com",
        subject: "验证你的 AIFlow 邮箱",
        html: expect.any(String),
      });
      const html = sendMail.mock.calls[0]![0].html as string;
      expect(html).toContain("AIFlow");
      expect(html).toContain("alice@example.com");
      expect(html).toContain(
        'href="https://aiflow.example/account/verify?token=a%2Bb%2Fc%3Fd%3De%26f%23+%E7%A9%BA"',
      );
      expect(html).not.toContain("discard");
      expect(logger.log).not.toHaveBeenCalled();
    },
  );

  it("preserves configured TLS and port values for SMTP", async () => {
    const { service, factory } = fixture({
      ...smtp,
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
    });
    await service.sendVerificationEmail({
      to: "alice@example.com",
      token: "one",
    });
    expect(factory.mock.calls[0]![0]).toMatchObject({
      port: 465,
      secure: true,
    });
  });

  it("escapes all variable HTML content without changing the recipient", async () => {
    const { service, sendMail } = fixture(smtp);
    const to = `a&<>"'@example.com`;
    await service.sendVerificationEmail({
      to,
      token: `"><script>alert(1)</script>`,
    });
    const message = sendMail.mock.calls[0]![0];
    expect(message.to).toBe(to);
    expect(message.html).toContain("a&amp;&lt;&gt;&quot;&#39;@example.com");
    expect(message.html).not.toContain(to);
    expect(message.html).not.toContain("<script>");
    expect(message.html).toContain(
      // cspell:disable-next-line -- 保留 HTML 注入载荷编码，确保链接不引入可执行标签。
      "token=%22%3E%3Cscript%3Ealert%281%29%3C%2Fscript%3E",
    );
  });

  it.each(["development", "test"])(
    "prints the usable URL only in explicit %s console mode without constructing SMTP",
    async (NODE_ENV) => {
      const { service, factory, sendMail, logger } = fixture({
        ...smtp,
        NODE_ENV,
        AUTH_EMAIL_MODE: "console",
      });
      await service.sendVerificationEmail({
        to: "alice@example.com",
        token: "local+token",
      });
      expect(factory).not.toHaveBeenCalled();
      expect(sendMail).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledExactlyOnceWith(
        "[AIFlow] 邮箱验证链接：https://aiflow.example/account/verify?token=local%2Btoken",
      );
      expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
        "smtp-account",
      );
      expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
        "smtp-password",
      );
    },
  );

  it.each(["development", "production"])(
    "propagates SMTP failures without logging secrets in %s",
    async (NODE_ENV) => {
      const { service, sendMail, logger } = fixture({ ...smtp, NODE_ENV });
      sendMail.mockRejectedValue(
        new Error("smtp-account smtp-password private-token"),
      );
      await expect(
        service.sendVerificationEmail({
          to: "alice@example.com",
          token: "private-token",
        }),
      ).rejects.toThrow();
      expect(logger.log).not.toHaveBeenCalled();
    },
  );

  it("rejects production console mode before any transport or token logging", () => {
    expect(() =>
      fixture({ NODE_ENV: "production", AUTH_EMAIL_MODE: "console" }),
    ).toThrow(/AUTH_EMAIL_MODE/);
  });

  it("exports the mail adapter through the authentication port for Nest consumers", async () => {
    @Injectable()
    class MailConsumer {
      constructor(
        @Inject(VerificationEmailSender)
        readonly sender: VerificationEmailSender,
      ) {}
    }
    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          skipProcessEnv: true,
          load: [() => loadEnvironment({ JWT_SECRET: "a".repeat(32) })],
        }),
        MailModule,
      ],
      providers: [MailConsumer],
    })
    class MailConsumerModule {}
    const application = await NestFactory.createApplicationContext(
      MailConsumerModule,
      { logger: false, abortOnError: false },
    );
    try {
      const sender = application.get(MailConsumer).sender;
      expect(sender).toBeInstanceOf(MailService);
      expect(sender).toBe(application.get(MailService));
    } finally {
      await application.close();
    }
  });
});
