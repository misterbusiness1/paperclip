export type AnnotationAvailability = "available" | "unavailable";

export interface JobObservation {
  repository: string;
  workflowName: string;
  runId: number;
  attempt: number;
  jobId: number;
  pullRequestNumbers: number[];
  conclusion: string | null;
  startedAt: string;
  completedAt: string;
  runnerName: string | null;
  stepCount: number;
  annotationAvailability: AnnotationAvailability;
  annotationMessages: string[];
}

export type BillingReason = "payments_failed" | "spending_limit" | "structural_fallback";
export type DetectionConfidence = "confirmed" | "suspected";

export interface Detection {
  observation: JobObservation;
  confidence: DetectionConfidence;
  reason: BillingReason;
}

export interface IncidentState {
  windowStartedAt: string | null;
  incidentIssueId: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  clearWindows: number;
  recoveryExecutionSeen: boolean;
  affectedWorkflows: string[];
}

export const EMPTY_STATE: IncidentState = {
  windowStartedAt: null,
  incidentIssueId: null,
  firstSeenAt: null,
  lastSeenAt: null,
  clearWindows: 0,
  recoveryExecutionSeen: false,
  affectedWorkflows: [],
};
