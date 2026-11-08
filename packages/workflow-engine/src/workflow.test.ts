import { describe, expect, it } from "vitest";
import { workflowDefinitionSchema } from "@aiflow/contracts";
import {
  executeWorkflow,
  validateWorkflow,
  WorkflowValidationError,
} from "./index.js";

const graph = {
  schemaVersion: 1,
  nodes: [
    { id: "start", type: "start", position: { x: 0, y: 0 } },
    { id: "end", type: "end", position: { x: 200, y: 0 } },
  ],
  edges: [
    {
      id: "edge",
      source: "start",
      sourcePort: "output",
      target: "end",
      targetPort: "input",
    },
  ],
};

describe("workflow protocol", () => {
  it("accepts a V1 graph and rejects unknown versions and fields", () => {
    expect(workflowDefinitionSchema.safeParse(graph).success).toBe(true);
    expect(
      workflowDefinitionSchema.safeParse({ ...graph, schemaVersion: 2 })
        .success,
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({ ...graph, extra: true }).success,
    ).toBe(false);
  });
  it("rejects invalid positions and unknown node types", () => {
    expect(
      workflowDefinitionSchema.safeParse({
        ...graph,
        nodes: [
          { ...graph.nodes[0], position: { x: Infinity, y: 0 } },
          graph.nodes[1],
        ],
      }).success,
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({
        ...graph,
        nodes: [{ ...graph.nodes[0], type: "llm" }, graph.nodes[1]],
      }).success,
    ).toBe(false);
  });
});

describe("graph validation", () => {
  it("accepts a connected start-to-end graph", () =>
    expect(validateWorkflow(graph)).toEqual({ valid: true, errors: [] }));
  it("rejects duplicate IDs and dangling edges", () => {
    const invalid = {
      ...graph,
      nodes: [graph.nodes[0], graph.nodes[0], graph.nodes[1]],
      edges: [...graph.edges, { ...graph.edges[0], target: "missing" }],
    };
    const result = validateWorkflow(invalid);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining([
        "duplicate_node_id",
        "duplicate_edge_id",
        "unknown_endpoint",
      ]),
    );
  });
  it("rejects cycles, invalid direction and disconnected nodes", () => {
    const invalid = {
      ...graph,
      edges: [
        ...graph.edges,
        {
          id: "back",
          source: "end",
          sourcePort: "output",
          target: "start",
          targetPort: "input",
        },
      ],
    };
    expect(validateWorkflow(invalid).errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["cycle", "invalid_direction"]),
    );
    expect(
      validateWorkflow({ ...graph, edges: [] }).errors.map((e) => e.code),
    ).toContain("unreachable_node");
  });
  it("rejects duplicate edges and malformed payloads", () => {
    expect(
      validateWorkflow({
        ...graph,
        edges: [...graph.edges, { ...graph.edges[0], id: "other" }],
      }).errors.map((e) => e.code),
    ).toContain("duplicate_connection");
    expect(validateWorkflow(null).errors[0]?.code).toBe("invalid_definition");
  });
});

describe("workflow execution", () => {
  it("passes JSON input from start to end and records each node", () => {
    const input = { text: "hello", nested: { value: 1 } };
    const result = executeWorkflow(graph, input);
    expect(result.output).toEqual(input);
    expect(result.nodes.map((node) => [node.nodeId, node.status])).toEqual([
      ["start", "succeeded"],
      ["end", "succeeded"],
    ]);
    input.nested.value = 2;
    expect(result.output).toEqual({ text: "hello", nested: { value: 1 } });
  });
  it("validates and executes the same graph snapshot", () => {
    let reads = 0;
    const changing = {
      ...graph,
      get edges() {
        reads++;
        return reads === 1 ? graph.edges : [];
      },
    };
    expect(executeWorkflow(changing, {}).status).toBe("succeeded");
    expect(reads).toBe(1);
  });
  it("keeps results independent of each other", () => {
    const result = executeWorkflow(graph, { nested: { value: 1 } });
    const nested = result.nodes[0]!.output.nested as { value: number };
    nested.value = 99;
    expect(result.output).toEqual({ nested: { value: 1 } });
    expect(result.nodes[1]!.input).toEqual({ nested: { value: 1 } });
  });
  it("rejects cyclic objects, sparse arrays and non-object inputs", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => executeWorkflow(graph, cyclic)).toThrow(/cycles/);
    expect(() => executeWorkflow(graph, { list: new Array(1) })).toThrow(
      /dense/,
    );
    expect(() => executeWorkflow(graph, [])).toThrow(/object/);
    expect(() => executeWorkflow(graph, { date: new Date() })).toThrow(
      /plain objects/,
    );
  });
  it("rejects invalid graphs and non-JSON inputs before execution", () => {
    expect(() => executeWorkflow({ ...graph, edges: [] }, {})).toThrow(
      WorkflowValidationError,
    );
    expect(() => executeWorkflow(graph, { bad: undefined })).toThrow();
    expect(() => executeWorkflow(graph, { bad: Infinity })).toThrow();
  });
});
