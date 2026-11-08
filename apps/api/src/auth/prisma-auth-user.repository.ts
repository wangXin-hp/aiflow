import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service.js";
import { Prisma } from "../generated/prisma/client.js";
import { z } from "zod";
import {
  AuthError,
  AuthUserRepository,
  type AuthUser,
  type CreateAuthUser,
} from "./auth.types.js";

// Prisma 7 的 pg 适配器把约束放在 cause.constraint.index，而非旧版 meta.target。
// 只识别模型、表名、异常种类和完整索引名，不通过数据库错误消息猜测约束。
const pgEmailUniqueMetadata = z.object({
  modelName: z.literal("User"),
  driverAdapterError: z.object({
    cause: z.object({
      kind: z.literal("UniqueConstraintViolation"),
      table: z.literal("User"),
      constraint: z.object({ index: z.literal("User_email_key") }),
    }),
  }),
});

/** 复用全局 PrismaService；数据库异常在此转成领域错误，绝不向业务层暴露 SQL 或连接信息。 */
@Injectable()
export class PrismaAuthUserRepository extends AuthUserRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  create(input: CreateAuthUser): Promise<AuthUser> {
    return this.execute(() => this.prisma.user.create({ data: input }), true);
  }

  findByEmail(email: string): Promise<AuthUser | null> {
    return this.execute(() =>
      this.prisma.user.findUnique({ where: { email } }),
    );
  }

  findById(id: string): Promise<AuthUser | null> {
    return this.execute(() => this.prisma.user.findUnique({ where: { id } }));
  }

  /** 把未验证条件放进 UPDATE，避免验证码已消费后又写回可用 token。 */
  async rotateVerificationToken(
    id: string,
    hash: string,
    expiresAt: Date,
  ): Promise<boolean> {
    const result = await this.execute(() =>
      this.prisma.user.updateMany({
        where: { id, emailVerifiedAt: null },
        data: {
          verificationTokenHash: hash,
          verificationTokenExpiresAt: expiresAt,
        },
      }),
    );
    return result.count === 1;
  }

  /** 单条条件 UPDATE 实现原子消费；等于过期时间也无效，成功后清除凭据。 */
  async consumeVerificationToken(hash: string, now: Date): Promise<boolean> {
    const result = await this.execute(() =>
      this.prisma.user.updateMany({
        where: {
          verificationTokenHash: hash,
          emailVerifiedAt: null,
          verificationTokenExpiresAt: { gt: now },
        },
        data: {
          emailVerifiedAt: now,
          verificationTokenHash: null,
          verificationTokenExpiresAt: null,
        },
      }),
    );
    return result.count === 1;
  }

  private async execute<T>(
    operation: () => Promise<T>,
    mapEmailDuplicate = false,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const target =
        error instanceof Prisma.PrismaClientKnownRequestError
          ? error.meta?.target
          : undefined;
      // 仅明确命中 email 单列唯一约束时才报重复邮箱，其他约束故障不能伪装成业务冲突。
      const emailConstraint =
        (Array.isArray(target) &&
          target.length === 1 &&
          target[0] === "email") ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
          pgEmailUniqueMetadata.safeParse(error.meta).success);
      if (
        mapEmailDuplicate &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002" &&
        emailConstraint
      ) {
        throw new AuthError("EMAIL_ALREADY_EXISTS");
      }
      throw new AuthError("AUTH_UNAVAILABLE");
    }
  }
}
