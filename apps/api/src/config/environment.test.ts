import { describe, expect, it } from "vitest";
import { loadEnvironment } from "./environment.js";

const development = { JWT_SECRET: "a".repeat(32) };
const smtp = {
  AUTH_EMAIL_MODE: "smtp",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "developer",
  SMTP_PASSWORD: "development-password",
  SMTP_FROM: "AIFlow <noreply@example.com>",
};

describe("environment configuration", () => {
  it("loads valid development configuration", () => {
    expect(loadEnvironment(development)).toMatchObject({
      NODE_ENV: "development",
      API_HOST: "127.0.0.1",
      API_PORT: 3000,
      DATABASE_URL: "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow",
      DATABASE_POOL_MAX: 10,
      DATABASE_CONNECTION_TIMEOUT_MS: 5000,
      DATABASE_IDLE_TIMEOUT_MS: 30000,
      QDRANT_URL: "http://127.0.0.1:6333",
      WEB_PUBLIC_URL: "http://127.0.0.1:5173",
      JWT_EXPIRES_IN_SECONDS: 604800,
      AUTH_EMAIL_MODE: "console",
      RUN_NODE_TIMEOUT_MS: 30000,
      RUN_TOTAL_TIMEOUT_MS: 300000,
      RUN_EVENT_MAX_BYTES: 65536,
      ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3",
      RUN_MAX_NODES: 100,
      RUN_MAX_CONCURRENT: 4,
    });
  });

  it("rejects a short JWT secret", () => {
    expect(() => loadEnvironment({ JWT_SECRET: "a".repeat(31) })).toThrow(
      /JWT_SECRET/,
    );
    expect(loadEnvironment(development).JWT_SECRET).toHaveLength(32);
    expect(() => loadEnvironment({})).toThrow(/JWT_SECRET/);
  });

  it("requires SMTP settings in smtp mode", () => {
    expect(() =>
      loadEnvironment({ ...development, AUTH_EMAIL_MODE: "smtp" }),
    ).toThrow(/SMTP_HOST/);
    for (const key of Object.keys(smtp).filter(
      (key) => !["AUTH_EMAIL_MODE", "SMTP_PORT"].includes(key),
    )) {
      expect(() =>
        loadEnvironment({ ...development, ...smtp, [key]: undefined }),
      ).toThrow(new RegExp(key));
    }
    expect(loadEnvironment({ ...development, ...smtp }).SMTP_PORT).toBe(587);
    const defaults = loadEnvironment({
      ...development,
      ...smtp,
      SMTP_PORT: undefined,
    });
    expect(defaults.SMTP_PORT).toBe(465);
    expect(defaults.SMTP_SECURE).toBe(true);
    expect(
      loadEnvironment({ ...development, ...smtp, SMTP_SECURE: "false" })
        .SMTP_SECURE,
    ).toBe(false);
  });

  it("allows console mail only outside production", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(
        loadEnvironment({ ...development, NODE_ENV }).AUTH_EMAIL_MODE,
      ).toBe("console");
    }
    expect(() =>
      loadEnvironment({ ...development, NODE_ENV: "production" }),
    ).toThrow(/AUTH_EMAIL_MODE/);
    expect(
      loadEnvironment({ ...development, ...smtp, NODE_ENV: "production" })
        .AUTH_EMAIL_MODE,
    ).toBe("smtp");
  });

  it("preserves secret bytes when validating credentials", () => {
    const JWT_SECRET = ` ${"a".repeat(32)} `;
    const SMTP_PASSWORD = " development-password ";
    const environment = loadEnvironment({
      ...smtp,
      JWT_SECRET,
      SMTP_PASSWORD,
    });
    expect(environment.JWT_SECRET).toBe(JWT_SECRET);
    expect(environment.SMTP_PASSWORD).toBe(SMTP_PASSWORD);
    expect(() => loadEnvironment({ JWT_SECRET: " ".repeat(32) })).toThrow(
      /JWT_SECRET/,
    );
  });

  it.each([
    ["NODE_ENV", "staging"],
    ["AUTH_EMAIL_MODE", "disabled"],
    ["DATABASE_URL", "https://localhost:5432/aiflow"],
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "1.5"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", "-1"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", ""],
    ["DATABASE_IDLE_TIMEOUT_MS", "never"],
    ["DATABASE_IDLE_TIMEOUT_MS", "0"],
    ["QDRANT_URL", "file:///tmp/qdrant"],
    ["WEB_PUBLIC_URL", "not-a-url"],
    ["API_PORT", "65536"],
    ["API_PORT", ""],
    ["API_HOST", " "],
    ["JWT_EXPIRES_IN_SECONDS", "forever"],
    ["RUN_NODE_TIMEOUT_MS", "0"],
    ["RUN_TOTAL_TIMEOUT_MS", "0"],
    ["RUN_EVENT_MAX_BYTES", "0"],
    ["SMTP_PORT", "65536"],
    ["SMTP_SECURE", "yes"],
    ["ARK_BASE_URL", "file:///tmp/ark"],
    ["RUN_MAX_NODES", "1.5"],
    ["RUN_MAX_CONCURRENT", "-1"],
  ])("rejects invalid %s=%s", (key, value) => {
    expect(() => loadEnvironment({ ...development, [key]: value })).toThrow(
      new RegExp(key),
    );
  });

  it("coerces configured numeric values and ignores unrelated process variables", () => {
    expect(
      loadEnvironment({
        ...development,
        API_PORT: "3100",
        DATABASE_POOL_MAX: "4",
        DATABASE_CONNECTION_TIMEOUT_MS: "2000",
        DATABASE_IDLE_TIMEOUT_MS: "10000",
        RUN_NODE_TIMEOUT_MS: "60000",
        RUN_MAX_NODES: "200",
        RUN_MAX_CONCURRENT: "8",
        PATH: "system-path",
      }),
    ).toMatchObject({
      API_PORT: 3100,
      DATABASE_POOL_MAX: 4,
      DATABASE_CONNECTION_TIMEOUT_MS: 2000,
      DATABASE_IDLE_TIMEOUT_MS: 10000,
      RUN_NODE_TIMEOUT_MS: 60000,
      RUN_MAX_NODES: 200,
      RUN_MAX_CONCURRENT: 8,
    });
    expect(
      loadEnvironment({ ...development, PATH: "system-path" }),
    ).not.toHaveProperty("PATH");
  });
});

// 限流配置属于安全边界：缺省生效，显式值必须为正整数。
describe("authentication rate limit configuration", () => {
  const keys = [
    "AUTH_LOGIN_RATE_LIMIT",
    "AUTH_LOGIN_RATE_WINDOW_MS",
    "AUTH_RESEND_RATE_LIMIT",
    "AUTH_RESEND_RATE_WINDOW_MS",
  ];
  it("loads defaults and coerces explicit numeric settings", () => {
    expect(loadEnvironment(development)).toMatchObject({
      AUTH_LOGIN_RATE_LIMIT: 5,
      AUTH_LOGIN_RATE_WINDOW_MS: 60000,
      AUTH_RESEND_RATE_LIMIT: 3,
      AUTH_RESEND_RATE_WINDOW_MS: 900000,
    });
    expect(
      loadEnvironment({
        ...development,
        AUTH_LOGIN_RATE_LIMIT: "7",
        AUTH_LOGIN_RATE_WINDOW_MS: "12000",
        AUTH_RESEND_RATE_LIMIT: "4",
        AUTH_RESEND_RATE_WINDOW_MS: "30000",
      }),
    ).toMatchObject({
      AUTH_LOGIN_RATE_LIMIT: 7,
      AUTH_LOGIN_RATE_WINDOW_MS: 12000,
      AUTH_RESEND_RATE_LIMIT: 4,
      AUTH_RESEND_RATE_WINDOW_MS: 30000,
    });
  });
  it.each(["0", "-1", "1.5", "", "never"])(
    "rejects invalid rate settings %s",
    (value) => {
      for (const key of keys)
        expect(() => loadEnvironment({ ...development, [key]: value })).toThrow(
          new RegExp(key),
        );
    },
  );
});
