import type { ModelAdapterV2 } from "../v2/nodes.js";
import { readBoundedText } from "./response.js";

/** 云端兼容接口的连接配置；密钥由服务端调用方注入，不写入工作流定义。 */
export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
}
function createClient(options: OpenAICompatibleOptions) {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new TypeError(
      "Cloud API base URL must be HTTPS without credentials, query or fragment",
    );
  if (!options.apiKey.trim()) throw new TypeError("Cloud API key is required");
  const root = new URL(base.href.endsWith("/") ? base.href : `${base.href}/`);
  const limit = options.maxResponseBytes ?? 1_048_576;
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError("Invalid response size limit");
  return async (
    path: string,
    body: object,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const response = await (options.fetch ?? fetch)(new URL(path, root), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
    // 不暴露供应商错误响应体：其中可能包含请求数据或凭据。
    if (!response.ok)
      throw new Error(
        `Cloud model request failed with status ${response.status}`,
      );
    const text = await readBoundedText(response, limit);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("Invalid cloud response JSON");
    }
  };
}

/** Chat Completions 兼容适配器；具体模型及受支持的参数由供应商决定。 */
export function createOpenAICompatibleModelAdapter(
  options: OpenAICompatibleOptions & {
    maxTokensField?: "max_tokens" | "max_completion_tokens";
  },
): ModelAdapterV2 {
  const post = createClient(options);
  return {
    async generate(request) {
      const messages: Array<{
        role: "system" | "user" | "assistant";
        content: string;
      }> = [];
      if (request.system)
        messages.push({ role: "system", content: request.system });
      if (request.assistant)
        messages.push({ role: "assistant", content: request.assistant });
      messages.push({ role: "user", content: request.user });
      const data = await post(
        "chat/completions",
        {
          model: request.model,
          messages,
          stream: false,
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          ...(request.maxTokens !== undefined
            ? { [options.maxTokensField ?? "max_tokens"]: request.maxTokens }
            : {}),
        },
        request.signal,
      );
      if (
        !data ||
        typeof data !== "object" ||
        !("choices" in data) ||
        !Array.isArray(data.choices) ||
        !data.choices[0] ||
        typeof data.choices[0] !== "object" ||
        !("message" in data.choices[0]) ||
        !data.choices[0].message ||
        typeof data.choices[0].message !== "object" ||
        typeof data.choices[0].message.content !== "string"
      )
        throw new Error("Invalid cloud model response");
      const usage = "usage" in data ? data.usage : undefined;
      const tokens =
        usage &&
        typeof usage === "object" &&
        "total_tokens" in usage &&
        typeof usage.total_tokens === "number" &&
        Number.isSafeInteger(usage.total_tokens) &&
        usage.total_tokens >= 0
          ? usage.total_tokens
          : undefined;
      return {
        text: data.choices[0].message.content,
        ...(tokens === undefined ? {} : { tokens }),
      };
    },
  };
}

/** embeddings 兼容适配器，返回的维度应与目标向量库集合一致。 */
export function createOpenAICompatibleEmbeddingAdapter(
  options: OpenAICompatibleOptions & { model: string },
): { embed(text: string, signal: AbortSignal): Promise<number[]> } {
  if (!options.model.trim()) throw new TypeError("Embedding model is required");
  const post = createClient(options);
  return {
    async embed(text, signal) {
      const data = await post(
        "embeddings",
        { model: options.model, input: text, encoding_format: "float" },
        signal,
      );
      if (
        !data ||
        typeof data !== "object" ||
        !("data" in data) ||
        !Array.isArray(data.data) ||
        data.data.length !== 1 ||
        !data.data[0] ||
        typeof data.data[0] !== "object" ||
        !Array.isArray(data.data[0].embedding) ||
        data.data[0].embedding.length === 0 ||
        !data.data[0].embedding.every(
          (value: unknown) =>
            typeof value === "number" && Number.isFinite(value),
        )
      )
        throw new Error("Invalid cloud embedding response");
      return data.data[0].embedding as number[];
    },
  };
}
