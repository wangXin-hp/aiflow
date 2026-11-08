import type { WorkflowNodeV2, JsonObject, JsonValue } from "@aiflow/contracts";
import { ExecutionFailure } from "./errors.js";

/** 模型、HTTP 和知识库均通过端口注入，调度器不依赖具体供应商。 */
export interface ModelAdapterV2 {
  generate(request: {
    model: string;
    user: string;
    system?: string;
    assistant?: string;
    temperature?: number;
    maxTokens?: number;
    signal: AbortSignal;
  }): Promise<{ text: string; tokens?: number }>;
}
export interface HttpAdapterV2 {
  request(request: {
    method: string;
    url: string;
    headers?: JsonObject;
    params?: JsonObject;
    bodyType?: "none" | "json" | "raw" | "form-data" | "x-www-form-urlencoded";
    body?: JsonValue;
    signal: AbortSignal;
  }): Promise<{ status: number; headers: JsonObject; data: JsonValue }>;
}
export interface KnowledgeAdapterV2 {
  retrieve(request: {
    query: string;
    knowledgeBaseIds: string[];
    mode: "vector" | "fulltext" | "hybrid";
    topK: number;
    threshold?: number;
    signal: AbortSignal;
  }): Promise<
    Array<{
      documentId: string;
      chunkId: string;
      content: string;
      score: number;
      knowledgeBaseId?: string;
      chunkIndex?: number;
    }>
  >;
}
export interface NodeAdaptersV2 {
  model?: ModelAdapterV2;
  http?: HttpAdapterV2;
  knowledge?: KnowledgeAdapterV2;
}
/** 执行器仅接收节点副本、已解析输入和取消信号，不直接持有运行上下文。 */
export interface NodeExecutorV2 {
  execute(
    node: WorkflowNodeV2,
    input: JsonObject,
    context: { signal: AbortSignal },
  ): Promise<{ output: JsonObject; branch?: string }>;
}
function requiredString(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim())
    throw new ExecutionFailure(
      "invalid_node_input",
      `${key} must be a non-empty string`,
    );
  return value;
}
function optionalString(input: JsonObject, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string")
    throw new ExecutionFailure("invalid_node_input", `${key} must be a string`);
  return value;
}
/** 节点结果只返回业务数据；敏感请求内容不进入引擎事件。 */
function createBuiltinExecutor(adapters: NodeAdaptersV2): NodeExecutorV2 {
  return {
    async execute(
      node,
      input,
      { signal },
    ): Promise<{ output: JsonObject; branch?: string }> {
      if (node.type === "start" && node.config) {
        for (const field of node.config.inputs) {
          if (
            !Object.hasOwn(input, field.name) &&
            field.defaultValue !== undefined
          )
            Object.defineProperty(input, field.name, {
              value: structuredClone(field.defaultValue),
              writable: true,
              configurable: true,
              enumerable: true,
            });
          if (!Object.hasOwn(input, field.name)) {
            if (field.required)
              throw new ExecutionFailure(
                "invalid_node_input",
                `Missing required input ${field.name}`,
              );
            continue;
          }
          const value = input[field.name];
          const matches =
            field.type === "array"
              ? Array.isArray(value)
              : field.type === "object"
                ? value !== null &&
                  typeof value === "object" &&
                  !Array.isArray(value)
                : typeof value === field.type;
          if (!matches)
            throw new ExecutionFailure(
              "invalid_node_input",
              `Invalid input type for ${field.name}: expected ${field.type}`,
            );
        }
        return { output: input };
      }
      if (node.type === "condition") {
        if (typeof input.value !== "boolean")
          throw new ExecutionFailure(
            "invalid_condition",
            "Condition value must be boolean",
          );
        return {
          output: { value: input.value },
          branch: input.value ? "true" : "false",
        };
      }
      if (node.type === "llm" || node.type === "intent") {
        if (!adapters.model)
          throw new ExecutionFailure(
            "adapter_not_configured",
            "Model adapter is not configured",
          );
        if (node.type === "llm") {
          const response = await adapters.model.generate({
            model: node.config.model,
            user: requiredString(input, "user"),
            system: optionalString(input, "system"),
            assistant: optionalString(input, "assistant"),
            temperature: node.config.temperature,
            maxTokens: node.config.maxTokens,
            signal,
          });
          return {
            output: { output: response.text, tokens: response.tokens ?? null },
          };
        }
        const text = requiredString(input, "text");
        const intents = node.config.intents.map(({ id, description }) => ({
          id,
          description,
        }));
        const response = await adapters.model.generate({
          model: node.config.model,
          system: `Select exactly one intent from this JSON list: ${JSON.stringify(intents)}. Return only JSON with intent and confidence.`,
          user: text,
          signal,
        });
        let result: unknown;
        try {
          result = JSON.parse(response.text);
        } catch {
          throw new ExecutionFailure(
            "invalid_intent_response",
            "Model returned invalid intent JSON",
          );
        }
        if (
          !result ||
          typeof result !== "object" ||
          !("intent" in result) ||
          typeof result.intent !== "string" ||
          !intents.some((intent) => intent.id === result.intent)
        )
          throw new ExecutionFailure(
            "invalid_intent_response",
            "Model returned an unknown intent",
          );
        const confidence =
          "confidence" in result &&
          typeof result.confidence === "number" &&
          Number.isFinite(result.confidence) &&
          result.confidence >= 0 &&
          result.confidence <= 1
            ? result.confidence
            : null;
        return {
          output: { intent: result.intent, confidence },
          branch: result.intent,
        };
      }
      if (node.type === "http") {
        if (!adapters.http)
          throw new ExecutionFailure(
            "adapter_not_configured",
            "HTTP adapter is not configured",
          );
        const headers = input.headers;
        if (
          headers !== undefined &&
          (headers === null ||
            typeof headers !== "object" ||
            Array.isArray(headers))
        )
          throw new ExecutionFailure(
            "invalid_node_input",
            "headers must be an object",
          );
        const params = input.params;
        if (
          params !== undefined &&
          (params === null ||
            typeof params !== "object" ||
            Array.isArray(params))
        )
          throw new ExecutionFailure(
            "invalid_node_input",
            "params must be an object",
          );
        const response = await adapters.http.request({
          method: node.config.method,
          url: requiredString(input, "url"),
          headers: headers as JsonObject | undefined,
          params: params as JsonObject | undefined,
          bodyType: node.config.bodyType,
          body: input.body,
          signal,
        });
        return {
          output: {
            status: response.status,
            headers: response.headers,
            data: response.data,
            success: response.status >= 200 && response.status < 300,
          },
        };
      }
      if (node.type === "knowledge") {
        if (!adapters.knowledge)
          throw new ExecutionFailure(
            "adapter_not_configured",
            "Knowledge adapter is not configured",
          );
        const results = await adapters.knowledge.retrieve({
          query: requiredString(input, "query"),
          knowledgeBaseIds: node.config.knowledgeBaseIds,
          mode: node.config.retrievalMode,
          topK: node.config.topK,
          threshold: node.config.threshold,
          signal,
        });
        const output =
          node.config.outputFormat === "text"
            ? results
                .map((item, index) => `[${index + 1}] ${item.content}`)
                .join("\n\n")
            : JSON.stringify(results, null, 2);
        return { output: { results, output } };
      }
      return { output: input };
    },
  };
}
/** 注册表隔离节点实现；无显式适配器时拒绝访问外部服务。 */
export class NodeRegistryV2 {
  private readonly executors = new Map<
    WorkflowNodeV2["type"],
    NodeExecutorV2
  >();
  private readonly builtin: NodeExecutorV2;
  constructor(adapters: NodeAdaptersV2 = {}) {
    this.builtin = createBuiltinExecutor(adapters);
  }
  register(type: WorkflowNodeV2["type"], executor: NodeExecutorV2): void {
    this.executors.set(type, executor);
  }
  get(type: WorkflowNodeV2["type"]): NodeExecutorV2 {
    return this.executors.get(type) ?? this.builtin;
  }
}
