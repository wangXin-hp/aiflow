import { z } from "zod";

/** 所有成功响应统一包装；data 仍由各接口的严格契约约束，不能额外夹带 token。 */
export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({
    success: z.literal(true),
    data,
    message: z.string().optional(),
  });
}

/** 错误顶层只公开稳定字段；details 用于安全、可序列化的验证问题。 */
export const ApiErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.json().optional(),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorSchema>;
export type ApiSuccess<T> = { success: true; data: T; message?: string };
