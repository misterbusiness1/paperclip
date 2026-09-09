import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

type TimerHandle = ReturnType<typeof setTimeout>;

export type DatabaseBackupSchedulerOptions = {
  backupDir: string;
  intervalMs: number;
  runBackup: () => Promise<unknown>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  onError?: (error: unknown) => void;
};

export function findLatestCompletedDatabaseBackupMtimeMs(backupDir: string): number | null {
  try {
    let latest: number | null = null;
    for (const name of readdirSync(backupDir)) {
      if (!name.endsWith(".sql.gz")) continue;
      const mtimeMs = statSync(join(backupDir, name)).mtimeMs;
      if (latest === null || mtimeMs > latest) latest = mtimeMs;
    }
    return latest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function createDatabaseBackupScheduler(options: DatabaseBackupSchedulerOptions) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const intervalMs = Math.max(1, options.intervalMs);
  let timer: TimerHandle | null = null;
  let started = false;
  let stopped = false;
  let tickInFlight: Promise<void> | null = null;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimer(() => void tick(), Math.max(0, delayMs));
  };

  const tick = (): Promise<void> => {
    if (tickInFlight) return tickInFlight;
    tickInFlight = (async () => {
      try {
        const latestMtimeMs = findLatestCompletedDatabaseBackupMtimeMs(options.backupDir);
        const ageMs = latestMtimeMs === null ? intervalMs : Math.max(0, now() - latestMtimeMs);
        if (latestMtimeMs === null || ageMs >= intervalMs) {
          await options.runBackup();
          schedule(intervalMs);
        } else {
          schedule(intervalMs - ageMs);
        }
      } catch (error) {
        options.onError?.(error);
        schedule(intervalMs);
      } finally {
        tickInFlight = null;
      }
    })();
    return tickInFlight;
  };

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      void tick();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    tick,
  };
}
