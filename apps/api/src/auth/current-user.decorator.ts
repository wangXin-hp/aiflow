import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { PublicUser } from "@aiflow/contracts";
import type { Request } from "express";
import { ApiError } from "../common/api-error.js";

export type AuthenticatedRequest = Request & { user?: PublicUser };
/** 只读取 Guard 已验签且重新查询的安全用户投影，不解码未验证的客户端数据。 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PublicUser => {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new ApiError(401, "UNAUTHORIZED", "请先登录");
    return user;
  },
);
