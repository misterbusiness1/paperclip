import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  RunProcessResult,
  RunningProcessTransportStopEvidence,
} from "@paperclipai/adapter-utils/server-utils";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  stopRunningProcessTransport,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async (..._args: unknown[]): Promise<RunProcessResult> => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "remote failure",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  stopRunningProcessTransport: vi.fn(async (..._args: unknown[]): Promise<RunningProcessTransportStopEvidence> => ({
    kind: "process_transport_stop" as const,
    handled: true,
    scope: "ssh" as const,
    remote: null,
  })),
  syncDirectoryToSsh: vi.fn(async () => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
    stopRunningProcessTransport,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { UnconfirmedSshProcessTerminationError } from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./execute.js";
import { CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS } from "./output-inactivity-monitor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("codex remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function startMonitoredRemoteExecution(runId: string) {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-monitor-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => undefined);

    return {
      onLog,
      execution: execute({
        runId,
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CodexCoder",
          adapterType: "codex_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "codex",
          engine: "cli",
          env: { CODEX_HOME: codexHomeDir },
          outputInactivityTimeoutMs: 10,
        },
        context: {
          paperclipWorkspace: {
            cwd: workspaceDir,
            source: "project_primary",
          },
        },
        executionTransport: {
          remoteExecution: {
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteWorkspacePath: "/remote/workspace",
            remoteCwd: "/remote/workspace",
            privateKey: "PRIVATE KEY",
            knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
            strictHostKeyChecking: true,
          },
        },
        onLog,
      }),
    };
  }

  function installDeferredProcess() {
    const spawned = deferred<void>();
    const result = deferred<RunProcessResult>();
    runChildProcess.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as {
        onSpawn?: (meta: {
          pid: number;
          processGroupId: number | null;
          startedAt: string;
        }) => Promise<void>;
      };
      await options.onSpawn?.({
        // Intentionally not a host PID. Sandbox/provider onSpawn metadata must
        // never be passed directly to process.kill by the Codex adapter.
        pid: 987_654,
        processGroupId: null,
        startedAt: new Date().toISOString(),
      });
      spawned.resolve(undefined);
      return await result.promise;
    });
    return { spawned: spawned.promise, result };
  }

  const stoppedProcessResult = (overrides: Partial<RunProcessResult> = {}): RunProcessResult => ({
    exitCode: null,
    signal: "SIGTERM",
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 987_654,
    startedAt: new Date().toISOString(),
    ...overrides,
  });

  it("prepares the workspace, syncs CODEX_HOME, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(rootDir, "instructions.md"), "Use the remote workspace.\n", "utf8");
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    const alternateWorkspaceDir = path.join(rootDir, "alternate-workspace");
    await mkdir(alternateWorkspaceDir, { recursive: true });

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-codex",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    // The home asset now syncs a curated *staged* allowlist dir, not the raw
    // managed CODEX_HOME, and carries no `exclude` denylist.
    const homeSyncArgs = (syncDirectoryToSsh.mock.calls[0] as unknown[])?.[0] as {
      localDir: string;
      remoteDir: string;
      followSymlinks?: boolean;
      exclude?: string[];
    };
    expect(homeSyncArgs.localDir).not.toBe(codexHomeDir);
    expect(homeSyncArgs.localDir).toContain("paperclip-codex-home-sync");
    expect(homeSyncArgs.remoteDir).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(homeSyncArgs.followSymlinks).toBe(true);
    expect(homeSyncArgs.exclude).toBeUndefined();

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).not.toContain("--skip-git-repo-check");
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("stages only the allowlist into the home asset: keeps config.toml/skills/auth, drops session+sqlite state, no exclude", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-allowlist-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });

    // Seed the managed home with the files Codex needs (config.toml carries a
    // provider-routing block; skills injected) plus large runtime decoys the
    // old 4-name denylist missed.
    await writeFile(path.join(codexHomeDir, "auth.json"), '{"tokens":{"account_id":"a","refresh_token":"r"}}', "utf8");
    await writeFile(
      path.join(codexHomeDir, "config.toml"),
      'model_provider = "bifrost"\n\n[model_providers.bifrost]\nname = "bifrost"\n',
      "utf8",
    );
    await writeFile(path.join(codexHomeDir, "instructions.md"), "hi\n", "utf8");
    await mkdir(path.join(codexHomeDir, "skills", "demo"), { recursive: true });
    await writeFile(path.join(codexHomeDir, "skills", "demo", "SKILL.md"), "# demo\n", "utf8");
    // Decoys:
    await writeFile(path.join(codexHomeDir, "logs_2.sqlite"), "x", "utf8");
    await writeFile(path.join(codexHomeDir, "state_5.sqlite"), "x", "utf8");
    await mkdir(path.join(codexHomeDir, "sessions"), { recursive: true });
    await writeFile(path.join(codexHomeDir, "sessions", "rollout.jsonl"), "x", "utf8");
    await mkdir(path.join(codexHomeDir, "tmp"), { recursive: true });
    await symlink("/usr/bin/env", path.join(codexHomeDir, "tmp", "arg0"));

    // Snapshot the staged dir contents at sync time — execute() removes the
    // staged temp dir on teardown, so we cannot read it after execute returns.
    let stagedSnapshot:
      | { localDir: string; entries: string[]; skillEntries: string[]; configToml: string; authJson: string }
      | null = null;
    (syncDirectoryToSsh as unknown as {
      mockImplementationOnce: (fn: (args: { localDir: string }) => Promise<void>) => void;
    }).mockImplementationOnce(async (args: { localDir: string }) => {
      const entries = (await readdir(args.localDir)).sort();
      const skillEntries = entries.includes("skills")
        ? (await readdir(path.join(args.localDir, "skills"))).sort()
        : [];
      const configToml = entries.includes("config.toml")
        ? await readFile(path.join(args.localDir, "config.toml"), "utf8")
        : "";
      const authJson = entries.includes("auth.json")
        ? await readFile(path.join(args.localDir, "auth.json"), "utf8")
        : "";
      stagedSnapshot = { localDir: args.localDir, entries, skillEntries, configToml, authJson };
    });

    await execute({
      runId: "run-allowlist",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(stagedSnapshot).not.toBeNull();
    const snap = stagedSnapshot as unknown as {
      localDir: string;
      entries: string[];
      skillEntries: string[];
      configToml: string;
      authJson: string;
    };
    // Allowlist present; decoys gone.
    expect(snap.entries).toEqual(
      ["auth.json", "config.json", "config.toml", "instructions.md", "skills"]
        .filter((e) => e !== "config.json") // no config.json was seeded
        .sort(),
    );
    for (const decoy of ["logs_2.sqlite", "state_5.sqlite", "sessions", "tmp", "plugins"]) {
      expect(snap.entries).not.toContain(decoy);
    }
    // Phase-3 behavioral invariants: provider routing + skills + auth survive staging.
    expect(snap.configToml).toContain("[model_providers.bifrost]");
    expect(snap.configToml).toContain("model_provider");
    expect(snap.skillEntries).toContain("demo");
    expect(snap.authJson).toContain("refresh_token");

    // The staged temp dir is removed after execute completes (cleanup on teardown).
    await expect(readdir(snap.localDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not resume saved Codex sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "-",
    ]);
  });

  it("resumes saved Codex sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "resume",
      "session-123",
      "-",
    ]);
  });

  it("uses the provider-neutral execution target contract for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-target-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-target/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-target",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).toEqual([
      "exec",
      "--json",
      "resume",
      "session-123",
      "-",
    ]);
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
  });

  it("awaits the transport stop confirmation before returning an inactivity result", async () => {
    vi.useFakeTimers();
    const runId = "run-monitor-confirmation";
    const child = installDeferredProcess();
    const stop = deferred<RunningProcessTransportStopEvidence>();
    const confirmedStop = {
      kind: "process_transport_stop",
      handled: true,
      scope: "ssh",
      remote: {
        kind: "process_group_termination",
        scope: "ssh",
        target: "group",
        suspendSent: true,
        termSent: true,
        forceKilled: true,
        confirmedExited: true,
        outcome: "force_killed",
      },
    } satisfies RunningProcessTransportStopEvidence;
    stopRunningProcessTransport.mockReturnValueOnce(stop.promise);
    const { execution } = await startMonitoredRemoteExecution(runId);
    let settled = false;
    void execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    try {
      await child.spawned;
      await vi.advanceTimersByTimeAsync(10);
      expect(stopRunningProcessTransport).toHaveBeenCalledWith(runId, {
        localForceAfterMs: CODEX_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS,
      });

      child.result.resolve(stoppedProcessResult());
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);

      stop.resolve(confirmedStop);
      await expect(execution).resolves.toMatchObject({
        errorCode: "codex_output_inactivity_monitor",
        signal: "SIGKILL",
        resultJson: {
          outputInactivityMonitor: {
            kind: "output_inactivity",
            terminationSignal: "SIGKILL",
          },
        },
      });
      expect(stopRunningProcessTransport).toHaveBeenCalledTimes(1);
    } finally {
      child.result.resolve(stoppedProcessResult());
      stop.resolve(confirmedStop);
      await execution.catch(() => undefined);
    }
  });

  it("bubbles an unconfirmed SSH termination error from the inactivity stop", async () => {
    vi.useFakeTimers();
    const runId = "run-monitor-unconfirmed";
    const child = installDeferredProcess();
    const stop = deferred<RunningProcessTransportStopEvidence>();
    const terminationError = new UnconfirmedSshProcessTerminationError({
      runId,
      evidence: {
        kind: "process_group_termination",
        scope: "ssh",
        target: "group",
        suspendSent: false,
        termSent: false,
        forceKilled: false,
        confirmedExited: false,
        outcome: "not_started",
      },
    });
    stopRunningProcessTransport.mockReturnValueOnce(stop.promise);
    const { execution } = await startMonitoredRemoteExecution(runId);

    try {
      await child.spawned;
      await vi.advanceTimersByTimeAsync(10);
      stop.reject(terminationError);
      await vi.advanceTimersByTimeAsync(0);

      // A failed confirmation does not settle execute until the transport's
      // process result also drains, but it remains the authoritative error.
      child.result.resolve(stoppedProcessResult());
      await expect(execution).rejects.toBe(terminationError);
      expect(stopRunningProcessTransport).toHaveBeenCalledTimes(1);
    } finally {
      child.result.resolve(stoppedProcessResult());
      stop.reject(terminationError);
      await execution.catch(() => undefined);
    }
  });

  it("never signals a provider-style PID when no transport stop control is registered", async () => {
    vi.useFakeTimers();
    const runId = "run-monitor-provider-fallback";
    const child = installDeferredProcess();
    const killSpy = vi.spyOn(process, "kill");
    stopRunningProcessTransport.mockResolvedValueOnce({
      kind: "process_transport_stop",
      handled: false,
      scope: null,
      remote: null,
    });
    const { execution, onLog } = await startMonitoredRemoteExecution(runId);
    let settled = false;
    void execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    try {
      await child.spawned;
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(stopRunningProcessTransport).toHaveBeenCalledTimes(1);
      expect(killSpy).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      expect(onLog.mock.calls.some(([, chunk]) =>
        String(chunk).includes("waiting for provider timeout"))).toBe(true);

      child.result.resolve(stoppedProcessResult({ signal: null, timedOut: true }));
      await expect(execution).resolves.toMatchObject({
        errorCode: "codex_output_inactivity_monitor",
        signal: null,
      });
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      child.result.resolve(stoppedProcessResult({ signal: null, timedOut: true }));
      await execution.catch(() => undefined);
      killSpy.mockRestore();
    }
  });
});
