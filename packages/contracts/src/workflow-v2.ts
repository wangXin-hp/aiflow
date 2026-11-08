import { z } from "zod";
import type { JsonValue } from "./workflow.js";

// 严格检查 JSON 字面量：拒绝循环、过深结构及不能无损表示的值。
function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value) && Object.keys(value).length !== value.length)
      return false;
    return Object.values(value).every((item) =>
      isJsonValue(item, ancestors, depth + 1),
    );
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

// V2 与 V1 分开演进；草稿允许暂时缺少节点或连线，执行前另做图校验。
const id = z.string().trim().min(1).max(128);
const position = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});
const referenceBinding = z.strictObject({
  kind: z.literal("reference"),
  nodeId: id,
  key: z.string().min(1).max(128),
  fallback: z
    .custom<JsonValue>((value) => isJsonValue(value), "Invalid JSON value")
    .transform((value) => structuredClone(value))
    .optional(),
});
export const valueBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("literal"),
    value: z
      .custom<JsonValue>((value) => isJsonValue(value), "Invalid JSON value")
      .transform((value) => structuredClone(value)),
  }),
  referenceBinding,
  z.strictObject({
    kind: z.literal("template"),
    parts: z
      .array(z.union([z.string(), referenceBinding]))
      .min(1)
      .max(100),
  }),
]);

const values = z.record(z.string().min(1).max(128), valueBindingSchema);
const base = { id, position };
const node = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("start"),
    config: z
      .strictObject({
        inputs: z
          .array(
            z.strictObject({
              name: id,
              type: z.enum(["string", "number", "boolean", "array", "object"]),
              required: z.boolean().default(false),
              defaultValue: z
                .custom<JsonValue>(
                  (value) => isJsonValue(value),
                  "Invalid JSON value",
                )
                .transform((value) => structuredClone(value))
                .optional(),
            }),
          )
          .max(100)
          .refine(
            (items) =>
              new Set(items.map((item) => item.name)).size === items.length,
            "Input names must be unique",
          ),
      })
      .optional(),
  }),
  z.strictObject({
    ...base,
    type: z.literal("transform"),
    config: z.strictObject({ values }),
  }),
  z.strictObject({
    ...base,
    type: z.literal("condition"),
    config: z.strictObject({ value: valueBindingSchema }),
  }),
  z.strictObject({
    ...base,
    type: z.literal("llm"),
    config: z.strictObject({
      model: id,
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).max(131072).optional(),
      values,
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal("http"),
    config: z.strictObject({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      bodyType: z
        .enum(["none", "json", "raw", "form-data", "x-www-form-urlencoded"])
        .optional(),
      values,
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal("knowledge"),
    config: z.strictObject({
      knowledgeBaseIds: z.array(id).min(1).max(100),
      retrievalMode: z.enum(["vector", "fulltext", "hybrid"]),
      outputFormat: z.enum(["text", "json"]).optional(),
      topK: z.number().int().min(1).max(100),
      threshold: z.number().min(0).max(1).optional(),
      values,
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal("intent"),
    config: z.strictObject({
      model: id,
      intents: z
        .array(z.strictObject({ id, description: z.string().max(2000) }))
        .min(1)
        .max(20)
        .refine(
          (items) => new Set(items.map((i) => i.id)).size === items.length,
          "Intent IDs must be unique",
        ),
      values,
    }),
  }),
  z.strictObject({
    ...base,
    type: z.literal("end"),
    config: z.strictObject({ values }),
  }),
]);
const edge = z.strictObject({
  id,
  source: id,
  target: id,
  sourcePort: id,
  targetPort: z.literal("input"),
});
/** V2 结构协议；完整图语义由引擎负责校验。 */
export const workflowV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  nodes: z.array(node).max(1000),
  edges: z.array(edge).max(5000),
});
export type WorkflowV2 = z.infer<typeof workflowV2Schema>;
export type WorkflowNodeV2 = WorkflowV2["nodes"][number];
export type ValueBinding = z.infer<typeof valueBindingSchema>;
