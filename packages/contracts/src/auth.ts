import { z } from "zod";

// 邮箱只在输入边界规范化；密码和 token 是不透明凭据，禁止 trim 或大小写转换。
const email = z.string().trim().toLowerCase().pipe(z.email());
const optionalName = z
  .string()
  .trim()
  .transform((value) => value || undefined)
  .optional();
// bcrypt 仅处理前 72 个 UTF-8 字节；拒绝超长输入，避免不同密码因截断而等价。
// TextEncoder 与 Node 的 UTF-8 字节计数一致，同时可直接在浏览器中使用。
const withinBcryptLimit = (value: string) =>
  new TextEncoder().encode(value).byteLength <= 72;
const passwordLengthMessage = "密码不能超过72个UTF-8字节";

/** 注册请求拒绝未知字段；空姓名等同未提供，密码保留原始内容。 */
export const RegisterRequestSchema = z.strictObject({
  email,
  password: z.string().min(8).refine(withinBcryptLimit, passwordLengthMessage),
  name: optionalName,
});
/** 登录要求非空并遵守 bcrypt 字节上限，不沿用新注册的最小长度约束。 */
export const LoginRequestSchema = z.strictObject({
  email,
  password: z.string().min(1).refine(withinBcryptLimit, passwordLengthMessage),
});
/** 重发请求不接受其他身份线索，服务统一返回不暴露账号状态的结果。 */
export const ResendVerificationRequestSchema = z.strictObject({ email });
/** 验证链接中的 token 按原始内容参与哈希匹配。 */
export const VerifyEmailQuerySchema = z.strictObject({
  token: z.string().min(1),
});

/** 公开用户投影白名单；日期跨 HTTP 边界只使用 ISO 字符串，不允许携带任何凭据。 */
export const PublicUserSchema = z.strictObject({
  id: z.string().min(1),
  email: z.email(),
  name: z.string().nullable(),
  avatarUrl: z.url().nullable(),
  emailVerifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

/** 注册只公开新用户 ID；资料响应复用用户白名单，会话令牌由服务端单独处理。 */
export const RegisterResponseSchema = z.strictObject({
  userId: z.string().min(1),
});
export const AuthUserResponseSchema = z.strictObject({
  user: PublicUserSchema,
});
/** 不论邮箱是否存在、是否已验证，重发响应形状和消息均相同。 */
export const AuthMessageResponseSchema = z.strictObject({
  message: z.string(),
});

/** 请求与响应类型全部从运行时契约推导，避免客户端和服务端定义漂移。 */
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type ResendVerificationRequest = z.infer<
  typeof ResendVerificationRequestSchema
>;
export type VerifyEmailQuery = z.infer<typeof VerifyEmailQuerySchema>;
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type RegisterResponse = z.infer<typeof RegisterResponseSchema>;
export type AuthUserResponse = z.infer<typeof AuthUserResponseSchema>;
export type AuthMessageResponse = z.infer<typeof AuthMessageResponseSchema>;
