import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRunOwnedPaperclipEnv, runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("run-owned Paperclip process environment", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("repoints shared local children and nested package-script children without touching hostile sentinels", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-scratch-"));
    const production = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-production-"));
    roots.push(scratch, production);
    const productionEnv = path.join(production, ".env");
    const productionConfig = path.join(production, "config.json");
    await fs.writeFile(productionEnv, "env-sentinel\n");
    await fs.writeFile(productionConfig, "config-sentinel\n");
    const hostile = {
      PATH: process.env.PATH ?? "",
      PAPERCLIP_RUN_SCRATCH_DIR: scratch,
      PAPERCLIP_HOME: production,
      PAPERCLIP_CONFIG: productionConfig,
      PAPERCLIP_CONTEXT: path.join(production, "context.json"),
      PAPERCLIP_INSTANCE_ID: "default",
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_WORKTREES_DIR: production,
      PAPERCLIP_WORKTREE_NAME: "default",
    };

    const direct = await runChildProcess("shared-boundary", process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      cwd: production,
      env: hostile,
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
    });
    const nested = await runChildProcess("shared-boundary", process.execPath, ["-e", "process.stdout.write(require('node:child_process').execFileSync(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env))']))"], {
      cwd: production,
      env: hostile,
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
    });

    for (const observed of [JSON.parse(direct.stdout), JSON.parse(nested.stdout)] as Record<string, string>[]) {
      expect(observed.PAPERCLIP_HOME).toBe(path.join(scratch, "child-paperclip-instance", "home"));
      expect(observed.PAPERCLIP_CONFIG).toBe(path.join(scratch, "child-paperclip-instance", "config.json"));
      expect(observed.PAPERCLIP_CONTEXT).toBe(path.join(scratch, "child-paperclip-instance", "context.json"));
      expect(observed.PAPERCLIP_INSTANCE_ID).toMatch(/^run-/);
      expect(observed.PAPERCLIP_IN_WORKTREE).toBeUndefined();
      expect(observed.PAPERCLIP_WORKTREES_DIR).toBeUndefined();
      expect(observed.PAPERCLIP_WORKTREE_NAME).toBeUndefined();
    }
    expect(await fs.readFile(productionEnv, "utf8")).toBe("env-sentinel\n");
    expect(await fs.readFile(productionConfig, "utf8")).toBe("config-sentinel\n");
  });

  it("prepares the ACP session env at the same run-owned boundary", async () => {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acp-scratch-"));
    roots.push(scratch);
    const env = await prepareRunOwnedPaperclipEnv({
      PAPERCLIP_RUN_SCRATCH_DIR: scratch,
      PAPERCLIP_HOME: "/paperclip/instances/default",
      PAPERCLIP_CONFIG: "/paperclip/instances/default/config.json",
      PAPERCLIP_INSTANCE_ID: "default",
      PAPERCLIP_CONTEXT: "/paperclip/instances/default/context.json",
      PAPERCLIP_IN_WORKTREE: "true",
    }, "acp-run");
    expect(env.PAPERCLIP_HOME).toBe(path.join(scratch, "child-paperclip-instance", "home"));
    expect(env.PAPERCLIP_IN_WORKTREE).toBeUndefined();
  });
});
