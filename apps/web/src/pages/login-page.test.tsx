import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AuthProvider } from "../auth/auth-context";

const user = {
  id: "user-1",
  email: "alice@example.com",
  name: "Alice",
  avatarUrl: null,
  emailVerifiedAt: "2026-11-08T00:00:00.000Z",
  createdAt: "2026-11-08T00:00:00.000Z",
};
const success = (data: unknown) => Response.json({ success: true, data });
const unauthorized = () =>
  Response.json({ code: "UNAUTHORIZED", message: "未登录" }, { status: 401 });
let handlers: Record<
  string,
  (init: RequestInit) => Response | Promise<Response>
>;

function Location() {
  const location = useLocation();
  return (
    <div aria-label="当前位置">
      {location.pathname + location.search + location.hash}
    </div>
  );
}
function mount(path = "/account/login", strict = false) {
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
        <Location />
      </AuthProvider>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}
beforeEach(() => {
  handlers = { "/api/auth/me": unauthorized };
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    if (init.credentials !== "include")
      throw new Error("Session credentials missing");
    const handler = handlers[url];
    if (!handler) throw new Error(`Unexpected request ${url}`);
    return handler(init);
  });
});

describe("authentication routes", () => {
  it.each([
    Response.json(
      { code: "INVALID_SESSION", message: "会话失效" },
      { status: 401 },
    ),
    new Response("Unauthorized", { status: 401 }),
  ])("treats any HTTP 401 session response as anonymous", async (response) => {
    handlers["/api/auth/me"] = () => response;
    mount("/apps");
    expect(await screen.findByRole("button", { name: "登录" })).toBeVisible();
  });
  it("keeps an accessible loading state until the session resolves", async () => {
    let resolve!: (value: Response) => void;
    handlers["/api/auth/me"] = () =>
      new Promise((done) => {
        resolve = done;
      });
    mount("/apps");
    expect(screen.getByRole("status")).toHaveTextContent(/加载|检查/);
    expect(
      screen.queryByRole("button", { name: "登录" }),
    ).not.toBeInTheDocument();
    await act(async () => resolve(unauthorized()));
    expect(await screen.findByRole("button", { name: "登录" })).toBeVisible();
  });
  it("preserves path, search and hash when a protected route requires login", async () => {
    mount("/apps?sort=new#recent");
    expect(await screen.findByRole("button", { name: "登录" })).toBeVisible();
    expect(screen.getByLabelText("当前位置")).toHaveTextContent(
      "/account/login?redirect=%2Fapps%3Fsort%3Dnew%23recent",
    );
  });
  it("renders verified user data and clears the session after logout", async () => {
    const ui = userEvent.setup();
    handlers["/api/auth/me"] = () => success({ user });
    handlers["/api/auth/logout"] = (init) =>
      init.method === "POST"
        ? success({ message: "已退出登录" })
        : unauthorized();
    mount("/apps");
    expect(await screen.findByText("alice@example.com")).toBeVisible();
    expect(screen.getByText("Alice")).toBeVisible();
    await ui.click(screen.getByRole("button", { name: "退出登录" }));
    expect(await screen.findByRole("button", { name: "登录" })).toBeVisible();
    expect(screen.queryByText("alice@example.com")).not.toBeInTheDocument();
  });
  it("offers recovery for session errors instead of pretending the user is anonymous", async () => {
    const ui = userEvent.setup();
    handlers["/api/auth/me"] = () =>
      Response.json(
        { code: "UNAVAILABLE", message: "服务暂不可用" },
        { status: 503 },
      );
    mount("/apps");
    expect(await screen.findByRole("alert")).toHaveTextContent("服务暂不可用");
    handlers["/api/auth/me"] = () => success({ user });
    await ui.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("alice@example.com")).toBeVisible();
  });
});

describe("login and registration", () => {
  it("validates fields without sending invalid input", async () => {
    const ui = userEvent.setup();
    mount();
    await ui.click(await screen.findByRole("button", { name: "登录" }));
    expect(await screen.findByText("请输入有效邮箱")).toBeVisible();
    expect(screen.getByText("请输入密码")).toBeVisible();
  });
  it("clears sensitive passwords and validation errors when changing mode", async () => {
    const ui = userEvent.setup();
    mount();
    await ui.type(await screen.findByLabelText("密码"), "private-password");
    await ui.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("请输入有效邮箱")).toBeVisible();
    await ui.click(screen.getByRole("button", { name: "创建账号" }));
    expect(screen.getByLabelText("密码")).toHaveValue("");
    expect(screen.queryByText("请输入有效邮箱")).not.toBeInTheDocument();
    await ui.type(screen.getByLabelText("密码"), "short");
    await ui.click(screen.getByRole("button", { name: "注册" }));
    expect(await screen.findByText("密码至少需要 8 个字符")).toBeVisible();
  });
  it("registers normalized input and returns to login with an email notice", async () => {
    const ui = userEvent.setup();
    handlers["/api/auth/register"] = (init) => {
      const input: unknown = JSON.parse(String(init.body));
      return init.method === "POST" &&
        JSON.stringify(input) ===
          JSON.stringify({
            email: "alice@example.com",
            password: "password-123",
            name: "Alice",
          })
        ? success({ userId: "user-1" })
        : unauthorized();
    };
    mount();
    await ui.click(await screen.findByRole("button", { name: "创建账号" }));
    await ui.type(screen.getByLabelText("姓名（可选）"), " Alice ");
    await ui.type(screen.getByLabelText("邮箱"), "ALICE@example.com");
    await ui.type(screen.getByLabelText("密码"), "password-123");
    await ui.click(screen.getByRole("button", { name: "注册" }));
    expect(await screen.findByRole("status")).toHaveTextContent("查收邮件");
    expect(screen.getByRole("button", { name: "登录" })).toBeVisible();
    expect(screen.getByLabelText("密码")).toHaveValue("");
  });
  it("logs in with a cookie-backed user and follows a safe redirect", async () => {
    const ui = userEvent.setup();
    handlers["/api/auth/login"] = (init) =>
      init.method === "POST" ? success({ user }) : unauthorized();
    mount("/account/login?redirect=%2Fapps%3Fsort%3Dnew%23recent");
    await ui.type(await screen.findByLabelText("邮箱"), "alice@example.com");
    await ui.type(screen.getByLabelText("密码"), "password-123");
    await ui.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByText("alice@example.com")).toBeVisible();
    expect(screen.getByLabelText("当前位置")).toHaveTextContent(
      "/apps?sort=new#recent",
    );
  });
  it.each([
    ["EMAIL_NOT_VERIFIED", "邮箱尚未验证，请先查收验证邮件"],
    ["INVALID_CREDENTIALS", "邮箱或密码错误"],
  ])("shows API error %s", async (code, message) => {
    const ui = userEvent.setup();
    handlers["/api/auth/login"] = () =>
      Response.json(
        {
          code,
          message: code === "EMAIL_NOT_VERIFIED" ? "not verified" : message,
        },
        { status: 401 },
      );
    mount();
    await ui.type(await screen.findByLabelText("邮箱"), "alice@example.com");
    await ui.type(screen.getByLabelText("密码"), "password-123");
    await ui.click(screen.getByRole("button", { name: "登录" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });
});

describe("email verification", () => {
  it("does not consume the one-use verification token twice in StrictMode", async () => {
    let consumed = false;
    handlers["/api/auth/verify?token=once"] = () => {
      if (consumed)
        return Response.json(
          { code: "INVALID_VERIFY_TOKEN", message: "验证链接已失效" },
          { status: 400 },
        );
      consumed = true;
      return success({ message: "邮箱验证成功" });
    };
    mount("/account/verify?token=once", true);
    expect(await screen.findByText("邮箱验证成功，请登录")).toBeVisible();
  });
  it("explains a missing token and provides a return link", async () => {
    mount("/account/verify");
    expect(await screen.findByRole("alert")).toHaveTextContent("缺少验证链接");
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute(
      "href",
      "/account/login",
    );
  });
  it("shows loading followed by successful verification", async () => {
    let resolve!: (value: Response) => void;
    handlers["/api/auth/verify?token=opaque%2Btoken"] = () =>
      new Promise((done) => {
        resolve = done;
      });
    mount("/account/verify?token=opaque%2Btoken");
    expect(await screen.findByText("正在验证邮箱…")).toBeVisible();
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    await act(async () => resolve(success({ message: "邮箱验证成功" })));
    expect(await screen.findByText("邮箱验证成功，请登录")).toBeVisible();
  });
  it("renders expired-token errors", async () => {
    handlers["/api/auth/verify?token=expired"] = () =>
      Response.json(
        { code: "INVALID_TOKEN", message: "验证链接已失效" },
        { status: 400 },
      );
    mount("/account/verify?token=expired");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "验证链接已失效",
    );
  });
});
