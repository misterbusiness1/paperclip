import { describe, expect, it, vi } from "vitest";
import {
  coordinateHeartbeatSchedulerShutdown,
  drainHeartbeatRunsForSafeShutdown,
} from "./shutdown.js";

describe("coordinateHeartbeatSchedulerShutdown", () => {
  it("waits for scheduler and run admission idle before capturing a hot-restart snapshot", async () => {
    let snapshotCaptured = false;
    let releaseScheduler!: () => void;
    let releaseAdmission!: () => void;
    const waitForHeartbeatSchedulerIdle = vi.fn(() => new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    }));
    const waitForHeartbeatRunAdmissionIdle = vi.fn(() => new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    }));

    const resultPromise = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        snapshotCaptured = true;
        return { mode: "prepared" as const, skipDrain: true };
      }),
      waitForHeartbeatSchedulerIdle,
      waitForHeartbeatRunAdmissionIdle,
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(snapshotCaptured).toBe(false);
    expect(waitForHeartbeatRunAdmissionIdle).not.toHaveBeenCalled();
    releaseScheduler();
    await vi.waitFor(() => expect(waitForHeartbeatRunAdmissionIdle).toHaveBeenCalledOnce());
    expect(snapshotCaptured).toBe(false);
    releaseAdmission();

    const result = await resultPromise;
    expect(snapshotCaptured).toBe(true);
    expect(result).toEqual({
      hotRestart: { mode: "prepared", skipDrain: true },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("preserves the scheduler idle wait for normal graceful shutdown", async () => {
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);
    let settled = false;

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "not_requested" as const,
        skipDrain: false,
      })),
      waitForHeartbeatSchedulerIdle,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    releaseScheduler();

    await expect(shutdown).resolves.toEqual({
      hotRestart: { mode: "not_requested", skipDrain: false },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("waits for scheduler idle when hot-restart preparation is unavailable", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: null,
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("falls back to the scheduler idle wait when hot-restart preparation fails", async () => {
    const preparationError = new Error("snapshot failed");
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        throw preparationError;
      }),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError,
      waitedForSchedulerIdle: true,
    });
  });
});

describe("drainHeartbeatRunsForSafeShutdown", () => {
  it("retains shutdown state and retries until the heartbeat drain is confirmed", async () => {
    const onAttemptFailure = vi.fn();
    const drain = vi
      .fn<(_signal: "SIGINT" | "SIGTERM") => Promise<{ interrupted: number }>>()
      .mockRejectedValueOnce(new Error("remote exit unconfirmed"))
      .mockResolvedValueOnce({ interrupted: 1 });

    await expect(drainHeartbeatRunsForSafeShutdown({
      signal: "SIGTERM",
      drain,
      retryDelayMs: 0,
      onAttemptFailure,
    })).resolves.toEqual({ interrupted: 1 });

    expect(drain).toHaveBeenCalledTimes(2);
    expect(onAttemptFailure).toHaveBeenCalledWith(expect.any(Error), 1);
  });
});
