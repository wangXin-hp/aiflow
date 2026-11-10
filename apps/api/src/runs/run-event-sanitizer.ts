import {
  MAX_RUN_EVENT_PAYLOAD_BYTES,
  SafeRunEventPayloadSchema,
  type JsonValue,
} from "@aiflow/contracts";

const byteLength = (value: object) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const unsafeKey =
  /authorization|cookie|password|token|api.?key|prompt|input|output|secret/iu;
const allowed = new Set([
  "status",
  "elapsedMs",
  "durationMs",
  "startedAt",
  "finishedAt",
  "errorCode",
  "truncated",
]);

/** 遍历原值而不复制业务数据；深度、数量及循环均只产生截断标记。 */
function inspect(value: unknown): boolean {
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  let removed = false;
  while (stack.length) {
    const current = stack.pop()!;
    if (++count > 1024 || current.depth > 12) return true;
    if (!current.value || typeof current.value !== "object") {
      if (
        ["function", "symbol", "bigint", "undefined"].includes(
          typeof current.value,
        )
      )
        removed = true;
      continue;
    }
    if (seen.has(current.value)) return true;
    seen.add(current.value);
    if (
      !Array.isArray(current.value) &&
      Object.getPrototypeOf(current.value) !== Object.prototype &&
      Object.getPrototypeOf(current.value) !== null
    )
      return true;
    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(current.value);
    } catch {
      return true;
    }
    if (keys.length > 128) return true;
    for (const key of keys) {
      if (
        typeof key !== "string" ||
        unsafeKey.test(key) ||
        (current.depth === 0 && !allowed.has(key))
      ) {
        removed = true;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        removed = true;
        continue;
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return removed;
}

/** 仅输出公开事件元数据；超限或危险内容返回完整 JSON 标记，永不切割序列化文本。 */
export function sanitizeRunEventPayload(
  value: unknown,
  maxBytes: number = MAX_RUN_EVENT_PAYLOAD_BYTES,
): JsonValue {
  const limit = Math.min(maxBytes, MAX_RUN_EVENT_PAYLOAD_BYTES);
  if (!Number.isInteger(limit) || limit < 2)
    throw new RangeError("Invalid event payload byte limit");
  let removed = inspect(value);
  const projected: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of allowed) {
      if (key === "durationMs") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor && descriptor.enumerable)
        projected[key] = descriptor.value;
    }
    if (projected.elapsedMs === undefined) {
      const duration = Object.getOwnPropertyDescriptor(value, "durationMs");
      if (duration && "value" in duration && duration.enumerable)
        projected.elapsedMs = duration.value;
    }
  } else removed = true;
  const parsed = SafeRunEventPayloadSchema.safeParse(projected);
  if (!parsed.success) {
    removed = true;
    for (const key of Object.keys(projected)) {
      if (
        !SafeRunEventPayloadSchema.safeParse({ [key]: projected[key] }).success
      )
        delete projected[key];
    }
  }
  if (removed) projected.truncated = true;
  for (const key of [
    "errorCode",
    "finishedAt",
    "startedAt",
    "elapsedMs",
    "status",
  ]) {
    if (byteLength(projected) <= limit) break;
    delete projected[key];
    projected.truncated = true;
  }
  if (byteLength(projected) > limit)
    return limit >= byteLength({ truncated: true }) ? { truncated: true } : {};
  return SafeRunEventPayloadSchema.parse(projected);
}
