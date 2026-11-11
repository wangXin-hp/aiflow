import { encodeWorkflowCursor, type WorkflowResponse } from "@aiflow/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  RouterProvider,
  useLocation,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth/auth-context";

const timestamp = "2026-11-08T00:00:00.000Z";
const draft: WorkflowResponse = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  name: "工作流甲",
  description: "",
  createdAt: timestamp,
  updatedAt: timestamp,
  revision: 1,
  definition: {
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
  },
};
const second = {
  ...draft,
  id: "123e4567-e89b-42d3-a456-426614174001",
  name: "工作流乙",
};
const cursor = encodeWorkflowCursor({ id: draft.id, createdAt: timestamp });
const user = {
  id: "user-1",
  email: "alice@example.com",
  name: "Alice",
  avatarUrl: null,
  emailVerifiedAt: timestamp,
  createdAt: timestamp,
};

const success = (data: unknown) => Response.json({ success: true, data });
const page = (
  items: WorkflowResponse[] = [],
  nextCursor: string | null = null,
) => success({ items, nextCursor });
const failure = (status = 503) =>
  Response.json({ code: "UNAVAILABLE", message: "服务暂不可用" }, { status });
const fetchMock =
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
function Location() {
  return <output aria-label="当前位置">{useLocation().pathname}</output>;
}
function mount(path = "/apps") {
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <AuthProvider>
            <App />
            <Location />
          </AuthProvider>
        ),
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
}
function mockRequests(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  fetchMock.mockImplementation(async (url, init) =>
    url === "/api/auth/me" ? success({ user }) : handler(url, init),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("workflow workspace", () => {
  it("shows list loading and then the empty state", async () => {
    let resolve!: (response: Response) => void;
    mockRequests(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mount();
    expect(await screen.findByText("正在加载工作流…")).toBeVisible();
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    await act(async () => resolve(page()));
    expect(await screen.findByText("还没有工作流")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "继续加载" }),
    ).not.toBeInTheDocument();
  });

  it("retries the first page after a recoverable failure", async () => {
    const ui = userEvent.setup();
    mockRequests(() => failure());
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂不可用");
    mockRequests(() => page([draft]));
    await ui.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("link", { name: draft.name })).toBeVisible();
  });

  it("creates a connected V2 draft and navigates to its protected route", async () => {
    const ui = userEvent.setup();
    mockRequests((url, init) =>
      (url === "/api/workflows" && init?.method === "POST") ||
      url === `/api/workflows/${draft.id}`
        ? success(draft)
        : page(),
    );
    mount();
    await ui.click(await screen.findByRole("button", { name: "新建工作流" }));
    expect(
      await screen.findByRole("link", { name: "返回工作流列表" }),
    ).toBeVisible();
    expect(screen.getByLabelText("当前位置")).toHaveTextContent(
      `/workflows/${draft.id}`,
    );
    const create = fetchMock.mock.calls.find(
      ([url, init]) => url === "/api/workflows" && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      definition: draft.definition,
    });
  });

  it("appends unseen IDs in server order using the opaque cursor", async () => {
    const ui = userEvent.setup();
    mockRequests((url) =>
      url === "/api/workflows"
        ? page([draft], cursor)
        : page([second, draft, second]),
    );
    mount();
    await ui.click(await screen.findByRole("button", { name: "继续加载" }));
    expect(
      await screen.findByRole("link", { name: second.name }),
    ).toBeVisible();
    expect(
      within(screen.getByRole("list", { name: "工作流" }))
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual([draft.name, second.name]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toContain(
      `/api/workflows?cursor=${cursor}`,
    );
    expect(
      screen.queryByRole("button", { name: "继续加载" }),
    ).not.toBeInTheDocument();
  });

  it("only archives after confirmation and retains the card on failure", async () => {
    const ui = userEvent.setup();
    let archived = false;
    mockRequests((url) =>
      url === "/api/workflows"
        ? page([draft])
        : archived
          ? new Response(null, { status: 204 })
          : failure(),
    );
    mount();
    const archive = await screen.findByRole("button", {
      name: `归档 ${draft.name}`,
    });
    await ui.click(archive);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    await ui.click(screen.getByRole("button", { name: "取消" }));
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
    await ui.click(screen.getByRole("button", { name: `归档 ${draft.name}` }));
    await ui.click(screen.getByRole("button", { name: "确认归档" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂不可用");
    expect(screen.getByRole("link", { name: draft.name })).toBeVisible();
    archived = true;
    await ui.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: draft.name }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("还没有工作流")).toBeVisible();
  });

  it("rechecks the existing session after a list 401", async () => {
    let expired = false;
    fetchMock.mockImplementation(async (url) => {
      if (url === "/api/auth/me" && !expired) return success({ user });
      expired = true;
      return failure(401);
    });
    mount();
    expect(await screen.findByRole("button", { name: "登录" })).toBeVisible();
  });
});
