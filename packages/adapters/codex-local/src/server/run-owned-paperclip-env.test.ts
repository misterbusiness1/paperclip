import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { prepareRunOwnedPaperclipEnvironment } from "./run-owned-paperclip-env.js";

describe("run-owned Paperclip child environment", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((fn) => fn()));
  });

  it.each([
    ["direct command", ["-e", "process.stdout.write(JSON.stringify(process.env))"]],
    ["package-script child", ["-e", "process.stdout.write(require('node:child_process').execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env))'],{stdio:['ignore','pipe','inherit']}))"]],
  ])("isolates hostile inherited selectors for a %s", async (_name, args) => {
    const productionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-production-sentinel-"));
    cleanup.push(() => fs.rm(productionRoot, { recursive: true, force: true }));
    const productionEnvPath = path.join(productionRoot, ".env");
    const productionConfigPath = path.join(productionRoot, "config.json");
    const sentinelEnv = "PRODUCTION_ENV_SENTINEL\n";
    const sentinelConfig = '{"sentinel":"production"}\n';
    await fs.writeFile(productionEnvPath, sentinelEnv);
    await fs.writeFile(productionConfigPath, sentinelConfig);

    const prepared = await prepareRunOwnedPaperclipEnvironment({
      PATH: process.env.PATH ?? "",
      PAPERCLIP_HOME: productionRoot,
      PAPERCLIP_CONFIG: productionConfigPath,
      PAPERCLIP_INSTANCE_ID: "default",
      PAPERCLIP_CONTEXT: path.join(productionRoot, "context.json"),
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREES_DIR: productionRoot,
      PAPERCLIP_WORKTREE_NAME: "default",
      PAPERCLIP_WORKTREE_START_POINT: "production",
    });
    cleanup.push(prepared.cleanup);

    const result = await runChildProcess("run-owned-env-regression", process.execPath, args, {
      cwd: productionRoot,
      env: prepared.env,
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
    });
    const childEnv = JSON.parse(result.stdout) as Record<string, string>;

    expect(childEnv.PAPERCLIP_HOME).toBe(path.join(prepared.rootDir, "home"));
    expect(childEnv.PAPERCLIP_CONFIG).toBe(path.join(prepared.rootDir, "config.json"));
    expect(childEnv.PAPERCLIP_INSTANCE_ID).toBe("run");
    expect(childEnv.PAPERCLIP_CONTEXT).toBe(path.join(prepared.rootDir, "context.json"));
    expect(childEnv.PAPERCLIP_IN_WORKTREE).toBeUndefined();
    expect(childEnv.PAPERCLIP_WORKTREES_DIR).toBeUndefined();
    expect(childEnv.PAPERCLIP_WORKTREE_NAME).toBeUndefined();
    expect(await fs.readFile(productionEnvPath, "utf8")).toBe(sentinelEnv);
    expect(await fs.readFile(productionConfigPath, "utf8")).toBe(sentinelConfig);
  });
});
