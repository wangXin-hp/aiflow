import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createArkModelAdapter,
  createFetchHttpAdapter,
  createOpenAICompatibleEmbeddingAdapter,
  createQdrantKnowledgeAdapter,
  NodeRegistryV2,
  runWorkflowV2,
} from "@aiflow/workflow-engine";
import type { Environment } from "../config/environment.js";
import { PrismaService } from "../database/prisma.service.js";

/** 外部适配器按执行时配置创建；缺少云端凭据时节点显式失败，不回退本地模型。 */
@Injectable()
export class RunAdaptersFactory {
  readonly run = runWorkflowV2;
  constructor(
    @Inject(ConfigService)
    private readonly config: ConfigService<Environment, true>,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  registry(ownerId: string): NodeRegistryV2 {
    const apiKey = this.config.get("ARK_API_KEY", { infer: true });
    const embeddingModel = this.config.get("ARK_EMBEDDING_MODEL_ID", {
      infer: true,
    });
    const baseUrl = this.config.get("ARK_BASE_URL", { infer: true });
    const model = apiKey
      ? createArkModelAdapter({ apiKey, baseUrl })
      : undefined;
    const embed =
      apiKey && embeddingModel
        ? createOpenAICompatibleEmbeddingAdapter({
            apiKey,
            baseUrl,
            model: embeddingModel,
          })
        : undefined;
    const knowledge = {
      retrieve: async (
        request: Parameters<
          ReturnType<typeof createQdrantKnowledgeAdapter>["retrieve"]
        >[0],
      ) => {
        // 工作流定义中的知识库 ID 不是授权；每次检索都按运行 owner 复核。
        const bases = await this.prisma.knowledgeBase.findMany({
          where: { id: { in: request.knowledgeBaseIds }, ownerId },
          select: { id: true, qdrantCollection: true },
        });
        if (bases.length !== new Set(request.knowledgeBaseIds).size)
          throw new Error("Knowledge base is not available for this run");
        if (request.mode !== "fulltext" && !embed)
          throw new Error("Knowledge embedding is not configured");
        const results = await Promise.all(
          bases.map(async (base) =>
            createQdrantKnowledgeAdapter({
              baseUrl: this.config.get("QDRANT_URL", { infer: true }),
              collection: base.qdrantCollection,
              embed: (text, signal) => {
                if (!embed)
                  throw new Error("Knowledge embedding is not configured");
                return embed.embed(text, signal);
              },
              ...(this.config.get("QDRANT_API_KEY", { infer: true })
                ? {
                    apiKey: this.config.get("QDRANT_API_KEY", {
                      infer: true,
                    }),
                  }
                : {}),
            }).retrieve({ ...request, knowledgeBaseIds: [base.id] }),
          ),
        );
        return results
          .flat()
          .sort((a, b) => b.score - a.score)
          .slice(0, request.topK);
      },
    };
    return new NodeRegistryV2({
      ...(model ? { model } : {}),
      knowledge,
      http: createFetchHttpAdapter({
        // HTTP 节点仅访问部署者配置的目标域名，默认不开放任意内网 URL。
        allowUrl: (url) =>
          this.config
            .get("RUN_HTTP_ALLOWED_HOSTS", { infer: true })
            .split(",")
            .map((host) => host.trim().toLowerCase())
            .filter(Boolean)
            .includes(url.hostname.toLowerCase()),
      }),
    });
  }
}
