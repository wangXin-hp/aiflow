import { SetMetadata } from "@nestjs/common";

export const PUBLIC_ROUTE = Symbol("PUBLIC_ROUTE");
/** 认证默认拒绝；只有明确标记的 handler/Controller 允许匿名访问。 */
export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
