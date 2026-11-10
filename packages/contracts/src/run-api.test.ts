import { describe, expect, it } from "vitest";
import {
  CreateRunRequestSchema,
  NodeRunStatusSchema,
  RunResponseSchema,
  RunEventSchema,
  RunEventCursorSchema,
  SafeRunEventPayloadSchema,
} from "./run-api.js";

const id = "123e4567-e89b-42d3-a456-426614174000";
const time = "2026-11-10T12:00:00.000Z";
const run = {
  id,
  workflowId: id,
  status: "QUEUED",
  input: {},
  definitionSnapshot: { schemaVersion: 2, nodes: [], edges: [] },
  createdAt: time,
  startedAt: null,
  finishedAt: null,
  output: null,
  errorCode: null,
  errorMessage: null,
};
const event = {
  id: "9007199254740993",
  runId: id,
  type: "run.queued",
  level: "info",
  payload: { status: "QUEUED" },
  createdAt: time,
};

function deepObject(): object {
  let value = {};
  for (let index = 0; index < 3_000; index++) value = { child: value };
  return value;
}

describe("run API contracts", () => {
  it("accepts only a JSON object as debug input", () => {
    expect(
      CreateRunRequestSchema.parse({ input: { prompt: "hello" } }),
    ).toEqual({ input: { prompt: "hello" } });
    for (const input of [[], null, "hello"]) {
      expect(CreateRunRequestSchema.safeParse({ input }).success).toBe(false);
    }
    expect(
      CreateRunRequestSchema.safeParse({ input: {}, extra: 1 }).success,
    ).toBe(false);
  });

  it("checks every public run status", () => {
    for (const status of [
      "QUEUED",
      "RUNNING",
      "CANCELLING",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "INTERRUPTED",
    ]) {
      expect(RunResponseSchema.safeParse({ ...run, status }).success).toBe(
        true,
      );
    }
    expect(
      RunResponseSchema.safeParse({ ...run, status: "UNKNOWN" }).success,
    ).toBe(false);
  });

  it("checks every public node status", () => {
    for (const status of [
      "PENDING",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "SKIPPED",
      "CANCELLED",
    ]) {
      expect(NodeRunStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(NodeRunStatusSchema.safeParse("QUEUED").success).toBe(false);
  });

  it("rejects malformed timestamps and extra fields in public envelopes", () => {
    expect(
      RunResponseSchema.safeParse({ ...run, createdAt: "2026-11-10" }).success,
    ).toBe(false);
    expect(RunResponseSchema.safeParse({ ...run, ownerId: id }).success).toBe(
      false,
    );
    expect(
      RunEventSchema.safeParse({ ...event, nodeId: null, createdAt: "no" })
        .success,
    ).toBe(false);
    expect(
      RunEventSchema.safeParse({ ...event, nodeId: null, extra: 1 }).success,
    ).toBe(false);
  });

  it("accepts omitted, null, and string event node IDs", () => {
    expect(RunEventSchema.parse(event)).toEqual(event);
    expect(RunEventSchema.parse({ ...event, nodeId: null }).nodeId).toBeNull();
    expect(RunEventSchema.parse({ ...event, nodeId: id }).nodeId).toBe(id);
  });

  it("keeps precise decimal IDs within the PostgreSQL BigInt range", () => {
    for (const value of ["1", "9007199254740993", "9223372036854775807"]) {
      expect(RunEventCursorSchema.parse(value)).toBe(value);
      expect(
        RunEventSchema.parse({ ...event, nodeId: null, id: value }).id,
      ).toBe(value);
    }
    for (const value of [
      1,
      "01",
      "-1",
      "9223372036854775808",
      "9".repeat(1024),
    ]) {
      expect(RunEventCursorSchema.safeParse(value).success).toBe(false);
      expect(
        RunEventSchema.safeParse({ ...event, nodeId: null, id: value }).success,
      ).toBe(false);
    }
  });

  it("reserves zero for the initial replay cursor", () => {
    expect(RunEventCursorSchema.parse("0")).toBe("0");
    expect(
      RunEventSchema.safeParse({ ...event, nodeId: null, id: "0" }).success,
    ).toBe(false);
  });

  it("accepts only public state, timing, and error metadata in events", () => {
    const payload = {
      status: "FAILED",
      elapsedMs: 12,
      startedAt: time,
      finishedAt: time,
      errorCode: "node_timeout",
      truncated: true,
    };
    expect(SafeRunEventPayloadSchema.parse(payload)).toEqual(payload);
    for (const payload of [
      { prompt: "private" },
      { output: { whole: true } },
      { input: {} },
      { token: "secret" },
      { errorMessage: "raw details" },
      { status: { nested: "RUNNING" } },
      { elapsedMs: -1 },
    ]) {
      expect(SafeRunEventPayloadSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("checks event payload UTF-8 size before parsing its shape", () => {
    const result = SafeRunEventPayloadSchema.safeParse({
      errorCode: "错".repeat(22_000),
    });
    expect(result.error?.issues).toMatchObject([{ code: "custom", path: [] }]);
  });

  it("rejects free-form text in the event error code", () => {
    expect(
      SafeRunEventPayloadSchema.safeParse({ errorCode: "raw error details" })
        .success,
    ).toBe(false);
  });

  it("rejects deeply nested event payloads without throwing", () => {
    expect(
      SafeRunEventPayloadSchema.safeParse({ status: deepObject() }).success,
    ).toBe(false);
  });

  it("rejects deeply nested run input without throwing", () => {
    expect(
      CreateRunRequestSchema.safeParse({ input: deepObject() }).success,
    ).toBe(false);
  });

  it("rejects cyclic run input without throwing", () => {
    const input: { self?: unknown } = {};
    input.self = input;
    expect(CreateRunRequestSchema.safeParse({ input }).success).toBe(false);
  });

  it("rejects own prototype keys instead of silently removing input data", () => {
    const input: unknown = JSON.parse('{"values":[{"__proto__":{"x":1}}]}');
    expect(CreateRunRequestSchema.safeParse({ input }).success).toBe(false);
    expect(RunResponseSchema.safeParse({ ...run, input }).success).toBe(false);
  });

  it("retains nested JSON values in run input", () => {
    const input = { values: [{ text: "中文", items: [1, null, true] }] };
    expect(CreateRunRequestSchema.parse({ input }).input).toEqual(input);
  });

  it("rejects run input over the HTTP byte budget", () => {
    const input = { text: "中".repeat(700_000) };
    expect(CreateRunRequestSchema.safeParse({ input }).success).toBe(false);
  });
});
