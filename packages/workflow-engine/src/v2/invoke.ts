import type { WorkflowNodeV2, JsonObject } from "@aiflow/contracts";
import { ExecutionFailure } from "./errors.js";
import type { NodeExecutorV2 } from "./nodes.js";

/** 限制节点等待时间。停止等待不能撤销执行器已产生的外部副作用。 */
export async function invokeNode(
  executor: NodeExecutorV2,
  node: WorkflowNodeV2,
  input: JsonObject,
  timeoutMs: number,
  outerSignal?: AbortSignal,
): Promise<{ output: JsonObject; branch?: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(new ExecutionFailure("cancelled", "Run cancelled"));
      controller.abort();
    };
    if (outerSignal?.aborted) onAbort();
    else outerSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      reject(new ExecutionFailure("node_timeout", "Node execution timed out"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted)
        throw new ExecutionFailure("cancelled", "Run cancelled");
      return executor.execute(node, input, { signal: controller.signal });
    });
    return await Promise.race([operation, interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) outerSignal?.removeEventListener("abort", onAbort);
  }
}
