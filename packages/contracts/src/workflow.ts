import { z } from "zod";

// 所有引用同一标识符规则：去除首尾空白，并限制长度，避免空 ID 和无限长键。
const identifier = z.string().trim().min(1).max(128);
// 坐标属于画布布局信息；必须为有限数，才能安全序列化和渲染。
const positionSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});
// V1 仅声明已实现的节点类型；扩展类型时需同步设计执行语义与兼容策略。
const nodeSchema = z.strictObject({
  id: identifier,
  type: z.enum(["start", "end"]),
  position: positionSchema,
});
// 连线显式记录端点及端口，为后续多端口节点保留稳定的表达方式。
const edgeSchema = z.strictObject({
  id: identifier,
  source: identifier,
  sourcePort: z.literal("output"),
  target: identifier,
  targetPort: z.literal("input"),
});
/**
 * 工作流定义的 V1 运行时协议，也是前后端共享类型的唯一来源。
 * strictObject 会拒绝未知字段，避免不同版本的调用方静默丢失配置。
 * 节点和边的数量上限用于限制单次图校验的资源消耗。
 */
export const workflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nodes: z.array(nodeSchema).max(1000),
  edges: z.array(edgeSchema).max(5000),
});
/** 由运行时协议推导类型，保证静态类型与实际输入校验保持一致。 */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowNode = WorkflowDefinition["nodes"][number];
export type WorkflowEdge = WorkflowDefinition["edges"][number];
/** 节点运行数据只允许可表示为 JSON 的值，具体运行时校验由引擎负责。 */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
