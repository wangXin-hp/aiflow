import { describe, expect, it } from "vitest";
import { sanitizeRunEventPayload } from "./run-event-sanitizer.js";

describe("sanitizeRunEventPayload", () => {
  it("keeps only public state, timing and short error code", () => {
    expect(
      sanitizeRunEventPayload(
        { status: "RUNNING", durationMs: 12, errorCode: "node_timeout" },
        1024,
      ),
    ).toEqual({ status: "RUNNING", elapsedMs: 12, errorCode: "node_timeout" });
    expect(
      sanitizeRunEventPayload({ status: "SUCCEEDED", durationMs: 12.4 }, 1024),
    ).toEqual({ status: "SUCCEEDED", elapsedMs: 12 });
    expect(sanitizeRunEventPayload({ durationMs: -1 }, 1024)).toEqual({
      truncated: true,
    });
    expect(sanitizeRunEventPayload({ durationMs: Number.NaN }, 1024)).toEqual({
      truncated: true,
    });
  });

  it("recursively excludes secrets, prompts and full outputs regardless of case", () => {
    const value = {
      status: "FAILED",
      Authorization: "secret",
      nested: {
        COOKIE: "secret",
        passWORD: "secret",
        token: "secret",
        apiKey: "secret",
        prompt: "private",
        output: { full: true },
      },
    };
    const result = sanitizeRunEventPayload(value, 1024);
    expect(result).toMatchObject({ status: "FAILED", truncated: true });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|full/u);
  });

  it("handles deep, cyclic and unsupported values without throwing", () => {
    const cyclic: Record<string, unknown> = { status: "RUNNING" };
    cyclic.self = cyclic;
    cyclic.function = () => 1;
    cyclic.array = Array.from({ length: 1000 }, () => "secret");
    const result = sanitizeRunEventPayload(cyclic, 1024);
    expect(result).toMatchObject({ status: "RUNNING", truncated: true });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(sanitizeRunEventPayload(new Date(), 1024)).toEqual({
      truncated: true,
    });
  });

  it("turns proxy reflection failures into a safe marker", () => {
    const prototypeTrap = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error("prototype");
        },
      },
    );
    const descriptorTrap = new Proxy(
      { status: "RUNNING" },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("descriptor");
        },
      },
    );
    const revoked = Proxy.revocable({ status: "RUNNING" }, {});
    revoked.revoke();
    for (const value of [prototypeTrap, descriptorTrap, revoked.proxy]) {
      expect(() => sanitizeRunEventPayload(value, 1024)).not.toThrow();
      expect(sanitizeRunEventPayload(value, 1024)).toEqual({ truncated: true });
    }
  });

  it("defines the minimum budget and checks the exact byte boundary", () => {
    expect(() => sanitizeRunEventPayload({ output: "private" }, 17)).toThrow(
      RangeError,
    );
    expect(sanitizeRunEventPayload({ output: "private" }, 18)).toEqual({
      truncated: true,
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify({ status: "RUNNING" }),
    ).length;
    expect(sanitizeRunEventPayload({ status: "RUNNING" }, bytes)).toEqual({
      status: "RUNNING",
    });
    expect(sanitizeRunEventPayload({ status: "RUNNING" }, bytes - 1)).toEqual({
      truncated: true,
    });
  });

  it("bounds UTF-8 bytes without slicing JSON", () => {
    const result = sanitizeRunEventPayload(
      { status: "RUNNING", errorCode: "é".repeat(40) },
      32,
    );
    expect(result).toEqual({ truncated: true });
    expect(
      new TextEncoder().encode(JSON.stringify(result)).length,
    ).toBeLessThanOrEqual(32);
  });
});
