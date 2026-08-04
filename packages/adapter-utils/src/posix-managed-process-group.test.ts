import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPosixManagedNodeProcessGroupLaunch,
  buildPosixManagedProcessGroupStop,
  parsePosixManagedProcessGroupIdentity,
  parsePosixManagedProcessGroupStopEvidence,
  type PosixManagedProcessGroupIdentity,
} from "./posix-managed-process-group.js";

const execFile = promisify(execFileCallback);

describe.skipIf(process.platform === "win32")("POSIX managed process groups", () => {
  const cleanupDirs: string[] = [];
  const cleanupGroups: number[] = [];

  afterEach(async () => {
    while (cleanupGroups.length > 0) {
      const processGroupId = cleanupGroups.pop();
      if (!processGroupId) continue;
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The managed group has already exited.
      }
    }
    while (cleanupDirs.length > 0) {
      const directory = cleanupDirs.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function launchManagedGroup(rootDir: string): Promise<{
    identity: PosixManagedProcessGroupIdentity;
    metadataFile: string;
    pidFile: string;
  }> {
    const entrypoint = path.join(rootDir, "managed-child.mjs");
    const metadataFile = path.join(rootDir, "ownership.json");
    const pidFile = path.join(rootDir, "managed.pid");
    await writeFile(entrypoint, "setInterval(() => {}, 1000);\n", "utf8");
    const launch = buildPosixManagedNodeProcessGroupLaunch({
      nodeCommand: process.execPath,
      entrypoint,
      metadataFile,
      pidFile,
    });
    const result = await execFile(launch.command, launch.args, { cwd: rootDir });
    const identity = parsePosixManagedProcessGroupIdentity(result.stdout, launch.nonce);
    cleanupGroups.push(identity.processGroupId);
    return { identity, metadataFile, pidFile };
  }

  async function writeKillProbeShim(rootDir: string): Promise<string> {
    const shim = path.join(rootDir, "kill-probe-shim.cjs");
    await writeFile(
      shim,
      [
        'const originalKill = process.kill.bind(process);',
        'let groupKillSent = false;',
        'let injectedCount = 0;',
        'process.kill = (target, signal) => {',
        '  if (groupKillSent && target < 0 && signal === 0) {',
        '    const mode = process.env.PAPERCLIP_TEST_POST_KILL_PROBE;',
        '    if (mode === "persistent-eperm" || (mode === "once-eperm" && injectedCount++ === 0)) {',
        '      const error = new Error("injected kill EPERM");',
        '      error.code = "EPERM";',
        '      throw error;',
        '    }',
        '  }',
        '  const result = originalKill(target, signal);',
        '  if (target < 0 && signal === "SIGKILL") groupKillSent = true;',
        '  return result;',
        '};',
      ].join("\n"),
      "utf8",
    );
    await chmod(shim, 0o600);
    return shim;
  }

  it("retries an indeterminate post-kill EPERM probe until group absence is confirmed", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-group-eperm-once-"));
    cleanupDirs.push(rootDir);
    const { identity, metadataFile, pidFile } = await launchManagedGroup(rootDir);
    const shim = await writeKillProbeShim(rootDir);
    const stop = buildPosixManagedProcessGroupStop({
      identity,
      metadataFile,
      pidFile,
      confirmationTimeoutMs: 2_000,
      nodeCommand: process.execPath,
    });

    const result = await execFile(stop.command, stop.args, {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${shim}`,
        PAPERCLIP_TEST_POST_KILL_PROBE: "once-eperm",
      },
    });

    expect(parsePosixManagedProcessGroupStopEvidence(result.stdout, identity)).toMatchObject({
      confirmedExited: true,
      forceKilled: true,
    });
    await expect(readFile(metadataFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(pidFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    cleanupGroups.pop();
  });

  it("fails closed and retains ownership metadata when post-kill EPERM persists", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-managed-group-eperm-persistent-"));
    cleanupDirs.push(rootDir);
    const { identity, metadataFile, pidFile } = await launchManagedGroup(rootDir);
    const shim = await writeKillProbeShim(rootDir);
    const stop = buildPosixManagedProcessGroupStop({
      identity,
      metadataFile,
      pidFile,
      confirmationTimeoutMs: 100,
      nodeCommand: process.execPath,
    });

    const failure = await execFile(stop.command, stop.args, {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${shim}`,
        PAPERCLIP_TEST_POST_KILL_PROBE: "persistent-eperm",
      },
    }).then(
      () => null,
      (error: unknown) => error as NodeJS.ErrnoException & { code?: number; stderr?: string },
    );

    expect(failure).not.toBeNull();
    expect(failure?.code).toBe(125);
    expect(failure?.stderr).toContain("post-kill confirmation");
    expect(failure?.stderr).toContain(`process group ${identity.processGroupId} (pid ${identity.pid})`);
    expect(failure?.stderr).toContain("EPERM");
    expect(JSON.parse(await readFile(metadataFile, "utf8"))).toMatchObject({
      pid: identity.pid,
      processGroupId: identity.processGroupId,
      nonce: identity.nonce,
    });
    expect((await readFile(pidFile, "utf8")).trim()).toBe(String(identity.pid));
    cleanupGroups.pop();
  });
});
