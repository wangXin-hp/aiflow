import type { WorkflowResponse } from "@aiflow/contracts";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/auth-context";
import { ProtectedRoute } from "../auth/protected-route";
import { createStarterDefinition } from "../workflow/graph";
import { WorkflowEditorPage } from "./workflow-editor-page";

const timestamp = "2026-11-08T00:00:00.000Z";
const draft: WorkflowResponse = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "示例工作流",
  description: "",
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 1,
  definition: createStarterDefinition(),
};

const fetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
let stored = draft;

function mount() {
  const router = createMemoryRouter(
    [
      {
        element: (
          <AuthProvider>
            <ProtectedRoute />
          </AuthProvider>
        ),
        children: [{ path: "/workflows/:id", element: <WorkflowEditorPage /> }],
      },
      { path: "/apps", element: <h1>工作流列表</h1> },
    ],
    { initialEntries: [`/workflows/${draft.id}`] },
  );
  return render(<RouterProvider router={router} />);
}

beforeEach(() => {
  stored = structuredClone(draft);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url, init) => {
    if (url === "/api/auth/me")
      return Response.json({
        success: true,
        data: {
          user: {
            id: "user-1",
            email: "editor@example.com",
            name: "Editor",
            avatarUrl: null,
            emailVerifiedAt: timestamp,
            createdAt: timestamp,
          },
        },
      });
    if (init?.method === "PATCH") {
      stored = {
        ...stored,
        ...JSON.parse(String(init.body)),
        revision: stored.revision + 1,
      };
    }
    return Response.json({ success: true, data: stored });
  });
  vi.stubGlobal("fetch", fetchMock);
});

it("保存名称与节点模型，重新进入时读取已保存的名称和节点配置", async () => {
  const first = mount();
  const name = await screen.findByRole("textbox", { name: "工作流名称" });
  fireEvent.change(name, { target: { value: "修改后的名称" } });
  fireEvent.click(screen.getByRole("button", { name: "大语言模型" }));
  fireEvent.change(screen.getByRole("textbox", { name: "模型" }), {
    target: { value: "test-model" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("已保存");
  expect(stored.definition.nodes).toContainEqual(
    expect.objectContaining({
      type: "llm",
      config: expect.objectContaining({ model: "test-model" }),
    }),
  );
  first.unmount();
  mount();
  expect(
    await screen.findByRole("textbox", { name: "工作流名称" }),
  ).toHaveValue("修改后的名称");
  fireEvent.click(screen.getByLabelText(/^大语言模型 llm-1$/));
  expect(screen.getByRole("textbox", { name: "模型" })).toHaveValue(
    "test-model",
  );
});

it("显示服务端图错误且保留画布上的节点", async () => {
  mount();
  await screen.findByRole("textbox", { name: "工作流名称" });
  fireEvent.click(screen.getByRole("button", { name: "数据转换" }));
  fetchMock.mockResolvedValueOnce(
    Response.json(
      {
        code: "WORKFLOW_GRAPH_INVALID",
        message: "工作流图无效",
        details: [{ code: "unreachable_node", message: "transform-1" }],
      },
      { status: 400 },
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /transform-1.*不在.*路径/ }),
  );
  expect(screen.getByLabelText(/^数据转换 transform-1$/)).toBeInTheDocument();
});

it("保存时阻止悬空引用并定位到消费节点", async () => {
  const end = stored.definition.nodes.find((node) => node.type === "end")!;
  end.config.values = {
    answer: { kind: "reference", nodeId: "missing", key: "answer" },
  };
  mount();
  const name = await screen.findByRole("textbox", { name: "工作流名称" });
  fireEvent.change(name, { target: { value: "本地名称" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  fireEvent.click(await screen.findByRole("button", { name: /end.*missing/ }));
  expect(screen.getByRole("region", { name: "节点配置" })).toHaveTextContent(
    "结束",
  );
  expect(
    fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
  ).toBe(false);
});

it("仅在有未保存编辑时提醒浏览器离开", async () => {
  mount();
  const name = await screen.findByRole("textbox", { name: "工作流名称" });
  const unload = () =>
    window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  expect(unload()).toBe(true);
  fireEvent.change(name, { target: { value: "本地名称" } });
  expect(unload()).toBe(false);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
  });
  expect(unload()).toBe(true);
});

it("切换到列表前可以取消离开并继续编辑", async () => {
  mount();
  const name = await screen.findByRole("textbox", { name: "工作流名称" });
  fireEvent.change(name, { target: { value: "保留的名称" } });
  fireEvent.click(screen.getByRole("link", { name: "返回工作流列表" }));
  expect(
    await screen.findByRole("dialog", { name: "未保存的修改" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  expect(name).toHaveValue("保留的名称");
  fireEvent.click(screen.getByRole("link", { name: "返回工作流列表" }));
  fireEvent.click(screen.getByRole("button", { name: "离开编辑器" }));
  expect(
    await screen.findByRole("heading", { name: "工作流列表" }),
  ).toBeInTheDocument();
});

it("非法高级配置在切换节点后保留，并阻止提交", async () => {
  mount();
  await screen.findByRole("textbox", { name: "工作流名称" });
  fireEvent.click(screen.getByRole("button", { name: "大语言模型" }));
  fireEvent.click(screen.getByText("高级配置（JSON）"));
  fireEvent.change(screen.getByRole("textbox", { name: "节点配置 JSON" }), {
    target: { value: '{"model": 42}' },
  });
  fireEvent.click(screen.getByLabelText("结束 end"));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "节点 llm-1 的高级配置无效" }),
  );
  expect(screen.getByRole("textbox", { name: "节点配置 JSON" })).toHaveValue(
    '{"model": 42}',
  );
  expect(
    fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
  ).toBe(false);
});

it("可将结束节点的输出绑定到开始节点的字段", async () => {
  mount();
  await screen.findByRole("textbox", { name: "工作流名称" });
  fireEvent.click(screen.getByLabelText("结束 end"));
  fireEvent.change(screen.getByRole("textbox", { name: "新绑定名称" }), {
    target: { value: "answer" },
  });
  fireEvent.click(screen.getByRole("button", { name: "添加绑定" }));
  fireEvent.change(screen.getByRole("combobox", { name: "绑定方式" }), {
    target: { value: "reference" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "输出字段" }), {
    target: { value: "query" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("已保存");
  expect(
    stored.definition.nodes.find((node) => node.type === "end")?.config.values,
  ).toEqual({
    answer: { kind: "reference", nodeId: "start", key: "query" },
  });
});
it("冲突时保留本地草稿，只在确认重新载入后替换", async () => {
  mount();
  const name = await screen.findByRole("textbox", { name: "工作流名称" });
  fireEvent.change(name, { target: { value: "尚未保存的名称" } });
  fetchMock.mockResolvedValueOnce(
    Response.json({ code: "CONFLICT", message: "版本冲突" }, { status: 409 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("保存冲突");
  expect(name).toHaveValue("尚未保存的名称");
  const reload = screen.getByRole("button", { name: "重新载入服务器版本" });
  vi.stubGlobal(
    "confirm",
    vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true),
  );
  fireEvent.click(reload);
  expect(name).toHaveValue("尚未保存的名称");
  stored = { ...stored, revision: 2, name: "其他会话的新名称" };
  fireEvent.click(reload);
  await screen.findByDisplayValue("其他会话的新名称");
  expect(screen.getByText("已保存")).toBeInTheDocument();
});

it("401 保存后在受保护路由上保留本地编辑，可恢复会话后重新保存", async () => {
  mount();
  const name = await screen.findByRole("textbox", { name: "工作流名称" });
  fireEvent.change(name, { target: { value: "会话恢复后保存" } });
  fetchMock.mockResolvedValueOnce(
    Response.json(
      { code: "UNAUTHORIZED", message: "会话已失效" },
      { status: 401 },
    ),
  );
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "保存" })),
  );
  expect(screen.getByRole("textbox", { name: "工作流名称" })).toHaveValue(
    "会话恢复后保存",
  );
  expect(
    screen.getByRole("link", { name: "在新标签页重新登录" }),
  ).toHaveAttribute("target", "_blank");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByText("已保存");
  expect(stored.name).toBe("会话恢复后保存");
});
