import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSshSpawnTarget,
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  prepareWorkspaceForSshExecution,
  readSshEnvLabFixtureStatus,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  shellQuote,
  syncDirectoryFromSsh,
  syncDirectoryToSsh,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
} from "./ssh.js";
import {
  clearProcessCancellation,
  getRemoteProcessTerminationControl,
  requestProcessCancellation,
  runningProcesses,
  runChildProcess,
  signalRunningProcess,
} from "./server-utils.js";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";

const SSH_FIXTURE_TEST_TIMEOUT_MS = 30_000;
let sshEnvLabUnsupportedReason: string | null = null;

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function assertShellSyntax(script: string) {
  await new Promise<void>((resolve, reject) => {
    execFile("sh", ["-n", "-c", script], (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

function readShellQuotedWord(value: string, start = 0) {
  if (value[start] !== "'") {
    throw new Error("Expected a single-quoted shell word");
  }
  let decoded = "";
  let cursor = start + 1;
  while (cursor < value.length) {
    const quote = value.indexOf("'", cursor);
    if (quote < 0) throw new Error("Unterminated single-quoted shell word");
    decoded += value.slice(cursor, quote);
    if (value.startsWith(`'"'"'`, quote)) {
      decoded += "'";
      cursor = quote + 5;
      continue;
    }
    return { decoded, end: quote + 1 };
  }
  throw new Error("Unterminated single-quoted shell word");
}

async function waitForOutput(read: () => string, expected: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (read().includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(read()).toContain(expected);
}

async function waitForRunningProcess(runId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = runningProcesses.get(runId);
    if (running) return running;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return runningProcesses.get(runId) ?? null;
}

async function startSshEnvLabFixtureOrSkip(statePath: string, label: string) {
  if (sshEnvLabUnsupportedReason) {
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }

  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    sshEnvLabUnsupportedReason = support.reason ?? "unsupported environment";
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }

  try {
    return await startSshEnvLabFixture({ statePath });
  } catch (error) {
    sshEnvLabUnsupportedReason = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping ${label}: ${sshEnvLabUnsupportedReason}`);
    return null;
  }
}

interface ParsedProgressLine {
  raw: string;
  percent: number | null;
  doneMb: number | null;
  totalMb: number | null;
}

function parseProgressLine(line: string): ParsedProgressLine {
  const trimmed = line.trimEnd();
  const percentMatch = trimmed.match(/:\s*(\d+)%\s*\(([\d.]+)\/([\d.]+) MB\)$/);
  if (percentMatch) {
    return {
      raw: trimmed,
      percent: Number.parseInt(percentMatch[1]!, 10),
      doneMb: Number.parseFloat(percentMatch[2]!),
      totalMb: Number.parseFloat(percentMatch[3]!),
    };
  }
  const mbMatch = trimmed.match(/:\s*([\d.]+) MB$/);
  if (mbMatch) {
    return { raw: trimmed, percent: null, doneMb: Number.parseFloat(mbMatch[1]!), totalMb: null };
  }
  return { raw: trimmed, percent: null, doneMb: null, totalMb: null };
}

describe("ssh env-lab fixture", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("starts an isolated sshd fixture and executes commands through it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const quotedWorkspace = JSON.stringify(started.workspaceDir);
    const result = await runSshCommand(
      config,
      `cd ${quotedWorkspace} && pwd`,
    );

    expect(result.stdout.trim()).toBe(started.workspaceDir);
    const status = await readSshEnvLabFixtureStatus(statePath);
    expect(status.running).toBe(true);

    await stopSshEnvLabFixture(statePath);

    const stopped = await readSshEnvLabFixtureStatus(statePath);
    expect(stopped.running).toBe(false);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("forwards stdin to remote SSH commands", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH stdin forwarding test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remotePath = path.posix.join(started.workspaceDir, "stdin-forwarded.txt");

    await runSshCommand(
      config,
      `cat > ${JSON.stringify(remotePath)}`,
      {
        stdin: "hello over ssh stdin\n",
        timeoutMs: 30_000,
        maxBuffer: 256 * 1024,
      },
    );

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(remotePath)}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    expect(result.stdout).toBe("hello over ssh stdin\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("does not treat an unrelated reused pid as the running fixture", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    await stopSshEnvLabFixture(statePath);
    await mkdir(path.dirname(statePath), { recursive: true });

    await writeFile(
      statePath,
      JSON.stringify({ ...started, pid: process.pid }, null, 2),
      { mode: 0o600 },
    );

    const staleStatus = await readSshEnvLabFixtureStatus(statePath);
    expect(staleStatus.running).toBe(false);

    const restarted = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture restart test");
    if (!restarted) return;
    expect(restarted.pid).not.toBe(process.pid);

    await stopSshEnvLabFixture(statePath);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("rejects invalid environment variable keys when constructing SSH spawn targets", async () => {
    await expect(
      buildSshSpawnTarget({
        runId: "invalid-env-key-test",
        spec: {
          host: "ssh.example.test",
          port: 22,
          username: "ssh-user",
          remoteCwd: "/srv/paperclip/workspace",
          remoteWorkspacePath: "/srv/paperclip/workspace",
          privateKey: null,
          knownHosts: null,
          strictHostKeyChecking: true,
        },
        command: "env",
        args: [],
        env: {
          "BAD KEY": "value",
        },
      }),
    ).rejects.toThrow("Invalid SSH environment variable key: BAD KEY");
  });

  it("constructs a syntactically valid, gated SSH supervisor", async () => {
    const target = await buildSshSpawnTarget({
      runId: "supervisor-syntax-test",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "ssh-user",
        remoteCwd: "/srv/paperclip/work space",
        remoteWorkspacePath: "/srv/paperclip/work space",
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: true,
      },
      command: "printf",
      args: ["apostrophe's value"],
      env: { SAFE_VALUE: "space and apostrophe's value" },
    });

    try {
      const remoteArgument = target.args.at(-1) ?? "";
      expect(remoteArgument.startsWith("sh -c ")).toBe(true);
      const supervisor = readShellQuotedWord(remoteArgument, "sh -c ".length).decoded;
      await assertShellSyntax(supervisor);
      expect(supervisor).toContain("setsid -w");
      expect(supervisor).toContain("ready_file");
      expect(supervisor).toContain("gate_file");
      expect(supervisor.indexOf("setsid -w")).toBeLessThan(supervisor.indexOf(".profile"));
      const gatedPrefix = "setsid -w sh -c ";
      const gatedStart = supervisor.indexOf(gatedPrefix);
      expect(gatedStart).toBeGreaterThanOrEqual(0);
      const gated = readShellQuotedWord(supervisor, gatedStart + gatedPrefix.length).decoded;
      await assertShellSyntax(gated);
      const profiledPrefix = "exec sh -c ";
      const profiledStart = gated.indexOf(profiledPrefix);
      expect(profiledStart).toBeGreaterThanOrEqual(0);
      const profiled = readShellQuotedWord(gated, profiledStart + profiledPrefix.length).decoded;
      await assertShellSyntax(profiled);
      expect(profiled).toContain(".profile");
      expect(supervisor).toContain('[ -z "${child_pgid:-}" ] || child_group_is_alive');
    } finally {
      await target.cleanup();
    }
  });

  it("recovers a nonce-bound PGID from readiness after a pre-ready unconfirmed state", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-ready-recovery-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH readiness-recovery fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const runId = randomUUID();
    const target = await buildSshSpawnTarget({
      runId,
      spec: { ...config, remoteCwd: started.workspaceDir },
      command: "true",
      args: [],
      env: {},
    });
    const remoteArgument = target.args.at(-1) ?? "";
    const supervisor = readShellQuotedWord(remoteArgument, "sh -c ".length).decoded;
    const nonceAssignment = supervisor.match(/^control_nonce=(.+)$/m)?.[1];
    expect(nonceAssignment).toBeTruthy();
    const nonce = readShellQuotedWord(nonceAssignment!).decoded;
    const controlDir = path.posix.join(started.workspaceDir, ".paperclip-runtime", "process-groups");
    const readyPath = path.posix.join(controlDir, `${runId}.ready`);
    const controlPath = path.posix.join(controlDir, `${runId}.state`);
    const markerPath = path.posix.join(started.workspaceDir, `ready-recovery-marker-${randomUUID()}`);

    try {
      const inner = [
        `printf 'ready:%s:%s\\n' ${JSON.stringify(nonce)} "$$" > ${JSON.stringify(readyPath)}`,
        "sleep 1",
        `printf late > ${JSON.stringify(markerPath)}`,
        "sleep 30",
      ].join("; ");
      await runSshCommand(
        config,
        [
          `mkdir -p ${JSON.stringify(controlDir)}`,
          `rm -f ${JSON.stringify(readyPath)} ${JSON.stringify(controlPath)} ${JSON.stringify(markerPath)}`,
          `nohup setsid sh -c ${shellQuote(inner)} >/dev/null 2>&1 </dev/null &`,
          `wait_count=0; while [ ! -s ${JSON.stringify(readyPath)} ] && [ "$wait_count" -lt 100 ]; do sleep 0.02; wait_count=$((wait_count + 1)); done`,
          `test -s ${JSON.stringify(readyPath)}`,
          `printf 'unconfirmed:%s\\n' ${JSON.stringify(nonce)} > ${JSON.stringify(controlPath)}`,
        ].join("; "),
        { sourceProfiles: false, timeoutMs: 10_000 },
      );

      await expect(target.terminateRemote({ confirmationTimeoutMs: 5_000 })).resolves.toMatchObject({
        scope: "ssh",
        confirmedExited: true,
        forceKilled: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const marker = await runSshCommand(
        config,
        `test ! -e ${JSON.stringify(markerPath)} && printf absent`,
        { sourceProfiles: false },
      );
      expect(marker.stdout).toBe("absent");
    } finally {
      await target.terminateRemote({ confirmationTimeoutMs: 2_000 }).catch(() => undefined);
      await target.cleanup();
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("confirms remote group cancellation before a delayed descendant can write", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-cancel-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH cancellation fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const markerPath = path.posix.join(started.workspaceDir, `late-write-${randomUUID()}`);
    const runId = randomUUID();
    let output = "";
    const resultPromise = runChildProcess(
      runId,
      "sh",
      [
        "-c",
        `(sleep 1; printf late > ${JSON.stringify(markerPath)}) & printf 'READY\\n'; wait`,
      ],
      {
        cwd: started.workspaceDir,
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        remoteExecution: { ...config, remoteCwd: started.workspaceDir },
        onLog: async (_stream, chunk) => {
          output += chunk;
        },
      },
    );

    try {
      await waitForOutput(() => output, "READY");
      const running = runningProcesses.get(runId);
      expect(running?.terminateRemote).toBeTypeOf("function");
      const evidence = await running!.terminateRemote!({ confirmationTimeoutMs: 5_000 });
      expect(evidence).toMatchObject({
        scope: "ssh",
        confirmedExited: true,
      });
      await resultPromise;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const marker = await runSshCommand(config, `test ! -e ${JSON.stringify(markerPath)} && printf absent`, {
        sourceProfiles: false,
      });
      expect(marker.stdout).toBe("absent");
    } finally {
      const running = runningProcesses.get(runId);
      if (running?.terminateRemote) {
        await running.terminateRemote({ confirmationTimeoutMs: 2_000 }).catch(() => undefined);
      }
      if (running) signalRunningProcess(running, "SIGKILL");
      await resultPromise.catch(() => undefined);
      runningProcesses.delete(runId);
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("tombstones an SSH launch cancelled immediately after the local client spawns", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-pre-ready-cancel-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH pre-ready cancellation fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const markerPath = path.posix.join(started.workspaceDir, `pre-ready-write-${randomUUID()}`);
    const runId = randomUUID();
    const resultPromise = runChildProcess(
      runId,
      "sh",
      ["-c", `sleep 1; printf late > ${JSON.stringify(markerPath)}`],
      {
        cwd: started.workspaceDir,
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        remoteExecution: { ...config, remoteCwd: started.workspaceDir },
        onLog: async () => {},
      },
    );

    try {
      const running = await waitForRunningProcess(runId);
      expect(running?.terminateRemote).toBeTypeOf("function");
      const evidence = await running!.terminateRemote!({ confirmationTimeoutMs: 5_000 });
      expect(evidence.confirmedExited).toBe(true);
      await resultPromise;
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      const marker = await runSshCommand(config, `test ! -e ${JSON.stringify(markerPath)} && printf absent`, {
        sourceProfiles: false,
      });
      expect(marker.stdout).toBe("absent");
    } finally {
      const running = runningProcesses.get(runId);
      if (running?.terminateRemote) {
        await running.terminateRemote({ confirmationTimeoutMs: 2_000 }).catch(() => undefined);
      }
      if (running) signalRunningProcess(running, "SIGKILL");
      await resultPromise.catch(() => undefined);
      runningProcesses.delete(runId);
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("retains remote termination control after a fenced SSH client closes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-control-retention-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH control-retention fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const runId = randomUUID();
    let output = "";
    const resultPromise = runChildProcess(
      runId,
      "sh",
      ["-c", "printf 'READY\\n'; sleep 0.25"],
      {
        cwd: started.workspaceDir,
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        remoteExecution: { ...config, remoteCwd: started.workspaceDir },
        onLog: async (_stream, chunk) => {
          output += chunk;
        },
      },
    );

    try {
      await waitForOutput(() => output, "READY");
      await resultPromise;
      expect(runningProcesses.has(runId)).toBe(false);

      const terminateRemote = getRemoteProcessTerminationControl(runId);
      expect(terminateRemote).toBeTypeOf("function");
      expect(requestProcessCancellation(runId)).toEqual({ pendingStartCancelled: false });
      await expect(terminateRemote!({ confirmationTimeoutMs: 2_000 })).resolves.toMatchObject({
        scope: "ssh",
        confirmedExited: true,
        outcome: "already_exited",
      });
    } finally {
      const running = runningProcesses.get(runId);
      if (running) signalRunningProcess(running, "SIGKILL");
      await resultPromise.catch(() => undefined);
      runningProcesses.delete(runId);
      clearProcessCancellation(runId);
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("confirms a prior SSH group before a sequential same-run attempt", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-sequential-attempt-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH sequential-attempt fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const runId = randomUUID();

    try {
      const first = await runChildProcess(runId, "printf", ["first"], {
        cwd: started.workspaceDir,
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        remoteExecution: { ...config, remoteCwd: started.workspaceDir },
        onLog: async () => {},
      });
      expect(first.stdout).toBe("first");
      expect(getRemoteProcessTerminationControl(runId)).toBeTypeOf("function");

      const second = await runChildProcess(runId, "printf", ["second"], {
        cwd: started.workspaceDir,
        env: {},
        timeoutSec: 0,
        graceSec: 1,
        remoteExecution: { ...config, remoteCwd: started.workspaceDir },
        onLog: async () => {},
      });
      expect(second.stdout).toBe("second");
    } finally {
      const terminateRemote = getRemoteProcessTerminationControl(runId);
      if (terminateRemote) {
        await terminateRemote({ confirmationTimeoutMs: 2_000 }).catch(() => undefined);
      }
      const running = runningProcesses.get(runId);
      if (running) signalRunningProcess(running, "SIGKILL");
      runningProcesses.delete(runId);
      clearProcessCancellation(runId);
    }
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("syncs a local directory into the remote fixture workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "message.txt"), "hello from paperclip\n", "utf8");
    await writeFile(path.join(localDir, "._message.txt"), "should never sync\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH env-lab fixture test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
    });

    const result = await runSshCommand(
      config,
      `cat ${JSON.stringify(path.posix.join(remoteDir, "message.txt"))} && if [ -e ${JSON.stringify(path.posix.join(remoteDir, "._message.txt"))} ]; then echo appledouble-present; fi`,
    );

    expect(result.stdout).toContain("hello from paperclip");
    expect(result.stdout).not.toContain("appledouble-present");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports throttled upload progress with a clamped percent and terminal 100% line", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(localDir, { recursive: true });
    // Multiple files large enough that tar emits several pipe chunks, so the
    // byte counter crosses several step boundaries before the stream closes.
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(localDir, `blob-${index}.bin`), Buffer.alloc(256 * 1024, index + 1));
    }

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH upload progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-progress");

    const lines: ParsedProgressLine[] = [];
    await syncDirectoryToSsh({
      spec: { ...config, remoteCwd: started.workspaceDir },
      localDir,
      remoteDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
      progressLabel: "workspace",
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.raw).toContain("Syncing workspace to ssh");
    }
    // Monotonically increasing byte counts.
    const doneSeries = lines.map((line) => line.doneMb ?? 0);
    for (let index = 1; index < doneSeries.length; index += 1) {
      expect(doneSeries[index]!).toBeGreaterThanOrEqual(doneSeries[index - 1]!);
    }
    // Percent clamped to <= 99% on every line emitted before the stream closed.
    for (const line of lines.slice(0, -1)) {
      if (line.percent != null) expect(line.percent).toBeLessThanOrEqual(99);
    }
    // Terminal completion line is 100% with matching done/total.
    const last = lines.at(-1)!;
    expect(last.percent).toBe(100);
    expect(last.doneMb).toBe(last.totalMb);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports restore progress with a terminal completion line", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-overlay");
    const restoreDir = path.join(rootDir, "restore-target");

    await mkdir(localDir, { recursive: true });
    await mkdir(restoreDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      await writeFile(path.join(localDir, `blob-${index}.bin`), Buffer.alloc(256 * 1024, index + 1));
    }

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH restore progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;
    const remoteDir = path.posix.join(started.workspaceDir, "restore-source");

    await syncDirectoryToSsh({ spec, localDir, remoteDir });

    const lines: ParsedProgressLine[] = [];
    await syncDirectoryFromSsh({
      spec,
      remoteDir,
      localDir: restoreDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
      progressLabel: "workspace",
    });

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.raw).toContain("Restoring workspace from ssh");
    }
    // Terminal completion line: either an exact 100% (probe succeeded) or a
    // final MB-received line (probe unavailable). Either is a valid terminal.
    const last = lines.at(-1)!;
    expect(last.percent === 100 || (last.percent === null && last.doneMb !== null)).toBe(true);
    // The restored files round-tripped through the byte-counting transport.
    await expect(readFile(path.join(restoreDir, "blob-0.bin"))).resolves.toEqual(
      Buffer.alloc(256 * 1024, 1),
    );
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("reports exact git-history import percentage from the known bundle size", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.bin"), Buffer.alloc(256 * 1024, 7));
    await git(localRepo, ["add", "tracked.bin"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH git import progress test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = { ...config, remoteCwd: started.workspaceDir } as const;

    const lines: ParsedProgressLine[] = [];
    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
      onProgress: (line) => {
        lines.push(parseProgressLine(line));
      },
    });

    const importLines = lines.filter((line) => line.raw.includes("Importing git history to ssh"));
    expect(importLines.length).toBeGreaterThan(0);
    // Known bundle size -> exact percentage with no "workspace" label.
    for (const line of importLines) {
      expect(line.raw).not.toContain("workspace");
      expect(line.percent).not.toBeNull();
    }
    const lastImport = importLines.at(-1)!;
    expect(lastImport.percent).toBe(100);
    expect(lastImport.doneMb).toBe(lastImport.totalMb);
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("can dereference local symlinks while syncing to the remote fixture", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const sourceDir = path.join(rootDir, "source");
    const localDir = path.join(rootDir, "local-overlay");

    await mkdir(sourceDir, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(sourceDir, "auth.json"), "{\"token\":\"secret\"}\n", "utf8");
    await symlink(path.join(sourceDir, "auth.json"), path.join(localDir, "auth.json"));

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH symlink sync test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "overlay-follow-links");

    await syncDirectoryToSsh({
      spec: {
        ...config,
        remoteCwd: started.workspaceDir,
      },
      localDir,
      remoteDir,
      followSymlinks: true,
    });

    const result = await runSshCommand(
      config,
      `if [ -L ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))} ]; then echo symlink; else echo regular; fi && cat ${JSON.stringify(path.posix.join(remoteDir, "auth.json"))}`,
    );

    expect(result.stdout).toContain("regular");
    expect(result.stdout).toContain("{\"token\":\"secret\"}");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("round-trips a git workspace through the SSH fixture", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await writeFile(path.join(localRepo, "._tracked.txt"), "should stay local only\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);
    const originalHead = await git(localRepo, ["rev-parse", "HEAD"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "dirty local\n", "utf8");
    await writeFile(path.join(localRepo, "untracked.txt"), "from local\n", "utf8");

    const started = await startSshEnvLabFixtureOrSkip(statePath, "SSH workspace round-trip test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    await prepareWorkspaceForSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const remoteStatus = await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git status --short`,
    );
    expect(remoteStatus.stdout).toContain("M tracked.txt");
    expect(remoteStatus.stdout).toContain("?? untracked.txt");
    expect(remoteStatus.stdout).not.toContain("._tracked.txt");

    await runSshCommand(
      config,
      `cd ${JSON.stringify(started.workspaceDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && git add tracked.txt untracked.txt && git commit -m "remote update" >/dev/null && printf "remote dirty\\n" > tracked.txt && printf "remote extra\\n" > remote-only.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await restoreWorkspaceFromSshExecution({
      spec,
      localDir: localRepo,
      remoteDir: started.workspaceDir,
    });

    const restoredHead = await git(localRepo, ["rev-parse", "HEAD"]);
    expect(restoredHead).not.toBe(originalHead);
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    expect(await git(localRepo, ["status", "--short"])).toContain("M tracked.txt");
    expect(await git(localRepo, ["status", "--short"])).not.toContain("._tracked.txt");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves both concurrent SSH restores in a shared git workspace", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "concurrent SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    expect(preparedA.workspaceRemoteDir).not.toBe(preparedB.workspaceRemoteDir);

    await runSshCommand(
      config,
      `printf "from run a\\n" > ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "run-a.txt"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `printf "from run b\\n" > ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "run-b.txt"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await Promise.all([
      preparedA.restoreWorkspace(),
      preparedB.restoreWorkspace(),
    ]);

    await expect(readFile(path.join(localRepo, "run-a.txt"), "utf8")).resolves.toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "run-b.txt"), "utf8")).resolves.toBe("from run b\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("preserves nested per-run files across sequential SSH restores with stale baselines", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "sequential nested SSH restore test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `mkdir -p ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "manual-qa/environment-matrix/ssh"))} && printf "from run a\\n" > ${JSON.stringify(path.posix.join(preparedA.workspaceRemoteDir, "manual-qa/environment-matrix/ssh/claude_local.md"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `mkdir -p ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "manual-qa/environment-matrix/ssh"))} && printf "from run b\\n" > ${JSON.stringify(path.posix.join(preparedB.workspaceRemoteDir, "manual-qa/environment-matrix/ssh/codex_local.md"))}`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await preparedA.restoreWorkspace();
    await preparedB.restoreWorkspace();

    await expect(readFile(path.join(localRepo, "manual-qa/environment-matrix/ssh/claude_local.md"), "utf8")).resolves
      .toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "manual-qa/environment-matrix/ssh/codex_local.md"), "utf8")).resolves
      .toBe("from run b\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("round-trips remote git commits through the managed runtime restore path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "managed-runtime SSH git round-trip test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "committed\\n" > tracked.txt && git add tracked.txt && git commit -m "remote update" >/dev/null && printf "dirty remote\\n" > tracked.txt`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe("remote update");
    await expect(readFile(path.join(localRepo, "tracked.txt"), "utf8")).resolves.toBe("dirty remote\n");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("propagates remote commits to the local worktree with no git remote configured (no-remote-git contract)", async () => {
    // Locks in the architectural contract documented in
    // packages/adapter-utils/README.md and packages/adapters/AUTHORING.md:
    // the local execution-workspace cwd is the only persistence boundary
    // across runs. No adapter may depend on a git remote for cross-run state.
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    // Assert there is no git remote configured before we begin, and verify
    // that no point in the round-trip introduces one. `git remote` returns an
    // empty string when no remotes exist (and exit code 0).
    expect(await git(localRepo, ["remote"])).toBe("");

    const started = await startSshEnvLabFixtureOrSkip(
      statePath,
      "no-remote-git contract test",
    );
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-no-remote",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    // Remote commit lands a deliverable that must show up locally via
    // sync-back alone — no `git push`, no fetch from any origin.
    await runSshCommand(
      config,
      `cd ${JSON.stringify(prepared.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "deliverable\\n" > tracked.txt && git add tracked.txt && git commit -m "remote-only commit" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await prepared.restoreWorkspace();

    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toBe(
      "remote-only commit",
    );
    expect(await readFile(path.join(localRepo, "tracked.txt"), "utf8")).toBe(
      "deliverable\n",
    );
    // Final assertion: still no git remote — restore did not silently add one.
    expect(await git(localRepo, ["remote"])).toBe("");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);

  it("merges concurrent remote commits through the managed runtime restore path", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-fixture-"));
    cleanupDirs.push(rootDir);
    const statePath = path.join(rootDir, "state.json");
    const localRepo = path.join(rootDir, "local-workspace");

    await mkdir(localRepo, { recursive: true });
    await git(localRepo, ["init"]);
    await git(localRepo, ["checkout", "-b", "main"]);
    await git(localRepo, ["config", "user.name", "Paperclip Test"]);
    await git(localRepo, ["config", "user.email", "test@paperclip.dev"]);
    await writeFile(path.join(localRepo, "tracked.txt"), "base\n", "utf8");
    await git(localRepo, ["add", "tracked.txt"]);
    await git(localRepo, ["commit", "-m", "initial"]);

    const started = await startSshEnvLabFixtureOrSkip(statePath, "concurrent managed-runtime SSH git merge test");
    if (!started) return;
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const preparedA = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit-a",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });
    const preparedB = await prepareRemoteManagedRuntime({
      spec,
      runId: "run-commit-b",
      adapterKey: "test-adapter",
      workspaceLocalDir: localRepo,
    });

    await runSshCommand(
      config,
      `cd ${JSON.stringify(preparedA.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "from run a\\n" > run-a.txt && git add run-a.txt && git commit -m "remote update a" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );
    await runSshCommand(
      config,
      `cd ${JSON.stringify(preparedB.workspaceRemoteDir)} && git config user.name "Paperclip SSH" && git config user.email "ssh@paperclip.dev" && printf "from run b\\n" > run-b.txt && git add run-b.txt && git commit -m "remote update b" >/dev/null`,
      { timeoutMs: 30_000, maxBuffer: 256 * 1024 },
    );

    await Promise.all([
      preparedA.restoreWorkspace(),
      preparedB.restoreWorkspace(),
    ]);

    await expect(readFile(path.join(localRepo, "run-a.txt"), "utf8")).resolves.toBe("from run a\n");
    await expect(readFile(path.join(localRepo, "run-b.txt"), "utf8")).resolves.toBe("from run b\n");
    expect(await git(localRepo, ["log", "-1", "--pretty=%s"])).toContain("Paperclip SSH sync merge");

    const recentSubjects = await git(localRepo, ["log", "--pretty=%s", "-3"]);
    expect(recentSubjects).toContain("remote update a");
    expect(recentSubjects).toContain("remote update b");
  }, SSH_FIXTURE_TEST_TIMEOUT_MS);
  async function assertSecurityQuarantineIsLocalOnly(
    gitBacked: boolean,
  ): Promise<void> {
    const rootDir = await mkdtemp(
      path.join(os.tmpdir(), "paperclip-ssh-quarantine-"),
    );
    cleanupDirs.push(rootDir);

    const statePath = path.join(rootDir, "state.json");
    const localDir = path.join(rootDir, "local-workspace");
    const quarantineDir = path.join(localDir, ".security-quarantine");
    const quarantineFile = path.join(quarantineDir, "local-only.ndjson");
    const workspaceFile = path.join(localDir, "workspace.txt");

    await mkdir(quarantineDir, { recursive: true });
    await writeFile(quarantineFile, "must remain local\n", "utf8");
    await chmod(quarantineFile, 0o000);
    const quarantineBefore = await stat(quarantineFile);

    await writeFile(workspaceFile, "local value\n", "utf8");

    if (gitBacked) {
      await git(localDir, ["init"]);
      await git(localDir, ["checkout", "-b", "main"]);
      await git(localDir, ["config", "user.name", "Paperclip Test"]);
      await git(localDir, ["config", "user.email", "test@paperclip.dev"]);
      await git(localDir, ["add", "workspace.txt"]);
      await git(localDir, ["commit", "-m", "initial"]);
    }

    const started = await startSshEnvLabFixtureOrSkip(
      statePath,
      `${gitBacked ? "git" : "non-git"} security quarantine test`,
    );
    if (!started) return;

    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = {
      ...config,
      remoteCwd: started.workspaceDir,
    } as const;

    const prepared = await prepareRemoteManagedRuntime({
      spec,
      runId: gitBacked ? "quarantine-git" : "quarantine-non-git",
      adapterKey: "test-adapter",
      workspaceLocalDir: localDir,
    });

    const remoteWorkspaceFile = path.posix.join(
      prepared.workspaceRemoteDir,
      "workspace.txt",
    );
    const remoteQuarantineDir = path.posix.join(
      prepared.workspaceRemoteDir,
      ".security-quarantine",
    );

    const uploadCheck = await runSshCommand(
      config,
      [
        `test -f ${JSON.stringify(remoteWorkspaceFile)}`,
        `test ! -e ${JSON.stringify(remoteQuarantineDir)}`,
        'printf "workspace-upload-clean\\n"',
      ].join(" && "),
    );

    expect(uploadCheck.stdout).toContain("workspace-upload-clean");

    await runSshCommand(
      config,
      [
        `mkdir -p ${JSON.stringify(remoteQuarantineDir)}`,
        `printf "must not restore\\n" > ${JSON.stringify(
          path.posix.join(remoteQuarantineDir, "remote-only.ndjson"),
        )}`,
        `printf "remote value\\n" > ${JSON.stringify(remoteWorkspaceFile)}`,
      ].join(" && "),
    );

    await prepared.restoreWorkspace();

    await expect(readFile(workspaceFile, "utf8")).resolves.toBe(
      "remote value\n",
    );

    const quarantineAfter = await stat(quarantineFile);
    expect(quarantineAfter.ino).toBe(quarantineBefore.ino);
    expect(quarantineAfter.mode & 0o777).toBe(0);

    await expect(
      stat(path.join(quarantineDir, "remote-only.ndjson")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }

  it(
    "keeps security quarantine local-only for non-git managed workspaces",
    async () => {
      await assertSecurityQuarantineIsLocalOnly(false);
    },
    SSH_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    "keeps security quarantine local-only for git-backed managed workspaces",
    async () => {
      await assertSecurityQuarantineIsLocalOnly(true);
    },
    SSH_FIXTURE_TEST_TIMEOUT_MS,
  );

  it(
    "still rejects unreadable ordinary workspace files",
    async () => {
      if (
        typeof process.getuid === "function" &&
        process.getuid() === 0
      ) {
        console.warn(
          "Skipping unreadable ordinary workspace test while running as root",
        );
        return;
      }

      const rootDir = await mkdtemp(
        path.join(os.tmpdir(), "paperclip-ssh-unreadable-"),
      );
      cleanupDirs.push(rootDir);

      const statePath = path.join(rootDir, "state.json");
      const localDir = path.join(rootDir, "local-workspace");
      const blockedFile = path.join(localDir, "blocked.txt");

      await mkdir(localDir, { recursive: true });
      await writeFile(blockedFile, "must fail\n", "utf8");
      await chmod(blockedFile, 0o000);

      const started = await startSshEnvLabFixtureOrSkip(
        statePath,
        "unreadable ordinary workspace test",
      );
      if (!started) return;

      const config = await buildSshEnvLabFixtureConfig(started);

      await expect(
        prepareRemoteManagedRuntime({
          spec: {
            ...config,
            remoteCwd: started.workspaceDir,
          },
          runId: "unreadable-ordinary",
          adapterKey: "test-adapter",
          workspaceLocalDir: localDir,
        }),
      ).rejects.toThrow(/Permission denied|Cannot open/i);
    },
    SSH_FIXTURE_TEST_TIMEOUT_MS,
  );

});
