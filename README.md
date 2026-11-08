# AIFlow

个人 AI 工作流平台，当前处于工程初始化阶段。产品范围和路线见 [设计草案](docs/superpowers/specs/2026-11-08-aiflow-design.md)。目前提供前端占位页面、API 健康检查，以及独立的工作流协议与支持转换、条件分支的内存执行引擎；工作流 API、画布、模型、数据库和身份认证尚未实现。

## 环境与运行

使用 Node.js 24.9 或更新的 24.x 版本以及 Corepack。项目固定 pnpm 10.34.9。

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

访问 Vite 启动时显示的地址（默认 http://localhost:5173），API 默认监听 127.0.0.1:3000，开发代理将 `/api` 转发给 API。健康检查为 `GET /api/health`。如果本机 Corepack 缓存失效，可使用 `npx --yes pnpm@10.34.9 install --frozen-lockfile` 及 `npx --yes pnpm@10.34.9 dev`。

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

生产部署、反向代理和安全配置尚未提供，当前服务仅用于本地开发。

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
