import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectBillingRefusals, isRecoveryExecution } from "./detector.js";
import { transitionState } from "./state.js";
import { EMPTY_STATE, type JobObservation } from "./types.js";

const fixture = (name: string): JobObservation => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
) as JobObservation;

describe("Actions billing-refusal detector", () => {
  it("classifies the retained payment-refusal fixture as confirmed", () => {
    const [detection] = detectBillingRefusals([fixture("billing-refusal")]);
    assert.equal(detection?.confidence, "confirmed");
    assert.equal(detection?.reason, "payments_failed");
  });

  it("excludes an executed failure with a runner and steps", () => {
    assert.deepEqual(detectBillingRefusals([fixture("executed-failure")]), []);
  });

  it("never alerts on one annotation-unavailable heuristic job", () => {
    const observation = { ...fixture("billing-refusal"), annotationAvailability: "unavailable" as const, annotationMessages: [] };
    assert.deepEqual(detectBillingRefusals([observation]), []);
  });

  it("requires two repositories within 15 minutes for suspected fallback", () => {
    const first = { ...fixture("billing-refusal"), annotationAvailability: "unavailable" as const, annotationMessages: [] };
    const second = { ...first, repository: "misterbusiness1/occ-fraud-checker", jobId: 2, startedAt: "2026-08-27T13:59:17Z", completedAt: "2026-08-27T13:59:20Z" };
    assert.equal(detectBillingRefusals([first, second]).length, 2);
    assert.deepEqual(detectBillingRefusals([first, { ...second, startedAt: "2026-08-27T14:00:18Z", completedAt: "2026-08-27T14:00:21Z" }]), []);
  });

  it("deduplicates for 60 minutes and recovers only after two clear windows plus execution proof", () => {
    const detections = detectBillingRefusals([fixture("billing-refusal")]);
    const opened = transitionState(EMPTY_STATE, detections, [], new Date("2026-08-27T13:46:00Z"));
    assert.equal(opened.action, "open");
    const linked = { ...opened.state, incidentIssueId: "incident-1" };
    assert.equal(transitionState(linked, detections, [], new Date("2026-08-27T14:45:59Z")).action, "update");

    const executed = fixture("executed-failure");
    assert.equal(isRecoveryExecution(executed, new Set([`${executed.repository}:${executed.workflowName}`])), true);
    const clearOne = transitionState(linked, [], [executed], new Date("2026-08-27T14:50:00Z"));
    assert.equal(clearOne.action, "none");
    assert.equal(transitionState(clearOne.state, [], [], new Date("2026-08-27T14:55:00Z")).action, "recover");
  });
});
