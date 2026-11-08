import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { ApiErrorResponse } from "@aiflow/contracts";
import type { Response } from "express";
import { ZodError } from "zod";
import { AuthError, type AuthErrorCode } from "../auth/auth.types.js";
import { ApiError, validationError } from "./api-error.js";

const authStatuses: Record<AuthErrorCode, number> = {
  PASSWORD_INCORRECT: 401,
  EMAIL_NOT_VERIFIED: 403,
  EMAIL_ALREADY_EXISTS: 409,
  INVALID_VERIFY_TOKEN: 400,
  USER_NOT_FOUND: 404,
  EMAIL_DELIVERY_FAILED: 503,
  AUTH_UNAVAILABLE: 503,
};
const httpErrors: Record<number, [string, string]> = {
  400: ["BAD_REQUEST", "请求无效"],
  401: ["UNAUTHORIZED", "请先登录"],
  403: ["FORBIDDEN", "无权访问"],
  404: ["NOT_FOUND", "接口不存在"],
  405: ["METHOD_NOT_ALLOWED", "请求方法不支持"],
  413: ["PAYLOAD_TOO_LARGE", "请求内容过大"],
  429: ["RATE_LIMITED", "请求过于频繁，请稍后重试"],
  503: ["AUTH_UNAVAILABLE", "认证服务暂时不可用"],
};

/** 统一安全错误边界：仅信任领域及显式 API 错误，绝不序列化堆栈、Prisma 或框架异常体。 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    let status = 500;
    let body: ApiErrorResponse = {
      code: "INTERNAL_ERROR",
      message: "服务暂时不可用",
    };
    const error =
      exception instanceof ZodError ? validationError(exception) : exception;
    if (error instanceof ApiError) {
      status = error.status;
      body = {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
    } else if (error instanceof AuthError) {
      status = authStatuses[error.code];
      body = { code: error.code, message: error.message };
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      const known = httpErrors[status];
      if (known) body = { code: known[0], message: known[1] };
    }
    host.switchToHttp().getResponse<Response>().status(status).json(body);
  }
}
