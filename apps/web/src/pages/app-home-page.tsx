import type { WorkflowResponse } from "@aiflow/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiClientError } from "../auth/auth-api";
import { useAuth } from "../auth/auth-state";
import { createStarterDefinition } from "../workflow/graph";
import { workflowApi } from "../workflow/workflow-api";

const createdDate = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" });

function appendWorkflows(
  current: WorkflowResponse[],
  incoming: WorkflowResponse[],
) {
  // 按首次出现的位置保留服务端顺序，同时去掉跨页和同页的重复项。
  const seen = new Set(current.map(({ id }) => id));
  const appended = incoming.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return [...current, ...appended];
}

/** 管理当前会话的工作流列表、分页和草稿操作。 */
export function AppHomePage() {
  const { user, logout, retry: retrySession } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkflowResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [firstPage, setFirstPage] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const [operation, setOperation] = useState<
    "more" | "create" | "archive" | "logout" | null
  >(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [avatarFailed, setAvatarFailed] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const restoreArchiveFocus = useRef<string | null>(null);
  const reportInitialFailure = useEffectEvent((failure: unknown) => {
    setFirstPage("error");
    reportFailure(failure, "加载工作流失败，请重试");
  });

  useEffect(() => {
    const request = new AbortController();
    activeRequest.current = request;
    void workflowApi.list().then(
      (page) => {
        if (request.signal.aborted) return;
        setItems(appendWorkflows([], page.items));
        setNextCursor(page.nextCursor);
        setFirstPage("ready");
      },
      (failure: unknown) => {
        if (!request.signal.aborted) reportInitialFailure(failure);
      },
    );
    // 离开页面时忽略旧响应，避免迟到的创建结果把用户带回编辑器。
    return () => request.abort();
  }, [attempt]);

  function reportFailure(failure: unknown, fallback: string) {
    if (failure instanceof ApiClientError && failure.status === 401) {
      // 由现有会话检查决定是否跳转登录页，并保留当前地址。
      retrySession();
      return;
    }
    setError(failure instanceof ApiClientError ? failure.message : fallback);
  }

  async function perform(
    action: NonNullable<typeof operation>,
    fallback: string,
    request: (signal: AbortSignal) => Promise<void>,
  ) {
    const signal = activeRequest.current?.signal;
    if (!signal || signal.aborted || operation) return;
    // 分页与归档串行提交，防止迟到的页面结果重新显示已归档的工作流。
    setOperation(action);
    setError("");
    try {
      await request(signal);
    } catch (failure) {
      if (!signal.aborted) reportFailure(failure, fallback);
    } finally {
      if (!signal.aborted) setOperation(null);
    }
  }

  function loadMore(cursor: string) {
    void perform("more", "加载更多工作流失败，请重试", async (signal) => {
      const page = await workflowApi.list(cursor);
      if (signal.aborted) return;
      setItems((current) => appendWorkflows(current, page.items));
      setNextCursor(page.nextCursor);
    });
  }

  function create() {
    void perform("create", "创建工作流失败，请重试", async (signal) => {
      const workflow = await workflowApi.create({
        name: "未命名工作流",
        description: "",
        definition: createStarterDefinition(),
      });
      if (!signal.aborted) void navigate(`/workflows/${workflow.id}`);
    });
  }

  function archive(id: string) {
    void perform("archive", "归档工作流失败，请重试", async (signal) => {
      await workflowApi.archive(id);
      if (signal.aborted) return;
      setItems((current) => current.filter((item) => item.id !== id));
      setArchiveId(null);
      // 卡片即将移除，将焦点移至仍可继续导航的列表标题。
      listHeading.current?.focus();
    });
  }

  if (!user) return null;

  return (
    <div className="workspace">
      <header className="workspace-nav">
        <Link className="brand" to="/apps" aria-label="AIFlow 工作台">
          AI<span>Flow</span>
        </Link>
        <div className="workspace-account">
          <div className="profile">
            <div className="avatar" aria-hidden="true">
              {user.avatarUrl && !avatarFailed ? (
                <img
                  src={user.avatarUrl}
                  alt=""
                  onError={() => setAvatarFailed(true)}
                />
              ) : (
                Array.from(user.name || user.email)[0]?.toUpperCase()
              )}
            </div>
            <div className="profile-details">
              <strong>{user.name || "AIFlow 用户"}</strong>
              <p>{user.email}</p>
            </div>
          </div>
          <button
            className="secondary"
            disabled={operation !== null}
            aria-busy={operation === "logout"}
            onClick={() => {
              void perform("logout", "退出失败，请重试", logout);
            }}
          >
            {operation === "logout" ? "正在退出…" : "退出登录"}
          </button>
        </div>
      </header>
      <main className="workspace-main">
        <div className="workspace-heading">
          <h1 ref={listHeading} tabIndex={-1}>
            工作流
          </h1>
          <button
            className="primary"
            disabled={operation !== null}
            onClick={create}
          >
            {operation === "create" ? "正在创建…" : "新建工作流"}
          </button>
        </div>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {firstPage === "loading" && (
          <p className="workspace-state" role="status">
            正在加载工作流…
          </p>
        )}
        {firstPage === "error" && (
          <button
            className="secondary"
            disabled={operation !== null}
            onClick={() => {
              setFirstPage("loading");
              setError("");
              setAttempt((current) => current + 1);
            }}
          >
            重试
          </button>
        )}
        {firstPage === "ready" && items.length === 0 && nextCursor === null && (
          <p className="workspace-state">还没有工作流</p>
        )}
        {items.length > 0 && (
          <ul className="workflow-list" role="list" aria-label="工作流">
            {items.map((item) => (
              <li className="workflow-card" key={item.id}>
                <h2>
                  <Link to={`/workflows/${item.id}`}>{item.name}</Link>
                </h2>
                {item.description && <p>{item.description}</p>}
                <div className="workflow-card-footer">
                  <time dateTime={item.createdAt}>
                    创建于 {createdDate.format(new Date(item.createdAt))}
                  </time>
                  {archiveId !== item.id && (
                    <button
                      ref={(button) => {
                        // 取消后触发器重新挂载，只恢复对应卡片的焦点一次。
                        if (button && restoreArchiveFocus.current === item.id) {
                          restoreArchiveFocus.current = null;
                          button.focus();
                        }
                      }}
                      className="text-button"
                      disabled={operation !== null}
                      aria-label={`归档 ${item.name}`}
                      onClick={() => setArchiveId(item.id)}
                    >
                      归档
                    </button>
                  )}
                </div>
                {archiveId === item.id && (
                  <div
                    className="workflow-archive"
                    role="group"
                    aria-label={`确认归档 ${item.name}`}
                  >
                    <p>归档后，工作流将从列表移除。</p>
                    <button
                      className="secondary"
                      autoFocus
                      disabled={operation !== null}
                      onClick={() => {
                        restoreArchiveFocus.current = item.id;
                        setArchiveId(null);
                      }}
                    >
                      取消
                    </button>
                    <button
                      className="primary"
                      disabled={operation !== null}
                      onClick={() => archive(item.id)}
                    >
                      {operation === "archive" ? "正在归档…" : "确认归档"}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {nextCursor !== null && (
          <button
            className="secondary workspace-more"
            disabled={operation !== null}
            onClick={() => loadMore(nextCursor)}
          >
            {operation === "more" ? "正在加载…" : "继续加载"}
          </button>
        )}
      </main>
    </div>
  );
}
