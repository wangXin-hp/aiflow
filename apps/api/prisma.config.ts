import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { defineConfig, env } from "prisma/config";

// 使用配置文件位置定位根环境文件，不依赖 CLI 的调用目录，也不覆盖进程环境。
try {
  loadEnvFile(resolve(import.meta.dirname, "../../.env"));
} catch (error) {
  // CI 可仅通过进程环境提供连接串；其他文件读取错误必须显式失败。
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export default defineConfig({
  schema: resolve(import.meta.dirname, "prisma/schema.prisma"),
  migrations: { path: resolve(import.meta.dirname, "prisma/migrations") },
  datasource: { url: env("DATABASE_URL") },
});
