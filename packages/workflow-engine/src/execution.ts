import { type JsonObject, type JsonValue } from "@aiflow/contracts";
import {
  parseAndValidateWorkflow,
  type ValidationIssue,
} from "./validation.js";

/** 非法工作流定义的错误；issues 保留可供界面或 API 展示的校验详情。 */
export class WorkflowValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super("Invalid workflow definition");
    this.name = "WorkflowValidationError";
  }
}
/** V1 节点执行快照：当前仅有同步成功状态，其他状态留待后续设计。 */
export interface NodeExecutionResult {
  nodeId: string;
  status: "succeeded";
  input: JsonObject;
  output: JsonObject;
}
/** V1 单次运行的节点结果和最终输出；当前结果只存在于内存中。 */
export interface WorkflowExecutionResult {
  status: "succeeded";
  nodes: NodeExecutionResult[];
  output: JsonObject;
}

/**
 * 递归校验并复制 JSON 值，避免 JSON.stringify 静默丢弃 undefined 等数据。
 * ancestors 只记录当前递归路径，因此允许多个位置引用同一个非循环对象。
 * 深度上限保护调用栈；普通对象采用无原型副本，避免特殊键影响对象原型。
 */
export function cloneJson(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): JsonValue {
  if (depth > 100) throw new TypeError("Input exceeds maximum depth");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object")
    throw new TypeError("Input must contain only JSON values");
  if (ancestors.has(value))
    throw new TypeError("Input must not contain cycles");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TypeError("Input objects must be plain objects");
  // 进入当前分支时记录对象，离开时移除，以区分循环引用与普通共享引用。
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length)
        throw new TypeError("Input arrays must be dense");
      return value.map((item) => cloneJson(item, ancestors, depth + 1));
    }
    if (Object.getOwnPropertySymbols(value).length)
      throw new TypeError("Input must not contain symbol keys");
    // 无原型对象和显式属性定义可安全复制 __proto__ 等普通 JSON 键。
    const output: JsonObject = Object.create(null) as JsonObject;
    for (const [key, item] of Object.entries(value))
      Object.defineProperty(output, key, {
        value: cloneJson(item, ancestors, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return output;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * 同步执行已支持的开始 → 结束流程。
 * @param definition 不可信的工作流定义；会解析并校验一次。
 * @param input 输入 JSON 对象；不接受循环引用、非有限数字或特殊对象。
 * @returns 独立复制的节点快照和最终输出，调用方修改它们不会互相影响。
 * @throws WorkflowValidationError 定义非法；TypeError 输入不符合 JSON 约束。
 */
export function executeWorkflow(
  definition: unknown,
  input: unknown,
): WorkflowExecutionResult {
  // 只解析一次，并且仅使用通过校验的快照，避免读取可变原始定义两次。
  const { validation, graph } = parseAndValidateWorkflow(definition);
  if (!validation.valid || !graph)
    throw new WorkflowValidationError(validation.errors);
  const cloned = cloneJson(input);
  if (cloned === null || Array.isArray(cloned) || typeof cloned !== "object")
    throw new TypeError("Workflow input must be a JSON object");
  // V1 仅有开始和结束两种节点；图校验已确保两者各有且仅有一个。
  const start = graph.nodes.find((node) => node.type === "start")!;
  const end = graph.nodes.find((node) => node.type === "end")!;
  // 为每个节点输入、输出和最终输出分别生成副本，防止后续修改串扰。
  return {
    status: "succeeded",
    nodes: [
      {
        nodeId: start.id,
        status: "succeeded",
        input: cloneJson(cloned) as JsonObject,
        output: cloneJson(cloned) as JsonObject,
      },
      {
        nodeId: end.id,
        status: "succeeded",
        input: cloneJson(cloned) as JsonObject,
        output: cloneJson(cloned) as JsonObject,
      },
    ],
    output: cloneJson(cloned) as JsonObject,
  };
}
