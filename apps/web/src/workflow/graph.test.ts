import { workflowV2Schema } from "@aiflow/contracts";
import { describe, expect, it } from "vitest";
import { validateWorkflowV2 } from "../../../../packages/workflow-engine/src/v2/graph";
import {
  addNode,
  connectNodes,
  createStarterDefinition,
  disconnectEdge,
  findDanglingReferences,
  fromFlowPosition,
  moveNode,
  removeNode,
  toFlowElements,
} from "./graph";

const position = { x: 40, y: 60 };

describe("V2 graph commands", () => {
  it("creates independent starter definitions accepted by the server", () => {
    const starter = createStarterDefinition();
    expect(validateWorkflowV2(starter)).toEqual({ valid: true, errors: [] });
    expect(createStarterDefinition().nodes).not.toBe(starter.nodes);
  });

  it.each([
    "transform",
    "condition",
    "llm",
    "http",
    "knowledge",
    "intent",
  ] as const)("gives %s nodes a protocol-valid config", (type) => {
    const graph = addNode(createStarterDefinition(), type, position);
    expect(workflowV2Schema.safeParse(graph).success).toBe(true);
    expect(graph.nodes.at(-1)).toMatchObject({ type, position });
  });

  it("preserves prior graph snapshots while editing and deleting incident edges", () => {
    const starter = createStarterDefinition();
    const snapshot = structuredClone(starter);
    const added = addNode(starter, "transform", position);
    const id = added.nodes.at(-1)!.id;
    const moved = moveNode(added, id, { x: 80, y: 90 });
    const incoming = connectNodes(moved, {
      source: "start",
      sourcePort: "output",
      target: id,
    });
    const connected = connectNodes(incoming, {
      source: id,
      sourcePort: "output",
      target: "end",
    });
    const removed = removeNode(connected, id);

    expect(starter).toEqual(snapshot);
    expect(added.nodes.at(-1)!.position).toEqual(position);
    expect(moved.nodes.at(-1)!.position).toEqual({ x: 80, y: 90 });
    expect(connected.edges).toHaveLength(3);
    expect(removed.nodes).toEqual(starter.nodes);
    expect(removed.edges).toEqual(starter.edges);
    expect(disconnectEdge(connected, connected.edges.at(-1)!.id)).toEqual(
      incoming,
    );
    expect(connected.edges).toHaveLength(3);
  });

  it.each(["start", "end"] as const)("protects the unique %s node", (type) => {
    const graph = createStarterDefinition();
    expect(() => addNode(graph, type, position)).toThrow();
    expect(() => removeNode(graph, type)).toThrow();
  });

  it("allocates unique node and edge IDs across repeated edits", () => {
    let graph = createStarterDefinition();
    for (let count = 0; count < 3; count += 1) {
      graph = addNode(graph, "transform", position);
      graph = connectNodes(graph, {
        source: "start",
        sourcePort: "output",
        target: graph.nodes.at(-1)!.id,
      });
    }

    expect(new Set(graph.nodes.map(({ id }) => id)).size).toBe(5);
    expect(new Set(graph.edges.map(({ id }) => id)).size).toBe(4);
  });

  it("rejects invalid ports, endpoints and duplicate connections", () => {
    const graph = addNode(
      addNode(createStarterDefinition(), "condition", position),
      "intent",
      position,
    );
    const condition = graph.nodes.find((node) => node.type === "condition")!;
    const intent = graph.nodes.find((node) => node.type === "intent")!;
    for (const connection of [
      { source: "start", sourcePort: "true", target: "end" },
      { source: "end", sourcePort: "output", target: condition.id },
      { source: condition.id, sourcePort: "false", target: "start" },
      { source: condition.id, sourcePort: "output", target: "end" },
      { source: intent.id, sourcePort: "missing", target: "end" },
      { source: "missing", sourcePort: "output", target: "end" },
      { source: "start", sourcePort: "output", target: "end" },
    ]) {
      expect(() => connectNodes(graph, connection)).toThrow();
    }
    const branched = connectNodes(graph, {
      source: condition.id,
      sourcePort: "false",
      target: intent.id,
    });
    expect(
      connectNodes(branched, {
        source: intent.id,
        sourcePort: intent.config.intents[0]!.id,
        target: "end",
      }).edges,
    ).toHaveLength(3);
  });

  it.each(["direct", "template"] as const)(
    "diagnoses missing %s references without changing config",
    (kind) => {
      const graph = addNode(createStarterDefinition(), "transform", position);
      const id = graph.nodes.at(-1)!.id;
      const reference = {
        kind: "reference",
        nodeId: id,
        key: "value",
      } as const;
      const missing =
        kind === "direct"
          ? reference
          : { kind: "template" as const, parts: ["text ", reference] };
      const values = {
        missing,
        repeated: missing,
        valid: { ...reference, nodeId: "start" },
      };
      const end = graph.nodes.find((node) => node.type === "end")!;
      end.config.values = values;

      const removed = removeNode(graph, id);
      expect(findDanglingReferences(graph)).toEqual([]);
      expect(findDanglingReferences(removed)).toEqual([
        { nodeId: "end", sourceNodeId: id },
      ]);
      expect(
        removed.nodes.find((node) => node.type === "end")?.config.values,
      ).toEqual(values);
      expect(
        findDanglingReferences(addNode(removed, "transform", position)),
      ).toEqual([{ nodeId: "end", sourceNodeId: id }]);
    },
  );

  it("maps protocol ports to flow handles and copies positions", () => {
    const graph = createStarterDefinition();
    const elements = toFlowElements(graph);
    expect(elements.edges[0]).toEqual({
      id: "start-end",
      source: "start",
      sourceHandle: "output",
      target: "end",
      targetHandle: "input",
    });
    expect(elements.nodes[0]).toMatchObject({
      id: "start",
      type: "start",
      position: { x: 0, y: 0 },
    });
    expect(elements.nodes[0]!.position).not.toBe(graph.nodes[0]!.position);
    expect(fromFlowPosition({ ...position, z: 1 } as typeof position)).toEqual(
      position,
    );
  });
});
