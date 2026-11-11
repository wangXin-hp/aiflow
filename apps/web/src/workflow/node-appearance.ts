import type { WorkflowNodeV2 } from "@aiflow/contracts";

/** 节点库、画布卡片和无障碍名称使用一致的类型标签。 */
export const nodeAppearance = {
  start: { label: "开始", icon: "▶" },
  end: { label: "结束", icon: "■" },
  transform: { label: "数据转换", icon: "↔" },
  condition: { label: "条件分支", icon: "◇" },
  llm: { label: "大语言模型", icon: "✦" },
  http: { label: "HTTP 请求", icon: "⇄" },
  knowledge: { label: "知识检索", icon: "▤" },
  intent: { label: "意图识别", icon: "◎" },
} satisfies Record<WorkflowNodeV2["type"], { label: string; icon: string }>;
