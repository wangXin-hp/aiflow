import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiErrorSchema, apiSuccessSchema } from "./api.js";

describe("API envelopes", () => {
  it("requires a successful envelope with validated data and optional message", () => {
    const schema = apiSuccessSchema(z.strictObject({ userId: z.string() }));
    expect(schema.parse({ success: true, data: { userId: "user-1" } })).toEqual(
      {
        success: true,
        data: { userId: "user-1" },
      },
    );
    expect(
      schema.safeParse({
        success: true,
        data: { userId: "user-1" },
        message: "已注册",
      }).success,
    ).toBe(true);
    for (const value of [
      { success: false, data: { userId: "user-1" } },
      { success: true, data: { token: "secret" } },
      { success: true, data: { userId: "user-1" }, token: "secret" },
      { data: { userId: "user-1" } },
    ])
      expect(schema.safeParse(value).success).toBe(false);
  });

  it("accepts only stable error fields without a success flag or internal extras", () => {
    expect(
      ApiErrorSchema.parse({
        code: "VALIDATION_ERROR",
        message: "输入无效",
        details: [{ code: "invalid_type", path: ["email"] }],
      }),
    ).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      ApiErrorSchema.safeParse({ code: "UNAUTHORIZED", message: "请登录" })
        .success,
    ).toBe(true);
    for (const value of [
      { code: "", message: "失败" },
      { code: "ERROR" },
      { code: "ERROR", message: "失败", stack: "internal" },
      { code: "ERROR", message: "失败", success: false },
    ])
      expect(ApiErrorSchema.safeParse(value).success).toBe(false);
  });
});
