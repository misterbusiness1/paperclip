import type { Detection, IncidentState, JobObservation } from "./types.js";

const DEDUP_WINDOW_MS = 60 * 60_000;

export interface StateTransition {
  state: IncidentState;
  action: "none" | "open" | "update" | "recover";
}

export function transitionState(
  previous: IncidentState,
  detections: Detection[],
  recoveryExecutions: JobObservation[],
  now: Date,
): StateTransition {
  const nowIso = now.toISOString();
  if (detections.length > 0) {
    const withinWindow = previous.windowStartedAt !== null
      && now.getTime() - Date.parse(previous.windowStartedAt) < DEDUP_WINDOW_MS;
    return {
      action: withinWindow && previous.incidentIssueId ? "update" : "open",
      state: {
        ...previous,
        windowStartedAt: withinWindow ? previous.windowStartedAt : nowIso,
        incidentIssueId: withinWindow ? previous.incidentIssueId : null,
        firstSeenAt: withinWindow && previous.firstSeenAt ? previous.firstSeenAt : nowIso,
        lastSeenAt: nowIso,
        clearWindows: 0,
        recoveryExecutionSeen: false,
        affectedWorkflows: [...new Set(detections.map(({ observation }) => `${observation.repository}:${observation.workflowName}`))],
      },
    };
  }

  if (!previous.incidentIssueId) return { state: previous, action: "none" };
  const recoverySeen = previous.recoveryExecutionSeen || recoveryExecutions.length > 0;
  const clearWindows = previous.clearWindows + 1;
  if (clearWindows >= 2 && recoverySeen) {
    return { state: { ...previous, clearWindows, recoveryExecutionSeen: true }, action: "recover" };
  }
  return {
    state: { ...previous, clearWindows, recoveryExecutionSeen: recoverySeen },
    action: "none",
  };
}
