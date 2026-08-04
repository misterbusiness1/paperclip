type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

export async function drainHeartbeatRunsForSafeShutdown<T>(input: {
  signal: "SIGINT" | "SIGTERM";
  drain: ((signal: "SIGINT" | "SIGTERM") => Promise<T>) | null;
  retryDelayMs?: number;
  onAttemptFailure?: (error: unknown, attempt: number) => void;
}): Promise<T | null> {
  if (!input.drain) return null;
  let attempt = 0;
  while (true) {
    attempt += 1;
    try {
      return await input.drain(input.signal);
    } catch (error) {
      input.onAttemptFailure?.(error, attempt);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, input.retryDelayMs ?? 1_000)));
    }
  }
}

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
  waitForHeartbeatRunAdmissionIdle?: () => Promise<void>;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  // The snapshot/drain boundary must be stable. Scheduler work and request
  // admissions that began before shutdown can otherwise claim a run after the
  // one-time running-row snapshot and orphan it when the process exits.
  await input.waitForHeartbeatSchedulerIdle();
  await input.waitForHeartbeatRunAdmissionIdle?.();

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: true,
  };
}
