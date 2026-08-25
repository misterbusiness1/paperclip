import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const INHERITED_WORKTREE_SELECTORS = [
  "PAPERCLIP_IN_WORKTREE",
  "PAPERCLIP_WORKTREES_DIR",
  "PAPERCLIP_WORKTREE_COLOR",
  "PAPERCLIP_WORKTREE_NAME",
  "PAPERCLIP_WORKTREE_START_POINT",
] as const;

export type RunOwnedPaperclipEnvironment = {
  env: Record<string, string>;
  rootDir: string;
  cleanup: () => Promise<void>;
};

/**
 * Give a local Codex process and every command below it a private Paperclip
 * instance. The directory lives for one adapter invocation and is removed
 * after the child process exits. Explicit selectors prevent commands started
 * from a Paperclip checkout from discovering the mounted default instance.
 */
export async function prepareRunOwnedPaperclipEnvironment(
  inputEnv: Record<string, string>,
): Promise<RunOwnedPaperclipEnvironment> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-run-"));
  const homeDir = path.join(rootDir, "home");
  const configPath = path.join(rootDir, "config.json");
  const contextPath = path.join(rootDir, "context.json");

  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.writeFile(configPath, "{}\n", { encoding: "utf8", mode: 0o600 }),
    fs.writeFile(contextPath, "{}\n", { encoding: "utf8", mode: 0o600 }),
  ]);

  const env = { ...inputEnv };
  for (const key of INHERITED_WORKTREE_SELECTORS) delete env[key];
  env.PAPERCLIP_HOME = homeDir;
  env.PAPERCLIP_CONFIG = configPath;
  env.PAPERCLIP_INSTANCE_ID = "run";
  env.PAPERCLIP_CONTEXT = contextPath;

  return {
    env,
    rootDir,
    cleanup: () => fs.rm(rootDir, { recursive: true, force: true }),
  };
}
