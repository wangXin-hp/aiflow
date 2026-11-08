import { describe, expect, it } from "vitest";
import { sanitizeRedirect } from "./redirect";

describe("redirect security boundary", () => {
  it.each([
    null,
    "",
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "\\evil.test",
    "javascript:alert(1)",
    "/%2f%2fevil.test",
    "/%5cevil.test",
    "/\nevil.test",
  ])("rejects unsafe destination %s", (value) => {
    expect(sanitizeRedirect(value)).toBe("/apps");
  });
  it.each([
    "/apps",
    "/apps?sort=new#recent",
    "/apps/workflow/42",
    "/account/login?next=%2Fapps",
  ])("preserves local destination %s", (value) => {
    expect(sanitizeRedirect(value)).toBe(value);
  });
});
