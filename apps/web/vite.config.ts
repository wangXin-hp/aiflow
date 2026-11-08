import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // Zod 4.6.7 注释中的 PURE 示例被 Rollup 误判，忽略此上游注释提示。
        if (
          warning.code === "INVALID_ANNOTATION" &&
          /\/node_modules\/zod\/v4\/core\/(regexes|util)\.js$/.test(
            warning.id?.replaceAll("\\", "/") ?? "",
          )
        )
          return;
        warn(warning);
      },
    },
  },
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"] },
});
