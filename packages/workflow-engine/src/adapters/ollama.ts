import type { ModelAdapterV2 } from "../v2/nodes.js";
import { readBoundedText } from "./response.js";

/** 使用 Ollama 的非流式 chat API；地址由应用层显式配置。 */
export function createOllamaModelAdapter(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
}): ModelAdapterV2 {
  const base = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(base.protocol))
    throw new TypeError("Invalid Ollama URL");
  const endpoint = new URL(
    "api/chat",
    base.href.endsWith("/") ? base : `${base.href}/`,
  );
  const send = options.fetch ?? fetch;
  return {
    async generate(request) {
      const messages: Array<{ role: string; content: string }> = [];
      if (request.system)
        messages.push({ role: "system", content: request.system });
      if (request.assistant)
        messages.push({ role: "assistant", content: request.assistant });
      messages.push({ role: "user", content: request.user });
      const response = await send(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages,
          stream: false,
          ...(request.temperature !== undefined ||
          request.maxTokens !== undefined
            ? {
                options: {
                  ...(request.temperature !== undefined
                    ? { temperature: request.temperature }
                    : {}),
                  ...(request.maxTokens !== undefined
                    ? { num_predict: request.maxTokens }
                    : {}),
                },
              }
            : {}),
        }),
        signal: request.signal,
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(`Ollama request failed with status ${response.status}`);
      const data: unknown = JSON.parse(
        await readBoundedText(response, options.maxResponseBytes ?? 1_048_576),
      );
      if (
        !data ||
        typeof data !== "object" ||
        !("message" in data) ||
        !data.message ||
        typeof data.message !== "object" ||
        !("content" in data.message) ||
        typeof data.message.content !== "string"
      )
        throw new Error("Invalid Ollama response");
      const prompt =
        "prompt_eval_count" in data &&
        typeof data.prompt_eval_count === "number"
          ? data.prompt_eval_count
          : undefined;
      const completion =
        "eval_count" in data && typeof data.eval_count === "number"
          ? data.eval_count
          : undefined;
      return {
        text: data.message.content,
        ...(prompt !== undefined && completion !== undefined
          ? { tokens: prompt + completion }
          : {}),
      };
    },
  };
}

/** Ollama 向量化适配器；向量维度由模型决定。 */
export function createOllamaEmbeddingAdapter(options: {
  baseUrl: string;
  model: string;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
}): { embed(text: string, signal: AbortSignal): Promise<number[]> } {
  const base = new URL(options.baseUrl);
  if (!["http:", "https:"].includes(base.protocol))
    throw new TypeError("Invalid Ollama URL");
  const endpoint = new URL(
    "api/embed",
    base.href.endsWith("/") ? base : `${base.href}/`,
  );
  return {
    async embed(text, signal) {
      const response = await (options.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: options.model, input: text }),
        signal,
        redirect: "error",
      });
      if (!response.ok)
        throw new Error(
          `Ollama embedding request failed with status ${response.status}`,
        );
      const data: unknown = JSON.parse(
        await readBoundedText(response, options.maxResponseBytes ?? 1_048_576),
      );
      if (
        !data ||
        typeof data !== "object" ||
        !("embeddings" in data) ||
        !Array.isArray(data.embeddings) ||
        data.embeddings.length !== 1 ||
        !Array.isArray(data.embeddings[0]) ||
        data.embeddings[0].length === 0 ||
        !data.embeddings[0].every(
          (value: unknown) =>
            typeof value === "number" && Number.isFinite(value),
        )
      )
        throw new Error("Invalid embedding response");
      return data.embeddings[0] as number[];
    },
  };
}
