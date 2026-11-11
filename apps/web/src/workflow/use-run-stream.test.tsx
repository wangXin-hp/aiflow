import type { RunDetailResponse } from "@aiflow/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createStarterDefinition } from "./graph";
import { useRunStream } from "./use-run-stream";

const runId = "123e4567-e89b-42d3-a456-426614174001";
const workflowId = "123e4567-e89b-42d3-a456-426614174000";
const timestamp = "2026-11-08T00:00:00.000Z";

class TestEventSource extends EventTarget {
  static latest: TestEventSource;
  readyState = 0;

  constructor(
    readonly url: string,
    readonly options?: EventSourceInit,
  ) {
    super();
    TestEventSource.latest = this;
  }

  close() {
    this.readyState = 2;
  }

  send(id: string, type: string, status: string, nodeId?: string) {
    this.dispatchEvent(
      new MessageEvent(type, {
        lastEventId: id,
        data: JSON.stringify({
          id,
          type,
          runId,
          nodeId,
          level: "info",
          payload: { status },
          createdAt: timestamp,
        }),
      }),
    );
  }
}

afterEach(() => vi.unstubAllGlobals());

it("重连沿用同一连接，重复事件只记录一次，终态关闭连接并刷新详情", async () => {
  const detail: RunDetailResponse = {
    id: runId,
    workflowId,
    status: "RUNNING",
    definitionSnapshot: createStarterDefinition(),
    input: {},
    output: null,
    errorCode: null,
    errorMessage: null,
    nodes: [],
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: null,
  };
  let server = detail;
  const fetchMock = vi.fn(async () =>
    Response.json({ success: true, data: server }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", TestEventSource);
  const { result } = renderHook(() => useRunStream(runId, workflowId));
  await waitFor(() => expect(TestEventSource.latest).toBeDefined());
  const stream = TestEventSource.latest;
  expect(stream.url).toBe(`/api/runs/${runId}/events`);
  expect(stream.options?.withCredentials).toBe(true);
  act(() => stream.dispatchEvent(new Event("open")));
  act(() => stream.send("9007199254740992", "node.started", "RUNNING", "end"));
  expect(result.current.nodeStatuses.end).toBe("RUNNING");
  act(() => stream.dispatchEvent(new Event("error")));
  expect(result.current.connection).toBe("reconnecting");
  act(() => stream.dispatchEvent(new Event("open")));
  expect(TestEventSource.latest).toBe(stream);
  await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
  act(() => stream.send("9007199254740992", "node.started", "RUNNING", "end"));
  expect(result.current.events).toHaveLength(1);
  server = { ...detail, status: "SUCCEEDED", finishedAt: timestamp };
  act(() => {
    stream.send("9007199254740993", "run.succeeded", "SUCCEEDED");
    stream.send("9007199254740993", "run.succeeded", "SUCCEEDED");
  });
  await waitFor(() => expect(result.current.detail?.status).toBe("SUCCEEDED"));
  expect(result.current.events.map(({ id }) => id)).toEqual([
    "9007199254740992",
    "9007199254740993",
  ]);
  expect(stream.readyState).toBe(2);
});
