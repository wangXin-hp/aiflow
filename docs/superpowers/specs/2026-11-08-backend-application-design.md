# AIFlow 后端应用层设计

状态：待审批  
日期：2026-11-08

## 背景与目标

AIFlow 已经具备独立的工作流协议、DAG 校验与执行器、豆包方舟适配器、HTTP 节点、知识检索适配器、运行事件和基础知识入库能力。本阶段在不改变引擎框架无关边界的前提下，建设第一个可持久化、可通过 HTTP 调用和可实时观察的后端纵向闭环。

本阶段交付以下能力：

- 提供注册、邮件验证、登录、当前用户、退出登录和受保护路由，形成与参考项目功能一致的认证闭环。
- 使用 PostgreSQL 保存工作流草稿、不可变版本预留结构、运行、节点运行和事件日志。
- 提供工作流创建、列表、详情、修改和归档 API。
- 从工作流草稿创建固定快照并异步启动一次调试运行。
- 将运行和节点状态持续写入数据库，并通过 SSE 推送可补发的持久化事件。
- 使用 Docker Compose 在本地管理 PostgreSQL 与 Qdrant，应用仍运行在宿主机以方便调试。
- 为后续知识库管理保留清晰的数据边界，但不在本阶段实现完整文档上传页面和发布 API。

首期支持多个注册用户，并以用户 ID 隔离工作流、运行和知识库资源；不实现组织、团队、角色权限、独立任务队列、高可用、断点续跑或多实例执行协调。目标是形成可验证的单机产品闭环，而不是提前模拟大型分布式平台。

## 技术栈

- Node.js 24、TypeScript 5.9、pnpm workspace、Turborepo。
- NestJS 11 负责 HTTP API、模块装配、生命周期和 SSE。
- PostgreSQL 17 负责关系数据、工作流 JSON 快照和持久化运行事件。
- Prisma 7 稳定版负责类型安全的数据访问、迁移和生成客户端；使用 `@prisma/adapter-pg` 与 `pg` 连接 PostgreSQL，不采用处于候选阶段的 Prisma 8。
- Qdrant 负责知识分块的向量与检索负载，PostgreSQL 只保存知识库和文档元数据。
- Zod 继续作为工作流定义与 API 边界的运行时校验工具。
- JWT 使用 7 天有效期的 HttpOnly Cookie 传递，bcrypt 负责密码哈希，Nodemailer 通过可配置 SMTP 发送验证邮件。
- React 19、Vite、React Router、React Hook Form、Tailwind CSS 4 和 Sonner 实现登录、注册、邮箱验证和受保护页面入口。
- Vitest 负责单元测试和 API/数据库集成测试。
- Docker Compose 只承载 PostgreSQL 与 Qdrant；NestJS 开发进程运行在宿主机。

所有镜像和 npm 依赖使用明确版本，锁文件进入仓库。真实凭据只通过未提交的 `.env` 注入，仓库只提供 `.env.example`。

## 方案选择

### 方案 1：API 进程内执行，PostgreSQL 作为状态真相源

HTTP 请求先在数据库中创建运行和初始事件，再由 NestJS 进程启动工作流引擎。引擎回调持续写入节点状态和事件，SSE 只读取已经持久化的事件。进程退出时不能恢复执行，重新启动后将遗留的 `QUEUED`、`RUNNING` 和 `CANCELLING` 运行标记为 `INTERRUPTED`。

优点是依赖少、调试直观，足以形成真实的单机闭环；限制是不能保证进程故障后的继续执行，也不支持多实例竞争。本阶段采用此方案。

### 方案 2：PostgreSQL 任务表与轮询 Worker

通过抢占、租约和心跳从数据库领取任务，能处理进程重启，但需要解决重复执行、过期租约和幂等副作用。它会把首期重点从应用闭环转移到任务系统，暂不采用。

### 方案 3：Redis、BullMQ 与独立 Worker

调度能力更成熟，但新增 Redis、Worker 部署和跨进程事件同步，超出当前仅使用 PostgreSQL 与 Qdrant 的本地基础设施范围。等单机运行量和可靠性需求有真实数据后再评估。

## 模块边界

`apps/api` 采用按业务能力拆分的模块化单体：

- `ConfigModule`：集中校验数据库、Qdrant、豆包和运行限制配置。
- `PrismaModule`：创建唯一的 Prisma 客户端，负责连接和关闭，不泄漏到工作流引擎包。
- `AuthModule`：注册、邮件验证、登录、JWT Cookie、当前用户、退出和认证守卫。
- `MailModule`：封装 SMTP 与验证邮件模板；测试时使用可注入替身，不在领域服务中直接调用 Nodemailer。
- `WorkflowModule`：工作流草稿 CRUD、图定义校验、乐观锁和归档。
- `RunModule`：创建固定快照、调度进程内执行、取消、恢复标记和运行详情查询。
- `RunEventModule`：在事务成功后通知订阅者，按数据库游标读取事件并生成 SSE。
- `KnowledgeModule`：本阶段只建立知识库、文档元数据和 Qdrant 配置边界，完整 CRUD 与索引流程后续实现。

`apps/web` 增加认证路由、认证状态查询和受保护布局。`packages/contracts` 增加认证、API 请求、响应、分页和 SSE 事件契约。`packages/workflow-engine` 不依赖 NestJS、Prisma、PostgreSQL 或 HTTP 控制器。

## 数据模型

所有业务主键使用 UUID。时间由 PostgreSQL/Prisma 生成并以 UTC 存储，API 返回 ISO 8601。枚举在数据库和 TypeScript 中使用大写状态，进入引擎边界时显式映射到引擎的小写状态，避免把持久化模型强耦合到引擎内部类型。

### User

- `id`、规范化后的唯一 `email`、`passwordHash`。
- 可选 `name`、`avatarUrl`。
- 可选 `emailVerifiedAt`。
- 可选 `verificationTokenHash`、`verificationTokenExpiresAt`；数据库不保存可直接使用的明文验证令牌。
- `createdAt`、`updatedAt`。

邮箱保存前去除首尾空格并转换为小写。密码最少 8 个字符，使用 bcrypt 12 轮哈希；任何响应都不返回密码哈希、令牌哈希或内部认证字段。

### Workflow

- `id`、`name`、`description`。
- `ownerId`：关联创建该工作流的用户，所有查询和修改必须同时限定当前用户。
- `definition`：通过 `WorkflowV2Schema` 校验后的 JSON 草稿。
- `revision`：从 1 开始的乐观锁版本，每次有效修改加 1。
- `archivedAt`：软删除时间；归档工作流默认不出现在列表，也不能创建新运行。
- `createdAt`、`updatedAt`。

名称限制 1 到 100 个字符，描述最多 2000 个字符。创建和修改时服务端始终重新校验工作流定义，不能相信前端校验结果。

### WorkflowVersion

- `id`、`workflowId`、递增的 `version`。
- `definitionSnapshot`、`createdAt`。
- `(workflowId, version)` 唯一。

本阶段创建表和关系，但不开放发布接口。后续发布只能插入，不能原地修改历史版本。

### WorkflowRun

- `id`、`workflowId`、可选 `workflowVersionId`。
- `ownerId`：冗余保存运行所属用户，用于直接、安全地过滤运行与 SSE 请求。
- `definitionSnapshot`：启动时保存的不可变图定义，后续草稿修改不影响运行。
- `input`、可选 `output`。
- `status`：`QUEUED`、`RUNNING`、`CANCELLING`、`SUCCEEDED`、`FAILED`、`CANCELLED`、`INTERRUPTED`。
- 可选 `errorCode`、`errorMessage`。
- `createdAt`、可选 `startedAt`、`finishedAt`。

调试运行直接关联草稿和快照；将来发布调用同时关联 `WorkflowVersion`。终态不可再次迁移。首期数据库记录状态，但不承诺从进程故障处恢复。

### NodeRun

- `id`、`runId`、`nodeId`、`nodeType`。
- `status`：`PENDING`、`RUNNING`、`SUCCEEDED`、`FAILED`、`SKIPPED`、`CANCELLED`。
- 可选的脱敏 `input`、`output`、`errorCode`、`errorMessage`。
- 可选 `startedAt`、`finishedAt`、`elapsedMs`。
- `(runId, nodeId)` 唯一，因为首期 DAG 不支持循环或节点重复执行。

节点行在运行创建时按快照批量初始化为 `PENDING`，这样运行详情能够稳定展示尚未执行的节点。

### RunEvent

- `id`：PostgreSQL 自增 `BigInt`，同时作为全局有序 SSE 游标；API 和 SSE 中序列化为十进制字符串。
- `runId`、可选 `nodeId`。
- `type`、`level`、`payload`、`createdAt`。
- 建立 `(runId, id)` 索引。

事件只追加不更新，是 SSE 重连补发和问题排查的依据。事件 payload 只包含状态、耗时、错误代码等可展示元数据；用户输入、模型提示词、Authorization、Cookie、API Key 和完整节点输出不进入日志事件。运行详情中的输入输出属于受保护业务数据，与日志分开保存。

### KnowledgeBase 与 KnowledgeDocument

PostgreSQL 保存知识库所属用户、知识库 ID、名称、描述、Qdrant collection、文档名称、内容摘要、索引状态、分块数量、错误与时间；Qdrant payload 使用用户 ID、知识库 ID、文档 ID、文档版本和分块 ID 建立过滤边界。文档内容和索引版本替换策略在知识库应用层阶段详细设计，本阶段不把向量数组写入 PostgreSQL。

## 认证功能与安全语义

参考项目采用邮箱密码、邮件验证和 JWT HttpOnly Cookie。本项目对齐这一用户功能，但使用 NestJS API 与 Vite SPA 独立实现，不复制参考项目受版权约束的源码、品牌文字或素材。

认证方式比较如下：

- 采用：短载荷 JWT 放入 7 天有效期的 HttpOnly Cookie。它与参考体验一致、无需新增会话存储，适合首期单机应用。
- 暂不采用：数据库 Session。它便于立即吊销所有会话，但会增加会话表和每请求查询；出现真实的多设备会话管理需求后再评估。
- 禁止采用：把 JWT 放在 localStorage。它会扩大 XSS 窃取令牌风险，也无法对齐参考项目的 HttpOnly Cookie 行为。

接口语义：

- `POST /api/auth/register`：接收可选姓名、邮箱和密码；创建未验证用户并发送验证邮件。
- `GET /api/auth/verify?token=...`：验证一次性令牌，将邮箱标记为已验证并立即清除令牌字段。
- `POST /api/auth/verification/resend`：为尚未验证的邮箱重新生成令牌并发送邮件，避免首次邮件失败后账号永久卡住；响应不泄露邮箱是否存在。
- `POST /api/auth/login`：校验邮箱和密码；不存在与密码错误统一返回“邮箱或密码错误”，未验证邮箱返回稳定的 `EMAIL_NOT_VERIFIED`。
- `GET /api/auth/me`：返回当前用户的安全公开字段。
- `POST /api/auth/logout`：清除 Cookie，并返回幂等成功。

Cookie 使用独立名称 `aiflow_session`，设置 `HttpOnly`、`SameSite=Lax`、`Path=/`，生产环境启用 `Secure`，有效期 7 天。JWT 只保存用户 ID、签发时间和过期时间，不保存邮箱、角色或敏感信息。`JWT_SECRET` 必须通过配置校验且不能使用仓库默认值。

认证守卫必须验证 JWT 签名、有效期和用户是否仍存在，不能只检查 Cookie 是否存在。除注册、登录、验证、重新发送验证邮件和健康检查外，所有 API 默认受保护。状态修改请求校验可信 Origin；结合 `SameSite=Lax` 降低 Cookie 认证下的 CSRF 风险。

验证令牌使用密码学安全随机值，数据库仅保存 SHA-256 哈希并设置 24 小时过期。重新发送时覆盖旧令牌。SMTP 主机、端口、TLS、账号、密码、发件人和前端公开地址全部来自环境变量，不使用硬编码凭据。开发环境可以显式选择 `AUTH_EMAIL_MODE=console`，只在本机日志中输出验证地址；生产环境必须使用 SMTP。

注册写库成功但邮件发送失败时保留未验证用户，并允许通过重新发送接口恢复。登录和重新发送接口设置基本的按 IP/邮箱限流；具体阈值作为配置项并在实施计划中固定。

## 登录与验证页面设计

本阶段不要求视觉上完全复刻参考项目，也不实现其粒子轨迹、旋转太极等装饰动画。登录页采用 AIFlow 自有品牌的简洁响应式布局，优先保证认证流程、表单状态、错误反馈和移动端可用性；完整视觉体系与工作台页面在后续前端应用层阶段统一设计。

页面使用 AIFlow 自有名称、图形和文案，不复制参考项目代码、品牌文字或素材。桌面端使用居中的认证卡片和适度的品牌背景，移动端保持无横向溢出的单列布局。

登录模式包含邮箱、密码、提交加载态、字段错误、未验证提示和“没有账号，注册”切换；注册模式额外显示可选姓名，密码至少 8 位，成功后提示查收邮件并切回登录。请求期间禁用重复提交。

`/account/verify` 提供验证中、成功和失败三种居中卡片状态，对应加载、成功和错误图标，并提供返回登录按钮。受保护路由未登录时跳转 `/account/login?redirect=<原相对路径>`；登录成功后只接受站内相对 redirect，拒绝 `//` 或外部 URL，防止开放重定向。

应用受保护布局显示当前用户姓名或邮箱、头像回退字符和退出入口。退出成功后清理前端认证缓存并跳转登录页。

## 后续工作流编辑器视觉约束

工作流编辑器不在本阶段的数据库与 API 交付范围内，但后续前端阶段必须把参考项目编辑器页面作为明确的视觉和交互基准。登录页“暂不完全对齐”的决定不能扩展到工作流编辑器。

编辑器需要对齐参考页面的整体区域划分、顶部工具栏、画布背景、节点卡片、端口与连线、缩放控制、右侧节点配置面板、测试运行面板、间距、圆角、阴影、颜色层级，以及选中、悬停、禁用、运行中、成功和失败等交互状态。验收时使用相同视口和同一份示例工作流进行并排截图检查，并验证核心操作流程，而不只比较静态首页。

对齐对象仅限通用产品布局、视觉层级和交互体验。页面标题、产品名称、Logo、品牌文案和可识别商标全部替换为 AIFlow 自有内容；代码、SVG、图标组合、插画和动画均独立实现，不复制参考仓库受限制源码或品牌素材。若视觉对齐与可访问性、响应式或本项目协议发生冲突，优先保证功能正确与可用性，并在对应前端设计文档中记录差异原因。

## 工作流 CRUD 语义

- 所有工作流接口先通过认证守卫，并只操作 `ownerId = currentUser.id` 的资源；对其他用户的资源统一返回 404，避免泄露资源是否存在。
- `POST /api/workflows` 创建已校验的草稿，返回 201。
- `GET /api/workflows` 提供默认排除归档记录的分页列表。
- `GET /api/workflows/:id` 返回草稿和当前 revision；不存在或已归档返回 404。
- `PATCH /api/workflows/:id` 必须携带客户端读取到的 revision。服务端在一个条件更新中完成修改和 revision 增长；revision 不匹配返回 409，避免静默覆盖。
- `DELETE /api/workflows/:id` 执行幂等软删除。已有运行、版本和事件继续可查。

请求体使用严格 schema，拒绝未知字段。数据库唯一约束、资源不存在、版本冲突和工作流图错误映射为稳定的 API 错误码，不把 Prisma 内部错误返回给客户端。

## 运行与持久化流程

`POST /api/workflows/:id/runs` 的行为如下：

1. 按当前用户查询未归档工作流，并再次解析定义和输入。
2. 在一个数据库事务中创建 `WorkflowRun(QUEUED)`、全部 `NodeRun(PENDING)` 和 `run.queued` 事件。
3. 返回 202 和运行 ID，不让 HTTP 请求等待整个模型调用。
4. 在提交成功后由进程内协调器启动执行；开始时把运行改为 `RUNNING` 并追加事件。
5. 引擎的 `onLog` 回调只进入应用服务，应用服务将状态映射为数据库状态，并在事务中更新对应记录、追加事件。
6. 引擎结束后写入运行输出或失败信息，再追加唯一终态事件。

同一运行的数据库写入由协调器串行化，防止异步日志回调造成状态倒退。终态更新使用条件写入，取消和自然结束竞争时只允许一个终态获胜。

运行输入在执行前按开始节点字段约束校验。应用层设置运行总超时、节点超时和输入/输出体积上限；超限数据返回稳定错误，不无限写入 JSON 字段。

## 取消与进程恢复

活跃运行在内存中保存 `AbortController`。取消接口先把非终态运行条件更新为 `CANCELLING`，再触发对应 signal。引擎确认后写入 `CANCELLED`；若运行已经进入终态，取消接口幂等返回当前状态。取消只能停止等待并通知支持 signal 的外部调用，不能撤销已经发生的 HTTP、模型或向量库副作用。

NestJS 启动时执行恢复检查：将本实例无法继续执行的 `QUEUED`、`RUNNING`、`CANCELLING` 记录改为 `INTERRUPTED`，补齐结束时间和恢复事件，并将非终态节点标记为 `CANCELLED`。本阶段明确只支持单 API 实例，否则一个实例可能错误中断另一个实例的运行。

## SSE 日志设计

`GET /api/runs/:id/events` 返回 `text/event-stream`，并在建立流之前验证运行归属当前用户。每条消息包含字符串 `id`、稳定的事件 `type`、时间、运行 ID、可选节点 ID和安全 payload。

客户端可以使用标准 `Last-Event-ID` 请求头重连。服务端先订阅当前进程的“该运行有新事件”通知，再从 PostgreSQL 查询 `id > cursor` 的事件；通知本身不携带业务结果，只触发再次查询数据库。这样通知与首次查询并发时最多产生一次空查询，不会丢事件。数据库记录才是 SSE 的真相源。

服务端定时发送无业务含义的 heartbeat，避免代理关闭空闲连接。读取到终态事件并发送完所有已提交事件后关闭流。无效游标返回 400；运行不存在返回 404。慢客户端按批次读取并设置单批上限，不一次加载无限历史。

## Docker 与配置

根目录提供 `compose.yaml`：

- PostgreSQL 仅绑定本机端口，配置健康检查和具名卷。
- Qdrant 暴露本机 HTTP/gRPC 端口，配置健康检查和具名卷。
- 服务使用固定镜像版本，不使用 `latest`。
- Compose 不保存豆包 API Key；应用从宿主机 `.env` 读取。

`.env.example` 只提供无敏感默认值和变量说明，包括 `DATABASE_URL`、`QDRANT_URL`、`ARK_API_KEY`、`ARK_MODEL_ID`、`JWT_SECRET`、SMTP、前端公开地址、API 端口和运行限制。开发命令明确区分启动基础设施、生成 Prisma 客户端、执行迁移和启动 NestJS。

## 错误、安全与可观测性

- 所有 HTTP 错误使用统一 `{ code, message, details? }` 结构，并由全局异常过滤器隐藏内部堆栈。
- 数据库日志不输出连接串，应用日志不输出工作流输入、模型提示词、密钥或完整节点输出。
- 可持久化错误信息经过长度限制和敏感字段清理；原始异常只在受控开发日志中保留。
- RunEvent 保存面向产品的结构化事件，NestJS 进程日志用于运维，两者不混用。
- CORS 仅允许配置的前端 Origin 并携带 Cookie；开发环境通过 Vite 代理保持同源，生产环境必须使用 HTTPS。
- 认证只能防止未授权访问，不能替代部署边界；服务默认监听受控地址，公网部署必须配置 HTTPS、强随机密钥和 SMTP 凭据。

## 测试与验收

- Prisma schema 能生成客户端，迁移可在空 PostgreSQL 上执行，并可重复启动容器保留数据。
- 认证测试覆盖邮箱规范化、重复注册、密码哈希、邮件验证、令牌过期和单次使用、未验证禁止登录、Cookie 属性、无效/过期 JWT、当前用户与退出。
- 资源归属测试使用两个真实测试用户，验证工作流、运行、事件和知识库不能跨用户读取或修改。
- 前端测试覆盖登录/注册切换、字段校验、验证页三种状态、受保护路由跳转、站内 redirect 和退出；桌面与移动端只验收基础响应式和功能可用性，不要求与参考页面逐像素一致。
- Repository/Service 单元测试覆盖创建、读取、分页、revision 冲突、归档和错误映射。
- 数据库集成测试覆盖运行快照不随草稿修改、事务回滚、状态终态保护和启动恢复。
- 执行集成测试使用确定性的模型/知识适配器替身，不调用真实豆包或 Qdrant。
- SSE 测试覆盖首次读取、按 `Last-Event-ID` 补发、连接期间新增事件、终态关闭、无效游标和敏感内容不进入 payload。
- Docker 基础设施通过健康检查；另保留明确标记为手动、会产生费用的豆包真实冒烟测试。
- 完成后执行格式、Lint、拼写、类型检查、全量测试和构建。

## 明确限制与后续演进

- 进程故障会中断运行，不进行断点恢复。
- 仅支持单 NestJS API 实例；扩展为多实例前需要任务所有权、租约或独立队列。
- 自动重试只在后续针对明确幂等的操作设计，不对任意 HTTP/LLM 节点默认重试。
- 本阶段不开放工作流发布、API Key 调用、知识文档上传、组织/角色权限和完整前端画布。
- 当真实指标证明需要更高可靠性时，再从持久化运行记录演进到 PostgreSQL Worker 或 BullMQ；不修改工作流引擎的核心协议。
