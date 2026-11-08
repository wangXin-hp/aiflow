import "reflect-metadata";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { getRounds } from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicUserSchema } from "@aiflow/contracts";
import { loadEnvironment } from "../config/environment.js";
import { AuthService } from "./auth.service.js";
import {
  AuthError,
  type AuthUser,
  type AuthUserRepository,
  type CreateAuthUser,
  type PasswordHasher,
  type VerificationEmailSender,
} from "./auth.types.js";
import { PasswordService } from "./password.service.js";
import { VerificationTokenService } from "./verification-token.service.js";
import { SessionTokenService } from "./session-token.service.js";

// 测试仓储仅替换持久化 I/O，仍执行唯一约束、未验证条件和原子消费语义。
class MemoryUsers implements AuthUserRepository {
  users = new Map<string, AuthUser>();
  async create(input: CreateAuthUser): Promise<AuthUser> {
    if (await this.findByEmail(input.email))
      throw new AuthError("EMAIL_ALREADY_EXISTS");
    const user: AuthUser = {
      ...input,
      id: `user-${this.users.size + 1}`,
      avatarUrl: null,
      emailVerifiedAt: null,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }
  async findByEmail(email: string) {
    return (
      [...this.users.values()].find((user) => user.email === email) ?? null
    );
  }
  async findById(id: string) {
    return this.users.get(id) ?? null;
  }
  async rotateVerificationToken(id: string, hash: string, expiresAt: Date) {
    const user = this.users.get(id);
    if (!user || user.emailVerifiedAt) return false;
    user.verificationTokenHash = hash;
    user.verificationTokenExpiresAt = expiresAt;
    return true;
  }
  async consumeVerificationToken(hash: string, now: Date) {
    const user = [...this.users.values()].find(
      (user) =>
        user.verificationTokenHash === hash &&
        !user.emailVerifiedAt &&
        user.verificationTokenExpiresAt &&
        user.verificationTokenExpiresAt > now,
    );
    if (!user) return false;
    user.emailVerifiedAt = now;
    user.verificationTokenHash = null;
    user.verificationTokenExpiresAt = null;
    return true;
  }
}

class EmailOutbox implements VerificationEmailSender {
  messages: { email: string; token: string }[] = [];
  fail = false;
  async sendVerificationEmail(email: string, token: string) {
    if (this.fail) throw new Error("SMTP internal secret");
    this.messages.push({ email, token });
  }
}

const simplePasswords: PasswordHasher = {
  async hash(password) {
    return `hashed:${password}`;
  },
  async verify(password, hash) {
    return hash === `hashed:${password}`;
  },
};

function fixture(
  passwords: PasswordHasher = simplePasswords,
  jwtExpires = "604800",
) {
  const users = new MemoryUsers();
  const mail = new EmailOutbox();
  const tokens = new VerificationTokenService();
  const configuration = new ConfigService(
    loadEnvironment({
      JWT_SECRET: "test-secret-".repeat(4),
      JWT_EXPIRES_IN_SECONDS: jwtExpires,
    }),
  );
  const jwt = new JwtService();
  const sessions = new SessionTokenService(jwt, configuration);
  const auth = new AuthService(users, passwords, tokens, sessions, mail);
  return { users, mail, tokens, jwt, auth };
}

const registration = {
  email: " Alice@Example.COM ",
  name: " Alice ",
  password: " secret  ",
};
const resendResult = {
  message: "如果该邮箱已注册且未验证，我们已发送验证邮件",
};
const verifyResult = { message: "邮箱验证成功，请登录" };

afterEach(() => vi.useRealTimers());

describe("AuthService", () => {
  it("registers normalized identity, preserves password bytes and exposes only userId", async () => {
    const { auth, users, mail } = fixture();
    const result = await auth.register(registration);
    expect(result).toEqual({ userId: "user-1" });
    const user = await users.findById(result.userId);
    expect(user).toMatchObject({
      email: "alice@example.com",
      name: "Alice",
      passwordHash: "hashed: secret  ",
    });
    expect(mail.messages).toHaveLength(1);
    expect(mail.messages[0]?.email).toBe("alice@example.com");
  });

  it("stores an absent or blank name as null", async () => {
    const { auth, users } = fixture();
    await auth.register({ ...registration, name: "  " });
    expect((await users.findById("user-1"))?.name).toBeNull();
  });

  it("rejects duplicate normalized email using a stable error", async () => {
    const { auth } = fixture();
    await auth.register(registration);
    await expect(
      auth.register({ ...registration, email: "alice@example.com" }),
    ).rejects.toMatchObject({ code: "EMAIL_ALREADY_EXISTS" });
  });

  it("stores a bcrypt cost-12 hash and verifies original password bytes", async () => {
    const passwords = new PasswordService();
    const { auth, users } = fixture(passwords);
    await auth.register(registration);
    const hash = (await users.findById("user-1"))!.passwordHash;
    expect(hash).not.toBe(registration.password);
    expect(getRounds(hash)).toBe(12);
    expect(await passwords.verify(registration.password, hash)).toBe(true);
    expect(await passwords.verify(registration.password.trim(), hash)).toBe(
      false,
    );
  });

  it("stores SHA-256 rather than the raw 32-byte random verification token with a 24h expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    const { auth, users, mail } = fixture();
    await auth.register(registration);
    const token = mail.messages[0]!.token;
    const user = await users.findById("user-1");
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(user?.verificationTokenHash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(user?.verificationTokenHash).not.toBe(token);
    expect(user?.verificationTokenExpiresAt?.toISOString()).toBe(
      "2026-11-09T12:00:00.000Z",
    );
  });

  it("rejects unknown and incorrect verification tokens", async () => {
    const { auth } = fixture();
    await expect(auth.verifyEmail("unknown")).rejects.toMatchObject({
      code: "INVALID_VERIFY_TOKEN",
    });
  });

  it("rejects verification at the exact expiration boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-08T12:00:00.000Z"));
    const { auth, mail, users } = fixture();
    await auth.register(registration);
    vi.setSystemTime(new Date("2026-11-09T12:00:00.000Z"));
    await expect(
      auth.verifyEmail(mail.messages[0]!.token),
    ).rejects.toMatchObject({ code: "INVALID_VERIFY_TOKEN" });
    expect((await users.findById("user-1"))?.emailVerifiedAt).toBeNull();
  });

  it("allows exactly one concurrent verification and clears stored token material", async () => {
    const { auth, users, mail } = fixture();
    await auth.register(registration);
    const token = mail.messages[0]!.token;
    const results = await Promise.allSettled([
      auth.verifyEmail(token),
      auth.verifyEmail(token),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "fulfilled"),
    ).toMatchObject({ value: verifyResult });
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "INVALID_VERIFY_TOKEN" } });
    expect(await users.findById("user-1")).toMatchObject({
      emailVerifiedAt: expect.any(Date),
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
    });
    await expect(auth.verifyEmail(token)).rejects.toMatchObject({
      code: "INVALID_VERIFY_TOKEN",
    });
  });

  it("uses the same error code and message for unknown email and wrong password", async () => {
    const { auth } = fixture();
    await auth.register(registration);
    const unknown = await auth
      .login({ email: "missing@example.com", password: "wrong" })
      .catch((error: unknown) => error);
    const incorrect = await auth
      .login({ email: registration.email, password: "wrong" })
      .catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(AuthError);
    expect(incorrect).toMatchObject({
      code: "PASSWORD_INCORRECT",
      message: (unknown as Error).message,
    });
    expect(unknown).toMatchObject({ code: "PASSWORD_INCORRECT" });
  });

  it("blocks login before email verification", async () => {
    const { auth } = fixture();
    await auth.register(registration);
    await expect(
      auth.login({
        email: registration.email,
        password: registration.password,
      }),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
  });

  it("returns a signed seven-day JWT containing only userId and standard claims", async () => {
    const { auth, mail, jwt } = fixture();
    await auth.register(registration);
    await auth.verifyEmail(mail.messages[0]!.token);
    const result = await auth.login({
      email: registration.email,
      password: registration.password,
    });
    const payload = await jwt.verifyAsync(result.sessionToken, {
      secret: "test-secret-".repeat(4),
    });
    expect(Object.keys(payload).sort()).toEqual(["exp", "iat", "sub"]);
    expect(payload.sub).toBe("user-1");
    expect(payload.exp - payload.iat).toBe(604800);
    expect(PublicUserSchema.parse(result.user)).toEqual(result.user);
    expect(result.user).toMatchObject({
      id: "user-1",
      email: "alice@example.com",
      name: "Alice",
      avatarUrl: null,
      emailVerifiedAt: expect.any(String),
      createdAt: expect.any(String),
    });
  });

  it("uses the validated configurable JWT lifetime", async () => {
    const { auth, mail, jwt } = fixture(simplePasswords, "120");
    await auth.register(registration);
    await auth.verifyEmail(mail.messages[0]!.token);
    const result = await auth.login({
      email: registration.email,
      password: registration.password,
    });
    const payload = await jwt.verifyAsync(result.sessionToken, {
      secret: "test-secret-".repeat(4),
    });
    expect(payload.exp - payload.iat).toBe(120);
  });

  it("returns only the public projection for current users", async () => {
    const { auth } = fixture();
    const { userId } = await auth.register(registration);
    const current = await auth.getCurrentUser(userId);
    expect(PublicUserSchema.parse(current)).toEqual(current);
    expect(current.emailVerifiedAt).toBeNull();
  });

  it("reports missing current user using a stable code", async () => {
    const { auth } = fixture();
    await expect(auth.getCurrentUser("missing")).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });
  });

  it("returns identical resend results for absent, unverified and verified accounts", async () => {
    const { auth, mail } = fixture();
    expect(
      await auth.resendVerification({ email: "missing@example.com" }),
    ).toEqual(resendResult);
    expect(mail.messages).toHaveLength(0);
    await auth.register(registration);
    expect(
      await auth.resendVerification({ email: " ALICE@EXAMPLE.COM " }),
    ).toEqual(resendResult);
    expect(mail.messages).toHaveLength(2);
    await auth.verifyEmail(mail.messages[1]!.token);
    expect(
      await auth.resendVerification({ email: registration.email }),
    ).toEqual(resendResult);
    expect(mail.messages).toHaveLength(2);
  });

  it("rotates a resend token and invalidates the old one", async () => {
    const { auth, mail } = fixture();
    await auth.register(registration);
    await auth.resendVerification({ email: registration.email });
    expect(mail.messages[0]!.token).not.toBe(mail.messages[1]!.token);
    await expect(
      auth.verifyEmail(mail.messages[0]!.token),
    ).rejects.toMatchObject({ code: "INVALID_VERIFY_TOKEN" });
    expect(await auth.verifyEmail(mail.messages[1]!.token)).toEqual(
      verifyResult,
    );
  });

  it("retains an unverified account after registration mail failure and allows resend", async () => {
    const { auth, mail, users } = fixture();
    mail.fail = true;
    await expect(auth.register(registration)).rejects.toMatchObject({
      code: "EMAIL_DELIVERY_FAILED",
    });
    expect(await users.findById("user-1")).toMatchObject({
      emailVerifiedAt: null,
    });
    mail.fail = false;
    expect(
      await auth.resendVerification({ email: registration.email }),
    ).toEqual(resendResult);
    expect(await auth.verifyEmail(mail.messages[0]!.token)).toEqual(
      verifyResult,
    );
  });

  it("does not expose account existence through resend delivery failures", async () => {
    const { auth, mail } = fixture();
    await auth.register(registration);
    mail.fail = true;
    expect(
      await auth.resendVerification({ email: registration.email }),
    ).toEqual(resendResult);
    expect(
      await auth.resendVerification({ email: "missing@example.com" }),
    ).toEqual(resendResult);
  });
});
