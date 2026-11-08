import { afterEach, describe, expect, it, vi } from "vitest";
import { authApi } from "./auth-api";

afterEach(() => vi.unstubAllGlobals());
describe("auth HTTP boundary", () => {
  it.each([
    new Response("<html>bad gateway</html>", { status: 502 }),
    Response.json({ unexpected: true }),
    Response.json({
      success: true,
      data: { user: { email: "alice@example.com" } },
    }),
  ])("converts malformed responses into a stable error", async (response) => {
    vi.stubGlobal("fetch", async () => response);
    await expect(authApi.me()).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      message: "请求失败，请稍后重试",
    });
  });
  it("preserves structured error details", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        {
          code: "VALIDATION_ERROR",
          message: "输入有误",
          details: { field: "email" },
        },
        { status: 400 },
      ),
    );
    await expect(authApi.me()).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "输入有误",
      details: { field: "email" },
      status: 400,
    });
  });
  it("converts network failures into a stable error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    await expect(authApi.me()).rejects.toMatchObject({
      code: "REQUEST_FAILED",
    });
  });
});
