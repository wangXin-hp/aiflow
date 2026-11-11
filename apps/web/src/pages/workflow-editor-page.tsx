import type { WorkflowResponse } from "@aiflow/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { Link, useBlocker, useParams } from "react-router-dom";
import { ApiClientError } from "../auth/auth-api";
import { useAuth } from "../auth/auth-state";
import { NodeInspector } from "../workflow/node-inspector";
import { useWorkflowDraft } from "../workflow/use-workflow-draft";
import { workflowApi } from "../workflow/workflow-api";
import { WorkflowCanvas } from "../workflow/workflow-canvas";

const discardMessage = "离开后，未保存的修改将丢失。";

function DraftEditor({
  initial,
  onReload,
  reloading,
}: {
  initial: WorkflowResponse;
  onReload: () => void;
  reloading: boolean;
}) {
  const workflow = useWorkflowDraft(initial);
  const { draft, dirty, saving, conflict } = workflow;
  const [selectedNodeId, selectNode] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string }>();
  const selected = draft.definition.nodes.find(
    ({ id }) => id === selectedNodeId,
  );
  // 查询参数用于同一工作流的运行详情，切换查询参数可以保留当前编辑。
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  const blocked = blocker.state === "blocked";

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <>
      <header className="studio-header" inert={reloading || blocked}>
        <Link to="/apps" className="studio-brand" aria-label="返回工作流列表">
          AIFlow <span aria-hidden="true">/</span> 工作流
        </Link>
        <input
          aria-label="工作流名称"
          maxLength={100}
          value={draft.name}
          onChange={(event) => workflow.setName(event.target.value)}
        />
        <span className="studio-save-status" role="status">
          {saving
            ? "正在保存"
            : conflict
              ? "保存冲突"
              : dirty
                ? "未保存"
                : "已保存"}
        </span>
        <button
          type="button"
          className="studio-save"
          disabled={!dirty || saving || conflict}
          onClick={() => void workflow.save()}
        >
          保存
        </button>
      </header>
      {reloading && (
        <p className="studio-notice" role="status">
          正在重新载入服务器版本
        </p>
      )}
      {workflow.issues.length > 0 && (
        <div
          className="studio-notice"
          role="alert"
          inert={reloading || blocked}
        >
          <ul>
            {workflow.issues.map(
              ({ message, nodeId, reauthenticate }, index) => (
                <li key={index}>
                  {nodeId ? (
                    <button
                      type="button"
                      onClick={() => {
                        selectNode(nodeId);
                        setFocusRequest({ nodeId });
                      }}
                    >
                      {message}
                    </button>
                  ) : (
                    message
                  )}
                  {reauthenticate && (
                    <Link
                      to="/account/login"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      在新标签页重新登录
                    </Link>
                  )}
                </li>
              ),
            )}
          </ul>
          {conflict && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm("重新载入服务器版本将丢弃本地改动。"))
                  onReload();
              }}
            >
              重新载入服务器版本
            </button>
          )}
        </div>
      )}
      <div className="studio-editor-body" inert={reloading || blocked}>
        <WorkflowCanvas
          definition={draft.definition}
          onChange={workflow.setDefinition}
          selectedNodeId={selectedNodeId}
          onSelect={selectNode}
          focusRequest={focusRequest}
        />
        {selected ? (
          <NodeInspector
            key={selected.id}
            node={selected}
            definition={draft.definition}
            advanced={workflow.advanced.get(selected.id)}
            onChange={workflow.setNode}
            onAdvancedChange={workflow.setAdvanced}
          />
        ) : (
          <section className="studio-inspector" aria-label="节点配置">
            <h2>节点配置</h2>
            <p>选择画布上的节点以编辑配置。</p>
          </section>
        )}
      </div>
      {blocker.state === "blocked" && (
        <div className="studio-leave-overlay">
          <section
            className="studio-leave"
            role="dialog"
            aria-modal="true"
            aria-label="未保存的修改"
          >
            <p>{discardMessage}</p>
            <button type="button" autoFocus onClick={blocker.reset}>
              继续编辑
            </button>
            <button type="button" onClick={blocker.proceed}>
              离开编辑器
            </button>
          </section>
        </div>
      )}
    </>
  );
}

function WorkflowEditor({ id }: { id: string }) {
  const { retry } = useAuth();
  const [loaded, setLoaded] = useState<{
    draft: WorkflowResponse;
    attempt: number;
  }>();
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{
    message: string;
    status?: number;
    attempt: number;
  }>();
  const pending = loaded?.attempt !== attempt && failure?.attempt !== attempt;
  const reportFailure = useEffectEvent(
    (error: unknown, requestAttempt: number) => {
      if (error instanceof ApiClientError) {
        if (error.status === 401) retry();
        setFailure({
          message: error.message,
          status: error.status,
          attempt: requestAttempt,
        });
        return;
      }
      setFailure({
        message: "加载工作流失败，请重试",
        attempt: requestAttempt,
      });
    },
  );

  useEffect(() => {
    let current = true;
    void workflowApi.get(id).then(
      (draft) => {
        if (current) setLoaded({ draft, attempt });
      },
      (error: unknown) => {
        if (current) reportFailure(error, attempt);
      },
    );
    // 路由变化或重试后忽略旧请求，避免迟到的响应覆盖当前草稿。
    return () => {
      current = false;
    };
  }, [id, attempt]);

  return (
    <main className="studio-editor" aria-label="工作流编辑器">
      {failure?.attempt === attempt && (
        <section className="studio-notice" role="alert">
          <p>{failure.message}</p>
          {failure.status === 404 ? (
            <Link to="/apps">返回工作流列表</Link>
          ) : (
            !loaded && (
              <button
                type="button"
                onClick={() => setAttempt((current) => current + 1)}
              >
                重试
              </button>
            )
          )}
        </section>
      )}
      {loaded ? (
        <DraftEditor
          key={loaded.attempt}
          initial={loaded.draft}
          reloading={pending}
          onReload={() => setAttempt((current) => current + 1)}
        />
      ) : (
        pending && (
          <p className="studio-notice" role="status">
            正在加载工作流
          </p>
        )
      )}
    </main>
  );
}

/** 同一页面可能切换工作流 ID，按 ID 隔离草稿与加载生命周期。 */
export function WorkflowEditorPage() {
  const { id } = useParams();
  return id ? <WorkflowEditor key={id} id={id} /> : null;
}
