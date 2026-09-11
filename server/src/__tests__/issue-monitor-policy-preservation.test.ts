import { describe, expect, it } from "vitest";
import type { IssueExecutionPolicy } from "@paperclipai/shared";
import {
  applyIssueMonitorPolicyTransition,
  buildInitialIssueMonitorFields,
  buildIssueMonitorClearedPatch,
  buildIssueMonitorTriggeredPatch,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  stripMonitorFromExecutionPolicy,
} from "../services/issue-execution-policy.ts";

const agentId = "11111111-1111-4111-8111-111111111111";
const scheduledAt = new Date("2099-01-01T00:15:00Z");
const timeoutAt = "2099-01-01T04:00:00.000Z";
const reviewPreset = { id: "low_trust_review", version: 1, rawOutputDisposition: "quarantine" } as const;
const authorizationPolicy = {
  assignmentPolicy: { mode: "protected" },
  protectedAgent: { blockAssignment: true, blockReason: "Human review required" },
  trustBoundary: { mode: "low_trust_review", allowedToolClasses: ["git.read"] },
} as const;

function policy(extras: Record<string, unknown> = {}, withStages = false) {
  return normalizeIssueExecutionPolicy({
    stages: withStages ? [{ type: "review", participants: [{ type: "user", userId: "board" }] }] : [],
    ...extras,
    monitor: {
      nextCheckAt: scheduledAt.toISOString(), scheduledBy: "assignee", kind: "external_service",
      serviceName: "CI", timeoutAt, maxAttempts: 6, recoveryPolicy: "wake_owner",
    },
  })!;
}

function fixture(inputPolicy: IssueExecutionPolicy) {
  return {
    status: "in_progress", assigneeAgentId: agentId, assigneeUserId: null,
    executionPolicy: inputPolicy,
    ...buildInitialIssueMonitorFields({ policy: inputPolicy, status: "in_progress", assigneeAgentId: agentId }),
  };
}

describe("monitor policy preservation", () => {
  const extras = [
    { reviewPreset }, { authorizationPolicy }, { maxReviewRounds: 1 }, { maxReviewRounds: 50 },
    { reviewPreset, authorizationPolicy, maxReviewRounds: 2 },
    { reviewPreset, authorizationPolicy, maxReviewRounds: null },
  ];

  for (const withStages of [false, true]) {
    it.each(extras)(`preserves governance when consumed and cleared (stages=${withStages}): %j`, (extra) => {
      const inputPolicy = policy(extra, withStages);
      const before = structuredClone(inputPolicy);
      const { monitor: _monitor, ...expected } = inputPolicy;
      const issue = fixture(inputPolicy);
      for (const patch of [
        buildIssueMonitorTriggeredPatch({ issue, policy: inputPolicy, triggeredAt: scheduledAt }),
        buildIssueMonitorClearedPatch({ issue, policy: inputPolicy, clearReason: "manual" }),
        applyIssueMonitorPolicyTransition({
          issue, policy: inputPolicy, requestedStatus: "blocked", requestedAssigneePatch: {}, actor: { userId: "board" },
        }).patch,
      ]) {
        expect(patch.executionPolicy).toEqual(expected);
        expect(normalizeIssueExecutionPolicy(patch.executionPolicy)).toEqual(expected);
        expect(patch.monitorNextCheckAt).toBeNull();
      }
      expect(inputPolicy).toEqual(before);
    });
  }

  it("retains consumed attempt count, original deadline and governance through 30/60 minute rescheduling", () => {
    let currentPolicy = policy({ reviewPreset, authorizationPolicy, maxReviewRounds: 2 });
    let issue = fixture(currentPolicy);
    for (const [index, minutes] of [15, 30, 60].entries()) {
      const triggeredAt = new Date(currentPolicy.monitor!.nextCheckAt);
      const consumed = buildIssueMonitorTriggeredPatch({ issue, policy: currentPolicy, triggeredAt });
      expect(consumed.monitorAttemptCount).toBe(index + 1);
      const remaining = normalizeIssueExecutionPolicy(consumed.executionPolicy)!;
      expect(remaining).toMatchObject({ reviewPreset, authorizationPolicy, maxReviewRounds: 2 });
      const nextCheckAt = new Date(triggeredAt.getTime() + minutes * 60_000).toISOString();
      const nextPolicy = normalizeIssueExecutionPolicy({ ...remaining, monitor: { ...currentPolicy.monitor, nextCheckAt } })!;
      const nextIssue = { ...issue, ...consumed, executionPolicy: remaining };
      const rescheduled = applyIssueMonitorPolicyTransition({
        issue: nextIssue, previousPolicy: remaining, policy: nextPolicy,
        monitorExplicitlyUpdated: true, requestedAssigneePatch: {}, actor: { agentId },
      }).patch;
      const monitor = parseIssueExecutionState(rescheduled.executionState)!.monitor!;
      expect(monitor).toMatchObject({ attemptCount: index + 1, timeoutAt, maxAttempts: 6, status: "scheduled", nextCheckAt });
      expect(nextPolicy.authorizationPolicy).toEqual(authorizationPolicy);
      issue = { ...nextIssue, ...rescheduled, executionPolicy: nextPolicy } as typeof issue;
      currentPolicy = nextPolicy;
    }
  });

  it("keeps ordinary empty/default and null round-limit policies null after monitor removal", () => {
    for (const extra of [{}, { maxReviewRounds: null }]) {
      const inputPolicy = policy(extra);
      expect(stripMonitorFromExecutionPolicy(inputPolicy)).toBeNull();
      expect(buildIssueMonitorTriggeredPatch({ issue: fixture(inputPolicy), policy: inputPolicy, triggeredAt: scheduledAt }).executionPolicy).toBeNull();
      expect(normalizeIssueExecutionPolicy({ stages: [], ...extra })).toBeNull();
    }
    expect(stripMonitorFromExecutionPolicy(null)).toBeNull();
  });

  it("does not change a policy that has no monitor", () => {
    const inputPolicy = normalizeIssueExecutionPolicy({ stages: [], authorizationPolicy, maxReviewRounds: 1 })!;
    expect(stripMonitorFromExecutionPolicy(inputPolicy)).toBe(inputPolicy);
  });
});
