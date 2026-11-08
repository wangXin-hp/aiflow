const scopes = ["repo", "web", "api", "contracts", "docs", "deps", "ci"];
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", scopes],
    "header-max-length": [2, "always", 100],
  },
  prompt: {
    types: [
      { value: "feat", name: "feat: 新增功能" },
      { value: "fix", name: "fix: 修复缺陷" },
      { value: "docs", name: "docs: 文档变更" },
      { value: "refactor", name: "refactor: 代码重构" },
      { value: "test", name: "test: 测试变更" },
      { value: "build", name: "build: 构建或依赖变更" },
      { value: "ci", name: "ci: 持续集成变更" },
      { value: "chore", name: "chore: 其他维护变更" },
    ],
    scopes,
    allowCustomScopes: false,
    allowEmptyScopes: true,
    useEmoji: false,
    maxHeaderLength: 100,
  },
};
