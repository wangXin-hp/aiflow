import { useEffect, useState } from "react";
import type { HealthResponse } from "@aiflow/contracts";
export function App() {
  const [status, setStatus] = useState("正在连接 API…");
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/health", { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("API unavailable");
        return response.json() as Promise<HealthResponse>;
      })
      .then((result) =>
        setStatus(result.status === "ok" ? "API 已连接" : "API 状态异常"),
      )
      .catch(() => {
        if (!controller.signal.aborted) setStatus("API 未连接，请检查服务");
      });
    return () => controller.abort();
  }, []);
  return (
    <main>
      <p className="eyebrow">AIFLOW / WORKSPACE</p>
      <h1>AIFlow</h1>
      <p>AI 工作流平台正在搭建中。</p>
      <p className="status">{status}</p>
    </main>
  );
}
