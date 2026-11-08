import type { ModelAdapterV2 } from "../v2/nodes.js";
import { createOpenAICompatibleModelAdapter } from "./openai-compatible.js";

/** 方舟标准 API 的北京地域地址；其他地域或套餐地址由调用方显式覆盖。 */
export const ARK_DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * 豆包文本模型适配器。模型 ID 或推理接入点 ID 随节点配置传入；
 * API Key 只保存在服务端调用方的运行配置中。
 */
export function createArkModelAdapter(options: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}): ModelAdapterV2 {
  return createOpenAICompatibleModelAdapter({
    ...options,
    baseUrl: options.baseUrl ?? ARK_DEFAULT_BASE_URL,
  });
}
