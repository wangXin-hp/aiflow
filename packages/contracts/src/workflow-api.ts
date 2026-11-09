import { z } from "zod";
import { workflowV2Schema } from "./workflow-v2.js";

const workflowNameSchema = z.string().trim().min(1).max(100);
const workflowDescriptionSchema = z.string().max(2000);
const workflowIdSchema = z.uuid();
const workflowTimestampSchema = z.iso.datetime();
/** Prisma `Int` 映射 PostgreSQL signed integer，revision 不得超出其可查询范围。 */
export const WORKFLOW_REVISION_MAX = 2_147_483_647;
const workflowRevisionSchema = z
  .number()
  .int()
  .min(1)
  .max(WORKFLOW_REVISION_MAX);

const workflowCursorValueSchema = z.strictObject({
  createdAt: workflowTimestampSchema,
  id: workflowIdSchema,
});
export type WorkflowCursorValue = z.infer<typeof workflowCursorValueSchema>;

function toBase64Url(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(`${base64}${padding}`);
}

/** 游标只封装稳定排序键；调用方不得从中注入其他数据库查询条件。 */
export function encodeWorkflowCursor(value: WorkflowCursorValue): string {
  return toBase64Url(JSON.stringify(workflowCursorValueSchema.parse(value)));
}

/** 在进入仓储前完整解析游标，失败时不返回部分排序键。 */
export function decodeWorkflowCursor(cursor: string): WorkflowCursorValue {
  try {
    const decoded = workflowCursorValueSchema.parse(
      JSON.parse(fromBase64Url(cursor)),
    );
    // 宽松 base64/JSON 解析会忽略空白或重复键；只接受唯一的规范编码。
    if (encodeWorkflowCursor(decoded) !== cursor)
      throw new Error("Non-canonical workflow cursor");
    return decoded;
  } catch {
    throw new Error("Invalid workflow cursor");
  }
}

const workflowCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    try {
      decodeWorkflowCursor(value);
      return true;
    } catch {
      return false;
    }
  }, "Invalid workflow cursor");

const queryLimitSchema = z.preprocess(
  (value) =>
    typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value,
  z.number().int().min(1).max(100),
);

/** 创建请求在共享边界完成规范化，服务收到的描述始终为非空类型的字符串。 */
export const CreateWorkflowRequestSchema = z.strictObject({
  name: workflowNameSchema,
  description: workflowDescriptionSchema.default(""),
  definition: workflowV2Schema,
});

/** revision 是并发前置条件，且空补丁不应无意义地推进 revision。 */
export const UpdateWorkflowRequestSchema = z
  .strictObject({
    revision: workflowRevisionSchema,
    name: workflowNameSchema.optional(),
    description: workflowDescriptionSchema.optional(),
    definition: workflowV2Schema.optional(),
  })
  .refine(
    ({ name, description, definition }) =>
      name !== undefined ||
      description !== undefined ||
      definition !== undefined,
    { message: "At least one workflow field is required" },
  );

/** 列表参数严格限制为不透明游标和小批量上限，避免任意查询字段泄漏到仓储。 */
export const WorkflowListQuerySchema = z.strictObject({
  cursor: workflowCursorSchema.optional(),
  limit: queryLimitSchema.default(20),
});

/** 工作流公开投影不包含 owner、archive 或数据库关系字段。 */
export const WorkflowResponseSchema = z.strictObject({
  id: workflowIdSchema,
  name: workflowNameSchema,
  description: workflowDescriptionSchema,
  definition: workflowV2Schema,
  revision: workflowRevisionSchema,
  createdAt: workflowTimestampSchema,
  updatedAt: workflowTimestampSchema,
});

export const WorkflowListResponseSchema = z.strictObject({
  items: z.array(WorkflowResponseSchema),
  nextCursor: workflowCursorSchema.nullable(),
});

export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;
export type UpdateWorkflowRequest = z.infer<typeof UpdateWorkflowRequestSchema>;
export type WorkflowListQuery = z.infer<typeof WorkflowListQuerySchema>;
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;
export type WorkflowListResponse = z.infer<typeof WorkflowListResponseSchema>;
