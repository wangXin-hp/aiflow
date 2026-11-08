# Workflow Foundation Implementation Plan

**Goal:** Deliver a versioned workflow contract and an independent, tested start-to-end execution engine.

**Architecture:** `@aiflow/contracts` owns runtime schemas and inferred types; `@aiflow/workflow-engine` consumes them and owns graph validation and synchronous execution. Neither package depends on applications or infrastructure.

**Tech Stack:** TypeScript, Zod, Vitest, pnpm, Turbo.

**Spec:** `docs/superpowers/specs/2026-11-08-aiflow-design.md`. This plan implements only the start/end subset; persistence, APIs, canvas, conditions and models are future work.

## Contract and checks

- V1 describes a graph with start/end nodes, positions, explicit source/target ports, and JSON-compatible inputs. Unknown schema versions, node types, fields and invalid JSON values are rejected.
- A runnable graph has unique node and edge IDs, exactly one start and end, existing endpoints, valid directions, no duplicate connections, no cycles and every node on a start-to-end path.
- Execution validates untrusted definition and inputs before executing. The start and end each record their input/output; the end returns the provided JSON input. Invalid inputs or graphs fail without executing nodes.

## Tasks

- [x] Define and test the public V1 contract and rejected malformed payloads.
- [x] Implement and test graph validation, including duplicates, dangling edges, cycles and unreachable nodes.
- [x] Implement and test execution, input validation, immutable data boundaries and errors.
- [x] Document the API and verify the workspace checks, exports and consumer behavior.
