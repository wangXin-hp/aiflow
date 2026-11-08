# Infrastructure and Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local PostgreSQL/Qdrant foundation and a complete email-registration, verification, cookie-login, current-user and logout flow with a functional React UI.

**Architecture:** Docker Compose owns only PostgreSQL and Qdrant. NestJS uses Prisma 7 through `@prisma/adapter-pg`; authentication is an isolated module with injectable password, token, mail and repository boundaries. The Vite SPA uses same-origin `/api` requests through its development proxy and protects routes by querying `/api/auth/me`.

**Tech Stack:** Node.js 24, TypeScript 5.9, NestJS 11.2.8, Prisma 7.10.1, PostgreSQL 17.11, Qdrant 1.20.0, bcryptjs 3.0.3, Nest JWT 11.0.2, Nodemailer 7.0.13, React 19, React Router 7, React Hook Form 7, Tailwind CSS 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-08-backend-application-design.md`

## Global Constraints

- Keep `packages/workflow-engine` independent from NestJS, Prisma and HTTP.
- Use Prisma 7.10.1 stable with the `prisma-client` generator, explicit generated output and `@prisma/adapter-pg`; do not install Prisma 8 RC.
- Pin Docker images to `postgres:17.11-alpine3.24` and `qdrant/qdrant:v1.20.0`; do not use `latest`.
- Store secrets only in an ignored `.env`; commit only `.env.example` placeholders.
- Add concise Chinese comments to public interfaces, core flows and non-obvious security decisions as required by `AGENTS.md`.
- Implement reference-project authentication functionality independently; do not copy its source, brand text, hard-coded credentials or assets.
- The login page needs functional responsive styling, not pixel parity with the reference project.

## Review Focus

- Email case and surrounding whitespace must not create duplicate users; Task 3 tests normalization and the database unique constraint.
- Registration must remain recoverable after SMTP failure; Task 4 tests resend for an existing unverified account without revealing account existence.
- Verification tokens must be single-use, hashed at rest and expire after 24 hours; Task 3 tests all three properties.
- Cookie authentication must reject missing, invalid, expired and deleted-user sessions; Task 5 tests guard behavior and Cookie flags.
- Redirect handling must allow `/workflows/123` but reject `//evil.example` and absolute URLs; Task 6 tests redirect sanitization.

---

### Task 1: Local infrastructure and validated configuration

**Files:**

- Create: `compose.yaml`
- Create: `.env.example`
- Create: `apps/api/src/config/environment.ts`
- Create: `apps/api/src/config/environment.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/package.json`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**

- Produces: `EnvironmentSchema`, `Environment`, `loadEnvironment(source: NodeJS.ProcessEnv): Environment`.
- Produces: root scripts `infra:up`, `infra:down`, `infra:logs`, `db:generate`, `db:migrate`, `db:deploy`.

- [ ] **Step 1: Add dependencies and scripts without application behavior**

Install Nest-compatible `@nestjs/config@4.0.4`, `zod@4.6.7` and the planned infrastructure scripts. This is dependency/configuration setup; do not add runtime configuration code yet.

- [ ] **Step 2: Write failing environment tests**

Add tests named `loads valid development configuration`, `rejects a short JWT secret`, `requires SMTP settings in smtp mode`, and `allows console mail only outside production`. Assert the exact default host URLs, 32-character minimum JWT secret and production restriction.

- [ ] **Step 3: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/config/environment.test.ts`

Expected: FAIL because `loadEnvironment` does not exist.

- [ ] **Step 4: Implement configuration and Compose**

Implement `loadEnvironment` with strict Zod validation; wire it through global `ConfigModule`. Add PostgreSQL and Qdrant services, loopback port bindings, health checks, named volumes and `docker compose up -d --wait` in `infra:up`. Add `.env.example` values for database, Qdrant, JWT, mail, public web URL and execution limits.

- [ ] **Step 5: Verify infrastructure and tests**

Run: `docker compose config --quiet`

If `.env` is absent, copy `.env.example` to `.env` and replace the JWT placeholder before starting services; never overwrite an existing `.env`.

Run: `pnpm --filter @aiflow/api test -- src/config/environment.test.ts`

Expected: Compose exits 0 and all environment tests PASS.

- [ ] **Step 6: Commit**

```bash
git add compose.yaml .env.example apps/api package.json README.md pnpm-lock.yaml
git commit -m "feat(repo): add local data infrastructure"
```

### Task 2: Prisma client and User persistence

**Files:**

- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_init_auth/migration.sql`
- Create: `apps/api/prisma.config.ts`
- Create: `apps/api/src/database/prisma.service.ts`
- Create: `apps/api/src/database/prisma.module.ts`
- Create: `apps/api/src/database/prisma.service.test.ts`
- Modify: `apps/api/package.json`
- Modify: `.gitignore`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Produces: global `PrismaModule` and `PrismaService extends PrismaClient` with Nest lifecycle hooks.
- Produces: `User` model with UUID ID, normalized unique email, password hash, profile fields, verification hash/expiry and timestamps.

- [ ] **Step 1: Install pinned Prisma dependencies**

Install `prisma@7.10.1` as a dev dependency and `@prisma/client@7.10.1`, `@prisma/adapter-pg@7.10.1`, `pg@8.23.1` and `@types/pg@8.23.1`. Add generate/migrate scripts and ignore `apps/api/src/generated/prisma/`.

- [ ] **Step 2: Write the failing lifecycle test**

Test `PrismaService connects on module init and closes on shutdown` using an injected adapter/client seam so the unit test does not require Docker. Assert exactly one connect and disconnect call.

- [ ] **Step 3: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/database/prisma.service.test.ts`

Expected: FAIL because `PrismaService` does not exist.

- [ ] **Step 4: Add schema, config, migration and service**

Use the Prisma 7 `prisma-client` generator with output `../src/generated/prisma`; configure the CLI URL in `prisma.config.ts`; instantiate runtime `PrismaClient` with `PrismaPg`. Add pool connection and idle timeouts from validated config. Add Chinese comments explaining generated client and lifecycle ownership.

- [ ] **Step 5: Start the database and verify migration**

Run: `pnpm infra:up`

Run: `pnpm db:generate`

Run: `pnpm db:migrate -- --name init_auth`

Run: `pnpm --filter @aiflow/api test -- src/database/prisma.service.test.ts`

Expected: PostgreSQL and Qdrant report healthy, migration applies, client generation exits 0 and test PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma apps/api/prisma.config.ts apps/api/src/database apps/api/package.json .gitignore .github pnpm-lock.yaml
git commit -m "feat(api): add prisma user persistence"
```

### Task 3: Authentication contracts and domain services

**Files:**

- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/auth.test.ts`
- Create: `apps/api/src/auth/auth.types.ts`
- Create: `apps/api/src/auth/password.service.ts`
- Create: `apps/api/src/auth/verification-token.service.ts`
- Create: `apps/api/src/auth/session-token.service.ts`
- Create: `apps/api/src/auth/auth.service.ts`
- Create: `apps/api/src/auth/auth.service.test.ts`
- Create: `apps/api/src/auth/prisma-auth-user.repository.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/package.json`

**Interfaces:**

- Produces: strict `RegisterRequestSchema`, `LoginRequestSchema`, `ResendVerificationRequestSchema`, `VerifyEmailQuerySchema`, `PublicUserSchema`.
- Produces: `AuthService.register`, `verifyEmail`, `resendVerification`, `login`, `getCurrentUser`.
- Produces: injectable `AuthUserRepository`, `PasswordHasher`, `VerificationTokenManager`, `SessionTokenManager` interfaces.

- [ ] **Step 1: Write failing contract tests**

Add `vitest@3.2.7` and a `test` script to `@aiflow/contracts`; install `bcryptjs@3.0.3` and `@nestjs/jwt@11.0.2` in the API. Test normalized email input, optional trimmed name, minimum eight-character registration password, non-empty login password, and rejection of unknown fields.

- [ ] **Step 2: Verify contract RED**

Run: `pnpm --filter @aiflow/contracts test -- src/auth.test.ts`

Expected: FAIL because auth schemas are missing.

- [ ] **Step 3: Implement strict shared contracts**

Export request/response types inferred from schemas. Keep password fields request-only and public user output limited to ID, email, name, avatar URL, verification time and creation time.

- [ ] **Step 4: Write failing domain tests**

Add focused tests for: normalized registration; duplicate email; bcrypt hash not equaling the password; login unknown-user and wrong-password sharing one error; unverified login; verified login returning a session token; verification hash stored instead of raw token; expired token; token single use; resend returning the same public result for present and absent email.

- [ ] **Step 5: Verify domain RED**

Run: `pnpm --filter @aiflow/api test -- src/auth/auth.service.test.ts`

Expected: FAIL because auth services are missing.

- [ ] **Step 6: Implement minimal auth domain and Prisma repository**

Use bcrypt cost 12, `crypto.randomBytes(32)` for verification tokens, SHA-256 for token storage, 24-hour expiry and 7-day JWT expiry. Map Prisma uniqueness errors to stable domain errors without exposing Prisma messages.

- [ ] **Step 7: Verify GREEN**

Run: `pnpm --filter @aiflow/contracts test -- src/auth.test.ts`

Run: `pnpm --filter @aiflow/api test -- src/auth/auth.service.test.ts`

Expected: all new contract and domain tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts apps/api/src/auth
git commit -m "feat(api): implement authentication domain"
```

### Task 4: Mail delivery and recoverable verification

**Files:**

- Create: `apps/api/src/mail/mail.types.ts`
- Create: `apps/api/src/mail/mail.service.ts`
- Create: `apps/api/src/mail/mail.module.ts`
- Create: `apps/api/src/mail/verification-email.ts`
- Create: `apps/api/src/mail/mail.service.test.ts`
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.service.test.ts`

**Interfaces:**

- Produces: `MailService.sendVerificationEmail(input: { to: string; token: string }): Promise<void>`.
- Consumes: validated `AUTH_EMAIL_MODE`, SMTP settings and `WEB_PUBLIC_URL`.

- [ ] **Step 1: Install mail dependency and write failing tests**

Install `nodemailer@7.0.13` and compatible types. Test SMTP mode uses configured sender and an encoded verification URL; console mode never creates a transporter; SMTP errors leave the user eligible for resend; production rejects console mode through Task 1 configuration.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/mail/mail.service.test.ts src/auth/auth.service.test.ts`

Expected: FAIL because `MailService` and resend integration are missing.

- [ ] **Step 3: Implement mail adapter and verification HTML**

Create a small independent HTML template using AIFlow branding. Never log SMTP credentials or the full token outside explicit development console mode. Send registration mail after user persistence; keep the unverified record if delivery fails.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm --filter @aiflow/api test -- src/mail/mail.service.test.ts src/auth/auth.service.test.ts`

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/mail apps/api/src/auth apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): add email verification delivery"
```

### Task 5: Nest authentication HTTP boundary

**Files:**

- Create: `apps/api/src/common/api-error.ts`
- Create: `apps/api/src/common/api-exception.filter.ts`
- Create: `apps/api/src/common/zod-validation.pipe.ts`
- Create: `apps/api/src/auth/auth.controller.ts`
- Create: `apps/api/src/auth/auth.guard.ts`
- Create: `apps/api/src/auth/current-user.decorator.ts`
- Create: `apps/api/src/auth/public.decorator.ts`
- Create: `apps/api/src/auth/auth.module.ts`
- Create: `apps/api/src/auth/auth.e2e.test.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `apps/api/package.json`

**Interfaces:**

- Produces: `/api/auth/register`, `/verify`, `/verification/resend`, `/login`, `/me`, `/logout`.
- Produces: global default-deny `AuthGuard`, opt-out `@Public()` and `@CurrentUser()`.
- Produces: stable success envelopes and `{ code, message, details? }` errors.

- [ ] **Step 1: Install HTTP security/testing dependencies and write failing E2E tests**

Install `@nestjs/throttler@6.7.1`, `cookie-parser@1.4.7`, Nest testing 11.2.8 and Supertest 7.3.2. Test the full register-verify-login-me-logout sequence, HttpOnly/SameSite/Path/Max-Age Cookie attributes, unverified rejection, invalid JWT, deleted user, public health route, protected route 401 and stable error shape.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @aiflow/api test -- src/auth/auth.e2e.test.ts`

Expected: FAIL because routes and guard are missing.

- [ ] **Step 3: Implement HTTP boundary**

Add the global guard and exception filter; parse cookies; configure trusted CORS origin with credentials; check Origin for state-changing Cookie-authenticated requests; rate-limit login and resend. Login writes `aiflow_session`; logout clears it with matching attributes.

- [ ] **Step 4: Verify GREEN and database integration**

Run: `pnpm --filter @aiflow/api test -- src/auth/auth.e2e.test.ts`

Expected: all authentication E2E tests PASS against the test database.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): expose secure authentication api"
```

### Task 6: Functional React authentication UI

**Files:**

- Create: `apps/web/src/auth/auth-api.ts`
- Create: `apps/web/src/auth/auth-context.tsx`
- Create: `apps/web/src/auth/protected-route.tsx`
- Create: `apps/web/src/auth/redirect.ts`
- Create: `apps/web/src/auth/redirect.test.ts`
- Create: `apps/web/src/pages/login-page.tsx`
- Create: `apps/web/src/pages/login-page.test.tsx`
- Create: `apps/web/src/pages/verify-email-page.tsx`
- Create: `apps/web/src/pages/app-home-page.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/style.css`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/package.json`

**Interfaces:**

- Produces: `AuthProvider`, `useAuth`, `ProtectedRoute`, `sanitizeRedirect(value: string | null): string`.
- Consumes: shared auth schemas and same-origin Nest endpoints.

- [ ] **Step 1: Install UI dependencies and write failing routing tests**

Install React Router 7.18.5, React Hook Form 7.91.0, resolvers 7.0.3, Sonner 2.0.8, Tailwind CSS 4.3.5, Vitest 3.2.7, jsdom and Testing Library; add a `test` script to `@aiflow/web`. Test safe relative redirects, rejected protocol-relative/external redirects, protected-route login navigation and verified-session rendering.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @aiflow/web test -- src/auth/redirect.test.ts src/pages/login-page.test.tsx`

Expected: FAIL because routing and pages are missing.

- [ ] **Step 3: Implement authentication state and pages**

Create a simple responsive AIFlow-branded card layout. Support login/register mode switching, field messages, loading state, EMAIL_NOT_VERIFIED feedback, verification loading/success/error states, current-user display and logout. Configure Vite `/api` proxy to the Nest development server.

- [ ] **Step 4: Verify GREEN and browser behavior**

Run: `pnpm --filter @aiflow/web test`

Run: `pnpm --filter @aiflow/web build`

Expected: UI tests PASS and production build exits 0 without warnings.

- [ ] **Step 5: Run full phase verification**

Run: `pnpm format:check`

Run: `pnpm lint`

Run: `pnpm lint:style`

Run: `pnpm spellcheck`

Run: `pnpm typecheck`

Run: `pnpm test`

Run: `pnpm build`

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/web packages/contracts README.md pnpm-lock.yaml
git commit -m "feat(web): add authentication experience"
```
