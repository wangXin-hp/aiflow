import type { JsonObject, JsonValue, ValueBinding } from "@aiflow/contracts";
import { cloneJson } from "../execution.js";
import { ExecutionFailure } from "./errors.js";

export function objectCopy(input: unknown): JsonObject {
  const value = cloneJson(input);
  if (value === null || Array.isArray(value) || typeof value !== "object")
    throw new TypeError("Workflow input must be a JSON object");
  return value;
}
export function bindingsOutput(
  values: Record<string, ValueBinding>,
  outputs: Map<string, JsonObject>,
): JsonObject {
  const result: JsonObject = Object.create(null) as JsonObject;
  for (const [name, binding] of Object.entries(values))
    Object.defineProperty(result, name, {
      enumerable: true,
      writable: true,
      configurable: true,
      value: resolve(binding, outputs),
    });
  return result;
}
export function resolve(
  binding: ValueBinding,
  outputs: Map<string, JsonObject>,
): JsonValue {
  if (binding.kind === "literal") return cloneJson(binding.value);
  if (binding.kind === "template")
    return binding.parts
      .map((part) => {
        if (typeof part === "string") return part;
        const value = resolve(part, outputs);
        return typeof value === "string" ? value : JSON.stringify(value);
      })
      .join("");
  const source = outputs.get(binding.nodeId);
  if (!source || !Object.hasOwn(source, binding.key)) {
    if (binding.fallback !== undefined) return cloneJson(binding.fallback);
    throw new ExecutionFailure(
      "missing_reference",
      `Missing output ${binding.nodeId}.${binding.key}`,
    );
  }
  return cloneJson(source[binding.key]);
}
