# Workflow Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 已登录用户可以创建、编辑、保存和调试 V2 工作流，并在 AIFlow 编辑器里查看节点结果。

**Architecture:** React 视图通过独立的 API 客户端访问既有 NestJS 契约；纯图编辑命令把画布操作映射成 V2 协议，服务端负责最终图校验。`@xyflow/react` 只管理画布交互，保存状态、revision 和运行状态由页面控制器管理。

**Tech Stack:** React 19、TypeScript 5.9、Vite 7、`@xyflow/react` 12.12.1、Vitest、Testing Library、`@aiflow/contracts`。

**Spec:** `docs/superpowers/specs/2026-11-11-workflow-studio-design.md`

## Global Constraints

- 参考项目只作通用视觉与交互基准；独立实现源码、图标和 AIFlow 文案。
- 工作流、运行 API 响应必须通过共享 Zod 契约解析；Cookie 请求使用 `credentials: include`。
- 新草稿是有效 `start → end` 图，所有保存携带 revision，409 不自动覆盖。
- 测试运行先保存当前修改；失败时不启动旧版本。
- 新增或修改的公共接口、核心流程和非显然设计决策添加简洁中文说明注释。
- 每个任务从失败测试开始，运行相关测试与格式、类型门禁后提交；最后运行完整仓库门禁。

## Review Focus

- 分页继续加载时同一工作流不得重复或漏掉：Task 2 测试游标追加和去重。
- 异步保存过程中用户继续编辑时，不得错误显示“已保存”：Task 5 测试版本化脏状态。
- 删除节点时不能留下悬空边或引用：Task 3 测试删除命令和保存前错误提示。
- 运行创建前保存遇到 409 时不得运行旧快照：Task 6 测试短路行为。
- SSE 重连/终态事件重复时不得重复追踪且必须最终取详情：Task 6 测试 ID 去重和详情刷新。

---

### Task 1: 工作流与运行 API 客户端

**Files:**

- Create: `apps/web/src/workflow/workflow-api.ts`
- Test: `apps/web/src/workflow/workflow-api.test.ts`
- Modify: `apps/web/src/auth/auth-api.ts`（只导出或抽取共同错误类型，避免复制错误语义）

**Interfaces:**

- `workflowApi.list(cursor?: string): Promise<WorkflowListResponse>`、`create(input: CreateWorkflowRequest): Promise<WorkflowResponse>`、`get(id: string): Promise<WorkflowResponse>`、`update(id: string, input: UpdateWorkflowRequest): Promise<WorkflowResponse>`、`archive(id: string): Promise<void>`。
- `runApi.create(workflowId: string, input: CreateRunRequest): Promise<RunResponse>`、`get(id: string): Promise<RunDetailResponse>`、`cancel(id: string): Promise<{status: RunStatus}>`。
- 失败抛出 `ApiClientError`，保留后端 code/status；204 不解析 JSON。

- [ ] 写失败测试：成功响应通过共享 schema；畸形响应、401、409、网络失败、204 归档各有稳定结果。
- [ ] 运行 `pnpm --filter @aiflow/web test -- workflow-api.test.ts`，确认因缺少客户端而失败。
- [ ] 实现客户端，给公共 API 与不可信响应边界添加中文注释。
- [ ] 运行单测、`pnpm --filter @aiflow/web typecheck` 和 `pnpm format:check`。
- [ ] 提交 `feat(web): add workflow and run api clients`。

### Task 2: 工作流工作台

**Files:**

- Modify: `apps/web/src/App.tsx`、`apps/web/src/pages/app-home-page.tsx`、`apps/web/src/style.css`
- Test: `apps/web/src/pages/app-home-page.test.tsx`

**Interfaces:**

- 使用 Task 1 `workflowApi`；新草稿固定 `schemaVersion: 2`、`start`/`end`、`output → input`，创建成功导航 `/workflows/:id`。
- 列表以服务端顺序显示，`nextCursor` 为 null 时隐藏继续加载；归档需确认。

- [ ] 写失败测试：列表加载/空态、创建并导航、继续加载去重、归档确认/失败反馈。
- [ ] 运行目标测试，确认缺少行为而失败。
- [ ] 实现工作台与路由入口，保留现有认证退出功能和移动端可读性。
- [ ] 运行 Web 测试、类型和格式检查。
- [ ] 提交 `feat(web): add workflow workspace`。

### Task 3: 图编辑命令与协议映射

**Files:**

- Create: `apps/web/src/workflow/graph.ts`、`apps/web/src/workflow/graph.test.ts`

**Interfaces:**

- `createStarterDefinition(): WorkflowV2`。
- `addNode(definition: WorkflowV2, type: WorkflowNodeV2['type'], position: {x:number;y:number}): WorkflowV2`、`moveNode(definition, nodeId, position): WorkflowV2`、`removeNode(definition, nodeId): WorkflowV2`、`connectNodes(definition, {source, sourcePort, target}): WorkflowV2`、`disconnectEdge(definition, edgeId): WorkflowV2`；所有命令返回新图而不修改输入。
- `findDanglingReferences(definition: WorkflowV2): Array<{nodeId:string; sourceNodeId:string}>`，供保存前定位被删除节点留下的绑定。
- `toFlowElements(definition: WorkflowV2)` 和 `fromFlowPosition(...)` 只映射视图数据；端口规则为 `condition: true/false`、`intent: config.intents[].id`、普通节点 `output`，`end` 无输出。

- [ ] 写失败测试：模板可由服务端图校验通过；添加/移动/删除不改变原图；删除清理边；不重复 start/end；错误端口拒绝；节点 ID/边 ID 唯一。
- [ ] 运行目标测试，确认缺少命令而失败。
- [ ] 实现纯命令；引用失效时产生可定位诊断而非静默删除用户配置。
- [ ] 运行目标测试、Web 类型和格式检查。
- [ ] 提交 `feat(web): add v2 graph edit commands`。

### Task 4: 画布与节点视觉

**Files:**

- Create: `apps/web/src/workflow/workflow-canvas.tsx`、`apps/web/src/workflow/node-card.tsx`、`apps/web/src/workflow/studio.css`
- Test: `apps/web/src/workflow/workflow-canvas.test.tsx`
- Modify: `apps/web/package.json`、`pnpm-lock.yaml`

**Interfaces:**

- `<WorkflowCanvas definition onChange onSelect selectedNodeId nodeStatuses />`；节点库支持协议中的可添加类型；画布使用 Task 3 命令。
- `@xyflow/react` 仅做显示/交互；V2 定义保留为外部单一状态源。

- [ ] 写失败测试：节点库添加、移动/连线回调、节点选择、删除、运行状态标识与不可重复的 start/end。
- [ ] 运行目标测试，确认组件缺失而失败。
- [ ] 安装锁定 `@xyflow/react@12.12.1`，实现全屏点阵画布、节点卡、端口、缩放控件和小地图；独立 CSS，不复制参考素材。
- [ ] 运行 Web 测试、类型、格式、构建。
- [ ] 提交 `feat(web): build workflow canvas`。

### Task 5: 编辑器配置与保存

**Files:**

- Create: `apps/web/src/pages/workflow-editor-page.tsx`、`apps/web/src/workflow/node-inspector.tsx`、`apps/web/src/workflow/use-workflow-draft.ts`
- Test: `apps/web/src/pages/workflow-editor-page.test.tsx`、`apps/web/src/workflow/use-workflow-draft.test.tsx`
- Modify: `apps/web/src/App.tsx`、`apps/web/src/workflow/studio.css`

**Interfaces:**

- `/workflows/:id` 受保护；加载 workflow 后使用 Task 4 画布。
- 配置面板按节点类型编辑常用字段及字面量/引用绑定；高级配置需显式标记且按 V2 schema 校验。
- `useWorkflowDraft` 保存 revision、当前本地改动序号和最后提交序号；`save(): Promise<boolean>` 只在该次提交覆盖当前序号时显示已保存。409 保留本地改动并提示重新载入。

- [ ] 写失败测试：刷新回读、名称和节点配置保存、无效图反馈、409 保留改动、保存中再次编辑仍为未保存、离开提醒。
- [ ] 运行目标测试，确认行为缺失而失败。
- [ ] 实现页面、配置表单与草稿状态机；完整图校验以服务端结果为准。
- [ ] 运行 Web 测试、类型、格式、构建。
- [ ] 提交 `feat(web): edit and save workflow drafts`。

### Task 6: 调试运行与事件追踪

**Files:**

- Create: `apps/web/src/workflow/run-panel.tsx`、`apps/web/src/workflow/use-run-stream.ts`
- Test: `apps/web/src/workflow/run-panel.test.tsx`、`apps/web/src/workflow/use-run-stream.test.tsx`
- Modify: `apps/web/src/pages/workflow-editor-page.tsx`、`apps/web/src/workflow/studio.css`

**Interfaces:**

- 运行输入由 start.config.inputs 生成；未保存修改先等待 Task 5 `save()` 成功。
- `useRunStream(runId)` 使用带 Cookie 的原生 EventSource；自动重连沿用 Last-Event-ID，事件以持久化 ID 去重；终态后关闭并调用 `runApi.get`。
- URL `?run=<uuid>` 刷新后可读取该单次运行详情；取消调用 `runApi.cancel`。

- [ ] 写失败测试：动态输入、保存冲突时不创建运行、事件去重/重连状态、终态详情刷新、取消、URL 恢复。
- [ ] 运行目标测试，确认缺少运行面板而失败。
- [ ] 实现输入/结果/追踪面板，区分安全事件与受保护节点输出。
- [ ] 运行 Web 测试、类型、格式、构建。
- [ ] 提交 `feat(web): add workflow debug run panel`。

### Task 7: 视觉与端到端验收

**Files:**

- Modify: `apps/web/src/workflow/studio.css`、`docs/backend-development.md`（增加前端闭环入口与限制）
- Test: `apps/web/src/pages/workflow-editor-page.test.tsx`（关键流程）

- [ ] 在 1440×900 检查工作台/编辑器的区域、节点卡、端口、面板和状态；按参考源码审计调整布局。
- [ ] 用本地 API 与测试 PG 完成登录→创建→编辑→保存→调试→刷新回读的浏览器冒烟；参考画面缺失时将视觉对齐标为待截图验证。
- [ ] 运行 `pnpm exec turbo test --force`、`pnpm format:check`、`pnpm lint`、`pnpm lint:style`、`pnpm spellcheck`、`pnpm exec turbo typecheck --force`、`pnpm exec turbo build --force`。
- [ ] 更新文档并提交 `docs(web): document workflow studio validation`。
