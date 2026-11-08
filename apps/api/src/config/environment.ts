import { z } from "zod";

const positiveInteger = z.coerce.number().int().positive();
const port = positiveInteger.max(65535);
const httpUrl = z.url({ protocol: /^https?$/ });
const optionalText = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);
// 密码和密钥的空白也可能参与认证，仅检查非空，不改变其实际字节。
const optionalSecret = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .refine((value) => value.trim().length > 0)
    .optional(),
);

/** API 启动配置契约：允许系统环境中的无关字段，已声明字段必须通过类型和模式校验。 */
export const EnvironmentSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    API_HOST: z.string().trim().min(1).default("127.0.0.1"),
    API_PORT: port.default(3000),
    DATABASE_URL: z
      .url({ protocol: /^postgres(ql)?$/ })
      .default("postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow"),
    DATABASE_POOL_MAX: positiveInteger.default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: positiveInteger.default(5000),
    DATABASE_IDLE_TIMEOUT_MS: positiveInteger.default(30000),
    QDRANT_URL: httpUrl.default("http://127.0.0.1:6333"),
    QDRANT_API_KEY: optionalSecret,
    WEB_PUBLIC_URL: httpUrl.default("http://127.0.0.1:5173"),
    JWT_SECRET: z
      .string()
      .min(32)
      .refine((value) => value.trim().length >= 32),
    JWT_EXPIRES_IN_SECONDS: positiveInteger.default(604800),
    AUTH_LOGIN_RATE_LIMIT: positiveInteger.default(5),
    AUTH_LOGIN_RATE_WINDOW_MS: positiveInteger.default(60000),
    AUTH_RESEND_RATE_LIMIT: positiveInteger.default(3),
    AUTH_RESEND_RATE_WINDOW_MS: positiveInteger.default(900000),
    AUTH_EMAIL_MODE: z.enum(["console", "smtp"]).default("console"),
    SMTP_HOST: optionalText,
    SMTP_PORT: port.default(465),
    // 不用 Boolean("false") 转换，避免显式关闭 TLS 时反而得到 true。
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    SMTP_USER: optionalText,
    SMTP_PASSWORD: optionalSecret,
    SMTP_FROM: optionalText,
    ARK_API_KEY: optionalSecret,
    ARK_MODEL_ID: optionalText,
    ARK_BASE_URL: httpUrl.default("https://ark.cn-beijing.volces.com/api/v3"),
    RUN_NODE_TIMEOUT_MS: positiveInteger.default(30000),
    RUN_TOTAL_TIMEOUT_MS: positiveInteger.default(300000),
    RUN_MAX_NODES: positiveInteger.default(100),
    RUN_MAX_CONCURRENT: positiveInteger.default(4),
    RUN_EVENT_MAX_BYTES: positiveInteger.default(65536),
  })
  .superRefine((environment, context) => {
    // 生产环境禁止把验证码写入日志，防止误用本地开发邮件通道。
    if (
      environment.NODE_ENV === "production" &&
      environment.AUTH_EMAIL_MODE !== "smtp"
    ) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_EMAIL_MODE"],
        message: "生产环境必须使用 smtp 邮件模式",
      });
    }
    if (environment.AUTH_EMAIL_MODE === "smtp") {
      for (const key of [
        "SMTP_HOST",
        "SMTP_USER",
        "SMTP_PASSWORD",
        "SMTP_FROM",
      ] as const) {
        if (!environment[key]) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "smtp 模式必须配置此字段",
          });
        }
      }
    }
  });

/** 通过校验后的配置类型，数值和布尔字段已转换为运行时类型。 */
export type Environment = z.infer<typeof EnvironmentSchema>;

/** 校验输入环境；配置缺失或无效时抛出 ZodError，使服务在监听端口前失败。 */
export function loadEnvironment(source: NodeJS.ProcessEnv): Environment {
  return EnvironmentSchema.parse(source);
}
