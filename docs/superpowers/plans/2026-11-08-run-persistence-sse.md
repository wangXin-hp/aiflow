# Run Persistence and SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a fixed workflow snapshot in-process while durably persisting run/node state and streaming replayable safe events over SSE.

**Architecture:** A run application service transactionally creates the run, node rows and queued event, then hands the ID to an in-process coordinator. An event writer persists every event before publishing a process-local notification; SSE notifications only trigger cursor reads from PostgreSQL, so the database remains the source of truth. Conditional terminal writes resolve cancellation/completion races.

**Tech Stack:** NestJS 11, Prisma 7.10.1, PostgreSQL 17.11, RxJS 7, existing `@aiflow/workflow-engine`, Zod 4, Vitest, Supertest.

**Spec:** `docs/superpowers/specs/2026-11-08-backend-application-design.md`

## Global Constraints

- Complete infrastructure/auth and workflow CRUD plans first.
- Execute the stored `definitionSnapshot`; never reread a mutable workflow after run creation.
- Persist an event before notifying SSE subscribers; no business payload may exist only in memory.
- Run only one NestJS API instance in this phase; startup recovery marks inherited active work interrupted.
- Do not log prompts, authorization values, cookies, API keys or full node outputs in `RunEvent.payload`.
- Cancellation is cooperative and cannot promise reversal of external side effects.
- Add concise Chinese comments around state transitions, event cursor semantics and race handling.

## Review Focus

- Cancellation and natural completion racing must result in exactly one terminal state/event; Task 4 tests both orderings.
- A crash after run creation but before execution must become `INTERRUPTED` on startup; Task 4 tests queued and running recovery.
- SSE connection setup must not miss an event committed between subscription and backlog query; Task 5 injects that exact race.
- Large or sensitive engine log fields must be omitted/truncated before database insert; Task 2 tests recursive redaction and byte limits.
- Slow or stale clients must page event history rather than load it unbounded; Task 5 tests batch boundaries and cursor continuation.

---

### Task 1: Run persistence schema and API contracts

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_runs/migration.sql`
- Create: `packages/contracts/src/run-api.ts`
- Create: `packages/contracts/src/run-api.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Produces: Prisma `WorkflowRun`, `NodeRun`, `RunEvent` models and run/node status enums.
- Produces: `CreateRunRequestSchema`, `RunResponseSchema`, `RunEventSchema`, `RunEventCursorSchema`.

- [ ] **Step 1: Write failing contract tests**

Test strict run input object, all public statuses, string BigInt event IDs, ISO dates, optional node ID and safe payload shape. Reject numeric event IDs to avoid JSON precision loss.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @aiflow/contracts test -- src/run-api.test.ts`

Expected: FAIL because run contracts are absent.

- [ ] **Step 3: Add schema, migration and contracts**

Add owner/workflow/version relations, immutable JSON snapshot/input, optional output/error, run timestamps, unique `(runId,nodeId)`, BigInt autoincrement event ID and `(runId,id)` index. Add conditional-status-friendly indexes.

- [ ] **Step 4: Generate, migrate and verify**

Run: `pnpm db:generate`

Run: `pnpm db:migrate -- --name add_runs`

Run: `pnpm --filter @aiflow/contracts test -- src/run-api.test.ts`

Expected: migration applies and contract tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma packages/contracts
git commit -m "feat(api): add run persistence schema"
```

### Task 2: Safe event writer and notification hub

**Files:**

- Create: `apps/api/src/runs/run-event-sanitizer.ts`
- Create: `apps/api/src/runs/run-event-sanitizer.test.ts`
- Create: `apps/api/src/runs/run-event-hub.ts`
- Create: `apps/api/src/runs/run-event-writer.ts`
- Create: `apps/api/src/runs/run-event-writer.test.ts`

**Interfaces:**

- Produces: `sanitizeRunEventPayload(value: unknown, maxBytes: number): JsonValue`.
- Produces: `RunEventWriter.append(input): Promise<PersistedRunEvent>`; resolves only after commit, then calls `RunEventHub.notify(runId)`.
- Produces: `RunEventHub.notifications(runId): Observable<void>`.

- [ ] **Step 1: Write failing sanitizer tests**

Test recursive redaction for case-insensitive `authorization`, `cookie`, `password`, `token`, `apiKey` keys; depth/array limits; circular or unsupported values; UTF-8 byte truncation without invalid JSON.

- [ ] **Step 2: Verify sanitizer RED**

Run: `pnpm --filter @aiflow/api test -- src/runs/run-event-sanitizer.test.ts`

Expected: FAIL because sanitizer is absent.

- [ ] **Step 3: Implement sanitizer**

Return a JSON-safe structure and a truncation marker rather than slicing serialized JSON. Preserve state, timing and error-code fields used by the UI.

- [ ] **Step 4: Write failing writer tests**

Test `notify` happens after repository insert resolves, insert failure never notifies, IDs serialize as strings and payload always passes through sanitizer.

- [ ] **Step 5: Verify writer RED**

Run: `pnpm --filter @aiflow/api test -- src/runs/run-event-writer.test.ts`

Expected: FAIL because writer/hub are absent.

- [ ] **Step 6: Implement writer and hub, then verify GREEN**

Run: `pnpm --filter @aiflow/api test -- src/runs/run-event-sanitizer.test.ts src/runs/run-event-writer.test.ts`

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/runs
git commit -m "feat(api): persist safe run events"
```

### Task 3: Transactional run creation and details

**Files:**

- Create: `apps/api/src/runs/run.repository.ts`
- Create: `apps/api/src/runs/prisma-run.repository.ts`
- Create: `apps/api/src/runs/run.service.ts`
- Create: `apps/api/src/runs/run.service.test.ts`
- Create: `apps/api/src/runs/run.mapper.ts`

**Interfaces:**

- Produces: `RunService.createDebugRun(ownerId, workflowId, input): Promise<RunResponse>`.
- Produces: `RunService.get(ownerId, runId): Promise<RunResponse>` and paginated owner-scoped list.
- Produces: one repository transaction that creates queued run, pending node rows and queued event.

- [ ] **Step 1: Write failing service tests**

Test owner-scoped active workflow lookup, input validation, exact definition snapshot, one pending row per graph node, queued event in the same transaction, 202-ready response and snapshot stability after workflow update.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/runs/run.service.test.ts`

Expected: FAIL because run service is absent.

- [ ] **Step 3: Implement transaction and mapping**

Validate start inputs using the snapshot before opening the transaction. Convert Prisma BigInt IDs to decimal strings at the mapper boundary. Notify the coordinator only after transaction commit.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @aiflow/api test -- src/runs/run.service.test.ts`

Expected: all service tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runs
git commit -m "feat(api): create persistent workflow runs"
```

### Task 4: In-process coordinator, engine bridge and cancellation

**Files:**

- Create: `apps/api/src/runs/run-state-machine.ts`
- Create: `apps/api/src/runs/run-state-machine.test.ts`
- Create: `apps/api/src/runs/run-coordinator.ts`
- Create: `apps/api/src/runs/run-coordinator.test.ts`
- Create: `apps/api/src/runs/run-adapters.factory.ts`
- Create: `apps/api/src/runs/run-recovery.service.ts`
- Create: `apps/api/src/runs/run-recovery.service.test.ts`

**Interfaces:**

- Produces: `RunCoordinator.enqueue(runId): void`, `cancel(ownerId, runId): Promise<RunStatus>`, `execute(runId): Promise<void>`.
- Produces: explicit allowed run/node transition functions.
- Consumes: `runWorkflowV2`, Ark/HTTP/Qdrant adapters, validated config and `AbortSignal`.

- [ ] **Step 1: Write failing transition tests**

Test every allowed forward transition and reject status regression, duplicate terminal changes and invalid `SUCCEEDED -> CANCELLED` transitions.

- [ ] **Step 2: Verify transition RED**

Run: `pnpm --filter @aiflow/api test -- src/runs/run-state-machine.test.ts`

Expected: FAIL because transition functions are absent.

- [ ] **Step 3: Implement state machine**

Keep transition decisions pure; repository conditional updates enforce the same source-state sets.

- [ ] **Step 4: Write failing coordinator/recovery tests**

Test engine event mapping, replacement of the engine-generated run ID with the persisted database run ID, node status persistence, waiting for the asynchronous persistence chain before the terminal update, final output, engine failure, total-run timeout, cooperative cancellation, cancel-vs-success in both orders, ignored late callbacks, Ark/Qdrant adapter configuration and startup interruption of queued/running/cancelling rows.

- [ ] **Step 5: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/runs/run-coordinator.test.ts src/runs/run-recovery.service.test.ts`

Expected: FAIL because coordinator and recovery are absent.

- [ ] **Step 6: Implement coordinator and recovery**

Serialize writes per run with a promise chain; `runWorkflowV2` does not await its log callback, so wait for that chain before writing the run terminal state. Ignore the engine's internal run ID at the application boundary and persist the database run ID. Store active AbortControllers by run ID, add the configured total-run timer and remove both in `finally`. Use conditional terminal updates so exactly one result wins. Startup recovery writes one interrupted event and cancels non-terminal nodes.

- [ ] **Step 7: Verify GREEN**

Run: `pnpm --filter @aiflow/api test -- src/runs/run-state-machine.test.ts src/runs/run-coordinator.test.ts src/runs/run-recovery.service.test.ts`

Expected: all coordinator tests PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/runs apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): coordinate persistent workflow execution"
```

### Task 5: Replayable SSE event stream

**Files:**

- Create: `apps/api/src/runs/run-event-stream.service.ts`
- Create: `apps/api/src/runs/run-event-stream.service.test.ts`
- Create: `apps/api/src/runs/run.controller.ts`
- Create: `apps/api/src/runs/run.module.ts`
- Create: `apps/api/src/runs/run.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**

- Produces: authenticated `POST /api/workflows/:id/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`, `GET /api/runs/:id/events`.
- Produces: `RunEventStreamService.stream(ownerId, runId, afterId?): Observable<MessageEvent>`.

- [ ] **Step 1: Write failing stream tests**

Test initial backlog, Last-Event-ID replay, notification committed during initial query, duplicate notification de-duplication, 100-event page boundaries, heartbeat, invalid cursor, cross-user 404 and completion after the terminal event.

- [ ] **Step 2: Verify stream RED**

Run: `pnpm --filter @aiflow/api test -- src/runs/run-event-stream.service.test.ts`

Expected: FAIL because stream service is absent.

- [ ] **Step 3: Implement cursor stream**

Subscribe to hub notifications before the first query. Use `startWith` plus serialized database reads after the mutable cursor; flatten each ordered batch and query again when a full batch is returned. Merge heartbeat messages without advancing the database cursor.

- [ ] **Step 4: Write failing endpoint E2E tests**

Test 202 run creation, persisted detail, cancel idempotency, SSE headers/IDs/replay, user ownership and stable errors. Use deterministic engine adapters; do not call real Ark or Qdrant.

- [ ] **Step 5: Verify endpoint RED**

Run: `pnpm --filter @aiflow/api test -- src/runs/run.e2e.test.ts`

Expected: FAIL because run routes are not wired.

- [ ] **Step 6: Implement controller/module and verify GREEN**

Run: `pnpm --filter @aiflow/api test -- src/runs`

Expected: all run and SSE tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/runs apps/api/src/app.module.ts
git commit -m "feat(api): stream replayable run events"
```

### Task 6: End-to-end persistence verification and documentation

**Files:**

- Create: `apps/api/src/runs/run.integration.test.ts`
- Modify: `README.md`
- Modify: `docs/workflow-engine-guide.md`
- Create: `docs/backend-development.md`

**Interfaces:**

- Verifies: real PostgreSQL persistence from authenticated workflow creation through terminal run and SSE replay.

- [ ] **Step 1: Write failing integration scenario**

Create a verified test user, authenticate, create a workflow, start a deterministic run, wait for terminal state, reconnect SSE from an earlier ID and assert identical ordered persisted events. Modify the draft after start and assert the run kept the original snapshot.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/runs/run.integration.test.ts`

Expected: FAIL until all persistence wiring is complete.

- [ ] **Step 3: Complete minimal integration wiring**

Fix only boundary issues found by the scenario. Document local startup, migrations, authentication, sample curl requests, SSE replay, Docker volumes, real cloud smoke-test cost warning and single-instance limitations.

- [ ] **Step 4: Run full verification**

Run: `pnpm format:check`

Run: `pnpm lint`

Run: `pnpm lint:style`

Run: `pnpm spellcheck`

Run: `pnpm exec turbo typecheck --force`

Run: `pnpm exec turbo test --force`

Run: `pnpm exec turbo build --force`

Expected: every command exits 0 with no failed tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/runs README.md docs
git commit -m "docs(api): document persistent run workflow"
```
