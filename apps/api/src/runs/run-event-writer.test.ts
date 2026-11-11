import { describe, expect, it, vi } from "vitest";
import { firstValueFrom, take } from "rxjs";
import { RunEventHub } from "./run-event-hub.js";
import { RunEventWriter } from "./run-event-writer.js";
import type { PrismaService } from "../database/prisma.service.js";
import { ConfigService } from "@nestjs/config";
import { loadEnvironment, type Environment } from "../config/environment.js";

const runId = "123e4567-e89b-42d3-a456-426614174000";
const base = {
  runId,
  type: "run.started",
  level: "info" as const,
  payload: { status: "RUNNING", prompt: "private" },
};
const row = {
  id: 9007199254740993n,
  runId,
  nodeId: null,
  type: "run.started",
  level: "info",
  payload: { status: "RUNNING", truncated: true },
  createdAt: new Date("2026-11-10T12:00:00.000Z"),
};

describe("RunEventWriter", () => {
  it("honors the validated deployment byte limit", () => {
    const config = new ConfigService<Environment, true>(
      loadEnvironment({
        NODE_ENV: "test",
        JWT_SECRET: "writer-test-secret-at-least-thirty-two-characters",
        RUN_EVENT_MAX_BYTES: "18",
      }),
    );
    const writer = new RunEventWriter(
      {} as PrismaService,
      new RunEventHub(),
      config,
    );
    expect(
      writer.prepare({ ...base, payload: { status: "RUNNING" } }).payload,
    ).toEqual({ truncated: true });
  });
  it("sanitizes and persists before notifying subscribers", async () => {
    let resolveInsert!: (value: typeof row) => void;
    const create = vi.fn().mockReturnValue(
      new Promise<typeof row>((resolve) => {
        resolveInsert = resolve;
      }),
    );
    const hub = new RunEventHub();
    const notify = vi.spyOn(hub, "notify");
    const writer = new RunEventWriter(
      { runEvent: { create } } as unknown as PrismaService,
      hub,
    );
    const next = firstValueFrom(hub.notifications(runId).pipe(take(1)));
    const pending = writer.append(base);
    expect(notify).not.toHaveBeenCalled();
    expect(create.mock.calls[0]?.[0]?.data.payload).toEqual({
      status: "RUNNING",
      truncated: true,
    });
    resolveInsert(row);
    await expect(pending).resolves.toMatchObject({
      id: "9007199254740993",
      createdAt: row.createdAt.toISOString(),
    });
    await next;
    expect(notify).toHaveBeenCalledWith(runId);
  });

  it("does not notify when the database insert fails", async () => {
    const hub = new RunEventHub();
    const notify = vi.spyOn(hub, "notify");
    const create = vi.fn().mockRejectedValue(new Error("db failed"));
    const writer = new RunEventWriter(
      { runEvent: { create } } as unknown as PrismaService,
      hub,
    );
    await expect(writer.append(base)).rejects.toThrow("db failed");
    expect(notify).not.toHaveBeenCalled();
  });

  it("rejects invalid envelopes before any database write or notification", async () => {
    const hub = new RunEventHub();
    const notify = vi.spyOn(hub, "notify");
    const create = vi.fn();
    const writer = new RunEventWriter(
      { runEvent: { create } } as unknown as PrismaService,
      hub,
    );
    await expect(writer.append({ ...base, type: "" })).rejects.toThrow();
    expect(() => writer.prepare({ ...base, type: "" })).toThrow();
    expect(create).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("only broadcasts to subscribers for the persisted run", async () => {
    const hub = new RunEventHub();
    const observed: string[] = [];
    const subscription = hub
      .notifications("other-run")
      .subscribe(() => observed.push("other"));
    hub.notify(runId);
    expect(observed).toEqual([]);
    subscription.unsubscribe();
  });
});
