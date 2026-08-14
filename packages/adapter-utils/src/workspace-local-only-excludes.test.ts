import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKSPACE_LOCAL_ONLY_EXCLUDES, workspaceLocalOnlyExcludes } from "./ssh.js";

const exec = promisify(execFile);

let dir: string;

async function git(...args: string[]): Promise<void> {
  await exec("git", ["-C", dir, ...args]);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-excl-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("workspaceLocalOnlyExcludes", () => {
  it("always includes the static local-only set", async () => {
    await git("init", "--quiet");
    const excludes = await workspaceLocalOnlyExcludes(dir);
    for (const entry of WORKSPACE_LOCAL_ONLY_EXCLUDES) {
      expect(excludes).toContain(entry);
    }
  });

  it("derives ignored directories from the workspace's own .gitignore", async () => {
    await git("init", "--quiet");
    await fs.writeFile(path.join(dir, ".gitignore"), "source-paperclip/\nnode_modules/\n.qa-run/\n");
    for (const name of ["source-paperclip", "node_modules", ".qa-run"]) {
      await fs.mkdir(path.join(dir, name), { recursive: true });
      await fs.writeFile(path.join(dir, name, "big.bin"), "x");
    }
    await fs.writeFile(path.join(dir, "kept.txt"), "content");

    const excludes = await workspaceLocalOnlyExcludes(dir);

    expect(excludes).toContain("source-paperclip");
    expect(excludes).toContain("node_modules");
    expect(excludes).toContain(".qa-run");
    // Tracked content must never be excluded — that would drop real work.
    expect(excludes).not.toContain("kept.txt");
  });

  it("strips trailing slashes so entries match tar --exclude patterns", async () => {
    await git("init", "--quiet");
    await fs.writeFile(path.join(dir, ".gitignore"), "build/\n");
    await fs.mkdir(path.join(dir, "build"), { recursive: true });
    await fs.writeFile(path.join(dir, "build", "out.js"), "x");

    const excludes = await workspaceLocalOnlyExcludes(dir);

    expect(excludes).toContain("build");
    expect(excludes.some((entry) => entry.endsWith("/"))).toBe(false);
  });

  it("does not exclude a directory that is ignored but empty", async () => {
    await git("init", "--quiet");
    await fs.writeFile(path.join(dir, ".gitignore"), "empty-cache/\n");
    await fs.mkdir(path.join(dir, "empty-cache"), { recursive: true });

    const excludes = await workspaceLocalOnlyExcludes(dir);

    expect(excludes).not.toContain("empty-cache");
  });

  it("degrades to the static set for a non-git directory", async () => {
    const excludes = await workspaceLocalOnlyExcludes(dir);
    expect(excludes).toEqual([...WORKSPACE_LOCAL_ONLY_EXCLUDES]);
  });

  it("degrades to the static set when the path does not exist", async () => {
    const excludes = await workspaceLocalOnlyExcludes(path.join(dir, "missing"));
    expect(excludes).toEqual([...WORKSPACE_LOCAL_ONLY_EXCLUDES]);
  });

  it("returns no duplicate entries", async () => {
    await git("init", "--quiet");
    await fs.writeFile(path.join(dir, ".gitignore"), "dup/\ndup/\n");
    await fs.mkdir(path.join(dir, "dup"), { recursive: true });
    await fs.writeFile(path.join(dir, "dup", "f"), "x");

    const excludes = await workspaceLocalOnlyExcludes(dir);

    expect(new Set(excludes).size).toBe(excludes.length);
  });
});
