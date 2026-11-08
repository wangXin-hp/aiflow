# 工作流协议与引擎 V1

本阶段提供独立的 `@aiflow/contracts` 和 `@aiflow/workflow-engine`，尚未接入 API、数据库或画布。V1 仅支持一个开始节点和一个结束节点，执行时将输入 JSON 对象传递给结束节点。

## 定义示例

```json
{
  "schemaVersion": 1,
  "nodes": [
    { "id": "start", "type": "start", "position": { "x": 0, "y": 0 } },
    { "id": "end", "type": "end", "position": { "x": 200, "y": 0 } }
  ],
  "edges": [
    {
      "id": "edge-1",
      "source": "start",
      "sourcePort": "output",
      "target": "end",
      "targetPort": "input"
    }
  ]
}
```

`workflowDefinitionSchema` 用于解析不可信定义，并导出 `WorkflowDefinition` 等类型。协议对未知字段、版本、节点类型和端口采取严格拒绝策略；节点坐标必须是有限数字。节点最多 1000 个，边最多 5000 条。新增协议能力必须明确版本兼容和迁移策略。

```ts
import { executeWorkflow, validateWorkflow } from "@aiflow/workflow-engine";

const validation = validateWorkflow(definition);
if (validation.valid) {
  const result = executeWorkflow(definition, { text: "hello" });
  console.log(result.output);
}
```

`validateWorkflow` 返回 `{ valid, errors }`，结构错误使用 `invalid_definition`，图错误提供独立代码。`executeWorkflow` 首先再次验证定义，非法图抛出包含 `issues` 的 `WorkflowValidationError`；非 JSON 对象输入抛出 `TypeError`。运行结果包含各节点成功状态、输入、输出及最终输出；输入和结果通过拷贝隔离。它是同步的内存执行，不保存记录、不运行外部代码，也不承诺取消或恢复。

图校验要求节点、边 ID 唯一，连接端点存在且不重复，开始节点没有入边、结束节点没有出边，图无环且所有节点均位于从开始到结束的路径上。当前只有两种节点，条件分支、变量引用和其他节点会在后续协议及引擎设计中明确，不会被 V1 悄然接受。

## V2：多节点与条件分支

V1 接口保持兼容。V2 使用 `workflowV2Schema` 进行草稿结构校验，`validateWorkflowV2` 检查是否可执行，`runWorkflowV2` 异步运行。V2 节点类型包括 `start`、`transform`、`condition`、`intent`、`llm`、`http`、`knowledge` 和 `end`；开始节点返回输入对象，转换和结束节点通过 `config.values` 声明输出字段，条件节点通过 `config.value` 声明布尔条件。绑定支持 `{ "kind": "literal", "value": 1 }` 或 `{ "kind": "reference", "nodeId": "start", "key": "count" }`，引用保留原始 JSON 类型。

普通节点出端口为 `output`，条件节点出端口为 `true` 或 `false`，意图节点使用配置的意图 ID 作为出端口，目标端口为 `input`。条件和意图节点要求每个分支都连接。执行器按拓扑顺序串行运行；每条边标记为有效或跳过，全部入边跳过的节点继续传播跳过，汇合节点至少有一条有效入边时执行。

必填引用须指向严格上游，且该节点必须位于从开始节点到当前节点的所有路径上。这是保守校验：它也可能拒绝某些无条件扇出、但实际上两个分支都会执行的引用。引用可设置 JSON `fallback`，用于节点被跳过或字段缺失的情况；未设置默认值时返回 `missing_reference` 错误。还支持 `template`，按顺序组合文本和引用；对象值按 JSON 字符串插入。开始节点可选声明字段类型、必填和默认值，尚无完整的跨节点静态字段类型检查。

`NodeRegistryV2` 可按已有节点类型替换异步执行器，执行器收到独立的节点和输入副本。运行返回 UUID、时间、终态、节点结果和执行耗时；`captureInputs: true` 可显式捕获节点输入，默认关闭；但节点输出仍会被记录，开始节点的输出包含工作流输入，关闭该选项并不构成脱敏；事件回调只包含状态和标识，不包含节点输入输出。回调不阻塞运行，回调异常会被忽略；不可依赖它作为可靠持久化机制。

支持通过 `AbortSignal` 取消运行，取消时引擎立即停止等待当前节点，并将节点级信号传给执行器。`nodeTimeoutMs` 配置每个节点的最大等待时间（默认 30000 毫秒，取值为 1 至 2147483647 的整数）；超时产生 `node_timeout` 错误并跳过后续节点。执行器的第三个参数为 `{ signal }`，应传递给支持取消的外部 I/O。引擎无法强制停止忽略信号的执行器，也不会回滚已经产生的外部副作用；同步阻塞代码会阻塞事件循环，使计时器和取消信号无法及时执行。当前没有断点恢复。运行数据只在内存中，结果和错误可能包含业务数据或执行器错误信息，应用接入持久化或日志前应进行脱敏和权限控制。

## 外部节点与适配器

`NodeRegistryV2` 接受 `model`、`http`、`knowledge` 适配器；未注入时运行对应节点返回 `adapter_not_configured`。`llm` 的 `values` 可引用 `user`、`system` 和 `assistant` 字段，配置支持 `temperature`、`maxTokens`；输出为 `output` 和 `tokens`（服务未返回用量时为 null）。`intent` 接收 `text`，模型返回包含配置内 `intent` 的 JSON，未知意图或无效 JSON 将失败。

`http` 的 `values` 可提供 `url`、`headers`、`params`、`body`；配置方法和 `bodyType`。自带 fetch 适配器要求调用方提供 URL 允许策略，不跟随重定向；应用部署时仍需结合网络出口、DNS 和权限控制。`knowledge` 接收 `query`，配置知识库 ID、检索模式、数量和阈值，输出含来源的 `results`。

默认面向云端使用 OpenAI Chat Completions 兼容的模型适配器与 embeddings 兼容的向量化适配器；Ollama 保留为可选适配器。还提供 Qdrant 向量和有上限的全文扫描，以及基于 RRF 的混合检索。全文扫描适合小规模数据；扫描超过上限会报错，需要生产环境的全文索引或专门搜索服务。适配器测试使用替身；云端模型及向量库需要配置后单独联调。

接口参考：[Ollama Chat](https://docs.ollama.com/api/chat)、[Ollama Embed](https://docs.ollama.com/api/embed)、[Qdrant Query](https://api.qdrant.tech/api-reference/search/query-points)、[Qdrant Scroll](https://api.qdrant.tech/api-reference/points/scroll-points)。

## 豆包云端模型配置

本项目使用火山方舟的豆包 Chat API，通过 `createArkModelAdapter({ apiKey })` 创建适配器并注入 `new NodeRegistryV2({ model })`。默认基础地址为北京地域标准方舟 API：`https://ark.cn-beijing.volces.com/api/v3`；其他地域或账户方案应以方舟控制台和官方文档为准，通过 `baseUrl` 显式覆盖。

API Key 由服务端秘密配置注入；模型 ID 或推理接入点 ID 由节点的 `config.model` 指定。不要将真实密钥写入工作流、前端代码、示例文件或仓库。方舟标准 API 与 Agent Plan 的计费、Key 和地址可能不同，应按实际开通的方案选择，不能混用。

示例从当前进程的 `ARK_API_KEY` 和 `ARK_MODEL_ID` 读取配置，`ARK_BASE_URL` 可选。完成环境变量设置后，在项目根目录运行：

```powershell
pnpm build
pnpm --filter @aiflow/workflow-engine demo:cloud
```

该命令会向所配置的云服务发送真实请求，可能产生费用。示例将单节点超时设为 120 秒；引擎默认是 30 秒，实际值应按模型延迟调整。示例没有自动读取 `.env` 文件，也没有把适配器接入 API 服务或管理页面。`maxTokensField` 可按模型支持情况选择 `max_tokens` 或 `max_completion_tokens`，不能同时发送；具体模型是否支持 temperature 等参数，应以该模型的文档为准。

知识库的云端向量化需要单独确认所选模型的接口和模型 ID。通用 `createOpenAICompatibleEmbeddingAdapter` 仅适用于兼容的文本向量接口，不能假定兼容方舟所有多模态向量模型；Qdrant 仍需独立配置。当前豆包和向量库均未使用真实凭据联调。

参考：[火山方舟 OpenAI 兼容接入](https://docs.volcengine.com/docs/ark/ai-tools-other-tools?lang=zh)、[Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh)、[输出长度配置](https://docs.volcengine.com/docs/ark/context-management?lang=zh)。

## 运行日志

`runWorkflowV2` 返回的 `logs` 是有序结构化日志，记录运行 ID、时间、节点 ID/类型、开始和终态、耗时与错误码。传入 `onLog` 可接收实时日志；同步和异步回调失败都不会中断工作流，回调不保证可靠投递。日志不包含输入、输出、提示词或异常原文，但节点 ID 由调用方提供，不应将秘密写进 ID。运行结果的 `nodes[].output` 仍可能包含敏感内容，日志的安全约束不等同于运行结果脱敏。

## 知识文档的基础索引链路

`splitText` 按 Unicode 码点切分；`splitMarkdown` 识别标题层级及围栏代码块。分块保留原文 UTF-16 起止偏移，`text.slice(startOffset, endOffset)` 可恢复分块。单个文档上限为 200 万个 UTF-16 单元和 1000 个分块，超限抛错；这是内存型引擎的保护性限制。

`createQdrantVectorStore` 提供 `ensureCollection`、`upsert` 和按知识库 + 文档双条件限定的 `deleteDocument`。`indexKnowledgeDocument` 先切分，再使用应用注入的 `embed(text, signal)` 逐块向量化；所有向量合法且维度一致后才一次 upsert。调用方应先确保集合存在且维度与嵌入模型一致；本函数不自动创建集合。

下面是索引调用顺序示意；`embed` 必须由应用提供并返回与集合维度一致的向量：

```ts
import {
  createQdrantVectorStore,
  indexKnowledgeDocument,
} from "@aiflow/workflow-engine";

const store = createQdrantVectorStore({
  baseUrl: qdrantUrl,
  collection: "knowledge_chunks",
});
const signal = new AbortController().signal;
await store.ensureCollection(embeddingDimensions, signal);
await indexKnowledgeDocument({
  knowledgeBaseId: "kb-1",
  documentId: "doc-1",
  content,
  format: "markdown",
  chunkSize: 500,
  chunkOverlap: 50,
  embed,
  store,
  signal,
});
```

**更新语义：** 当前索引操作是稳定 ID 的新增/覆盖，不会自动删除同一文档以前多出的尾部分块；空文档也不会清空旧数据。它不是原子替换，也不适合直接用于文档更新。后续应用层应设计版本化切换或受控清理，不能简单先删除旧数据再向量化。Qdrant 的写入与检索分别遵循其 [Upsert](https://api.qdrant.tech/api-reference/points/upsert-points) 和 [Query](https://api.qdrant.tech/api-reference/search/query-points) 接口。

工作流知识节点支持 `outputFormat: "text" | "json"`：`output` 为格式化文本，`results` 保留结构化结果及可用的知识库、文档、分块来源信息。向量化接口须由实际服务提供；方舟多模态向量接口不能假设与通用文本 embeddings 接口相同。
