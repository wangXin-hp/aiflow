import type { WorkflowResponse } from "@aiflow/contracts";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { createStarterDefinition } from "./graph";
import { useWorkflowDraft } from "./use-workflow-draft";

const timestamp = "2026-11-08T00:00:00.000Z";
const original: WorkflowResponse = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "服务器草稿",
  description: "",
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 1,
  definition: createStarterDefinition(),
};
const fetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const response = (draft: WorkflowResponse) =>
  Response.json({ success: true, data: draft });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

it("冲突后保留本地名称，禁止重复提交同一旧版本", async () => {
  const { result } = renderHook(() => useWorkflowDraft(original));
  act(() => result.current.setName("本地编辑"));
  fetchMock.mockResolvedValueOnce(
    Response.json({ code: "CONFLICT", message: "版本冲突" }, { status: 409 }),
  );
  await act(async () => expect(await result.current.save()).toBe(false));
  expect(result.current.draft.name).toBe("本地编辑");
  expect(result.current.conflict).toBe(true);
  expect(result.current.dirty).toBe(true);
  await act(async () => expect(await result.current.save()).toBe(false));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("旧提交完成后保留更新的本地编辑，下一次保存使用新 revision", async () => {
  const { result } = renderHook(() => useWorkflowDraft(original));
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((complete) => {
    resolve = complete;
  });
  fetchMock.mockReturnValueOnce(pending);
  act(() => result.current.setName("第一次编辑"));
  let save!: Promise<boolean>;
  act(() => {
    save = result.current.save();
    result.current.setName("第二次编辑");
  });
  await act(async () => {
    resolve(response({ ...original, name: "第一次编辑", revision: 2 }));
    expect(await save).toBe(false);
  });
  expect(result.current.draft.name).toBe("第二次编辑");
  expect(result.current.dirty).toBe(true);
  fetchMock.mockResolvedValueOnce(
    response({ ...original, name: "第二次编辑", revision: 3 }),
  );
  await act(async () => expect(await result.current.save()).toBe(true));
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
    revision: 2,
    name: "第二次编辑",
  });
  expect(result.current.dirty).toBe(false);
});
