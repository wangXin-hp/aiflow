import { describe, expect, it } from "vitest";
import { workflowV2Schema } from "@aiflow/contracts";
import { NodeRegistryV2, runWorkflowV2, validateWorkflowV2 } from "./v2.js";

const pos = { x: 0, y: 0 };
const ref = (nodeId: string, key: string) => ({
  kind: "reference",
  nodeId,
  key,
});
const edge = (
  id: string,
  source: string,
  target: string,
  sourcePort = "output",
) => ({ id, source, target, sourcePort, targetPort: "input" });
const graph = {
  schemaVersion: 2,
  nodes: [
    { id: "s", type: "start", position: pos },
    {
      id: "t",
      type: "transform",
      position: pos,
      config: { values: { message: ref("s", "text") } },
    },
    {
      id: "e",
      type: "end",
      position: pos,
      config: { values: { result: ref("t", "message") } },
    },
  ],
  edges: [edge("a", "s", "t"), edge("b", "t", "e")],
};
const diamond = {
  schemaVersion: 2,
  nodes: [
    { id: "s", type: "start", position: pos },
    {
      id: "c",
      type: "condition",
      position: pos,
      config: { value: ref("s", "flag") },
    },
    {
      id: "yes",
      type: "transform",
      position: pos,
      config: { values: { value: { kind: "literal", value: "yes" } } },
    },
    {
      id: "no",
      type: "transform",
      position: pos,
      config: { values: { value: { kind: "literal", value: "no" } } },
    },
    {
      id: "e",
      type: "end",
      position: pos,
      config: { values: { flag: ref("s", "flag") } },
    },
  ],
  edges: [
    edge("a", "s", "c"),
    edge("b", "c", "yes", "true"),
    edge("c", "c", "no", "false"),
    edge("d", "yes", "e"),
    edge("e", "no", "e"),
  ],
};

describe("V2 protocol and graph", () => {
  it("allows incomplete drafts but rejects them for execution", () => {
    const draft = { ...graph, edges: [] };
    expect(workflowV2Schema.safeParse(draft).success).toBe(true);
    expect(validateWorkflowV2(draft).valid).toBe(false);
  });
  it("rejects cyclic literal values in the protocol", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const nodes = graph.nodes.map((node) =>
      node.id === "t"
        ? {
            ...node,
            config: { values: { bad: { kind: "literal", value: cyclic } } },
          }
        : node,
    );
    expect(workflowV2Schema.safeParse({ ...graph, nodes }).success).toBe(false);
  });
  it("rejects cycles, invalid ports and non-upstream references", () => {
    expect(
      validateWorkflowV2({
        ...graph,
        edges: [...graph.edges, edge("back", "t", "s")],
      }).valid,
    ).toBe(false);
    expect(
      validateWorkflowV2({
        ...graph,
        edges: [edge("a", "s", "t", "true"), graph.edges[1]],
      }).valid,
    ).toBe(false);
    const nodes = graph.nodes.map((n) =>
      n.id === "t"
        ? { ...n, config: { values: { x: ref("e", "result") } } }
        : n,
    );
    expect(validateWorkflowV2({ ...graph, nodes }).valid).toBe(false);
  });
});
describe("V2 runtime", () => {
  it("runs multiple nodes in dependency order and resolves typed values", async () => {
    const events: string[] = [];
    const result = await runWorkflowV2(
      graph,
      { text: 42 },
      { onEvent: (event) => events.push(event.type) },
    );
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual({ result: 42 });
    expect(result.nodes.map((n) => n.nodeId)).toEqual(["s", "t", "e"]);
    expect(events).toContain("node.started");
  });
  it.each([true, false])(
    "skips the unselected branch and runs the merge (%s)",
    async (flag) => {
      const result = await runWorkflowV2(diamond, { flag });
      expect(result.status).toBe("succeeded");
      expect(
        result.nodes.find((n) => n.nodeId === (flag ? "yes" : "no"))?.status,
      ).toBe("succeeded");
      expect(
        result.nodes.find((n) => n.nodeId === (flag ? "no" : "yes"))?.status,
      ).toBe("skipped");
      expect(result.nodes.find((n) => n.nodeId === "e")?.status).toBe(
        "succeeded",
      );
    },
  );
  it("isolates nested literal values from mutations during async execution", async () => {
    const literal = { value: 1 };
    const nodes = graph.nodes.map((node) =>
      node.id === "t"
        ? {
            ...node,
            config: {
              values: { message: { kind: "literal", value: literal } },
            },
          }
        : node,
    );
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new NodeRegistryV2();
    registry.register("start", {
      async execute(_node, input) {
        await wait;
        return { output: input };
      },
    });
    const pending = runWorkflowV2({ ...graph, nodes }, {}, { registry });
    literal.value = 9;
    release();
    expect((await pending).output).toEqual({ result: { value: 1 } });
  });
  it("rejects a required reference to a conditionally skipped branch", () => {
    const nodes = diamond.nodes.map((node) =>
      node.id === "e"
        ? { ...node, config: { values: { result: ref("yes", "value") } } }
        : node,
    );
    expect(
      validateWorkflowV2({ ...diamond, nodes }).errors.map((e) => e.code),
    ).toContain("unsafe_reference");
  });
  it.each([true, false])(
    "uses a fallback when a branch output is skipped (%s)",
    async (flag) => {
      const nodes = diamond.nodes.map((node) =>
        node.id === "e"
          ? {
              ...node,
              config: {
                values: {
                  result: { ...ref("yes", "value"), fallback: "none" },
                },
              },
            }
          : node,
      );
      const result = await runWorkflowV2({ ...diamond, nodes }, { flag });
      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual({ result: flag ? "yes" : "none" });
    },
  );
  it("does not let a custom executor mutate the validated graph", async () => {
    const registry = new NodeRegistryV2();
    registry.register("condition", {
      async execute(node) {
        (node as { type: string }).type = "start";
        return { output: { value: true }, branch: "true" };
      },
    });
    const result = await runWorkflowV2(diamond, { flag: true }, { registry });
    expect(result.nodes.find((n) => n.nodeId === "no")?.status).toBe("skipped");
  });
  it("reports cancellation when an in-flight executor rejects after abort", async () => {
    const controller = new AbortController();
    const registry = new NodeRegistryV2();
    registry.register("transform", {
      async execute() {
        controller.abort();
        throw new Error("aborted");
      },
    });
    expect(
      (
        await runWorkflowV2(
          graph,
          { text: 1 },
          { signal: controller.signal, registry },
        )
      ).status,
    ).toBe("cancelled");
  });
  it("does not start a node when its start observer cancels", async () => {
    const controller = new AbortController();
    let calls = 0;
    const registry = new NodeRegistryV2();
    registry.register("start", {
      async execute() {
        calls++;
        return { output: {} };
      },
    });
    const result = await runWorkflowV2(
      graph,
      { text: 1 },
      {
        signal: controller.signal,
        registry,
        onEvent: (event) => {
          if (event.type === "node.started") controller.abort();
        },
      },
    );
    expect(calls).toBe(0);
    expect(result.status).toBe("cancelled");
  });
  it("reports a missing reference and skips downstream nodes", async () => {
    const result = await runWorkflowV2(graph, {});
    expect(result.status).toBe("failed");
    expect(result.nodes.find((n) => n.nodeId === "t")?.error?.code).toBe(
      "missing_reference",
    );
    expect(result.nodes.find((n) => n.nodeId === "e")?.status).toBe("skipped");
  });
  it("times out a stuck node, aborts its signal, and skips downstream", async () => {
    const registry = new NodeRegistryV2();
    let observed: AbortSignal | undefined;
    registry.register("transform", {
      async execute(_node, _input, context) {
        observed = context.signal;
        return new Promise(() => {});
      },
    });
    const result = await runWorkflowV2(
      graph,
      { text: 1 },
      { registry, nodeTimeoutMs: 20 },
    );
    expect(result.status).toBe("failed");
    expect(result.nodes.find((n) => n.nodeId === "t")?.error?.code).toBe(
      "node_timeout",
    );
    expect(result.nodes.find((n) => n.nodeId === "e")?.status).toBe("skipped");
    expect(observed?.aborted).toBe(true);
  });
  it("reports timeout when the executor rejects in response to its signal", async () => {
    const registry = new NodeRegistryV2();
    registry.register("transform", {
      async execute(_node, _input, context) {
        return new Promise((_resolve, reject) =>
          context.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          ),
        );
      },
    });
    const result = await runWorkflowV2(
      graph,
      { text: 1 },
      { registry, nodeTimeoutMs: 20 },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("node_timeout");
  });
  it("preserves the timeout result when executor abort handlers also cancel the run", async () => {
    const controller = new AbortController();
    const registry = new NodeRegistryV2();
    registry.register("transform", {
      async execute(_node, _input, context) {
        return new Promise((_resolve, reject) =>
          context.signal.addEventListener(
            "abort",
            () => {
              controller.abort();
              reject(new Error("aborted"));
            },
            { once: true },
          ),
        );
      },
    });
    const result = await runWorkflowV2(
      graph,
      { text: 1 },
      { registry, signal: controller.signal, nodeTimeoutMs: 20 },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("node_timeout");
  });
  it("cleans up a completed node timeout without aborting its signal", async () => {
    const registry = new NodeRegistryV2();
    let signal: AbortSignal | undefined;
    registry.register("transform", {
      async execute(_node, input, context) {
        signal = context.signal;
        return { output: input };
      },
    });
    expect(
      (await runWorkflowV2(graph, { text: 1 }, { registry, nodeTimeoutMs: 20 }))
        .status,
    ).toBe("succeeded");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(signal?.aborted).toBe(false);
  });
  it("returns promptly when cancelling a stuck executor and ignores its late output", async () => {
    const controller = new AbortController();
    const registry = new NodeRegistryV2();
    let finish!: (value: { output: { message: string } }) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    registry.register("transform", {
      async execute() {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const pending = runWorkflowV2(
      graph,
      { text: 1 },
      { registry, signal: controller.signal, nodeTimeoutMs: 1000 },
    );
    await entered;
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.nodes.find((n) => n.nodeId === "t")?.status).toBe(
      "cancelled",
    );
    finish({ output: { message: "late" } });
    await Promise.resolve();
    expect(result.output).toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity, 1.5, 2147483648])(
    "rejects invalid node timeout %s",
    async (nodeTimeoutMs) => {
      await expect(
        runWorkflowV2(graph, { text: 1 }, { nodeTimeoutMs }),
      ).rejects.toThrow(RangeError);
    },
  );
  it("supports cancellation and ignores event callback errors", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      (await runWorkflowV2(graph, {}, { signal: controller.signal })).status,
    ).toBe("cancelled");
    const result = await runWorkflowV2(
      graph,
      { text: "ok" },
      {
        onEvent: () => {
          throw new Error("observer");
        },
      },
    );
    expect(result.status).toBe("succeeded");
  });
});
