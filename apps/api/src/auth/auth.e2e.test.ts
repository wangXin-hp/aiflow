import "reflect-metadata";
import {
  Controller,
  Get,
  HttpException,
  Param,
  type INestApplication,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { Agent } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthUserResponseSchema,
  RegisterResponseSchema,
} from "@aiflow/contracts";
import { loadEnvironment, type Environment } from "../config/environment.js";
import { configureHttpApplication } from "../common/http-application.js";
import { PrismaService } from "../database/prisma.service.js";
import { RunRecoveryService } from "../runs/run-recovery.service.js";
import {
  AuthError,
  VerificationEmailSender,
  type AuthErrorCode,
} from "./auth.types.js";

// 故意不添加公开标记，用来捕获新增 Controller 忘记鉴权的回归。
@Controller("probe")
class ProtectedProbeController {
  @Get()
  get() {
    return { secret: "must require a session" };
  }
  @Get("error/:code")
  error(@Param("code") code: string) {
    if (code === "internal")
      throw new Error("Prisma database password=private stack");
    if (code === "http")
      throw new HttpException({ message: "private", stack: "private" }, 400);
    throw new AuthError(code as AuthErrorCode);
  }
}

const origin = "http://127.0.0.1:5173";
const secret = "http-boundary-test-secret-32-characters";
const password = "test-password-123";
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow_test";
if (!new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("E2E requires a dedicated database whose name contains test");
}

describe("authentication HTTP boundary (real PostgreSQL)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let configuration: ConfigService<Environment, true>;
  let outbox: { to: string; token: string }[];
  let emails: string[];
  let mailUnavailable: boolean;

  beforeEach(async () => {
    // 只替换发信 I/O；仓储、密码哈希、JWT、Guard、HTTP 都使用真实实现。
    vi.stubEnv("JWT_SECRET", secret);
    const { AppModule } = await import("../app.module.js");
    configuration = new ConfigService(
      loadEnvironment({
        NODE_ENV: "test",
        JWT_SECRET: secret,
        DATABASE_URL: databaseUrl,
        WEB_PUBLIC_URL: origin,
      }),
    );
    emails = [];
    outbox = [];
    mailUnavailable = false;
    const module = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProtectedProbeController],
    })
      .overrideProvider(ConfigService)
      .useValue(configuration)
      // 并行 E2E 共用测试库；恢复扫描由独立用例验证，认证测试不触碰其他运行。
      .overrideProvider(RunRecoveryService)
      .useValue({ onModuleInit() {} })
      .overrideProvider(VerificationEmailSender)
      .useValue({
        async sendVerificationEmail(input: { to: string; token: string }) {
          if (mailUnavailable) throw new Error("private SMTP password");
          outbox.push(input);
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureHttpApplication(app);
    await app.init();
    prisma = app.get(PrismaService);
  }, 20000);

  afterEach(async () => {
    try {
      // 只清理当前用例生成的随机邮箱，不删除数据库或其他测试记录。
      if (prisma && emails?.length)
        await prisma.user.deleteMany({ where: { email: { in: emails } } });
    } finally {
      await app?.close();
      // Vitest 原生环境恢复 API，保留库的方法名。
      // cspell:ignore unstub
      vi.unstubAllEnvs();
    }
  });

  function email() {
    const value = `http-${randomUUID()}@example.com`;
    emails.push(value);
    return value;
  }
  function error(response: request.Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code, message: expect.any(String) });
    expect(Object.keys(response.body).sort()).toEqual(
      response.body.details
        ? ["code", "details", "message"]
        : ["code", "message"],
    );
    expect(JSON.stringify(response.body)).not.toMatch(
      /private|Prisma|passwordHash|sessionToken|stack/,
    );
  }
  async function register(address = email()) {
    const response = await request(app.getHttpServer())
      .post("/api/auth/register")
      .send({ email: address, password, name: "测试用户" });
    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(RegisterResponseSchema.safeParse(response.body.data).success).toBe(
      true,
    );
    return { address, userId: response.body.data.userId as string };
  }
  async function verified() {
    const user = await register();
    const token = outbox.find((mail) => mail.to === user.address)!.token;
    const response = await request(app.getHttpServer())
      .get("/api/auth/verify")
      .query({ token });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    return user;
  }
  async function login(address: string) {
    return request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: address, password });
  }
  function cookie(response: request.Response) {
    const header = response.headers["set-cookie"] as unknown as string[];
    expect(header).toHaveLength(1);
    return header[0]!;
  }

  it("allows public health, keeps logout idempotent and denies protected routes without a session", async () => {
    expect((await request(app.getHttpServer()).get("/api/health")).status).toBe(
      200,
    );
    for (const path of ["/api/probe", "/api/auth/me"])
      error(await request(app.getHttpServer()).get(path), 401, "UNAUTHORIZED");
    const logout = await request(app.getHttpServer()).post("/api/auth/logout");
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({
      success: true,
      data: { message: "已退出登录" },
    });
    expect(cookie(logout)).toMatch(/^aiflow_session=;/);
  });

  it("completes register → verify → login → me → logout with safe envelopes and cookies", async () => {
    const { address } = await verified();
    const response = await login(address);
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(AuthUserResponseSchema.safeParse(response.body.data).success).toBe(
      true,
    );
    expect(JSON.stringify(response.body)).not.toMatch(/token|password|Hash/i);
    const session = cookie(response);
    expect(session).toMatch(/^aiflow_session=/);
    for (const attribute of [
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=604800",
    ])
      expect(session).toContain(attribute);
    expect(session).not.toContain("Secure");
    const me = await request(app.getHttpServer())
      .get("/api/auth/me")
      .set("Cookie", session.split(";")[0]!);
    expect(me.status).toBe(200);
    expect(me.body).toEqual(response.body);
    const logout = await request(app.getHttpServer())
      .post("/api/auth/logout")
      .set("Origin", origin)
      .set("Cookie", session.split(";")[0]!);
    expect(logout.status).toBe(200);
    expect(logout.body.success).toBe(true);
    const cleared = cookie(logout);
    expect(cleared).toMatch(/^aiflow_session=;/);
    for (const attribute of [
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      "Expires=Thu, 01 Jan 1970",
    ])
      expect(cleared).toContain(attribute);
    error(
      await request(app.getHttpServer())
        .get("/api/auth/me")
        .set("Cookie", cleared.split(";")[0]!),
      401,
      "UNAUTHORIZED",
    );
  }, 20000);

  it("sets and clears Secure cookies in production", async () => {
    const user = await verified();
    configuration.set("NODE_ENV", "production");
    const session = cookie(await login(user.address));
    expect(session).toContain("Secure");
    const response = await request(app.getHttpServer())
      .post("/api/auth/logout")
      .set("Origin", origin)
      .set("Cookie", session.split(";")[0]!);
    expect(cookie(response)).toContain("Secure");
  }, 20000);

  it("rejects unverified accounts, duplicate emails and invalid or consumed verification tokens", async () => {
    const { address } = await register();
    error(await login(address), 403, "EMAIL_NOT_VERIFIED");
    error(
      await request(app.getHttpServer())
        .post("/api/auth/register")
        .send({ email: address, password }),
      409,
      "EMAIL_ALREADY_EXISTS",
    );
    error(
      await request(app.getHttpServer())
        .get("/api/auth/verify")
        .query({ token: "invalid" }),
      400,
      "INVALID_VERIFY_TOKEN",
    );
    const token = outbox[0]!.token;
    expect(
      (
        await request(app.getHttpServer())
          .get("/api/auth/verify")
          .query({ token })
      ).status,
    ).toBe(200);
    error(
      await request(app.getHttpServer())
        .get("/api/auth/verify")
        .query({ token }),
      400,
      "INVALID_VERIFY_TOKEN",
    );
  }, 20000);

  it("keeps wrong-password and unknown-email errors identical", async () => {
    const { address } = await verified();
    const wrong = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: address, password: "wrong" });
    const missing = await login(email());
    error(wrong, 401, "PASSWORD_INCORRECT");
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual(wrong.body);
  }, 20000);

  it("rejects tampered, expired, malformed claims and deleted-user sessions", async () => {
    const { address, userId } = await verified();
    const jwt = app.get(JwtService);
    const expired = await jwt.signAsync(
      { sub: userId },
      { secret, expiresIn: -1 },
    );
    const malformed = await jwt.signAsync({ sub: 123 }, { secret });
    const missingExpiry = await jwt.signAsync({ sub: userId }, { secret });
    const wrongAlgorithm = await jwt.signAsync(
      { sub: userId },
      { secret, algorithm: "HS512", expiresIn: 60 },
    );
    const forged = await jwt.signAsync(
      { sub: userId },
      { secret: "wrong-secret" },
    );
    for (const token of [
      "invalid.jwt",
      expired,
      malformed,
      missingExpiry,
      wrongAlgorithm,
      forged,
    ])
      error(
        await request(app.getHttpServer())
          .get("/api/auth/me")
          .set("Cookie", `aiflow_session=${token}`),
        401,
        "UNAUTHORIZED",
      );
    const session = cookie(await login(address)).split(";")[0]!;
    await prisma.user.delete({ where: { id: userId } });
    error(
      await request(app.getHttpServer())
        .get("/api/auth/me")
        .set("Cookie", session),
      401,
      "UNAUTHORIZED",
    );
  }, 20000);

  it("rejects every explicit untrusted Origin while preserving Origin-less CLI requests", async () => {
    const { address } = await verified();
    const session = cookie(await login(address)).split(";")[0]!;
    for (const untrusted of [
      undefined,
      "http://localhost:5173",
      `${origin}.evil.example`,
      `${origin}/path`,
      "null",
    ]) {
      for (const path of [
        "/api/auth/logout",
        "/api/auth/login",
        "/api/auth/verification/resend",
        "/api/auth/register",
      ]) {
        const pending = request(app.getHttpServer())
          .post(path)
          .set("Cookie", session)
          .send({ email: address, password });
        if (untrusted) pending.set("Origin", untrusted);
        error(await pending, 403, "ORIGIN_FORBIDDEN");
      }
    }
    error(
      await request(app.getHttpServer())
        .post("/api/auth/login")
        .set("Cookie", "aiflow_session=")
        .send({ email: address, password }),
      403,
      "ORIGIN_FORBIDDEN",
    );
    for (const untrusted of [
      "https://evil.example",
      "null",
      "http://localhost:5173",
    ]) {
      error(
        await request(app.getHttpServer())
          .post("/api/auth/login")
          .set("Origin", untrusted)
          .type("form")
          .send({ email: address, password }),
        403,
        "ORIGIN_FORBIDDEN",
      );
    }
    expect(
      (
        await request(app.getHttpServer())
          .post("/api/auth/login")
          .set("Origin", origin)
          .send({ email: address, password })
      ).status,
    ).toBe(200);
    // 无 Origin 且无 Cookie 代表非浏览器客户端，仍保留匿名 API 能力。
    expect((await login(address)).status).toBe(200);
    expect(
      (
        await request(app.getHttpServer())
          .post("/api/auth/logout")
          .set("Origin", origin)
          .set("Cookie", session)
      ).status,
    ).toBe(200);
  }, 20000);

  it("clears invalid sessions through repeatable logout without authenticating them", async () => {
    for (const session of [undefined, "aiflow_session=invalid.jwt"]) {
      let pending = request(app.getHttpServer())
        .post("/api/auth/logout")
        .set("Origin", origin);
      if (session) pending = pending.set("Cookie", session);
      const response = await pending;
      expect(response.status).toBe(200);
      expect(cookie(response)).toMatch(/^aiflow_session=;/);
    }
  });

  it("allows credentialed CORS only for the configured web origin", async () => {
    const trusted = await request(app.getHttpServer())
      .options("/api/auth/login")
      .set("Origin", origin)
      .set("Access-Control-Request-Method", "POST");
    expect(trusted.headers["access-control-allow-origin"]).toBe(origin);
    expect(trusted.headers["access-control-allow-credentials"]).toBe("true");
    const untrusted = await request(app.getHttpServer())
      .get("/api/health")
      .set("Origin", "https://evil.example");
    expect(untrusted.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("returns safe validation errors for body, unknown fields, malformed JSON and query", async () => {
    for (const body of [
      { email: "bad", password },
      { email: email(), password, private: "do not echo" },
      {},
    ])
      error(
        await request(app.getHttpServer()).post("/api/auth/login").send(body),
        400,
        "VALIDATION_ERROR",
      );
    const response = await request(app.getHttpServer())
      .post("/api/auth/login")
      .send({ email: "not-email", password: "private" });
    expect(response.body.details).toContainEqual({
      code: "invalid_format",
      path: ["email"],
    });
    error(
      await request(app.getHttpServer()).get("/api/auth/verify"),
      400,
      "VALIDATION_ERROR",
    );
    error(
      await request(app.getHttpServer())
        .post("/api/auth/login")
        .set("Content-Type", "application/json")
        .send('{"private"'),
      400,
      "BAD_REQUEST",
    );
  });

  it("keeps resend responses identical across missing, verified, unverified and failed-delivery accounts", async () => {
    const unverified = await register();
    const confirmed = await verified();
    const responses = [];
    for (const address of [unverified.address, confirmed.address, email()])
      responses.push(
        await request(app.getHttpServer())
          .post("/api/auth/verification/resend")
          .send({ email: address }),
      );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200,
    ]);
    expect(responses[0]!.body).toMatchObject({
      success: true,
      data: { message: expect.any(String) },
    });
    expect(responses[1]!.body).toEqual(responses[0]!.body);
    expect(responses[2]!.body).toEqual(responses[0]!.body);
  }, 20000);

  it("maps delivery failures without leaking SMTP details and preserves a recoverable account", async () => {
    mailUnavailable = true;
    const address = email();
    error(
      await request(app.getHttpServer())
        .post("/api/auth/register")
        .send({ email: address, password }),
      503,
      "EMAIL_DELIVERY_FAILED",
    );
    expect(
      await prisma.user.findUnique({ where: { email: address } }),
    ).toMatchObject({ emailVerifiedAt: null });
    const failed = await request(app.getHttpServer())
      .post("/api/auth/verification/resend")
      .send({ email: address });
    expect(failed.status).toBe(200);
    const absent = await request(app.getHttpServer())
      .post("/api/auth/verification/resend")
      .send({ email: email() });
    expect(failed.body).toEqual(absent.body);
    mailUnavailable = false;
    expect(
      (
        await request(app.getHttpServer())
          .post("/api/auth/verification/resend")
          .send({ email: address })
      ).status,
    ).toBe(200);
    expect(outbox).toHaveLength(1);
  }, 20000);

  it.each([
    ["login", 5, 401, "PASSWORD_INCORRECT"],
    ["verification/resend", 3, 200, undefined],
  ] as const)(
    "rate limits %s by IP even when email and forwarded headers change",
    async (path, limit, status, code) => {
      for (let attempt = 0; attempt < limit; attempt++) {
        const response = await request(app.getHttpServer())
          .post(`/api/auth/${path}`)
          .set("X-Forwarded-For", `192.0.2.${attempt + 1}`)
          .send({ email: email(), ...(path === "login" ? { password } : {}) });
        expect(response.status).toBe(status);
        if (code) expect(response.body.code).toBe(code);
      }
      error(
        await request(app.getHttpServer())
          .post(`/api/auth/${path}`)
          .send({ email: email(), ...(path === "login" ? { password } : {}) }),
        429,
        "RATE_LIMITED",
      );
    },
  );

  it.each([
    ["login", 5],
    ["verification/resend", 3],
  ] as const)(
    "rate limits %s by normalized email across distinct source IPs",
    async (path, limit) => {
      const address = email();
      for (let attempt = 0; attempt <= limit; attempt++) {
        const agent = new Agent({ localAddress: `127.0.0.${attempt + 2}` });
        try {
          const response = await request(app.getHttpServer())
            .post(`/api/auth/${path}`)
            .agent(agent)
            .send({
              email: attempt % 2 ? ` ${address.toUpperCase()} ` : address,
              ...(path === "login" ? { password } : {}),
            });
          if (attempt === limit) error(response, 429, "RATE_LIMITED");
          else expect(response.status).toBe(path === "login" ? 401 : 200);
        } finally {
          agent.destroy();
        }
      }
    },
  );

  it("maps domain errors and masks arbitrary internal and HTTP exception details", async () => {
    const { address } = await verified();
    const session = cookie(await login(address)).split(";")[0]!;
    for (const [code, status] of [
      ["USER_NOT_FOUND", 404],
      ["AUTH_UNAVAILABLE", 503],
      ["EMAIL_ALREADY_EXISTS", 409],
      ["PASSWORD_INCORRECT", 401],
      ["EMAIL_NOT_VERIFIED", 403],
      ["INVALID_VERIFY_TOKEN", 400],
      ["EMAIL_DELIVERY_FAILED", 503],
      ["internal", 500],
      ["http", 400],
    ] as const) {
      error(
        await request(app.getHttpServer())
          .get(`/api/probe/error/${code}`)
          .set("Cookie", session),
        status,
        code === "internal"
          ? "INTERNAL_ERROR"
          : code === "http"
            ? "BAD_REQUEST"
            : code,
      );
    }
  }, 20000);
});
