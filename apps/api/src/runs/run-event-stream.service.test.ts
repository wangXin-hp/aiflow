import { randomUUID } from "node:crypto";
import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { RunEventStreamService } from "./run-event-stream.service.js";

const runId = randomUUID();
const ownerId = randomUUID();
const createdAt = new Date("2026-11-11T00:00:00.000Z");

function event(id: bigint, type = "node.started") {
  return {
    id,
    runId,
    nodeId: null,
    type,
    level: "info",
    payload: { status: "RUNNING" },
    createdAt,
  };
}

function fixture(initial = [event(1n), event(2n, "run.succeeded")]) {
  const rows = [...initial];
  const signals = new Subject<void>();
  const pages: Array<{ after: bigint; take: number }> = [];
  const prisma = {
    workflowRun: {
      findFirst: async ({
        where,
      }: {
        where: { id: string; ownerId: string };
      }) =>
        where.id === runId && where.ownerId === ownerId
          ? {
              id: runId,
              status: rows.some(
                (row) =>
                  row.type.startsWith("run.") &&
                  [
                    "run.succeeded",
                    "run.failed",
                    "run.cancelled",
                    "run.interrupted",
                  ].includes(row.type),
              )
                ? "SUCCEEDED"
                : "RUNNING",
            }
          : null,
    },
    runEvent: {
      findMany: async ({
        where,
        take,
      }: {
        where: { runId: string; id: { gt: bigint } };
        take: number;
      }) => {
        pages.push({ after: where.id.gt, take });
        return rows
          .filter((row) => row.runId === where.runId && row.id > where.id.gt)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, take);
      },
    },
  };
  const hub = {
    notifications: () => signals.asObservable(),
    notify: () => signals.next(),
  };
  const service = new RunEventStreamService(prisma as never, hub as never);
  return { service, rows, pages, hub };
}

async function collect(
  stream: ReturnType<RunEventStreamService["stream"]>,
): Promise<Array<{ id?: string; type?: string; data?: unknown }>> {
  return new Promise((resolve, reject) => {
    const result: Array<{ id?: string; type?: string; data?: unknown }> = [];
    stream.subscribe({
      next: (value) => result.push(value),
      error: reject,
      complete: () => resolve(result),
    });
  });
}

describe("persisted run SSE stream", () => {
  it("replays ordered backlog, uses decimal IDs, and closes after terminal", async () => {
    const { service } = fixture();
    await service.assertOwned(ownerId, runId);
    const result = await collect(service.stream(ownerId, runId));
    expect(result.filter((item) => item.id).map((item) => item.id)).toEqual([
      "1",
      "2",
    ]);
    expect(result.at(-1)?.type).toBe("run.succeeded");
  });

  it("resumes strictly after Last-Event-ID and rejects foreign owners/invalid cursors", async () => {
    const { service } = fixture();
    expect(
      (await collect(service.stream(ownerId, runId, "1")))
        .filter((item) => item.id)
        .map((item) => item.id),
    ).toEqual(["2"]);
    await expect(
      service.assertOwned(randomUUID(), runId),
    ).rejects.toMatchObject({ status: 404 });
    expect(() =>
      service.stream(ownerId, runId, "9223372036854775808"),
    ).toThrow();
    expect(await collect(service.stream(ownerId, runId, "2"))).toEqual([]);
  });

  it("does not read events when a notification arrives before ownership is verified", async () => {
    const { service, pages, hub } = fixture();
    let rejectOwnership: (value: null) => void = () => {};
    (
      service as unknown as {
        prisma: { workflowRun: { findFirst: () => Promise<null> } };
      }
    ).prisma.workflowRun.findFirst = () =>
      new Promise<null>((resolve) => {
        rejectOwnership = resolve;
      });
    const pending = collect(service.stream(randomUUID(), runId));
    hub.notify();
    await Promise.resolve();
    expect(pages).toEqual([]);
    rejectOwnership(null);
    await expect(pending).rejects.toMatchObject({ status: 404 });
  });

  it("subscribes before backlog query and catches an event committed during that query", async () => {
    const { service, rows, hub } = fixture([event(1n)]);
    const firstQuery = (
      service as unknown as {
        prisma: {
          runEvent: { findMany: (...args: unknown[]) => Promise<unknown[]> };
        };
      }
    ).prisma.runEvent.findMany;
    let injected = false;
    (
      service as unknown as {
        prisma: {
          runEvent: { findMany: (...args: unknown[]) => Promise<unknown[]> };
        };
      }
    ).prisma.runEvent.findMany = async (...args) => {
      const page = await firstQuery(...args);
      if (!injected) {
        injected = true;
        rows.push(event(2n, "run.succeeded"));
        hub.notify();
      }
      return page;
    };
    expect(
      (await collect(service.stream(ownerId, runId)))
        .filter((item) => item.id)
        .map((item) => item.id),
    ).toEqual(["1", "2"]);
  });

  it("pages 100 at a time and deduplicates repeated notifications", async () => {
    const initial = Array.from({ length: 205 }, (_, index) =>
      event(BigInt(index + 1), index === 204 ? "run.failed" : "node.started"),
    );
    const { service, pages, hub } = fixture(initial);
    hub.notify();
    hub.notify();
    const result = await collect(service.stream(ownerId, runId));
    expect(result.filter((item) => item.id)).toHaveLength(205);
    expect(pages.map((page) => page.take)).toEqual([100, 100, 100]);
    expect(pages.map((page) => page.after)).toEqual([0n, 100n, 200n]);
  });

  it("delivers a committed notification after empty backlog without duplicating it", async () => {
    const { service, rows, pages, hub } = fixture([]);
    const pending = collect(service.stream(ownerId, runId));
    await vi.waitFor(() => expect(pages).toHaveLength(1));
    rows.push(event(1n, "run.succeeded"));
    hub.notify();
    hub.notify();
    expect(
      (await pending).filter((item) => item.id).map((item) => item.id),
    ).toEqual(["1"]);
  });

  it("sends a heartbeat without advancing the database cursor", async () => {
    vi.useFakeTimers();
    try {
      const { service, pages } = fixture([]);
      const received: Array<{ type?: string; id?: string }> = [];
      const subscription = service
        .stream(ownerId, runId)
        .subscribe((value) => received.push(value));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(received).toContainEqual(
        expect.objectContaining({ type: "heartbeat" }),
      );
      expect(
        received.find((item) => item.type === "heartbeat")?.id,
      ).toBeUndefined();
      expect(pages[0]?.after).toBe(0n);
      subscription.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });
});
