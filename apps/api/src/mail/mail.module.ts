import { Logger, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import nodemailer from "nodemailer";
import { VerificationEmailSender } from "../auth/auth.types.js";
import { MailService } from "./mail.service.js";
import {
  SMTP_TRANSPORT_FACTORY,
  VERIFICATION_MAIL_LOGGER,
  type SmtpTransportFactory,
} from "./mail.types.js";

/** 业务模块依赖抽象发信端口，实际 SMTP 传输和开发日志由此统一装配。 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: SMTP_TRANSPORT_FACTORY,
      useValue: ((options) =>
        nodemailer.createTransport(options)) satisfies SmtpTransportFactory,
    },
    {
      provide: VERIFICATION_MAIL_LOGGER,
      useValue: new Logger(MailService.name),
    },
    MailService,
    { provide: VerificationEmailSender, useExisting: MailService },
  ],
  exports: [VerificationEmailSender],
})
export class MailModule {}
