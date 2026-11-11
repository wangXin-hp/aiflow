# AIFlow

个人 AI 工作流平台。产品范围和路线见 [设计草案](docs/superpowers/specs/2026-11-08-aiflow-design.md)。目前提供 React 认证页面、NestJS 工作流 CRUD 与调试运行 API、PostgreSQL 运行和事件持久化、可重连 SSE，以及独立的工作流协议与引擎。可视化画布仍在后续开发阶段。

## 环境与运行

使用 Node.js 24.9 或更新的 24.x 版本以及 Corepack。项目固定 pnpm 10.34.9。

```sh
corepack enable
pnpm install --frozen-lockfile
```

首次运行时将 `.env.example` 复制为根目录的 `.env`，已有 `.env` 时保留原文件。把 `JWT_SECRET=replace-me` 替换为至少 32 字符的随机密钥；可用 `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` 生成。真实密钥仅写入本机 `.env`，不要提交到 Git。

安装并启动 Docker Desktop 后，在仓库根目录运行：

```sh
docker compose config --quiet
pnpm infra:up
pnpm db:generate
pnpm db:deploy
pnpm dev
```

`infra:up` 使用 `docker compose up -d --wait`，直到 PostgreSQL 与 Qdrant 健康后才返回。镜像固定为 `postgres:17.11-alpine3.24` 和 `qdrant/qdrant:v1.20.0`。两者使用具名卷持久化，仅向本机 `127.0.0.1` 开放 PostgreSQL 5432、Qdrant HTTP 6333 和 gRPC 6334。5432 被占用时可设置 `POSTGRES_PORT=5433`，并同步修改 `DATABASE_URL`、`TEST_DATABASE_URL` 的端口；不停止其他项目的数据库。`pnpm infra:logs` 跟踪日志；`pnpm infra:down` 停止服务并保留数据卷。示例数据库口令 `aiflow` 只供本地开发；修改 `POSTGRES_*` 时同步修改 `DATABASE_URL`，已初始化卷的口令不会随环境变量自动改变。

访问 Vite 启动时显示的地址（默认 http://localhost:5173），API 默认监听 127.0.0.1:3000，开发代理将 `/api` 转发给 API。健康检查为 `GET /api/health`。如果本机 Corepack 缓存失效，可使用 `npx --yes pnpm@10.34.9 install --frozen-lockfile` 及 `npx --yes pnpm@10.34.9 dev`。

API 无论从仓库根目录还是 `apps/api` 启动，都会读取根目录 `.env`，进程环境变量优先。配置在监听端口前统一校验；缺失 JWT 密钥、无效 URL/端口、非正整数执行限制或生产环境使用 console 邮件模式都会阻止启动。

| 配置                                                           | 默认值与约束                                            |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| `NODE_ENV`                                                     | `development`，可选 `development`、`test`、`production` |
| `API_HOST` / `API_PORT`                                        | `127.0.0.1` / `3000`；端口为 1–65535                    |
| `DATABASE_URL`                                                 | `postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow`      |
| `QDRANT_URL` / `QDRANT_API_KEY`                                | `http://127.0.0.1:6333` / 可选密钥                      |
| `WEB_PUBLIC_URL`                                               | `http://127.0.0.1:5173`，邮件回调所用的公开前端地址     |
| `JWT_SECRET` / `JWT_EXPIRES_IN_SECONDS`                        | 密钥必填且至少 32 字符 / `604800` 秒（7 天）            |
| `AUTH_LOGIN_RATE_LIMIT` / `AUTH_LOGIN_RATE_WINDOW_MS`          | `5` 次 / `60000` 毫秒，均为正整数                       |
| `AUTH_RESEND_RATE_LIMIT` / `AUTH_RESEND_RATE_WINDOW_MS`        | `3` 次 / `900000` 毫秒，均为正整数                      |
| `AUTH_EMAIL_MODE`                                              | `console`；生产环境必须显式设置 `smtp`                  |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM`      | smtp 模式必填，console 模式可缺省                       |
| `SMTP_PORT` / `SMTP_SECURE`                                    | `465` / `true`；布尔值仅接受 `true` 或 `false`          |
| `ARK_API_KEY` / `ARK_MODEL_ID` / `ARK_EMBEDDING_MODEL_ID`      | 云端模型及向量化模型按需配置；离线示例无需密钥          |
| `ARK_BASE_URL`                                                 | 默认 `https://ark.cn-beijing.volces.com/api/v3`         |
| `RUN_NODE_TIMEOUT_MS` / `RUN_TOTAL_TIMEOUT_MS`                 | `30000` / `300000` 毫秒，均为正整数                     |
| `RUN_MAX_NODES` / `RUN_MAX_CONCURRENT` / `RUN_EVENT_MAX_BYTES` | `100` / `4` / `65536`，均为正整数                       |
| `RUN_HTTP_ALLOWED_HOSTS`                                       | 默认空；HTTP 节点需显式列出可信主机名                   |

`pnpm db:generate`、`pnpm db:migrate`、`pnpm db:deploy` 分别生成 Prisma 客户端、创建开发迁移和应用已有迁移。真实 PostgreSQL E2E 使用独立测试库：先在本地创建 `aiflow_test`（如 `docker compose exec postgres createdb -U aiflow aiflow_test`，已有库无需重复创建），再用指向该库的 `DATABASE_URL` 执行 `pnpm db:deploy`。测试默认连接 `postgresql://aiflow:aiflow@127.0.0.1:5432/aiflow_test`，可用 `TEST_DATABASE_URL` 覆盖；测试辅助程序要求库名以 `_test` 结尾并核对实际连接库名。每例使用随机邮箱和按所有者限定的清理，不发送外部邮件。CI 自动创建并迁移测试库。

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

当前提供本地单实例开发闭环，生产部署、反向代理、HTTPS 与真实 SMTP/豆包联调仍需另行配置和验收。

## 认证 API

前端入口为 `/account/login`（可切换注册）、`/account/verify?token=...`（邮件验证）和 `/apps`（个人主页）。首次访问会检查当前会话，未登录时返回登录页并保留原站内地址；服务暂不可用时提供重试。注册后需查收邮件完成验证再登录。登录后显示公开用户资料，可退出并清空前端会话缓存；会话令牌不会进入 JavaScript 或浏览器存储。

匿名接口为 `POST /api/auth/register`、`GET /api/auth/verify?token=...`、`POST /api/auth/verification/resend`、`POST /api/auth/login` 和幂等的 `POST /api/auth/logout`；`GET /api/auth/me` 要求已验证会话。请求字段由共享契约约束：注册接受 `email`、`password`、可选 `name`，登录接受 `email`、`password`，重发仅接受 `email`。认证成功返回 `{ success: true, data, message? }`，错误返回 `{ code, message, details? }`，健康检查保持原有 `{ status, service }`。

登录仅通过 `aiflow_session` Cookie 返回会话，响应 JSON 不含 token。Cookie 使用 HttpOnly、SameSite=Lax、Path=/、7 天有效期，生产环境启用 Secure；退出无需有效会话也会清除相同作用域的 Cookie。浏览器请求需携带 credentials，CORS 仅允许 `WEB_PUBLIC_URL` 的同源地址。非 GET/HEAD/OPTIONS 请求只要显式携带 Origin 就必须与该地址精确匹配；携带会话 Cookie 时还必须提供可信 Origin。无 Cookie、无 Origin 的匿名接口仍可由 CLI 等非浏览器客户端调用。登录和重发同时按来源 IP、规范化邮箱分别限流，超限统一返回 429。两种计数均只保存在当前进程，重启会清空，多实例部署需要共享存储。

## 工作流 API

已登录用户可通过 `POST/GET /api/workflows` 与 `GET/PATCH/DELETE /api/workflows/:id` 创建、分页查看、修改和软归档自己的草稿。修改必须提交当前 `revision`，过期版本返回 409；其他用户的 ID 与未知 ID 均返回 404。`DELETE` 对自己的已归档工作流返回幂等 204。请求体须为 JSON，单次 HTTP 请求体上限为 2 MiB；超限返回固定的 `413 PAYLOAD_TOO_LARGE`，避免大图在解析阶段变成内部错误。

`POST /api/workflows/:id/runs` 从当前草稿创建固定快照并返回 202；`GET /api/runs/:id` 查询状态，`POST /api/runs/:id/cancel` 协作取消，`GET /api/runs/:id/events` 以持久化事件 ID 发送 SSE。重连时传 `Last-Event-ID`，服务端按 PostgreSQL 游标补发，心跳不推进游标。运行与节点状态、取消竞争、超时和进程重启后的中断标记均由单实例 NestJS 进程管理。完整的本地命令、请求示例与边界见 [后端开发手册](docs/backend-development.md)。

## 代码质量与提交

`pnpm install` 会通过 Husky 安装 Git hooks。提交前，`lint-staged` 只检查暂存文件：JavaScript/TypeScript 使用 ESLint 和 Prettier，CSS 使用 Stylelint 和 Prettier，文档及配置使用 Prettier。提交信息由 Commitlint 按 Conventional Commits 校验；可使用 `pnpm commit` 通过 cz-git 交互生成。允许的 scope 为 `repo`、`web`、`api`、`contracts`、`docs`、`deps` 和 `ci`，也可以省略 scope。

```sh
pnpm format          # 格式化项目
pnpm format:check    # 检查格式
pnpm lint            # ESLint
pnpm lint:style      # CSS 检查
pnpm spellcheck      # 拼写检查
pnpm typecheck
pnpm test
pnpm build
```

提交前钩子不会运行全量测试或构建，这些检查由 CI 执行。请在提交前按改动范围自行运行相关测试；拼写词典位于 `.cspell/project-words.txt`。

工作流协议和引擎的使用方法见 [工作流协议 V1](docs/workflow-protocol.md)。
