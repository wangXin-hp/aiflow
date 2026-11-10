import { z } from "zod";
import type { JsonObject } from "./workflow.js";
import { workflowV2Schema } from "./workflow-v2.js";

const uuid = z.uuid();
const timestamp = z.iso.datetime();
const maxEventId = "9223372036854775807";

/** 游标使用 PostgreSQL BigInt 范围内的十进制字符串，0 表示从头重放。 */
export const RunEventCursorSchema = z
  .string()
  .refine(
    (value) =>
      value.length <= maxEventId.length &&
      /^(0|[1-9]\d*)$/u.test(value) &&
      (value.length < maxEventId.length || value <= maxEventId),
    "Invalid PostgreSQL BigInt cursor",
  );

/** 运行及节点状态与 Prisma 的对应枚举保持一致。 */
export const RunStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "CANCELLING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);
/** 节点状态区分待执行和跳过，供节点持久化及日志共用。 */
export const NodeRunStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
]);

const maxRunInputBytes = 2 * 1024 * 1024;
const utf8 = new TextEncoder();

/** 公开事件载荷按序列化后的 UTF-8 字节计量，供写入层共用。 */
export const MAX_RUN_EVENT_PAYLOAD_BYTES = 64 * 1024;

/** 在 Zod 解析前逐层检查 JSON 字面量，遇到超限或会被静默丢弃的属性即拒绝。 */
function boundedJsonObject({
  maxDepth,
  maxBytes,
}: {
  maxDepth: number;
  maxBytes: number;
}) {
  return z.custom<JsonObject>((input) => {
    let remainingBytes = maxBytes;
    const ancestors = new Set<object>();
    function consume(bytes: number): boolean {
      remainingBytes -= bytes;
      return remainingBytes >= 0;
    }

    function consumeString(value: string): boolean {
      // 先排除明显超限的字符串，避免为整份载荷或单个超大字符串分配缓冲区。
      return (
        value.length <= remainingBytes &&
        consume(utf8.encode(JSON.stringify(value)).byteLength)
      );
    }

    function visit(value: unknown, depth: number): boolean {
      if (depth > maxDepth) return false;
      if (typeof value === "string") return consumeString(value);
      if (typeof value === "number")
        return Number.isFinite(value) && consume(String(value).length);
      if (value === null || typeof value === "boolean")
        return consume(String(value).length);
      if (typeof value !== "object" || ancestors.has(value)) return false;

      const array = Array.isArray(value);
      const prototype: unknown = Object.getPrototypeOf(value);
      if (
        array
          ? prototype !== Array.prototype
          : prototype !== Object.prototype && prototype !== null
      )
        return false;

      const keys = Reflect.ownKeys(value);
      const length = array ? value.length : keys.length;
      if (array && keys.length !== length + 1) return false;
      // 累计括号和逗号，随后逐项计入键、冒号和值。
      if (!consume(2 + Math.max(0, length - 1))) return false;

      ancestors.add(value);
      try {
        for (let index = 0; index < length; index++) {
          const key = array ? String(index) : keys[index];
          if (typeof key !== "string" || key === "__proto__") return false;
          if (!array && (!consumeString(key) || !consume(1))) return false;

          const property = Object.getOwnPropertyDescriptor(value, key);
          if (!property?.enumerable || !("value" in property)) return false;
          if (!visit(property.value, depth + 1)) return false;
        }
        return true;
      } finally {
        // 同一对象可出现在多个分支中，只有当前路径上的重复引用构成循环。
        ancestors.delete(value);
      }
    }

    try {
      return (
        input !== null &&
        typeof input === "object" &&
        !Array.isArray(input) &&
        visit(input, 0)
      );
    } catch {
      return false;
    }
  }, "Expected a bounded JSON object");
}

const runInput = boundedJsonObject({
  maxDepth: 100,
  maxBytes: maxRunInputBytes,
}).pipe(z.record(z.string(), z.json()));

/** 输入使用与 HTTP 请求一致的体积上限，应用层按快照校验开始节点字段。 */
export const CreateRunRequestSchema = z.strictObject({
  input: runInput,
});

/** 受保护的运行详情包含图快照及业务输入输出。 */
export const RunResponseSchema = z.strictObject({
  id: uuid,
  workflowId: uuid,
  workflowVersionId: uuid.nullable().optional(),
  status: RunStatusSchema,
  definitionSnapshot: workflowV2Schema,
  input: runInput,
  output: z.json().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
});

/** 公开事件只允许状态、耗时、错误代码和截断标记；应用层负责写入前脱敏。 */
export const SafeRunEventPayloadSchema = boundedJsonObject({
  maxDepth: 8,
  maxBytes: MAX_RUN_EVENT_PAYLOAD_BYTES,
}).pipe(
  z.strictObject({
    status: z.union([RunStatusSchema, NodeRunStatusSchema]).optional(),
    elapsedMs: z.int().nonnegative().optional(),
    startedAt: timestamp.optional(),
    finishedAt: timestamp.optional(),
    errorCode: z
      .string()
      .regex(/^[a-z\d][a-z\d_.-]{0,127}$/iu)
      .optional(),
    truncated: z.literal(true).optional(),
  }),
);

/** SSE 事件使用正整数持久化 ID；运行级事件可省略节点 ID 或使用 null。 */
export const RunEventSchema = z.strictObject({
  id: RunEventCursorSchema.refine((value) => value !== "0", "Invalid event ID"),
  runId: uuid,
  nodeId: z.string().nullish(),
  type: z.string().min(1),
  level: z.enum(["debug", "info", "warn", "error"]),
  payload: SafeRunEventPayloadSchema,
  createdAt: timestamp,
});

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type RunResponse = z.infer<typeof RunResponseSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
