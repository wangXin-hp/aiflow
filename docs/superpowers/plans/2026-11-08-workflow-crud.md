# Workflow Persistence and CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist user-owned workflow drafts and expose validated, paginated, revision-safe CRUD APIs.

**Architecture:** Shared Zod contracts define the HTTP boundary. A Nest workflow service owns graph validation and optimistic concurrency; a Prisma repository owns conditional database mutations. Every lookup includes the authenticated owner ID and returns 404 for another user's resource.

**Tech Stack:** TypeScript 5.9, NestJS 11, Prisma 7.10.1, PostgreSQL 17.11, Zod 4, Vitest, Supertest.

**Spec:** `docs/superpowers/specs/2026-11-08-backend-application-design.md`

## Global Constraints

- Complete `2026-11-08-infrastructure-auth.md` first; use its `User`, `AuthGuard`, `CurrentUser`, Prisma and error contracts.
- Store a `workflowV2Schema`-validated JSON definition and revalidate it on every create, update and run boundary.
- Use soft archive, not hard delete; historical runs and versions must remain queryable.
- Use `revision` optimistic locking and return 409 for stale writes.
- Never reveal whether a workflow belongs to another user; return the same 404 as an unknown ID.
- Add concise Chinese comments to public interfaces and concurrency decisions.

## Review Focus

- A stale revision must not partially update name, description or definition; Task 3 integration tests assert atomic conditional update.
- An archived workflow must disappear from normal lists and reject new mutations while its detail remains internally available for history; Task 3 tests this boundary.
- Invalid graphs must return stable validation details without persisting any row; Task 2 tests count before and after.
- Pagination must be deterministic for identical timestamps; Task 2 tests `createdAt DESC, id DESC` ordering.
- Two users using the same workflow ID must not infer ownership through different status codes or timings in controller behavior; Task 4 E2E tests consistent 404 responses.

---

### Task 1: Workflow, version and knowledge metadata schema

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_workflows/migration.sql`
- Create: `apps/api/src/workflows/workflow.mapper.ts`
- Create: `apps/api/src/workflows/workflow.mapper.test.ts`

**Interfaces:**

- Produces: Prisma `Workflow`, `WorkflowVersion`, `KnowledgeBase`, `KnowledgeDocument` models and supporting enums/indexes.
- Produces: `toWorkflowResponse(record): WorkflowResponse` that parses stored JSON before returning it.

- [ ] **Step 1: Write failing mapper tests**

Test conversion of a valid persisted definition, ISO timestamps and failure on corrupt stored JSON. Test that response omits internal relation fields.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/workflows/workflow.mapper.test.ts`

Expected: FAIL because mapper and generated models are absent.

- [ ] **Step 3: Add models and migration**

Add UUID IDs, owner foreign keys with indexes, JSON definition/snapshots, revision default 1, archived timestamp and unique `(workflowId, version)`. Add knowledge metadata with owner boundaries and document indexing status; do not add vector columns.

- [ ] **Step 4: Generate and verify**

Run: `pnpm db:generate`

Run: `pnpm db:migrate -- --name add_workflows`

Run: `pnpm --filter @aiflow/api test -- src/workflows/workflow.mapper.test.ts`

Expected: migration applies and mapper tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma apps/api/src/workflows
git commit -m "feat(api): add workflow persistence models"
```

### Task 2: Workflow API contracts and service

**Files:**

- Create: `packages/contracts/src/workflow-api.ts`
- Create: `packages/contracts/src/workflow-api.test.ts`
- Create: `apps/api/src/workflows/workflow.repository.ts`
- Create: `apps/api/src/workflows/prisma-workflow.repository.ts`
- Create: `apps/api/src/workflows/workflow.service.ts`
- Create: `apps/api/src/workflows/workflow.service.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Produces: `CreateWorkflowRequestSchema`, `UpdateWorkflowRequestSchema`, `WorkflowListQuerySchema`, `WorkflowResponseSchema`, `WorkflowListResponseSchema`.
- Produces: `WorkflowService.create`, `list`, `get`, `update`, `archive` with explicit current-user ID arguments.

- [ ] **Step 1: Write failing contract tests**

Test strict payloads, 1-100 character name, 2000-character description maximum, limit range 1-100, cursor shape, required positive revision and a full valid Workflow V2 definition.

- [ ] **Step 2: Verify contract RED**

Run: `pnpm --filter @aiflow/contracts test -- src/workflow-api.test.ts`

Expected: FAIL because API contracts are absent.

- [ ] **Step 3: Implement contracts**

Use cursor pagination encoded from `(createdAt,id)` and stable API response types. Keep database enum/field names out of the public contract.

- [ ] **Step 4: Write failing service tests**

Test valid creation, invalid graph rejection with no repository create, deterministic pagination, owner-scoped detail, successful revision increment, stale revision conflict, idempotent archive and archived mutation rejection.

- [ ] **Step 5: Verify service RED**

Run: `pnpm --filter @aiflow/api test -- src/workflows/workflow.service.test.ts`

Expected: FAIL because service/repository are missing.

- [ ] **Step 6: Implement service and repository**

Call `workflowV2Schema.parse` and exported `validateWorkflowV2` before persistence. Implement update as a single `updateMany` constrained by ID, owner, revision and `archivedAt: null`; distinguish 404 from 409 with an owner-scoped follow-up lookup.

- [ ] **Step 7: Verify GREEN**

Run: `pnpm --filter @aiflow/contracts test -- src/workflow-api.test.ts`

Run: `pnpm --filter @aiflow/api test -- src/workflows/workflow.service.test.ts`

Expected: all contract and service tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts apps/api/src/workflows
git commit -m "feat(api): implement workflow crud service"
```

### Task 3: PostgreSQL workflow integration

**Files:**

- Create: `apps/api/src/workflows/workflow.integration.test.ts`
- Create: `apps/api/src/test/database-test-context.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: real `PrismaWorkflowRepository` and migrated test PostgreSQL.
- Produces: reusable database cleanup/test-user helpers for later run tests.

- [ ] **Step 1: Write failing integration tests**

Using two database users, test owner isolation, atomic stale-revision failure, deterministic cursor pagination, soft archive, preserved version relation and transaction rollback for an invalid create path.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/workflows/workflow.integration.test.ts`

Expected: at least one assertion FAIL against the not-yet-integrated repository behavior.

- [ ] **Step 3: Complete Prisma repository behavior**

Make only the minimal query/index/transaction changes required by the failing integration tests. Add a PostgreSQL 17.11 service and test `DATABASE_URL` to CI so integration behavior is verified remotely. Do not add publishing endpoints.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @aiflow/api test -- src/workflows/workflow.integration.test.ts`

Expected: all PostgreSQL integration tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workflows apps/api/src/test apps/api/prisma
git commit -m "test(api): verify workflow database behavior"
```

### Task 4: Protected workflow controllers

**Files:**

- Create: `apps/api/src/workflows/workflow.controller.ts`
- Create: `apps/api/src/workflows/workflow.module.ts`
- Create: `apps/api/src/workflows/workflow.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**

- Produces: `POST/GET /api/workflows`, `GET/PATCH/DELETE /api/workflows/:id`.
- Consumes: `@CurrentUser()` and shared Zod validation/error envelope.

- [ ] **Step 1: Write failing E2E tests**

Test unauthenticated 401, create 201, list/detail 200, invalid graph 400 with details, stale update 409, archive 204/idempotency, archived 404 and cross-user read/update/delete all returning the same 404 shape.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/workflows/workflow.e2e.test.ts`

Expected: FAIL because controller routes are missing.

- [ ] **Step 3: Implement controller/module**

Keep controllers thin: parse input, read current user, call service and map status codes. Do not expose Prisma records directly.

- [ ] **Step 4: Verify phase**

Run: `pnpm --filter @aiflow/api test -- src/workflows`

Run: `pnpm typecheck && pnpm test && pnpm build`

Expected: workflow tests and full repository checks PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src packages/contracts
git commit -m "feat(api): expose protected workflow crud"
```
