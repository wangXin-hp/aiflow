import { describe, expect, it } from "vitest";
import { toWorkflowResponse } from "./workflow.mapper.js";

const validDefinition = {
  schemaVersion: 2 as const,
  nodes: [
    { id: "start", type: "start" as const, position: { x: 0, y: 0 } },
    {
      id: "end",
      type: "end" as const,
      position: { x: 240, y: 0 },
      config: {
        values: {
          result: {
            kind: "reference" as const,
            nodeId: "start",
            key: "message",
          },
        },
      },
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

function persistedWorkflow(definition: unknown = validDefinition) {
  return {
    id: "8e0e9401-0ca5-4072-a19b-02fd9d7f00ec",
    ownerId: "ff8ed9f1-07ad-4757-8031-48eb421e67f7",
    name: "客户问答",
    description: "处理常见问题",
    definition,
    revision: 3,
    archivedAt: null,
    createdAt: new Date("2026-11-08T08:30:00.000Z"),
    updatedAt: new Date("2026-11-08T09:45:00.000Z"),
    versions: [{ id: "internal-version" }],
    owner: { passwordHash: "must-not-leak" },
  };
}

describe("toWorkflowResponse", () => {
  it("重新校验持久化定义并把时间转换为 ISO 字符串", () => {
    expect(toWorkflowResponse(persistedWorkflow())).toEqual({
      id: "8e0e9401-0ca5-4072-a19b-02fd9d7f00ec",
      name: "客户问答",
      description: "处理常见问题",
      definition: validDefinition,
      revision: 3,
      createdAt: "2026-11-08T08:30:00.000Z",
      updatedAt: "2026-11-08T09:45:00.000Z",
    });
  });

  it("拒绝数据库中的损坏定义，而不是把未校验 JSON 返回给调用方", () => {
    expect(() =>
      toWorkflowResponse(
        persistedWorkflow({ schemaVersion: 2, nodes: "corrupt", edges: [] }),
      ),
    ).toThrow();
  });

  it("用共享响应契约拒绝损坏的公开元数据", () => {
    expect(() =>
      toWorkflowResponse({
        ...persistedWorkflow(),
        id: "corrupt-id",
        revision: 0,
      }),
    ).toThrow();
  });

  it("只映射公开字段，不泄露 owner、归档状态或关联记录", () => {
    const response = toWorkflowResponse(persistedWorkflow());

    expect(Object.keys(response).sort()).toEqual(
      [
        "createdAt",
        "definition",
        "description",
        "id",
        "name",
        "revision",
        "updatedAt",
      ].sort(),
    );
    expect(response).not.toHaveProperty("ownerId");
    expect(response).not.toHaveProperty("archivedAt");
    expect(response).not.toHaveProperty("versions");
    expect(response).not.toHaveProperty("owner");
  });
});
