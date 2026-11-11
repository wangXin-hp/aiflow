import {
  NodeRunStatusSchema,
  RunEventSchema,
  RunStatusSchema,
  type NodeRunResponse,
  type RunDetailResponse,
  type RunEvent,
  type RunResponse,
} from "@aiflow/contracts";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../auth/auth-api";
import { runApi } from "./workflow-api";

type RunStatus = RunResponse["status"];
type Connection = "connecting" | "connected" | "reconnecting" | "closed";

const terminalEvents = [
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
];
const eventTypes = [
  ...terminalEvents,
  "run.queued",
  "run.started",
  "run.cancelling",
  "node.started",
  "node.succeeded",
  "node.failed",
  "node.skipped",
  "node.cancelled",
];

const terminalStatuses = new Set<RunStatus>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);

/** 终态的输出已持久化，界面可开始下一次运行。 */
export function isTerminalRun(status: RunStatus | undefined) {
  return status !== undefined && terminalStatuses.has(status);
}

const runProgress: Record<RunStatus, number> = {
  QUEUED: 0,
  RUNNING: 1,
  CANCELLING: 2,
  SUCCEEDED: 3,
  FAILED: 3,
  CANCELLED: 3,
  INTERRUPTED: 3,
};

/** 重放和迟到的详情可能携带早期状态，只有权威终态可以覆盖已显示的终态。 */
function advanceStatus(previous: RunStatus | undefined, next: RunStatus) {
  return !previous || runProgress[next] >= runProgress[previous]
    ? next
    : previous;
}

type StreamState = {
  detail?: RunDetailResponse;
  events: RunEvent[];
  status?: RunStatus;
  connection: Connection;
  nodeStatuses: Partial<Record<string, NodeRunResponse["status"]>>;
  error?: string;
  cancelling: boolean;
};

const emptyStream: StreamState = {
  events: [],
  connection: "connecting",
  nodeStatuses: {},
  cancelling: false,
};

/** 以原生 EventSource 保留重连游标，按持久化 ID 去重，并用受保护详情获取最终结果。 */
export function useRunStream(runId: string | undefined, workflowId: string) {
  const [snapshot, setSnapshot] = useState<{
    runId: string;
    workflowId: string;
    state: StreamState;
  }>();
  const actions = useRef<{
    refresh: () => Promise<void>;
    cancel: () => Promise<void>;
  }>(null);

  useEffect(() => {
    if (!runId) return;
    const id = runId;
    let active = true;
    let source: EventSource | undefined;
    let stopped = false;
    let reconnected = false;
    let request = 0;
    let state = emptyStream;
    const seen = new Set<string>();

    function update(change: Partial<StreamState>) {
      state = { ...state, ...change };
      setSnapshot({ runId: id, workflowId, state });
    }

    function stop() {
      stopped = true;
      source?.close();
      update({ connection: "closed" });
    }

    async function refresh(retryConnection = false) {
      const current = ++request;
      try {
        const detail = await runApi.get(id);
        if (!active || current !== request) return;
        if (detail.workflowId !== workflowId || detail.id !== id) {
          update({ error: "该运行不属于当前工作流", connection: "closed" });
          return;
        }
        // 活跃节点在请求发出后仍可能推进，终态详情则覆盖重放中的中间状态。
        const persisted = new Map(
          detail.nodes.map(({ nodeId, status }) => [nodeId, status] as const),
        );
        if (!isTerminalRun(detail.status)) {
          for (const [nodeId, status] of Object.entries(state.nodeStatuses)) {
            const value = persisted.get(nodeId);
            if (
              status &&
              (!value || value === "PENDING" || value === "RUNNING")
            )
              persisted.set(nodeId, status);
          }
        }
        const status = advanceStatus(state.status, detail.status);
        update({
          detail,
          nodeStatuses: Object.fromEntries(persisted),
          status,
          error: undefined,
        });
        if (!source && !stopped) connect();
        else if (stopped && !isTerminalRun(status)) {
          if (retryConnection) connect();
          else update({ error: "事件流已断开，请重试连接" });
        }
      } catch (error) {
        if (active && current === request) {
          update({
            error:
              error instanceof ApiClientError
                ? error.message
                : "读取运行详情失败，请重试",
          });
        }
      }
    }

    function receive(message: Event) {
      if (!active || stopped || !(message instanceof MessageEvent)) return;
      let data: unknown;
      try {
        data = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const parsed = RunEventSchema.safeParse(data);
      if (!parsed.success) return;
      const event = parsed.data;
      if (
        event.runId !== id ||
        event.id !== message.lastEventId ||
        seen.has(event.id)
      )
        return;
      seen.add(event.id);
      const events = [...state.events, event];
      if (event.nodeId) {
        const status = NodeRunStatusSchema.safeParse(event.payload.status);
        const previous = Object.hasOwn(state.nodeStatuses, event.nodeId)
          ? state.nodeStatuses[event.nodeId]
          : undefined;
        // 重放的节点开始事件不能把详情里已完成的节点改回运行中。
        if (
          status.success &&
          (!previous || previous === "PENDING" || previous === "RUNNING")
        )
          update({
            events,
            nodeStatuses: {
              ...state.nodeStatuses,
              [event.nodeId]: status.data,
            },
          });
        else update({ events });
      } else {
        const status = RunStatusSchema.safeParse(event.payload.status);
        update({
          events,
          ...(status.success
            ? { status: advanceStatus(state.status, status.data) }
            : {}),
        });
      }
      if (terminalEvents.includes(event.type)) {
        stop();
        void refresh();
      }
    }

    function connect() {
      stopped = false;
      reconnected = false;
      update({ connection: "connecting" });
      source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`, {
        withCredentials: true,
      });
      const stream = source;
      for (const type of eventTypes) {
        stream.addEventListener(type, (event) => {
          if (source === stream) receive(event);
        });
      }
      stream.addEventListener("open", () => {
        if (!active || stopped || source !== stream) return;
        update({ connection: "connected" });
        if (reconnected) void refresh();
      });
      stream.addEventListener("error", () => {
        if (!active || stopped || source !== stream) return;
        // 详情可能先于终态事件到达；连接中的浏览器仍需按游标补发事件。
        if (stream.readyState === EventSource.CLOSED) {
          stop();
          void refresh();
          return;
        }
        reconnected = true;
        update({ connection: "reconnecting" });
      });
    }

    async function cancel() {
      if (state.cancelling || isTerminalRun(state.status)) return;
      update({ cancelling: true, error: undefined });
      try {
        const { status } = await runApi.cancel(id);
        if (!active) return;
        if (!isTerminalRun(state.status)) update({ status });
        // 取消排队任务可直接进入终态。保留 SSE，直到终态事件或断线补查。
        if (!stopped || !isTerminalRun(state.detail?.status)) await refresh();
      } catch (error) {
        if (active)
          update({
            error:
              error instanceof ApiClientError
                ? error.message
                : "取消运行失败，请重试",
          });
      } finally {
        if (active) update({ cancelling: false });
      }
    }

    actions.current = { refresh: () => refresh(true), cancel };
    void refresh();
    return () => {
      active = false;
      source?.close();
      actions.current = null;
    };
  }, [runId, workflowId]);

  return {
    ...(snapshot &&
    snapshot.runId === runId &&
    snapshot.workflowId === workflowId
      ? snapshot.state
      : emptyStream),
    refresh: () => actions.current?.refresh(),
    cancel: () => actions.current?.cancel(),
  };
}
