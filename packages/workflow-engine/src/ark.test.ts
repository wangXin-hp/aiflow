import { describe, expect, it, vi } from "vitest";
import { createArkModelAdapter } from "./adapters/index.js";

describe("火山方舟模型适配器", () => {
  it("使用方舟标准地址、调用方模型和 Bearer API Key", async () => {
    const send = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer fake-key",
        );
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "endpoint-example",
          messages: [{ role: "user", content: "你好" }],
        });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "你好" } }],
            usage: { total_tokens: 5 },
          }),
          { status: 200 },
        );
      },
    );
    const adapter = createArkModelAdapter({ apiKey: "fake-key", fetch: send });
    expect(
      await adapter.generate({
        model: "endpoint-example",
        user: "你好",
        signal: new AbortController().signal,
      }),
    ).toEqual({ text: "你好", tokens: 5 });
  });
  it("允许按账号方案覆盖基础地址", async () => {
    const adapter = createArkModelAdapter({
      apiKey: "fake-key",
      baseUrl: "https://example.com/api/plan/v3",
      fetch: async (url) => {
        expect(String(url)).toBe(
          "https://example.com/api/plan/v3/chat/completions",
        );
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
          { status: 200 },
        );
      },
    });
    expect(
      (
        await adapter.generate({
          model: "example",
          user: "hi",
          signal: new AbortController().signal,
        })
      ).text,
    ).toBe("ok");
  });
});
