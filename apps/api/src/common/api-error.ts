import type { ApiErrorResponse } from "@aiflow/contracts";
import type { ZodError } from "zod";

/** 仅显式构造的边界错误可公开消息，其他异常必须由 filter 转成固定文案。 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ApiErrorResponse["details"],
  ) {
    super(message);
  }
}

/** 不回传输入值、未知键、Zod 文案或内部异常，避免凭据经校验错误泄漏。 */
export function validationError(error: ZodError): ApiError {
  return new ApiError(
    400,
    "VALIDATION_ERROR",
    "请求参数无效",
    error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map((segment) =>
        typeof segment === "number" ? segment : String(segment),
      ),
    })),
  );
}
