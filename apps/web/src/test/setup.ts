import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// jsdom 没有尺寸观察器，几何交互由画布的单独测试覆盖。
beforeEach(() => {
  // 测试路由没有加载器，适配 jsdom 的 AbortSignal 与 Node Request 品牌检查。
  const NativeRequest = globalThis.Request;
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, { ...init, signal: undefined });
      }
    },
  );
  vi.stubGlobal(
    "DOMMatrixReadOnly",
    class {
      readonly m22 = 1;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
