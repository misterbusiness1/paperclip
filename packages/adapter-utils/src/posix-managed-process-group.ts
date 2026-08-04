import { randomUUID } from "node:crypto";

export interface PosixManagedProcessGroupIdentity {
  kind: "posix_managed_process_group";
  version: 1;
  pid: number;
  processGroupId: number;
  nonce: string;
  startedAt: string;
}

export interface PosixManagedProcessGroupStopEvidence {
  kind: "posix_managed_process_group_stop";
  pid: number;
  processGroupId: number;
  suspendSent: boolean;
  termSent: boolean;
  forceKilled: boolean;
  confirmedExited: true;
  outcome: "already_exited" | "force_killed";
}

export interface PosixManagedProcessGroupStopResult {
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
}

/**
 * macOS can transiently return EPERM for a process-group signal while group
 * membership is changing. A retry is safe only because the terminator repeats
 * nonce-bound ownership verification and still requires confirmed group
 * absence. Persistent EPERM remains a hard failure with ownership files intact.
 */
export function isRetryablePosixManagedProcessGroupStopFailure(
  result: PosixManagedProcessGroupStopResult,
): boolean {
  return !result.timedOut && result.exitCode === 125 && /\bEPERM\b/.test(result.stderr);
}

function launcherSource() {
  return [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const [entrypoint, metadataFile, nonce, pidFile, logFile] = process.argv.slice(1);',
    'if (process.platform === "win32") throw new Error("Managed sandbox bridge process groups require a POSIX runtime.");',
    'if (!entrypoint || !metadataFile || !nonce) throw new Error("Managed process-group launch arguments are incomplete.");',
    'const validId = (value) => Number.isInteger(value) && value > 1;',
    'const groupAlive = (pgid) => {',
    '  try { process.kill(-pgid, 0); return true; }',
    '  catch (error) { if (error && error.code === "ESRCH") return false; if (error && error.code === "EPERM") return true; throw error; }',
    '};',
    'if (fs.existsSync(metadataFile)) {',
    '  let prior;',
    '  try { prior = JSON.parse(fs.readFileSync(metadataFile, "utf8")); }',
    '  catch { throw new Error("Existing managed process-group ownership metadata is invalid."); }',
    '  if (!validId(prior && prior.pid) || !validId(prior && prior.processGroupId) || typeof prior.nonce !== "string") {',
    '    throw new Error("Existing managed process-group ownership metadata is incomplete.");',
    '  }',
    '  if (groupAlive(prior.processGroupId)) {',
    '    throw new Error("An existing managed process group is still alive; refusing to overwrite its ownership metadata.");',
    '  }',
    '  fs.rmSync(metadataFile, { force: true });',
    '}',
    'let outputFd = null;',
    'if (logFile) { fs.mkdirSync(path.dirname(logFile), { recursive: true }); outputFd = fs.openSync(logFile, "a"); }',
    'const child = spawn(process.execPath, [entrypoint, "--paperclip-managed-nonce=" + nonce], {',
    '  cwd: process.cwd(),',
    '  env: {',
    '    ...process.env,',
    '    PAPERCLIP_MANAGED_PROCESS_NONCE: nonce,',
    '    PAPERCLIP_MANAGED_PROCESS_METADATA_FILE: metadataFile,',
    '  },',
    '  detached: true,',
    '  stdio: ["ignore", outputFd === null ? "ignore" : outputFd, outputFd === null ? "ignore" : outputFd],',
    '});',
    'let settled = false;',
    'const fail = (error) => {',
    '  if (settled) return;',
    '  settled = true;',
    '  if (outputFd !== null) { try { fs.closeSync(outputFd); } catch {} }',
    '  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");',
    '  process.exitCode = 1;',
    '};',
    'child.once("error", fail);',
    'child.once("spawn", () => {',
    '  if (settled) return;',
    '  const pid = child.pid;',
    '  if (!validId(pid)) { fail(new Error("Managed process-group launcher did not receive a valid child PID.")); return; }',
    '  const identity = { kind: "posix_managed_process_group", version: 1, pid, processGroupId: pid, nonce, startedAt: new Date().toISOString() };',
    '  try {',
    '    fs.mkdirSync(path.dirname(metadataFile), { recursive: true });',
    '    const metadataTemp = metadataFile + ".tmp-" + process.pid + "-" + nonce;',
    '    fs.writeFileSync(metadataTemp, JSON.stringify(identity) + "\\n", { encoding: "utf8", mode: 0o600 });',
    '    fs.renameSync(metadataTemp, metadataFile);',
    '    if (pidFile) {',
    '      const pidTemp = pidFile + ".tmp-" + process.pid + "-" + nonce;',
    '      fs.writeFileSync(pidTemp, String(pid) + "\\n", { encoding: "utf8", mode: 0o600 });',
    '      fs.renameSync(pidTemp, pidFile);',
    '    }',
    '  } catch (error) {',
    '    try { process.kill(-pid, "SIGKILL"); } catch {}',
    '    fail(error);',
    '    return;',
    '  }',
    '  settled = true;',
    '  child.unref();',
    '  if (outputFd !== null) { try { fs.closeSync(outputFd); } catch {} }',
    '  process.stdout.write(JSON.stringify(identity) + "\\n");',
    '});',
  ].join("\n");
}

function terminatorSource() {
  return [
    'const { spawnSync } = require("node:child_process");',
    'const fs = require("node:fs");',
    'const [pidRaw, pgidRaw, nonce, metadataFile, pidFile, timeoutRaw] = process.argv.slice(1);',
    'const pid = Number(pidRaw);',
    'const processGroupId = Number(pgidRaw);',
    'const confirmationTimeoutMs = Number(timeoutRaw);',
    'const validId = (value) => Number.isInteger(value) && value > 1;',
    'if (process.platform === "win32") throw new Error("Managed sandbox bridge process groups require a POSIX runtime.");',
    'if (!validId(pid) || !validId(processGroupId) || !nonce || !metadataFile) throw new Error("Managed process-group stop arguments are incomplete.");',
    'const describeTarget = (target) => target === pid ? "pid " + pid : "process group " + processGroupId + " (pid " + pid + ")";',
    'const signalError = (operation, target, signal, error) => {',
    '  const code = error && typeof error.code === "string" ? error.code : "UNKNOWN";',
    '  return new Error("Managed process-group " + operation + " failed for " + describeTarget(target) + " with " + signal + ": " + code + ".");',
    '};',
    'const probe = (target) => {',
    '  try { process.kill(target, 0); return "alive"; }',
    '  catch (error) {',
    '    if (error && error.code === "ESRCH") return "absent";',
    '    if (error && error.code === "EPERM") return "indeterminate";',
    '    throw signalError("liveness check", target, "signal 0", error);',
    '  }',
    '};',
    'const liveness = (target) => {',
    '  const state = probe(target);',
    '  if (state === "indeterminate") {',
    '    const error = new Error("EPERM"); error.code = "EPERM";',
    '    throw signalError("liveness check", target, "signal 0", error);',
    '  }',
    '  return state === "alive";',
    '};',
    'const send = (target, signal) => {',
    '  try { process.kill(target, signal); return true; }',
    '  catch (error) { if (error && error.code === "ESRCH") return false; throw signalError("signal", target, signal, error); }',
    '};',
    'const commandLine = () => {',
    '  const procPath = "/proc/" + pid + "/cmdline";',
    '  try { return fs.readFileSync(procPath).toString("utf8").replace(/\\0/g, " "); } catch {}',
    '  const result = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });',
    '  if (result.error || result.status !== 0) throw new Error("Managed process-group ownership could not be verified.");',
    '  return result.stdout;',
    '};',
    'const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    '(async () => {',
    '  const target = -processGroupId;',
    '  let suspendSent = false;',
    '  let termSent = false;',
    '  let forceKilled = false;',
    '  let outcome = "already_exited";',
    '  if (liveness(target)) {',
    '    if (liveness(pid)) {',
    '      const nonceArg = "--paperclip-managed-nonce=" + nonce;',
    '      if (!commandLine().includes(nonceArg)) throw new Error("Managed process-group ownership nonce did not match.");',
    '    }',
    '    suspendSent = send(target, "SIGSTOP");',
    '    termSent = send(target, "SIGTERM");',
    '    forceKilled = send(target, "SIGKILL");',
    '    const deadline = Date.now() + Math.max(0, confirmationTimeoutMs);',
    '    let groupState = probe(target);',
    '    while (Date.now() < deadline && groupState !== "absent") {',
    '      await delay(50);',
    '      groupState = probe(target);',
    '    }',
    '    if (groupState === "indeterminate") {',
    '      const error = new Error("EPERM"); error.code = "EPERM";',
    '      throw signalError("post-kill confirmation", target, "signal 0", error);',
    '    }',
    '    if (groupState !== "absent") throw new Error("Managed process-group termination could not be confirmed for process group " + processGroupId + " (pid " + pid + ").");',
    '    outcome = forceKilled ? "force_killed" : "already_exited";',
    '  }',
    '  fs.rmSync(metadataFile, { force: true });',
    '  if (pidFile) fs.rmSync(pidFile, { force: true });',
    '  process.stdout.write(JSON.stringify({',
    '    kind: "posix_managed_process_group_stop",',
    '    pid,',
    '    processGroupId,',
    '    suspendSent,',
    '    termSent,',
    '    forceKilled,',
    '    confirmedExited: true,',
    '    outcome,',
    '  }) + "\\n");',
    '})().catch((error) => { process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n"); process.exitCode = 125; });',
  ].join("\n");
}

/**
 * Launches a Node entrypoint in its own POSIX session/process group. The
 * detached group is deliberately outside the short-lived runner shell's group
 * and is owned by nonce-bound metadata for later confirmed cleanup.
 *
 * Sandbox bridge daemons currently require a POSIX guest with `kill` and `ps`;
 * Windows guests fail explicitly instead of falling back to PID-only cleanup.
 */
export function buildPosixManagedNodeProcessGroupLaunch(input: {
  entrypoint: string;
  metadataFile: string;
  pidFile?: string | null;
  logFile?: string | null;
  nodeCommand?: string | null;
}): { command: string; args: string[]; nonce: string } {
  const nonce = randomUUID();
  return {
    command: input.nodeCommand?.trim() || "node",
    args: [
      "-e",
      launcherSource(),
      input.entrypoint,
      input.metadataFile,
      nonce,
      input.pidFile?.trim() ?? "",
      input.logFile?.trim() ?? "",
    ],
    nonce,
  };
}

export function parsePosixManagedProcessGroupIdentity(
  stdout: string,
  expectedNonce?: string,
): PosixManagedProcessGroupIdentity {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: Partial<PosixManagedProcessGroupIdentity> | null = null;
  try {
    parsed = JSON.parse(line) as Partial<PosixManagedProcessGroupIdentity>;
  } catch {
    throw new Error("Managed process-group launcher returned invalid ownership metadata.");
  }
  if (
    parsed.kind !== "posix_managed_process_group"
    || parsed.version !== 1
    || !Number.isInteger(parsed.pid)
    || (parsed.pid ?? 0) <= 1
    || !Number.isInteger(parsed.processGroupId)
    || (parsed.processGroupId ?? 0) <= 1
    || parsed.pid !== parsed.processGroupId
    || typeof parsed.nonce !== "string"
    || parsed.nonce.length === 0
    || (expectedNonce !== undefined && parsed.nonce !== expectedNonce)
    || typeof parsed.startedAt !== "string"
    || !Number.isFinite(Date.parse(parsed.startedAt))
  ) {
    throw new Error("Managed process-group launcher returned incomplete ownership metadata.");
  }
  return parsed as PosixManagedProcessGroupIdentity;
}

export function buildPosixManagedProcessGroupStop(input: {
  identity: PosixManagedProcessGroupIdentity;
  metadataFile: string;
  pidFile?: string | null;
  confirmationTimeoutMs?: number;
  nodeCommand?: string | null;
}): { command: string; args: string[] } {
  return {
    command: input.nodeCommand?.trim() || "node",
    args: [
      "-e",
      terminatorSource(),
      String(input.identity.pid),
      String(input.identity.processGroupId),
      input.identity.nonce,
      input.metadataFile,
      input.pidFile?.trim() ?? "",
      String(Math.max(0, input.confirmationTimeoutMs ?? 5_000)),
    ],
  };
}

export function parsePosixManagedProcessGroupStopEvidence(
  stdout: string,
  expected: PosixManagedProcessGroupIdentity,
): PosixManagedProcessGroupStopEvidence {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed: Partial<PosixManagedProcessGroupStopEvidence> | null = null;
  try {
    parsed = JSON.parse(line) as Partial<PosixManagedProcessGroupStopEvidence>;
  } catch {
    throw new Error("Managed process-group stop returned invalid confirmation evidence.");
  }
  if (
    parsed.kind !== "posix_managed_process_group_stop"
    || parsed.pid !== expected.pid
    || parsed.processGroupId !== expected.processGroupId
    || parsed.confirmedExited !== true
    || (parsed.outcome !== "already_exited" && parsed.outcome !== "force_killed")
    || typeof parsed.suspendSent !== "boolean"
    || typeof parsed.termSent !== "boolean"
    || typeof parsed.forceKilled !== "boolean"
    || (parsed.outcome === "force_killed" && parsed.forceKilled !== true)
  ) {
    throw new Error("Managed process-group stop returned incomplete confirmation evidence.");
  }
  return parsed as PosixManagedProcessGroupStopEvidence;
}
