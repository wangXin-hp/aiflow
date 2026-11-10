import { describe, expect, it } from "vitest";
import {
  CreateRunRequestSchema,
  RunResponseSchema,
  RunEventSchema,
  RunEventCursorSchema,
} from "./run-api.js";

const id = "123e4567-e89b-42d3-a456-426614174000";
const time = "2026-11-10T12:00:00.000Z";

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

  it("checks every public run status and ISO timestamps", () => {
    for (const status of [
      "QUEUED",
      "RUNNING",
      "CANCELLING",
      "SUCCEEDED",
      "FAILED",
      "CANCELLED",
      "INTERRUPTED",
    ]) {
      expect(
        RunResponseSchema.safeParse({
          id,
          workflowId: id,
          status,
          input: {},
          definitionSnapshot: { schemaVersion: 2, nodes: [], edges: [] },
          createdAt: time,
          startedAt: null,
          finishedAt: null,
          output: null,
          errorCode: null,
          errorMessage: null,
        }).success,
      ).toBe(true);
    }
    expect(
      RunResponseSchema.safeParse({
        id,
        workflowId: id,
        status: "UNKNOWN",
        input: {},
        definitionSnapshot: { schemaVersion: 2, nodes: [], edges: [] },
        createdAt: time,
        startedAt: null,
        finishedAt: null,
        output: null,
        errorCode: null,
        errorMessage: null,
      }).success,
    ).toBe(false);
  });

  it("uses decimal string event cursors and safe event payloads", () => {
    const event = {
      id: "9007199254740993",
      runId: id,
      nodeId: null,
      type: "run.queued",
      level: "info",
      payload: { status: "QUEUED" },
      createdAt: time,
    };
    expect(RunEventSchema.safeParse(event).success).toBe(true);
    expect(
      RunEventSchema.safeParse({ ...event, id: 9007199254740992 }).success,
    ).toBe(false);
    expect(RunEventSchema.safeParse({ ...event, nodeId: id }).success).toBe(
      true,
    );
    expect(
      RunEventSchema.safeParse({ ...event, payload: { token: "secret" } })
        .success,
    ).toBe(false);
    expect(RunEventCursorSchema.safeParse("9007199254740993").success).toBe(
      true,
    );
    expect(RunEventCursorSchema.safeParse(1).success).toBe(false);
  });
});
