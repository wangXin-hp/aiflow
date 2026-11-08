import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";

/** 邮件传输只接收渲染后的验证信，隔离外部 SMTP I/O 以便测试真实组装结果。 */
export interface VerificationMail {
  from: string;
  to: string;
  subject: string;
  html: string;
}

/** 传输拒绝时保留异常，由认证层转换稳定错误，适配器不自行吞掉失败。 */
export interface MailTransport {
  sendMail(message: VerificationMail): Promise<unknown>;
}

/** 工厂仅在 smtp 模式调用；console 模式不得构建传输器或触发网络连接。 */
export type SmtpTransportFactory = (
  options: SMTPTransport.Options,
) => MailTransport;
export const SMTP_TRANSPORT_FACTORY = Symbol("SMTP_TRANSPORT_FACTORY");

/** 仅非生产 console 通道允许输出验证 URL，其他通道不得记录令牌和 SMTP 凭据。 */
export interface MailLogger {
  log(message: string): void;
}
export const VERIFICATION_MAIL_LOGGER = Symbol("VERIFICATION_MAIL_LOGGER");
