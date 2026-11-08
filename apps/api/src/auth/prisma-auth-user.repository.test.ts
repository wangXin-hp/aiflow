import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { PrismaService } from "../database/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { PrismaAuthUserRepository } from "./prisma-auth-user.repository.js";
import { AuthError, type AuthUser, type CreateAuthUser } from "./auth.types.js";

const input: CreateAuthUser = {
  email: "alice@example.com",
  name: "Alice",
  passwordHash: "password-hash",
  verificationTokenHash: "token-hash",
  verificationTokenExpiresAt: new Date("2026-11-09T00:00:00.000Z"),
};
const user: AuthUser = {
  ...input,
  id: "d523a120-83ed-4c66-92c3-53fbc6deeb5d",
  avatarUrl: null,
  emailVerifiedAt: null,
  createdAt: new Date("2026-11-08T00:00:00.000Z"),
};

function fixture() {
  // Prisma 只替换执行查询的数据库边界，断言仓储生成的条件和数据而非实现内部调用链。
  const delegate = {
    create: vi.fn().mockResolvedValue(user),
    findUnique: vi.fn().mockResolvedValue(user),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const repository = new PrismaAuthUserRepository({
    user: delegate,
  } as unknown as PrismaService);
  return { repository, delegate };
}

function uniqueError(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError(
    "private SQL connection information",
    { code: "P2002", clientVersion: "7.10.1", meta: { target } },
  );
}

describe("PrismaAuthUserRepository", () => {
  it("persists only hashes from the create port", async () => {
    const { repository, delegate } = fixture();
    expect(await repository.create(input)).toEqual(user);
    expect(delegate.create).toHaveBeenCalledExactlyOnceWith({ data: input });
  });

  it("maps only email uniqueness failures to duplicate-email errors", async () => {
    const { repository, delegate } = fixture();
    delegate.create.mockRejectedValue(uniqueError(["email"]));
    await expect(repository.create(input)).rejects.toMatchObject({
      code: "EMAIL_ALREADY_EXISTS",
    });
    delegate.create.mockRejectedValue(uniqueError(["id"]));
    await expect(repository.create(input)).rejects.toMatchObject({
      code: "AUTH_UNAVAILABLE",
    });
  });

  it("hides underlying database messages for all operations", async () => {
    const { repository, delegate } = fixture();
    delegate.create.mockRejectedValue(new Error("private database secret"));
    delegate.findUnique.mockRejectedValue(new Error("private database secret"));
    delegate.updateMany.mockRejectedValue(new Error("private database secret"));
    const now = new Date();
    for (const action of [
      () => repository.create(input),
      () => repository.findByEmail(user.email),
      () => repository.findById(user.id),
      () => repository.rotateVerificationToken(user.id, "hash", now),
      () => repository.consumeVerificationToken("hash", now),
    ]) {
      const error = await action().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AuthError);
      expect(error).toMatchObject({ code: "AUTH_UNAVAILABLE" });
      expect((error as Error).message).not.toContain("private");
    }
  });

  it("recognizes the exact Prisma 7 pg adapter email index without misclassifying other constraints", async () => {
    const { repository, delegate } = fixture();
    for (const [index, table, code] of [
      ["User_email_key", "User", "EMAIL_ALREADY_EXISTS"],
      ["User_id_key", "User", "AUTH_UNAVAILABLE"],
      ["User_email_key", "Other", "AUTH_UNAVAILABLE"],
    ]) {
      delegate.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("private SQL", {
          code: "P2002",
          clientVersion: "7.10.1",
          meta: {
            modelName: "User",
            driverAdapterError: {
              name: "DriverAdapterError",
              cause: {
                originalCode: "23505",
                originalMessage: "private SQL",
                kind: "UniqueConstraintViolation",
                table,
                constraint: { index },
              },
            },
          },
        }),
      );
      await expect(repository.create(input)).rejects.toMatchObject({ code });
    }
  });

  it("looks up persisted users by exact normalized email or id", async () => {
    const { repository, delegate } = fixture();
    expect(await repository.findByEmail(user.email)).toEqual(user);
    expect(delegate.findUnique).toHaveBeenLastCalledWith({
      where: { email: "alice@example.com" },
    });
    expect(await repository.findById(user.id)).toEqual(user);
    expect(delegate.findUnique).toHaveBeenLastCalledWith({
      where: { id: user.id },
    });
    delegate.findUnique.mockResolvedValue(null);
    expect(await repository.findById(user.id)).toBeNull();
  });

  it("rotates only an existing unverified account", async () => {
    const { repository, delegate } = fixture();
    const expiresAt = new Date("2026-11-09T00:00:00.000Z");
    expect(
      await repository.rotateVerificationToken(user.id, "next-hash", expiresAt),
    ).toBe(true);
    expect(delegate.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: user.id, emailVerifiedAt: null },
      data: {
        verificationTokenHash: "next-hash",
        verificationTokenExpiresAt: expiresAt,
      },
    });
    delegate.updateMany.mockResolvedValue({ count: 0 });
    expect(
      await repository.rotateVerificationToken(user.id, "next-hash", expiresAt),
    ).toBe(false);
  });

  it("consumes only an unexpired unused hash in one conditional database update", async () => {
    const { repository, delegate } = fixture();
    const now = new Date("2026-11-08T12:00:00.000Z");
    expect(await repository.consumeVerificationToken("token-hash", now)).toBe(
      true,
    );
    expect(delegate.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        verificationTokenHash: "token-hash",
        emailVerifiedAt: null,
        verificationTokenExpiresAt: { gt: now },
      },
      data: {
        emailVerifiedAt: now,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
      },
    });
    delegate.updateMany.mockResolvedValue({ count: 0 });
    expect(await repository.consumeVerificationToken("token-hash", now)).toBe(
      false,
    );
  });
});
