import {
  CreateRunRequestSchema,
  type CreateRunRequest,
  type JsonValue,
  type WorkflowV2,
} from "@aiflow/contracts";
import { useState, type FormEvent } from "react";
import { isTerminalRun, type useRunStream } from "./use-run-stream";

type Stream = ReturnType<typeof useRunStream>;

const statusLabels = {
  QUEUED: "排队中",
  PENDING: "待执行",
  RUNNING: "运行中",
  CANCELLING: "正在取消",
  SUCCEEDED: "成功",
  FAILED: "失败",
  CANCELLED: "已取消",
  INTERRUPTED: "已中断",
  SKIPPED: "已跳过",
};

const connectionLabels = {
  connecting: "正在连接事件流",
  connected: "事件流已连接",
  reconnecting: "事件流重连中",
  closed: "事件流已关闭",
};

const fieldTypeLabels = {
  string: "文本",
  number: "数字",
  boolean: "布尔值",
  array: "JSON 数组",
  object: "JSON 对象",
};

/** 调试表单以当前开始节点声明为准，业务输出只从受保护的详情渲染。 */
export function RunPanel({
  definition,
  stream,
  runId,
  busy,
  unavailable,
  error,
  onRun,
  onClose,
}: {
  definition: WorkflowV2;
  stream: Stream;
  runId?: string;
  busy: boolean;
  unavailable: boolean;
  error?: string;
  onRun: (input: CreateRunRequest) => Promise<void>;
  onClose: () => void;
}) {
  const fields =
    definition.nodes.find((node) => node.type === "start")?.config?.inputs ??
    [];
  const [validation, setValidation] = useState<string>();
  const { detail, status } = stream;
  const active = status !== undefined && !isTerminalRun(status);
  const loading = runId !== undefined && !status && !stream.error;
  const blocked = busy || unavailable || active || loading;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    const form = new FormData(event.currentTarget);
    const entries: [string, JsonValue][] = [];
    for (const field of fields) {
      const raw = String(form.get(field.name) ?? "");
      // 未填写字段省略，由服务端按实际运行快照补默认值。
      if (raw === "") continue;
      try {
        const value: unknown =
          field.type === "string"
            ? raw
            : field.type === "number"
              ? Number(raw)
              : JSON.parse(raw);
        const actual = Array.isArray(value) ? "array" : typeof value;
        if (value === null || actual !== field.type)
          throw new Error("Invalid field type");
        entries.push([field.name, value as JsonValue]);
      } catch {
        setValidation(
          `字段 ${field.name} 需要有效的${fieldTypeLabels[field.type]}`,
        );
        return;
      }
    }
    const parsed = CreateRunRequestSchema.safeParse({
      input: Object.fromEntries(entries),
    });
    if (!parsed.success) {
      setValidation("运行输入无效或超过大小限制");
      return;
    }
    setValidation(undefined);
    void onRun(parsed.data);
  }

  return (
    <section
      className="studio-inspector studio-run-panel"
      aria-label="测试运行"
    >
      <div className="studio-run-heading">
        <h2>测试运行</h2>
        <button type="button" onClick={onClose} disabled={busy}>
          关闭运行面板
        </button>
      </div>
      <form onSubmit={submit} className="studio-run-form">
        <h3>运行输入</h3>
        {fields.length === 0 && <p>此工作流无需输入。</p>}
        {fields.map((field) => {
          const fallback =
            field.defaultValue === undefined
              ? undefined
              : field.type === "string"
                ? String(field.defaultValue)
                : JSON.stringify(field.defaultValue);
          const required = field.required && fallback === undefined;
          const props = { name: field.name, required, disabled: busy };
          return (
            <label key={`${field.name}:${field.type}`}>
              <span>{field.name}</span>
              {field.type === "boolean" ? (
                <select {...props}>
                  <option value="">
                    {fallback === undefined ? "请选择" : `默认：${fallback}`}
                  </option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : field.type === "array" || field.type === "object" ? (
                <textarea
                  {...props}
                  placeholder={fallback ?? fieldTypeLabels[field.type]}
                />
              ) : (
                <input
                  {...props}
                  type={field.type === "number" ? "number" : "text"}
                  step={field.type === "number" ? "any" : undefined}
                  placeholder={fallback}
                />
              )}
            </label>
          );
        })}
        {validation && <p role="alert">{validation}</p>}
        {error && <p role="alert">{error}</p>}
        <button className="studio-run-start" type="submit" disabled={blocked}>
          {busy ? "正在准备运行" : "开始运行"}
        </button>
      </form>
      {runId && (
        <>
          <section aria-label="运行结果">
            <h3>运行结果</h3>
            <p role="status">
              {status
                ? statusLabels[status]
                : loading
                  ? "正在读取运行详情"
                  : "运行详情不可用"}
            </p>
            {active && (
              <button
                type="button"
                onClick={() => void stream.cancel()}
                disabled={stream.cancelling || status === "CANCELLING"}
              >
                取消运行
              </button>
            )}
            {stream.error && (
              <>
                <p role="alert">{stream.error}</p>
                <button type="button" onClick={() => void stream.refresh()}>
                  重试读取详情
                </button>
              </>
            )}
            {detail?.errorMessage && <p role="alert">{detail.errorMessage}</p>}
            {detail?.output != null && (
              <pre>{JSON.stringify(detail.output, null, 2)}</pre>
            )}
            {detail && detail.nodes.length > 0 && (
              <ul className="studio-run-nodes">
                {detail.nodes.map((node) => (
                  <li key={node.id}>
                    <h4>
                      {node.nodeId} ·{" "}
                      {
                        statusLabels[
                          stream.nodeStatuses[node.nodeId] ?? node.status
                        ]
                      }
                    </h4>
                    {node.errorMessage && (
                      <p role="alert">{node.errorMessage}</p>
                    )}
                    {node.output !== null && (
                      <pre>{JSON.stringify(node.output, null, 2)}</pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="事件追踪">
            <h3>事件追踪</h3>
            <p role="status">{connectionLabels[stream.connection]}</p>
            <ol className="studio-run-events">
              {stream.events.map((event) => (
                <li key={event.id}>
                  <code>{event.type}</code>
                  {event.nodeId && <span>{event.nodeId}</span>}
                  {event.payload.elapsedMs !== undefined && (
                    <span>{event.payload.elapsedMs} ms</span>
                  )}
                  {event.payload.errorCode && (
                    <code>{event.payload.errorCode}</code>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </section>
  );
}
