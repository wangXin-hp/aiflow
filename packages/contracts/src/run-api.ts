import { z } from "zod";
import { workflowV2Schema } from "./workflow-v2.js";

const uuid = z.uuid();
const timestamp = z.iso.datetime();
const decimalId = z.string().regex(/^(0|[1-9]\d*)$/u);

/** BigInt 游标始终为十进制字符串，避免 JSON 数值精度丢失。 */
export const RunEventCursorSchema = decimalId;
export const RunStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "CANCELLING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);
export const NodeRunStatusSchema = z.enum([
  "PENDING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
]);

/** 输入只允许 JSON 对象；具体开始节点字段由应用层按快照校验。 */
export const CreateRunRequestSchema = z.strictObject({
  input: z.record(z.string(), z.json()),
});

export const RunResponseSchema = z.strictObject({
  id: uuid,
  workflowId: uuid,
  workflowVersionId: uuid.nullable().optional(),
  status: RunStatusSchema,
  definitionSnapshot: workflowV2Schema,
  input: z.record(z.string(), z.json()),
  output: z.json().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: timestamp,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
});

const forbiddenKey = /^(authorization|cookie|password|token|api.?key)$/iu;
function hasSensitiveKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSensitiveKey);
  return Object.entries(value).some(
    ([key, child]) => forbiddenKey.test(key) || hasSensitiveKey(child),
  );
}

/** 事件只承载可展示元数据；敏感键即使嵌套也不进入公开事件。 */
export const SafeRunEventPayloadSchema = z
  .record(z.string(), z.json())
  .refine((value) => !hasSensitiveKey(value), "Sensitive event payload key");

export const RunEventSchema = z.strictObject({
  id: decimalId,
  runId: uuid,
  nodeId: z.string().nullable(),
  type: z.string().min(1),
  level: z.enum(["debug", "info", "warn", "error"]),
  payload: SafeRunEventPayloadSchema,
  createdAt: timestamp,
});

export type CreateRunRequest = z.infer<typeof CreateRunRequestSchema>;
export type RunResponse = z.infer<typeof RunResponseSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
