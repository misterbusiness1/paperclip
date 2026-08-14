import { describe, expect, it } from "vitest";
import { isRetryableDelegationWakeFailure } from "../services/heartbeat.ts";

type RunPick = Parameters<typeof isRetryableDelegationWakeFailure>[0];

function run(over: Partial<RunPick>): RunPick {
  return {
    errorCode: null,
    resultJson: null,
    contextSnapshot: null,
    scheduledRetryReason: null,
    ...over,
  } as RunPick;
}

describe("isRetryableDelegationWakeFailure", () => {
  it("retries acpx_turn_failed on delegation wake reasons", () => {
    for (const reason of [
      "issue_blockers_resolved",
      "issue_children_completed",
      "issue_continuation_needed",
      "issue_commented",
      "issue_assigned",
    ]) {
      expect(
        isRetryableDelegationWakeFailure(
          run({ errorCode: "acpx_turn_failed", contextSnapshot: { wakeReason: reason } }),
        ),
      ).toBe(true);
    }
  });

  it("continues the chain via retryReason (context or scheduledRetryReason column)", () => {
    expect(
      isRetryableDelegationWakeFailure(
        run({ errorCode: "acpx_turn_failed", scheduledRetryReason: "delegation_wake_failure" }),
      ),
    ).toBe(true);
    expect(
      isRetryableDelegationWakeFailure(
        run({
          errorCode: "acpx_turn_failed",
          contextSnapshot: { retryReason: "delegation_wake_failure", wakeReason: "delegation_wake_retry" },
        }),
      ),
    ).toBe(true);
  });

  it("does NOT retry adapter_failed — operator-manual kills carry that code", () => {
    // The classifier keys purely on errorCode: adapter_failed is excluded from the acpx-only
    // allowlist, so operator "manually failed during ... containment" kills are never retried.
    expect(
      isRetryableDelegationWakeFailure(
        run({ errorCode: "adapter_failed", contextSnapshot: { wakeReason: "issue_commented" } }),
      ),
    ).toBe(false);
  });

  it("does NOT retry non-delegation reasons (self-bounded / timer)", () => {
    for (const reason of ["source_scoped_recovery_action", "heartbeat_timer", "run_liveness_continuation"]) {
      expect(
        isRetryableDelegationWakeFailure(
          run({ errorCode: "acpx_turn_failed", contextSnapshot: { wakeReason: reason } }),
        ),
      ).toBe(false);
    }
  });

  it("does NOT retry error codes owned by other paths", () => {
    for (const errorCode of ["process_lost", "claude_auth_required", "workspace_validation_failed", "setup_failed"]) {
      expect(
        isRetryableDelegationWakeFailure(
          run({ errorCode, contextSnapshot: { wakeReason: "issue_blockers_resolved" } }),
        ),
      ).toBe(false);
    }
  });

  it("defers to the transient path for provider_quota / *_transient_upstream", () => {
    for (const errorCode of ["provider_quota", "codex_transient_upstream", "claude_transient_upstream"]) {
      expect(
        isRetryableDelegationWakeFailure(
          run({ errorCode, contextSnapshot: { wakeReason: "issue_commented" } }),
        ),
      ).toBe(false);
    }
  });

  it("does NOT retry with no error code or no reason", () => {
    expect(isRetryableDelegationWakeFailure(run({ contextSnapshot: { wakeReason: "issue_commented" } }))).toBe(false);
    expect(isRetryableDelegationWakeFailure(run({ errorCode: "acpx_turn_failed" }))).toBe(false);
  });
});
