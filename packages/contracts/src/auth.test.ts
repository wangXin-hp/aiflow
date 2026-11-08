import { describe, expect, it } from "vitest";
import {
  LoginRequestSchema,
  PublicUserSchema,
  RegisterRequestSchema,
  ResendVerificationRequestSchema,
  VerifyEmailQuerySchema,
  RegisterResponseSchema,
  AuthUserResponseSchema,
  AuthMessageResponseSchema,
} from "./auth.js";

describe("authentication contracts", () => {
  it("normalizes email and name while preserving password bytes", () => {
    expect(
      RegisterRequestSchema.parse({
        email: " Alice@Example.COM ",
        name: " Alice ",
        password: " secret  ",
      }),
    ).toEqual({
      email: "alice@example.com",
      name: "Alice",
      password: " secret  ",
    });
  });

  it("normalizes an empty optional name to undefined", () => {
    expect(
      RegisterRequestSchema.parse({
        email: "a@example.com",
        password: "12345678",
        name: "  ",
      }).name,
    ).toBeUndefined();
  });

  it("allows registration without a name", () => {
    expect(
      RegisterRequestSchema.parse({
        email: "a@example.com",
        password: "12345678",
      }).name,
    ).toBeUndefined();
  });

  it("rejects registration passwords shorter than eight characters", () => {
    expect(
      RegisterRequestSchema.safeParse({
        email: "a@example.com",
        password: "1234567",
      }).success,
    ).toBe(false);
  });

  it.each([RegisterRequestSchema, LoginRequestSchema])(
    "accepts 72 ASCII password bytes and rejects 73 without transforming them",
    (schema) => {
      expect(
        schema.parse({ email: "a@example.com", password: " ".repeat(72) })
          .password,
      ).toBe(" ".repeat(72));
      const result = schema.safeParse({
        email: "a@example.com",
        password: "a".repeat(73),
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues[0]?.message).toBe(
          "密码不能超过72个UTF-8字节",
        );
    },
  );

  it.each([RegisterRequestSchema, LoginRequestSchema])(
    "enforces the password limit using UTF-8 bytes for multibyte characters",
    (schema) => {
      expect(
        schema.parse({ email: "a@example.com", password: "密".repeat(24) })
          .password,
      ).toBe("密".repeat(24));
      expect(
        schema.safeParse({ email: "a@example.com", password: "密".repeat(25) })
          .success,
      ).toBe(false);
    },
  );

  it("requires a nonempty login password and does not trim it", () => {
    expect(
      LoginRequestSchema.safeParse({ email: "a@example.com", password: "" })
        .success,
    ).toBe(false);
    expect(
      LoginRequestSchema.parse({ email: " A@EXAMPLE.COM ", password: " " }),
    ).toEqual({ email: "a@example.com", password: " " });
  });

  it("normalizes resend email", () => {
    expect(
      ResendVerificationRequestSchema.parse({ email: " A@EXAMPLE.COM " }),
    ).toEqual({ email: "a@example.com" });
  });

  it("requires an opaque nonempty verification token without transforming it", () => {
    expect(VerifyEmailQuerySchema.safeParse({ token: "" }).success).toBe(false);
    expect(VerifyEmailQuerySchema.parse({ token: " token " })).toEqual({
      token: " token ",
    });
  });

  it.each([
    [RegisterRequestSchema, { email: "invalid", password: "12345678" }],
    [LoginRequestSchema, { email: "invalid", password: "x" }],
    [ResendVerificationRequestSchema, { email: "invalid" }],
  ] as const)(
    "rejects invalid email at every email boundary",
    (schema, input) => {
      expect(schema.safeParse(input).success).toBe(false);
    },
  );

  it.each([
    [RegisterRequestSchema, { email: "a@example.com", password: "12345678" }],
    [LoginRequestSchema, { email: "a@example.com", password: "x" }],
    [ResendVerificationRequestSchema, { email: "a@example.com" }],
    [VerifyEmailQuerySchema, { token: "x" }],
  ] as const)("rejects unknown request fields", (schema, input) => {
    expect(schema.safeParse({ ...input, admin: true }).success).toBe(false);
  });

  const publicUser = {
    id: "user-id",
    email: "a@example.com",
    name: null,
    avatarUrl: null,
    emailVerifiedAt: null,
    createdAt: "2026-11-08T00:00:00.000Z",
  };

  it("restricts public response envelopes and excludes session tokens", () => {
    expect(RegisterResponseSchema.parse({ userId: "user-id" })).toEqual({
      userId: "user-id",
    });
    expect(AuthUserResponseSchema.parse({ user: publicUser })).toEqual({
      user: publicUser,
    });
    expect(AuthMessageResponseSchema.parse({ message: "ok" })).toEqual({
      message: "ok",
    });
    expect(
      AuthUserResponseSchema.safeParse({
        user: publicUser,
        sessionToken: "secret",
      }).success,
    ).toBe(false);
  });

  it("accepts only public user fields with ISO dates", () => {
    expect(PublicUserSchema.parse(publicUser)).toEqual(publicUser);
    expect(
      PublicUserSchema.safeParse({
        ...publicUser,
        emailVerifiedAt: "2026-11-08T00:00:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      PublicUserSchema.safeParse({ ...publicUser, createdAt: new Date() })
        .success,
    ).toBe(false);
    expect(
      PublicUserSchema.safeParse({
        ...publicUser,
        emailVerifiedAt: "yesterday",
      }).success,
    ).toBe(false);
  });

  it.each(["password", "passwordHash", "verificationTokenHash"])(
    "rejects secret field %s in public output",
    (field) => {
      expect(
        PublicUserSchema.safeParse({ ...publicUser, [field]: "secret" })
          .success,
      ).toBe(false);
    },
  );
});
