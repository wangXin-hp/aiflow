import {
  ApiErrorSchema,
  AuthMessageResponseSchema,
  AuthUserResponseSchema,
  RegisterResponseSchema,
  ResendVerificationRequestSchema,
  apiSuccessSchema,
  type ApiErrorResponse,
  type ApiSuccess,
  type LoginRequest,
  type RegisterRequest,
  type ResendVerificationRequest,
} from "@aiflow/contracts";
import type { z } from "zod";

/** 网络故障和不可信响应统一降级为稳定的可恢复错误。 */
export class ApiClientError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: ApiErrorResponse["details"],
    public status?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}
const requestFailed = (status?: number) =>
  new ApiClientError(
    "REQUEST_FAILED",
    "请求失败，请稍后重试",
    undefined,
    status,
  );

async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  init: RequestInit = {},
): Promise<z.output<T>> {
  try {
    const response = await fetch(`/api/auth/${path}`, {
      ...init,
      credentials: "include",
    });
    const body: unknown = await response.json().catch(() => {
      // 即使代理返回非 JSON，也保留 401 的会话失效语义。
      throw requestFailed(response.status);
    });
    if (!response.ok) {
      const error = ApiErrorSchema.safeParse(body);
      if (error.success)
        throw new ApiClientError(
          error.data.code,
          error.data.message,
          error.data.details,
          response.status,
        );
      throw requestFailed(response.status);
    }
    const result = apiSuccessSchema(schema).safeParse(body);
    if (!result.success) throw requestFailed(response.status);
    // Zod 泛型对象的条件可选键无法被 TS 收窄；运行时已验证完整共享包装。
    return (result.data as ApiSuccess<z.output<T>>).data;
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    throw requestFailed();
  }
}
const post = (
  body?: LoginRequest | RegisterRequest | ResendVerificationRequest,
): RequestInit => ({
  method: "POST",
  ...(body
    ? {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {}),
});

/** 会话仅由 HttpOnly Cookie 管理，客户端只缓存公开用户投影。 */
export const authApi = {
  me: (signal?: AbortSignal) =>
    request("me", AuthUserResponseSchema, { signal }),
  login: (input: LoginRequest) =>
    request("login", AuthUserResponseSchema, post(input)),
  register: (input: RegisterRequest) =>
    request("register", RegisterResponseSchema, post(input)),
  verify: (token: string, signal?: AbortSignal) =>
    request(
      `verify?${new URLSearchParams({ token })}`,
      AuthMessageResponseSchema,
      { signal },
    ),
  /** 服务端始终返回账号无关消息，前端不得据此推断邮箱是否存在。 */
  resendVerification: (input: ResendVerificationRequest) =>
    request(
      "verification/resend",
      AuthMessageResponseSchema,
      post(ResendVerificationRequestSchema.parse(input)),
    ),
  logout: () => request("logout", AuthMessageResponseSchema, post()),
};
