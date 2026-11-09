import { describe, expect, it } from "vitest";
import { decodeWorkflowCursor, type WorkflowV2 } from "@aiflow/contracts";
import type {
  CreateWorkflowRecord,
  ListWorkflowsInput,
  UpdateWorkflowRecord,
  WorkflowRecord,
  WorkflowRepository,
} from "./workflow.repository.js";
import { WorkflowService } from "./workflow.service.js";

const ownerA = "ff8ed9f1-07ad-4757-8031-48eb421e67f7";
const ownerB = "8dfd8439-aed3-4e95-b5f8-9720204f3dc3";
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
];

const validDefinition: WorkflowV2 = {
  schemaVersion: 2,
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 } },
    {
      id: "end",
      type: "end",
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
      targetPort: "input",
    },
  ],
};

const invalidGraph: WorkflowV2 = {
  schemaVersion: 2,
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 } },
    {
      id: "orphan",
      type: "end",
      position: { x: 240, y: 0 },
      config: { values: {} },
    },
  ],
  edges: [],
};

class MemoryWorkflowRepository implements WorkflowRepository {
  records = new Map<string, WorkflowRecord>();
  createCount = 0;
  updateCount = 0;
  lastListInput?: ListWorkflowsInput;
  private nextId = 0;

  async create(input: CreateWorkflowRecord): Promise<WorkflowRecord> {
    this.createCount += 1;
    const now = new Date("2026-11-08T08:30:00.000Z");
    const record: WorkflowRecord = {
      ...input,
      id: ids[this.nextId++]!,
      revision: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return structuredClone(record);
  }

  async listActive(input: ListWorkflowsInput): Promise<WorkflowRecord[]> {
    this.lastListInput = input;
    return [...this.records.values()]
      .filter(
        (record) => record.ownerId === input.ownerId && !record.archivedAt,
      )
      .filter((record) => {
        if (!input.cursor) return true;
        const created = record.createdAt.getTime();
        const cursorCreated = input.cursor.createdAt.getTime();
        return (
          created < cursorCreated ||
          (created === cursorCreated && record.id < input.cursor.id)
        );
      })
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .slice(0, input.take)
      .map((record) => structuredClone(record));
  }

  async findActiveById(ownerId: string, id: string) {
    const record = this.records.get(id);
    return record && record.ownerId === ownerId && !record.archivedAt
      ? structuredClone(record)
      : null;
  }

  async findOwnedById(ownerId: string, id: string) {
    const record = this.records.get(id);
    return record && record.ownerId === ownerId
      ? structuredClone(record)
      : null;
  }

  async updateActiveAtRevision(input: UpdateWorkflowRecord) {
    this.updateCount += 1;
    const record = this.records.get(input.id);
    if (
      !record ||
      record.ownerId !== input.ownerId ||
      record.archivedAt ||
      record.revision !== input.revision
    ) {
      return null;
    }
    const updated: WorkflowRecord = {
      ...record,
      ...input.changes,
      revision: record.revision + 1,
      updatedAt: new Date(record.updatedAt.getTime() + 1),
    };
    this.records.set(record.id, updated);
    return structuredClone(updated);
  }

  async archiveActive(ownerId: string, id: string, archivedAt: Date) {
    const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId || record.archivedAt)
      return false;
    this.records.set(id, { ...record, archivedAt, updatedAt: archivedAt });
    return true;
  }
}

function fixture() {
  const repository = new MemoryWorkflowRepository();
  return { repository, service: new WorkflowService(repository) };
}

async function create(
  service: WorkflowService,
  ownerId = ownerA,
  name = "客户问答",
) {
  return service.create(ownerId, { name, definition: validDefinition });
}

describe("WorkflowService", () => {
  it("创建前执行结构与图语义校验，并返回公开投影", async () => {
    const { service, repository } = fixture();
    const response = await create(service);

    expect(response).toMatchObject({
      id: ids[0],
      name: "客户问答",
      description: "",
      definition: validDefinition,
      revision: 1,
      createdAt: "2026-11-08T08:30:00.000Z",
    });
    expect(repository.createCount).toBe(1);
  });

  it("拒绝不可执行图并公开稳定详情，仓储保持零写入", async () => {
    const { service, repository } = fixture();

    await expect(
      service.create(ownerA, { name: "坏图", definition: invalidGraph }),
    ).rejects.toMatchObject({
      status: 400,
      code: "WORKFLOW_GRAPH_INVALID",
      details: expect.arrayContaining([
        expect.objectContaining({ code: "unreachable_node" }),
      ]),
    });
    expect(repository.records).toHaveLength(0);
    expect(repository.createCount).toBe(0);
  });

  it("按 createdAt 与 id 降序分页并生成最后一个可见项的游标", async () => {
    const { service, repository } = fixture();
    await create(service, ownerA, "A");
    await create(service, ownerA, "B");
    await create(service, ownerA, "C");
    await create(service, ownerB, "其他用户");

    const first = await service.list(ownerA, { limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeWorkflowCursor(first.nextCursor!)).toEqual({
      createdAt: "2026-11-08T08:30:00.000Z",
      id: ids[1],
    });
    expect(repository.lastListInput?.take).toBe(3);

    const second = await service.list(ownerA, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(second.nextCursor).toBeNull();
    expect(repository.lastListInput?.cursor).toEqual({
      createdAt: new Date("2026-11-08T08:30:00.000Z"),
      id: ids[1],
    });
  });

  it("在仓储查询前拒绝非规范游标", async () => {
    const { service, repository } = fixture();
    const canonical = Buffer.from(
      JSON.stringify({
        createdAt: "2026-11-08T08:30:00.000Z",
        id: ids[0],
      }),
    ).toString("base64url");

    await expect(
      service.list(ownerA, {
        limit: 20,
        cursor: `${canonical.slice(0, 4)}    ${canonical.slice(4)}`,
      }),
    ).rejects.toThrow();
    expect(repository.lastListInput).toBeUndefined();
  });

  it("详情仅返回当前 owner 的未归档工作流", async () => {
    const { service } = fixture();
    const workflow = await create(service, ownerB);

    await expect(service.get(ownerA, workflow.id)).rejects.toMatchObject({
      status: 404,
      code: "WORKFLOW_NOT_FOUND",
    });
    expect(await service.get(ownerB, workflow.id)).toMatchObject({
      id: workflow.id,
    });
  });

  it("以 revision 原子修改字段并只增长一次版本", async () => {
    const { service } = fixture();
    const workflow = await create(service);

    const updated = await service.update(ownerA, workflow.id, {
      revision: 1,
      name: "新名称",
      definition: validDefinition,
    });
    expect(updated).toMatchObject({ name: "新名称", revision: 2 });
  });

  it("将活动记录的旧 revision 映射为冲突且不部分修改字段", async () => {
    const { service } = fixture();
    const workflow = await create(service);
    await service.update(ownerA, workflow.id, {
      revision: 1,
      name: "当前名称",
    });

    await expect(
      service.update(ownerA, workflow.id, {
        revision: 1,
        name: "过期名称",
        description: "不应写入",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "WORKFLOW_REVISION_CONFLICT",
    });
    expect(await service.get(ownerA, workflow.id)).toMatchObject({
      name: "当前名称",
      description: "",
      revision: 2,
    });
  });

  it("在仓储写入前拒绝数据库不能表达的 revision", async () => {
    const { service, repository } = fixture();
    const workflow = await create(service);

    await expect(
      service.update(ownerA, workflow.id, {
        revision: 2_147_483_648,
        name: "禁止修改",
      }),
    ).rejects.toThrow();
    expect(repository.updateCount).toBe(0);
  });

  it("revision 达到数据库上限后返回稳定冲突且不再尝试增长", async () => {
    const { service, repository } = fixture();
    const workflow = await create(service);
    repository.records.set(workflow.id, {
      ...repository.records.get(workflow.id)!,
      revision: 2_147_483_647,
    });

    await expect(
      service.update(ownerA, workflow.id, {
        revision: 2_147_483_647,
        name: "无法再增长",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "WORKFLOW_REVISION_EXHAUSTED",
    });
    expect(repository.updateCount).toBe(0);
  });

  it.each([
    ["结构损坏", { schemaVersion: 2, nodes: "corrupt", edges: [] }],
    ["语义无效", invalidGraph],
  ])("元数据更新前拒绝%s的存量定义且保持零写入", async (_label, definition) => {
    const { service, repository } = fixture();
    const workflow = await create(service);
    repository.records.set(workflow.id, {
      ...repository.records.get(workflow.id)!,
      definition,
    });

    await expect(
      service.update(ownerA, workflow.id, {
        revision: 1,
        name: "不应写入",
      }),
    ).rejects.toMatchObject({
      status: 500,
      code: "WORKFLOW_DEFINITION_CORRUPT",
      message: "工作流定义已损坏",
    });
    expect(repository.updateCount).toBe(0);
    expect(repository.records.get(workflow.id)).toMatchObject({
      name: "客户问答",
      revision: 1,
    });
  });

  it("未知、跨 owner 与已归档的修改统一返回 404", async () => {
    const { service } = fixture();
    const workflow = await create(service, ownerB);
    await service.archive(ownerB, workflow.id);

    for (const [ownerId, id] of [
      [ownerA, workflow.id],
      [ownerB, workflow.id],
      [ownerA, ids[3]],
    ] as const) {
      await expect(
        service.update(ownerId, id, { revision: 1, name: "禁止修改" }),
      ).rejects.toMatchObject({ status: 404, code: "WORKFLOW_NOT_FOUND" });
    }
  });

  it("归档对 owner 已知记录幂等，并隐藏详情与列表", async () => {
    const { service } = fixture();
    const workflow = await create(service);

    await expect(service.archive(ownerA, workflow.id)).resolves.toBeUndefined();
    await expect(service.archive(ownerA, workflow.id)).resolves.toBeUndefined();
    await expect(service.get(ownerA, workflow.id)).rejects.toMatchObject({
      code: "WORKFLOW_NOT_FOUND",
    });
    expect((await service.list(ownerA, { limit: 20 })).items).toEqual([]);
    await expect(service.archive(ownerB, workflow.id)).rejects.toMatchObject({
      status: 404,
      code: "WORKFLOW_NOT_FOUND",
    });
  });
});
