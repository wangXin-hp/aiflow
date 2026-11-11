import type {
  ValueBinding,
  WorkflowNodeV2,
  WorkflowV2,
} from "@aiflow/contracts";
import { useState } from "react";
import { nodeAppearance } from "./node-appearance";

interface NodeInspectorProps {
  node: WorkflowNodeV2;
  definition: WorkflowV2;
  advanced?: { text: string; error?: string };
  onChange: (node: WorkflowNodeV2) => void;
  onAdvancedChange: (nodeId: string, text: string) => void;
}

function upstreamNodes(definition: WorkflowV2, nodeId: string) {
  const parents = new Map<string, string[]>();
  for (const edge of definition.edges) {
    const incoming = parents.get(edge.target) ?? [];
    incoming.push(edge.source);
    parents.set(edge.target, incoming);
  }
  const visited = new Set([nodeId]);
  const pending = [...(parents.get(nodeId) ?? [])];
  // 允许编辑尚未通过语义校验的图，因此需要处理环路。
  for (const id of pending) {
    if (visited.has(id)) continue;
    visited.add(id);
    for (const parent of parents.get(id) ?? []) pending.push(parent);
  }
  visited.delete(nodeId);
  return definition.nodes.filter(({ id }) => visited.has(id));
}

function BindingEditor({
  name,
  binding,
  upstream,
  onChange,
}: {
  name: string;
  binding: ValueBinding;
  upstream: WorkflowNodeV2[];
  onChange: (binding: ValueBinding) => void;
}) {
  return (
    <fieldset className="studio-binding">
      <legend>{name}</legend>
      <label>
        绑定方式
        <select
          value={binding.kind}
          onChange={(event) => {
            if (event.target.value === "literal")
              onChange({ kind: "literal", value: "" });
            if (event.target.value === "reference")
              onChange({
                kind: "reference",
                nodeId: upstream[0]?.id ?? "",
                key: "",
              });
          }}
        >
          <option value="literal">字面量</option>
          <option
            value="reference"
            disabled={!upstream.length && binding.kind !== "reference"}
          >
            上游输出引用
          </option>
          {binding.kind === "template" && (
            <option value="template">模板</option>
          )}
        </select>
      </label>
      {binding.kind === "literal" && (
        <LiteralEditor
          value={binding.value}
          onChange={(value) => onChange({ kind: "literal", value })}
        />
      )}
      {binding.kind === "reference" && (
        <>
          <label>
            来源节点
            <select
              value={binding.nodeId}
              onChange={(event) =>
                onChange({ ...binding, nodeId: event.target.value })
              }
            >
              {!upstream.some(({ id }) => id === binding.nodeId) && (
                <option value={binding.nodeId}>
                  {binding.nodeId || "请选择来源节点"}
                  {binding.nodeId && "（非上游）"}
                </option>
              )}
              {upstream.map(({ id, type }) => (
                <option key={id} value={id}>
                  {nodeAppearance[type].label} · {id}
                </option>
              ))}
            </select>
          </label>
          <label>
            输出字段
            <input
              value={binding.key}
              maxLength={128}
              onChange={(event) =>
                onChange({ ...binding, key: event.target.value })
              }
            />
          </label>
        </>
      )}
      {binding.kind === "template" && <p>在高级配置中编辑模板。</p>}
    </fieldset>
  );
}

type LiteralValue = Extract<ValueBinding, { kind: "literal" }>["value"];
const literalDefaults = { string: "", number: 0, boolean: false, null: null };
function LiteralEditor({
  value,
  onChange,
}: {
  value: LiteralValue;
  onChange: (value: LiteralValue) => void;
}) {
  const kind = value === null ? "null" : typeof value;
  return (
    <>
      <label>
        值类型
        <select
          value={kind}
          onChange={(event) => {
            const type = event.target.value as keyof typeof literalDefaults;
            onChange(literalDefaults[type]);
          }}
        >
          <option value="string">文本</option>
          <option value="number">数字</option>
          <option value="boolean">布尔</option>
          <option value="null">空值</option>
          {kind === "object" && <option value="object">结构化值</option>}
        </select>
      </label>
      {typeof value === "string" && (
        <label>
          值
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      )}
      {typeof value === "number" && (
        <label>
          值
          <input
            type="number"
            step="any"
            value={value}
            onChange={(event) => {
              if (Number.isFinite(event.target.valueAsNumber))
                onChange(event.target.valueAsNumber);
            }}
          />
        </label>
      )}
      {typeof value === "boolean" && (
        <label>
          <input
            type="checkbox"
            checked={value}
            onChange={(event) => onChange(event.target.checked)}
          />
          为真
        </label>
      )}
      {kind === "object" && <p>在高级配置中编辑结构化字面量。</p>}
    </>
  );
}

function BindingMap({
  values,
  upstream,
  onChange,
}: {
  values: Record<string, ValueBinding>;
  upstream: WorkflowNodeV2[];
  onChange: (values: Record<string, ValueBinding>) => void;
}) {
  const [key, setKey] = useState("");
  const name = key.trim();
  return (
    <>
      <h3>变量绑定</h3>
      {Object.entries(values).map(([entry, binding]) => (
        <div key={entry} className="studio-binding-row">
          <BindingEditor
            name={entry}
            binding={binding}
            upstream={upstream}
            onChange={(value) => onChange({ ...values, [entry]: value })}
          />
          <button
            type="button"
            aria-label={`移除绑定 ${entry}`}
            onClick={() => {
              const next = { ...values };
              delete next[entry];
              onChange(next);
            }}
          >
            移除
          </button>
        </div>
      ))}
      <label>
        新绑定名称
        <input
          value={key}
          maxLength={128}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      <button
        type="button"
        disabled={!name || Object.hasOwn(values, name)}
        onClick={() => {
          onChange({ ...values, [name]: { kind: "literal", value: "" } });
          setKey("");
        }}
      >
        添加绑定
      </button>
    </>
  );
}

type StartNode = Extract<WorkflowNodeV2, { type: "start" }>;
function StartInputs({
  node,
  onChange,
}: {
  node: StartNode;
  onChange: (node: StartNode) => void;
}) {
  const inputs = node.config?.inputs ?? [];
  const update = (items: typeof inputs) =>
    onChange({ ...node, config: { inputs: items } });
  return (
    <>
      <h3>运行输入</h3>
      {inputs.map((item, index) => (
        <fieldset key={index} className="studio-binding">
          <legend>输入 {index + 1}</legend>
          <label>
            名称
            <input
              value={item.name}
              onChange={(event) =>
                update(
                  inputs.map((entry, i) =>
                    i === index
                      ? { ...entry, name: event.target.value }
                      : entry,
                  ),
                )
              }
            />
          </label>
          <label>
            类型
            <select
              value={item.type}
              onChange={(event) =>
                update(
                  inputs.map((entry, i) =>
                    i === index
                      ? {
                          ...entry,
                          type: event.target.value as typeof item.type,
                          defaultValue: undefined,
                        }
                      : entry,
                  ),
                )
              }
            >
              <option value="string">文本</option>
              <option value="number">数字</option>
              <option value="boolean">布尔</option>
              <option value="array">数组</option>
              <option value="object">对象</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={item.required}
              onChange={(event) =>
                update(
                  inputs.map((entry, i) =>
                    i === index
                      ? { ...entry, required: event.target.checked }
                      : entry,
                  ),
                )
              }
            />
            必填
          </label>
          <button
            type="button"
            onClick={() => update(inputs.filter((_, i) => i !== index))}
          >
            移除输入
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={inputs.length >= 100}
        onClick={() => {
          let index = inputs.length + 1;
          while (inputs.some(({ name }) => name === `input-${index}`))
            index += 1;
          update([
            ...inputs,
            { name: `input-${index}`, type: "string", required: false },
          ]);
        }}
      >
        添加输入
      </button>
    </>
  );
}

/** 节点常用字段使用结构化控件，模板、默认值等高级配置交给共享 V2 协议校验。 */
export function NodeInspector({
  node,
  definition,
  advanced,
  onChange,
  onAdvancedChange,
}: NodeInspectorProps) {
  const upstream = upstreamNodes(definition, node.id);
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(advanced?.error));
  return (
    <section className="studio-inspector" aria-label="节点配置">
      <h2>{nodeAppearance[node.type].label}</h2>
      <p className="studio-node-id">{node.id}</p>
      <fieldset
        className="studio-inspector-fields"
        disabled={Boolean(advanced?.error)}
      >
        {node.type === "start" && (
          <StartInputs node={node} onChange={onChange} />
        )}
        {(node.type === "llm" || node.type === "intent") && (
          <label>
            模型
            <input
              value={node.config.model}
              onChange={(event) =>
                onChange({
                  ...node,
                  config: { ...node.config, model: event.target.value },
                } as typeof node)
              }
            />
          </label>
        )}
        {node.type === "llm" && (
          <label>
            温度
            <input
              type="number"
              min={0}
              max={2}
              step="any"
              value={node.config.temperature ?? ""}
              onChange={(event) =>
                onChange({
                  ...node,
                  config: {
                    ...node.config,
                    temperature:
                      event.target.value === ""
                        ? undefined
                        : event.target.valueAsNumber,
                  },
                })
              }
            />
          </label>
        )}
        {node.type === "http" && (
          <label>
            请求方法
            <select
              value={node.config.method}
              onChange={(event) =>
                onChange({
                  ...node,
                  config: {
                    ...node.config,
                    method: event.target.value as typeof node.config.method,
                  },
                })
              }
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
          </label>
        )}
        {node.type === "knowledge" && (
          <>
            <label>
              知识库 ID（每行一个）
              <textarea
                value={node.config.knowledgeBaseIds.join("\n")}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: {
                      ...node.config,
                      knowledgeBaseIds: event.target.value.split("\n"),
                    },
                  })
                }
              />
            </label>
            <label>
              检索方式
              <select
                value={node.config.retrievalMode}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: {
                      ...node.config,
                      retrievalMode: event.target
                        .value as typeof node.config.retrievalMode,
                    },
                  })
                }
              >
                <option value="vector">向量</option>
                <option value="fulltext">全文</option>
                <option value="hybrid">混合</option>
              </select>
            </label>
          </>
        )}
        {node.type === "intent" &&
          node.config.intents.map((intent, index) => (
            <label key={index}>
              {`意图 ${intent.id} 的描述`}
              <textarea
                value={intent.description}
                maxLength={2000}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: {
                      ...node.config,
                      intents: node.config.intents.map((item, i) =>
                        i === index
                          ? { ...item, description: event.target.value }
                          : item,
                      ),
                    },
                  })
                }
              />
            </label>
          ))}
        {node.type === "condition" && (
          <BindingEditor
            name="分支条件"
            binding={node.config.value}
            upstream={upstream}
            onChange={(value) => onChange({ ...node, config: { value } })}
          />
        )}
        {node.type !== "condition" && node.type !== "start" && (
          <BindingMap
            values={node.config.values}
            upstream={upstream}
            onChange={(values) =>
              onChange({
                ...node,
                config: { ...node.config, values },
              } as typeof node)
            }
          />
        )}
      </fieldset>
      <details
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary>高级配置（JSON）</summary>
        <label>
          节点配置 JSON
          <textarea
            rows={10}
            spellCheck={false}
            aria-invalid={Boolean(advanced?.error)}
            value={
              advanced?.text ??
              JSON.stringify(node.config ?? { inputs: [] }, null, 2)
            }
            onChange={(event) => onAdvancedChange(node.id, event.target.value)}
          />
        </label>
        {advanced?.error && <p role="alert">{advanced.error}</p>}
      </details>
    </section>
  );
}
