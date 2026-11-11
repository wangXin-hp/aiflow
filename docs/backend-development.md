# AIFlow 后端本地开发与运行闭环

后端使用 NestJS 11、Prisma 7、PostgreSQL 17 和 Qdrant。Docker Compose 只启动数据库与向量服务；React/Vite 和 NestJS 在宿主机运行。当前只支持单个 API 实例。

## 初始化

准备 Node.js 24、Corepack、Docker Desktop。在仓库根目录执行：

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
pnpm infra:up
pnpm db:generate
pnpm db:deploy
pnpm dev
```

Windows PowerShell 可用 `Copy-Item .env.example .env` 代替 `cp`。复制后先设置至少 32 字符的随机 `JWT_SECRET`。根目录 `.env` 不提交；真实豆包密钥、SMTP 凭据只在本机或部署环境注入。`pnpm db:migrate -- --name <name>` 用于开发新迁移；已有环境和 CI 使用 `pnpm db:deploy`。`pnpm infra:down` 停止容器但保留 PostgreSQL/Qdrant 具名卷，不会删除已有数据。

默认 API 为 `http://127.0.0.1:3000`，Web 为 `http://127.0.0.1:5173`。`WEB_PUBLIC_URL` 同时用于邮件链接与可信 Origin 校验。带会话 Cookie 的写请求须发送该 Origin；跨源浏览器请求还需携带 credentials。`AUTH_EMAIL_MODE=console` 仅供开发，验证链接写到本地 API 日志；生产环境必须使用 SMTP。运行 `llm`/知识节点时配置 `ARK_API_KEY`、`ARK_MODEL_ID`、需要向量化时的 `ARK_EMBEDDING_MODEL_ID`、`QDRANT_URL`。HTTP 节点需用 `RUN_HTTP_ALLOWED_HOSTS` 明确可信主机名，默认不开放外部主机。

## 从认证到运行

以下 `sh` 命令适用于 POSIX shell（如 Bash）；`<...>` 均为需替换的示例值。Windows PowerShell 5.1 请使用本节后面的文件传参示例，不能仅把 `curl` 改成 `curl.exe`，否则内嵌 JSON 双引号可能被原生命令参数传递去掉。注册后从本地 API 日志取得一次性验证链接，访问 `/api/auth/verify?token=<token>`，再登录并保存 HttpOnly Cookie：

```sh
curl -X POST http://127.0.0.1:3000/api/auth/register -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' -d '{"email":"you@example.com","password":"replace-with-a-long-password"}'
curl 'http://127.0.0.1:3000/api/auth/verify?token=<token>'
curl -c cookies.txt -X POST http://127.0.0.1:3000/api/auth/login -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' -d '{"email":"you@example.com","password":"replace-with-a-long-password"}'
```

最小工作流使用 start、end 和一条连接；把创建响应的 `data.id` 记为 `<workflow-id>`，运行响应的 `data.id` 记为 `<run-id>`：

```sh
curl -b cookies.txt -X POST http://127.0.0.1:3000/api/workflows -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' -d '{"name":"first run","definition":{"schemaVersion":2,"nodes":[{"id":"start","type":"start","position":{"x":0,"y":0}},{"id":"end","type":"end","position":{"x":200,"y":0},"config":{"values":{}}}],"edges":[{"id":"start-end","source":"start","sourcePort":"output","target":"end","targetPort":"input"}]}}'
curl -b cookies.txt -X POST 'http://127.0.0.1:3000/api/workflows/<workflow-id>/runs' -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' -d '{"input":{}}'
curl -b cookies.txt 'http://127.0.0.1:3000/api/runs/<run-id>'
curl -N -b cookies.txt 'http://127.0.0.1:3000/api/runs/<run-id>/events'
```

Windows PowerShell 5.1 在仓库根目录使用 UTF-8 无 BOM 文件发送 JSON；`--data-binary '@文件名'` 让 curl 从文件读取请求体，保留 JSON 双引号。替换邮箱、密码和两个响应中的 ID 后依次执行：

```powershell
$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText('auth.json', '{"email":"you@example.com","password":"replace-with-a-long-password"}', $utf8)
[System.IO.File]::WriteAllText('workflow.json', '{"name":"first run","definition":{"schemaVersion":2,"nodes":[{"id":"start","type":"start","position":{"x":0,"y":0}},{"id":"end","type":"end","position":{"x":200,"y":0},"config":{"values":{}}}],"edges":[{"id":"start-end","source":"start","sourcePort":"output","target":"end","targetPort":"input"}]}}', $utf8)
[System.IO.File]::WriteAllText('run.json', '{"input":{}}', $utf8)
curl.exe -X POST http://127.0.0.1:3000/api/auth/register -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' --data-binary '@auth.json'
curl.exe 'http://127.0.0.1:3000/api/auth/verify?token=<token>'
curl.exe -c cookies.txt -X POST http://127.0.0.1:3000/api/auth/login -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' --data-binary '@auth.json'
curl.exe -b cookies.txt -X POST http://127.0.0.1:3000/api/workflows -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' --data-binary '@workflow.json'
curl.exe -b cookies.txt -X POST 'http://127.0.0.1:3000/api/workflows/<workflow-id>/runs' -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:5173' --data-binary '@run.json'
curl.exe -b cookies.txt 'http://127.0.0.1:3000/api/runs/<run-id>'
curl.exe -N -b cookies.txt 'http://127.0.0.1:3000/api/runs/<run-id>/events'
```

这三个 JSON 文件含有登录凭据或请求数据，运行完后从本地目录删除。

SSE 的 `id` 为 PostgreSQL 自增 BigInt 的十进制字符串。断线后以最后收到的 ID 请求补发；服务端只发送该 ID 之后的持久化事件，心跳注释不改变游标。已消费终态的连接会结束。

```sh
curl -N -b cookies.txt -H 'Last-Event-ID: <last-event-id>' 'http://127.0.0.1:3000/api/runs/<run-id>/events'
curl -b cookies.txt -X POST -H 'Origin: http://127.0.0.1:5173' 'http://127.0.0.1:3000/api/runs/<run-id>/cancel'
```

取消是协作式的：数据库状态会走向 `CANCELLING`/`CANCELLED`，已发出的模型或 HTTP 外部副作用无法撤回。编辑草稿后，已创建运行仍使用启动时保存的 `definitionSnapshot`。日志事件只含状态、耗时和错误代码；完整业务输入输出只在受保护的运行详情中。

## 验证与部署边界

测试使用独立的 `aiflow_test` PostgreSQL 库。创建一次并应用全部迁移，执行 `pnpm exec turbo test --force`；测试辅助程序要求库名以 `_test` 结尾，并在写入前核对 `current_database()`。其他门禁为 `pnpm format:check`、`pnpm lint`、`pnpm lint:style`、`pnpm spellcheck`、`pnpm exec turbo typecheck --force` 和 `pnpm exec turbo build --force`。

当前部署前仍需自行配置 HTTPS、反向代理、强随机 JWT 密钥、SMTP 与受控网络出口。`RUN_HTTP_ALLOWED_HOSTS` 仅是主机名白名单，不能替代网络层限制。API 只支持一个实例：启动恢复会将遗留 `QUEUED`、`RUNNING`、`CANCELLING` 标记为 `INTERRUPTED`，不会恢复执行；多实例需要租约与跨实例事件通知。真实豆包和 Qdrant 冒烟测试可能产生云端费用，本地自动测试使用确定性流程，不调用外部付费模型。
