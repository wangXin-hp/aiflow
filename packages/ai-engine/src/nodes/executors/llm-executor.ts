import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { ChatOpenAI } from '@langchain/openai'

import type { ExecutionContext, ExecutionLogger, LLMNodeConfig, NodeExecutionResult, OutputVariableSchema } from '../../types'
import { BaseNodeExecutor } from '../base-executor'

/**
 * LLM 节点执行器
 * 使用火山方舟（OpenAI 兼容接口）调用大语言模型
 */
export class LLMExecutor extends BaseNodeExecutor<LLMNodeConfig> {
    readonly type = 'llm' as const

    protected async doExecute(
        nodeId: string,
        config: LLMNodeConfig,
        context: ExecutionContext,
        logger: ExecutionLogger
    ): Promise<NodeExecutionResult> {
        // 解析配置中的变量
        const resolvedConfig = this.resolveConfigVariables(config, context, logger)

        // 构建消息
        const messages: Array<SystemMessage | HumanMessage | AIMessage> = []

        if (resolvedConfig.systemPrompt) {
            messages.push(new SystemMessage(resolvedConfig.systemPrompt))
        }

        if (resolvedConfig.userPrompt) {
            messages.push(new HumanMessage(resolvedConfig.userPrompt))
        }

        if (resolvedConfig.assistantPrompt) {
            messages.push(new AIMessage(resolvedConfig.assistantPrompt))
        }

        // 记录请求
        logger.llmRequest(nodeId, {
            model: resolvedConfig.model,
            messages: messages.map(m => ({
                role: m._getType(),
                content: m.content as string,
            })),
            temperature: resolvedConfig.temperature,
            maxTokens: resolvedConfig.maxTokens,
        })

        const startTime = Date.now()

        // 创建火山方舟实例（OpenAI 兼容接口）
        const llm = new ChatOpenAI({
            model: resolvedConfig.model,
            temperature: resolvedConfig.temperature ?? 0.7,
            maxTokens: resolvedConfig.maxTokens,
            apiKey: process.env.ARK_API_KEY,
            configuration: {
                baseURL: process.env.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
            },
        })

        // 调用 LLM
        const response = await llm.invoke(messages)

        const duration = Date.now() - startTime
        const content = response.content as string

        // 估算 token 数（简化实现）
        const tokens = this.estimateTokens(content)

        // 记录响应
        logger.llmResponse(nodeId, {
            content,
            tokens,
            duration,
        })

        return {
            success: true,
            outputs: {
                output: content,
                tokens,
            },
            duration,
        }
    }

    private estimateTokens(text: string): number {
        // 简单估算：中文约1.5字符/token，英文约4字符/token
        const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length
        const otherChars = text.length - chineseChars
        return Math.ceil(chineseChars / 1.5 + otherChars / 4)
    }

    override validate(config: LLMNodeConfig): { valid: boolean; errors?: string[] } {
        const errors: string[] = []

        if (!config.model) {
            errors.push('Model is required')
        }

        if (!config.userPrompt && !config.systemPrompt) {
            errors.push('At least one prompt (user or system) is required')
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        }
    }

    override getOutputSchema(): OutputVariableSchema[] {
        return [
            { name: 'output', type: 'string', description: 'LLM 生成的文本内容' },
            { name: 'tokens', type: 'number', description: '消耗的 token 数量' },
        ]
    }
}
