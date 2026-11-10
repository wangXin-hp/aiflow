import type { RunResultV2 } from "@aiflow/workflow-engine";

const maxStoredOutputBytes = 2 * 1024 * 1024;

function validPostgresText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function validJsonText(value: unknown): boolean {
  if (typeof value === "string") return validPostgresText(value);
  if (Array.isArray(value)) return value.every(validJsonText);
  if (value && typeof value === "object")
    return Object.entries(value).every(
      ([key, item]) => validPostgresText(key) && validJsonText(item),
    );
  return true;
}

/** JSON 序列化后再检查键和值：覆盖 toJSON 结果，并保留正常的字面转义文本。 */
export function validateRunOutput(
  result: RunResultV2 | undefined,
): "valid" | "too_large" | "invalid" {
  try {
    for (const value of [
      result?.output,
      ...(result?.nodes.map((node) => node.output) ?? []),
    ]) {
      if (value === undefined) continue;
      const serialized = JSON.stringify(value);
      if (!serialized) return "invalid";
      if (
        new TextEncoder().encode(serialized).byteLength > maxStoredOutputBytes
      )
        return "too_large";
      if (!validJsonText(JSON.parse(serialized))) return "invalid";
    }
    return "valid";
  } catch {
    return "invalid";
  }
}
