import { encodeWorkflowCursor, type WorkflowResponse } from "@aiflow/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../auth/auth-api";
import { runApi, workflowApi } from "./workflow-api";

const workflow: WorkflowResponse = {
  id: "8e0e9401-0ca5-4072-a19b-02fd9d7f00ec",
  name: "客户问答",
  description: "",
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
  revision: 3,
  createdAt: "2026-11-08T08:30:00.000Z",
  updatedAt: "2026-11-08T09:45:00.000Z",
};
const run = {
  id: "b0c28566-1202-4a1c-929f-ea975a49ec95",
  workflowId: workflow.id,
  status: "QUEUED",
  definitionSnapshot: workflow.definition,
  input: {},
  output: null,
  errorCode: null,
  errorMessage: null,
  createdAt: workflow.createdAt,
  startedAt: null,
  finishedAt: null,
};

function stubResponse(response: Response) {
  const fetch = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => vi.unstubAllGlobals());

describe("workflow HTTP boundary", () => {
  const cursor = encodeWorkflowCursor({
    id: workflow.id,
    createdAt: workflow.createdAt,
  });
  const list = { items: [workflow], nextCursor: cursor };
  const { name, description, definition } = workflow;
  const create = { name, description, definition };
  const update = { revision: 2, name };

  it.each([
    [
      "list",
      () => workflowApi.list(),
      "/api/workflows",
      "GET",
      undefined,
      list,
    ],
    [
      "next page",
      () => workflowApi.list(cursor),
      "/api/workflows?cursor=" + cursor,
      "GET",
      undefined,
      list,
    ],
    [
      "create",
      () => workflowApi.create(create),
      "/api/workflows",
      "POST",
      create,
      workflow,
    ],
    [
      "get",
      () => workflowApi.get(workflow.id),
      "/api/workflows/" + workflow.id,
      "GET",
      undefined,
      workflow,
    ],
    [
      "update",
      () => workflowApi.update(workflow.id, update),
      "/api/workflows/" + workflow.id,
      "PATCH",
      update,
      workflow,
    ],
  ] as const)(
    "sends and validates %s requests",
    async (_name, call, url, method, body, data) => {
      const fetch = stubResponse(Response.json({ success: true, data }));
      await expect(call()).resolves.toEqual(data);
      const [path, init] = fetch.mock.calls[0] as [string, RequestInit];
      const request = new Request(new URL(path, "http://localhost"), init);
      expect(request.url).toBe("http://localhost" + url);
      expect(request.method).toBe(method);
      expect(request.credentials).toBe("include");
      if (body) {
        expect(request.headers.get("Content-Type")).toBe("application/json");
        expect(await request.json()).toEqual(body);
      }
    },
  );

  it("returns workflow data normalized by the shared schema", async () => {
    stubResponse(
      Response.json({
        success: true,
        data: { ...workflow, name: " 客户问答 " },
      }),
    );
    await expect(workflowApi.get(workflow.id)).resolves.toEqual(workflow);
  });

  it("archives without reading the body of a 204 response", async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, "json");
    const fetch = stubResponse(response);
    await expect(workflowApi.archive(workflow.id)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledWith("/api/workflows/" + workflow.id, {
      method: "DELETE",
      credentials: "include",
    });
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    [401, "UNAUTHENTICATED", () => workflowApi.get(workflow.id)],
    [
      409,
      "WORKFLOW_REVISION_CONFLICT",
      () => workflowApi.update(workflow.id, update),
    ],
    [404, "WORKFLOW_NOT_FOUND", () => workflowApi.archive(workflow.id)],
  ] as const)(
    "preserves structured HTTP %i errors",
    async (status, code, call) => {
      stubResponse(
        Response.json(
          { code, message: "请求被拒绝", details: { revision: 3 } },
          { status },
        ),
      );
      await expect(call()).rejects.toMatchObject({
        name: ApiClientError.name,
        code,
        message: "请求被拒绝",
        details: { revision: 3 },
        status,
      });
    },
  );

  it("preserves a proxy 401 even without a JSON body", async () => {
    stubResponse(new Response("Unauthorized", { status: 401 }));
    await expect(workflowApi.list()).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: 401,
    });
  });

  it("rejects a successful workflow response with an invalid nested revision", async () => {
    stubResponse(
      Response.json({
        success: true,
        data: { ...list, items: [{ ...workflow, revision: 0 }] },
      }),
    );
    await expect(workflowApi.list()).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: 200,
    });
  });

  it("maps fetch rejection to the same client error type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network down")),
    );
    await expect(workflowApi.list()).rejects.toBeInstanceOf(ApiClientError);
    await expect(workflowApi.list()).rejects.toMatchObject({
      code: "REQUEST_FAILED",
      status: undefined,
    });
  });
});

describe("run HTTP boundary", () => {
  const input = { input: {} };
  const detail = { ...run, nodes: [] };
  const cancellation = { status: "CANCELLED" };

  it.each([
    [
      "create",
      () => runApi.create(workflow.id, input),
      "/api/workflows/" + workflow.id + "/runs",
      "POST",
      input,
      run,
      202,
    ],
    [
      "detail",
      () => runApi.get(run.id),
      "/api/runs/" + run.id,
      "GET",
      undefined,
      detail,
      200,
    ],
    [
      "cancel",
      () => runApi.cancel(run.id),
      "/api/runs/" + run.id + "/cancel",
      "POST",
      undefined,
      cancellation,
      200,
    ],
  ] as const)(
    "sends and validates %s requests",
    async (_name, call, url, method, body, data, status) => {
      const fetch = stubResponse(
        Response.json({ success: true, data }, { status }),
      );
      const result = await call();
      expect(result).toEqual(data);
      const [path, init] = fetch.mock.calls[0] as [string, RequestInit];
      const request = new Request(new URL(path, "http://localhost"), init);
      expect(request.url).toBe("http://localhost" + url);
      expect(request.method).toBe(method);
      expect(request.credentials).toBe("include");
      if (body) {
        expect(request.headers.get("Content-Type")).toBe("application/json");
        expect(await request.json()).toEqual(body);
      } else {
        expect(request.body).toBeNull();
      }
    },
  );

  it.each([
    [
      "create",
      () => runApi.create(workflow.id, input),
      { ...run, status: "unknown" },
    ],
    ["detail", () => runApi.get(run.id), run],
    ["cancel", () => runApi.cancel(run.id), { status: "unknown" }],
  ] as const)(
    "rejects malformed %s payloads inside a successful wrapper",
    async (_name, call, data) => {
      stubResponse(Response.json({ success: true, data }));
      await expect(call()).rejects.toMatchObject({
        code: "REQUEST_FAILED",
        status: 200,
      });
    },
  );
});
