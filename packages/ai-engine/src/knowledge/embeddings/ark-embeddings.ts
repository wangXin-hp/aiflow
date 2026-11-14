import { OpenAIEmbeddings } from '@langchain/openai'

import type { EmbeddingConfig, EmbeddingService } from '../types'

/**
 * 火山方舟嵌入服务
 * 通过 OpenAI 兼容接口（/api/v3）调用火山方舟的 embedding 模型
 */
export class ArkEmbeddingService implements EmbeddingService {
    private embeddings: OpenAIEmbeddings
    private config: EmbeddingConfig

    constructor(config?: Partial<EmbeddingConfig>) {
        this.config = {
            model: config?.model ?? process.env.ARK_EMBEDDING_MODEL ?? 'doubao-embedding-large-text-240915',
            baseUrl: config?.baseUrl ?? process.env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
            dimensions: config?.dimensions ?? 1024,
        }

        this.embeddings = new OpenAIEmbeddings({
            model: this.config.model,
            apiKey: process.env.ARK_API_KEY,
            configuration: {
                baseURL: this.config.baseUrl,
            },
        })
    }

    /**
     * 获取单个文本的嵌入向量
     */
    async embedText(text: string): Promise<number[]> {
        if (!text || text.trim().length === 0) {
            throw new Error('Text cannot be empty')
        }

        try {
            const vector = await this.embeddings.embedQuery(text.trim())
            return vector
        } catch (error) {
            throw new Error(`Failed to embed text: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    /**
     * 批量获取文本的嵌入向量
     */
    async embedTexts(texts: string[]): Promise<number[][]> {
        if (!texts || texts.length === 0) {
            return []
        }

        // 过滤空文本
        const validTexts = texts.map(t => t.trim()).filter(t => t.length > 0)

        if (validTexts.length === 0) {
            return []
        }

        try {
            const vectors = await this.embeddings.embedDocuments(validTexts)
            return vectors
        } catch (error) {
            throw new Error(`Failed to embed texts: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    /**
     * 获取向量维度
     */
    getDimensions(): number {
        return this.config.dimensions
    }

    /**
     * 获取模型名称
     */
    getModel(): string {
        return this.config.model
    }

    /**
     * 获取服务地址
     */
    getBaseUrl(): string {
        return this.config.baseUrl
    }
}

/**
 * 创建火山方舟嵌入服务实例
 */
export function createArkEmbeddingService(config?: Partial<EmbeddingConfig>): EmbeddingService {
    return new ArkEmbeddingService(config)
}
