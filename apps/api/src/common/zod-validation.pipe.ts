import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";
import { validationError } from "./api-error.js";

/** 每个请求入口显式绑定共享契约，解析后的规范化值才可交给业务服务。 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<T>
> {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw validationError(result.error);
    return result.data;
  }
}
