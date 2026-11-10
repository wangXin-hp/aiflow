import { describe, expect, it } from "vitest";
import { canTransitionNode, canTransitionRun } from "./run-state-machine.js";

describe("run state transitions", () => {
  it("allows only forward run transitions", () => {
    expect(canTransitionRun("QUEUED", "RUNNING")).toBe(true);
    expect(canTransitionRun("QUEUED", "CANCELLING")).toBe(true);
    expect(canTransitionRun("QUEUED", "CANCELLED")).toBe(true);
    expect(canTransitionRun("RUNNING", "CANCELLING")).toBe(true);
    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"] as const) {
      expect(canTransitionRun("RUNNING", status)).toBe(true);
    }
    expect(canTransitionRun("CANCELLING", "CANCELLED")).toBe(true);
    expect(canTransitionRun("QUEUED", "INTERRUPTED")).toBe(true);
    expect(canTransitionRun("RUNNING", "INTERRUPTED")).toBe(true);
    expect(canTransitionRun("CANCELLING", "INTERRUPTED")).toBe(true);
    expect(canTransitionRun("SUCCEEDED", "CANCELLED")).toBe(false);
    expect(canTransitionRun("SUCCEEDED", "SUCCEEDED")).toBe(false);
    expect(canTransitionRun("RUNNING", "QUEUED")).toBe(false);
  });

  it("rejects duplicate or regressing node states", () => {
    expect(canTransitionNode("PENDING", "RUNNING")).toBe(true);
    expect(canTransitionNode("PENDING", "SKIPPED")).toBe(true);
    expect(canTransitionNode("PENDING", "CANCELLED")).toBe(true);
    expect(canTransitionNode("RUNNING", "SUCCEEDED")).toBe(true);
    expect(canTransitionNode("RUNNING", "FAILED")).toBe(true);
    expect(canTransitionNode("RUNNING", "CANCELLED")).toBe(true);
    expect(canTransitionNode("SUCCEEDED", "CANCELLED")).toBe(false);
    expect(canTransitionNode("RUNNING", "PENDING")).toBe(false);
    expect(canTransitionNode("SUCCEEDED", "SUCCEEDED")).toBe(false);
  });
});
