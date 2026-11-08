import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type DryRunTask = {
  taskId: string;
  resolvedTaskDefinition: { cache: boolean };
  environmentVariables: {
    specified: { env: string[] };
    configured: string[];
  };
};

describe("Turbo API environment boundary", () => {
  it("passes database overrides only to API tests and disables their cache", () => {
    const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
    const output =
      process.platform === "win32"
        ? execFileSync(
            "cmd.exe",
            ["/d", "/s", "/c", "pnpm exec turbo run test --dry=json"],
            {
              cwd: workspace,
              encoding: "utf8",
              env: {
                ...process.env,
                TEST_DATABASE_URL:
                  "postgresql://probe:probe@127.0.0.1:6543/non_default_test",
              },
            },
          )
        : execFileSync("pnpm", ["exec", "turbo", "run", "test", "--dry=json"], {
            cwd: workspace,
            encoding: "utf8",
            env: {
              ...process.env,
              TEST_DATABASE_URL:
                "postgresql://probe:probe@127.0.0.1:6543/non_default_test",
            },
          });
    const tasks = (JSON.parse(output) as { tasks: DryRunTask[] }).tasks;
    const api = tasks.find((task) => task.taskId === "@aiflow/api#test");
    const web = tasks.find((task) => task.taskId === "@aiflow/web#test");

    expect(api?.environmentVariables.specified.env).toContain(
      "TEST_DATABASE_URL",
    );
    expect(api?.resolvedTaskDefinition.cache).toBe(false);
    // Turbo 只展示哈希，不泄漏连接串；存在哈希证明非默认覆盖值进入了 API 任务边界。
    expect(api?.environmentVariables.configured).toEqual([
      expect.stringMatching(/^TEST_DATABASE_URL=[a-f\d]{64}$/),
    ]);
    expect(web?.environmentVariables.specified.env).not.toContain(
      "TEST_DATABASE_URL",
    );
  });
});
