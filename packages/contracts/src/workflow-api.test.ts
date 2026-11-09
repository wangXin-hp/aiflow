import { describe, expect, it } from "vitest";
import {
  CreateWorkflowRequestSchema,
  UpdateWorkflowRequestSchema,
  WorkflowListQuerySchema,
  WorkflowListResponseSchema,
  WorkflowResponseSchema,
  decodeWorkflowCursor,
  encodeWorkflowCursor,
} from "./workflow-api.js";

const definition = {
  schemaVersion: 2 as const,
  nodes: [
    { id: "start", type: "start" as const, position: { x: 0, y: 0 } },
    {
      id: "end",
      type: "end" as const,
      position: { x: 240, y: 0 },
      config: { values: {} },
    },
  ],
  edges: [
    {
      id: "start-end",
      source: "start",
      sourcePort: "output",
      target: "end",
      targetPort: "input" as const,
    },
  ],
};

const response = {
  id: "8e0e9401-0ca5-4072-a19b-02fd9d7f00ec",
  name: "客户问答",
  description: "处理常见问题",
  definition,
  revision: 3,
  createdAt: "2026-11-08T08:30:00.000Z",
  updatedAt: "2026-11-08T09:45:00.000Z",
};

describe("workflow API contracts", () => {
  it("规范化创建输入并拒绝名称、描述和未知字段越界", () => {
    expect(
      CreateWorkflowRequestSchema.parse({ name: "  客户问答  ", definition }),
    ).toEqual({ name: "客户问答", description: "", definition });

    for (const input of [
      { name: " ", definition },
      { name: "a".repeat(101), definition },
      { name: "ok", description: "a".repeat(2001), definition },
      { name: "ok", definition, internal: true },
    ]) {
      expect(CreateWorkflowRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it("要求更新携带正整数 revision 和至少一个严格校验的修改字段", () => {
    expect(
      UpdateWorkflowRequestSchema.parse({
        revision: 2,
        name: "  新名称 ",
        description: "",
      }),
    ).toEqual({ revision: 2, name: "新名称", description: "" });

    for (const input of [
      { revision: 0, name: "新名称" },
      { revision: 1.5, name: "新名称" },
      { revision: 1 },
      {
        revision: 1,
        definition: { schemaVersion: 2, nodes: [], edges: [], extra: true },
      },
      { revision: 1, name: "新名称", ownerId: "private" },
    ]) {
      expect(UpdateWorkflowRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it("允许真实修改旁带显式 undefined，但把仅 undefined 视为空补丁", () => {
    for (const input of [
      {
        revision: 1,
        name: "新名称",
        description: undefined,
        definition: undefined,
      },
      {
        revision: 1,
        name: undefined,
        description: "新描述",
        definition: undefined,
      },
      { revision: 1, name: undefined, description: undefined, definition },
    ]) {
      expect(UpdateWorkflowRequestSchema.safeParse(input).success).toBe(true);
    }
    expect(
      UpdateWorkflowRequestSchema.safeParse({
        revision: 1,
        name: undefined,
        description: undefined,
        definition: undefined,
      }).success,
    ).toBe(false);
  });

  it("只接受完整的 Workflow V2 定义", () => {
    expect(
      CreateWorkflowRequestSchema.safeParse({ name: "ok", definition }).success,
    ).toBe(true);
    expect(
      CreateWorkflowRequestSchema.safeParse({
        name: "ok",
        definition: { schemaVersion: 2, nodes: "invalid", edges: [] },
      }).success,
    ).toBe(false);
  });

  it("用不透明游标往返严格的 createdAt 与 UUID，并拒绝伪造输入", () => {
    const cursorValue = {
      createdAt: "2026-11-08T08:30:00.000Z",
      id: "8e0e9401-0ca5-4072-a19b-02fd9d7f00ec",
    };
    const cursor = encodeWorkflowCursor(cursorValue);

    expect(cursor).not.toContain(cursorValue.id);
    expect(decodeWorkflowCursor(cursor)).toEqual(cursorValue);
    expect(WorkflowListQuerySchema.parse({ cursor, limit: "25" })).toEqual({
      cursor,
      limit: 25,
    });

    for (const query of [
      { limit: 0 },
      { limit: 101 },
      { limit: "not-a-number" },
      { cursor: "not-base64-json" },
      {
        cursor: Buffer.from(
          JSON.stringify({ createdAt: "invalid", id: cursorValue.id }),
        ).toString("base64url"),
      },
      { cursor: `${cursor.slice(0, 4)}    ${cursor.slice(4)}` },
      {
        cursor: Buffer.from(
          `{"createdAt":"invalid","createdAt":"${cursorValue.createdAt}","id":"${cursorValue.id}"}`,
        ).toString("base64url"),
      },
    ]) {
      expect(WorkflowListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("把 revision 限制在 PostgreSQL signed Int 正数范围", () => {
    expect(
      UpdateWorkflowRequestSchema.safeParse({
        revision: 2_147_483_647,
        name: "仍可解析",
      }).success,
    ).toBe(true);
    expect(
      UpdateWorkflowRequestSchema.safeParse({
        revision: 2_147_483_648,
        name: "数据库不可表达",
      }).success,
    ).toBe(false);
    expect(
      WorkflowResponseSchema.safeParse({
        ...response,
        revision: 2_147_483_647,
      }).success,
    ).toBe(true);
    expect(
      WorkflowResponseSchema.safeParse({
        ...response,
        revision: 2_147_483_648,
      }).success,
    ).toBe(false);
  });

  it("公开响应保持稳定且不接受数据库内部字段", () => {
    expect(WorkflowResponseSchema.parse(response)).toEqual(response);
    expect(
      WorkflowResponseSchema.safeParse({ ...response, ownerId: "private" })
        .success,
    ).toBe(false);
    expect(
      WorkflowListResponseSchema.parse({ items: [response], nextCursor: null }),
    ).toEqual({ items: [response], nextCursor: null });
  });
});
