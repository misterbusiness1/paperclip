import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabaseBackupScheduler } from "../services/database-backup-scheduler.js";

const HOUR_MS = 60 * 60 * 1000;

describe("database backup scheduler", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function backupDir() {
    const root = mkdtempSync(join(tmpdir(), "paperclip-backup-scheduler-"));
    tempDirs.push(root);
    const dir = join(root, "backups");
    mkdirSync(dir);
    return dir;
  }

  function completedBackup(dir: string, mtimeMs: number) {
    const path = join(dir, "paperclip-20260909.sql.gz");
    writeFileSync(path, "completed");
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  }

  it("runs exactly one catch-up when no completed backup exists, including across duplicate starts", async () => {
    vi.useFakeTimers();
    const runBackup = vi.fn().mockResolvedValue(undefined);
    const scheduler = createDatabaseBackupScheduler({
      backupDir: backupDir(),
      intervalMs: 24 * HOUR_MS,
      runBackup,
    });

    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runBackup).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("does not duplicate a completed catch-up after a process restart", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-09T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const dir = backupDir();
    const runBackup = vi.fn(async () => completedBackup(dir, now));
    const firstProcess = createDatabaseBackupScheduler({
      backupDir: dir,
      intervalMs: 24 * HOUR_MS,
      runBackup,
    });

    firstProcess.start();
    await vi.advanceTimersByTimeAsync(0);
    firstProcess.stop();
    createDatabaseBackupScheduler({ backupDir: dir, intervalMs: 24 * HOUR_MS, runBackup }).start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it("does not run on startup when the latest completed backup is fresh", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-09T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const dir = backupDir();
    completedBackup(dir, now - 2 * HOUR_MS);
    const runBackup = vi.fn().mockResolvedValue(undefined);

    createDatabaseBackupScheduler({ backupDir: dir, intervalMs: 24 * HOUR_MS, runBackup }).start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runBackup).not.toHaveBeenCalled();
  });

  it("runs one catch-up when the latest completed backup is stale and ignores partial files", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-09T12:00:00Z").getTime();
    vi.setSystemTime(now);
    const dir = backupDir();
    completedBackup(dir, now - 25 * HOUR_MS);
    const partial = join(dir, "paperclip-new.sql.gz.partial");
    writeFileSync(partial, "in-flight");
    utimesSync(partial, now / 1000, now / 1000);
    const runBackup = vi.fn().mockResolvedValue(undefined);

    createDatabaseBackupScheduler({ backupDir: dir, intervalMs: 24 * HOUR_MS, runBackup }).start();
    await vi.advanceTimersByTimeAsync(0);

    expect(runBackup).toHaveBeenCalledTimes(1);
  });
});
