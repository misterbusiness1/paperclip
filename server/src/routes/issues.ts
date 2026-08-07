Warning: truncated output (original token count: 101176)
Total output lines: 10618

import { createHash, randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { and, asc, desc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  documents,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueExecutionDecisions,
  issueRelations,
  issues as issueRows,
  issueWorkProducts,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineStages,
  pipelines,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  addIssueCommentSchema,
  acceptIssueThreadInteractionSchema,
  attachmentArtifactWorkProductMetadataSchema,
  cancelIssueThreadInteractionSchema,
  companySearchExtractQuerySchema,
  companySearchQuerySchema,
  createIssueAttachmentMetadataSchema,
  createIssueThreadInteractionSchema,
  createIssueWorkProductSchema,
  createIssueLabelSchema,
  createAcceptedPlanDecompositionSchema,
  checkoutIssueSchema,
  createDocumentAnnotationCommentSchema,
  createDocumentAnnotationThreadSchema,
  createChildIssueSchema,
  createIssueSchema,
  resolveCreateIssueStatusDefault,
  resolveIssueRecoveryActionSchema,
  feedbackTargetTypeSchema,
  feedbackTraceStatusSchema,
  feedbackVoteValueSchema,
  upsertIssueFeedbackVoteSchema,
  upsertIssueWatchdogSchema,
  linkIssueApprovalSchema,
  issueDocumentKeySchema,
  ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
  ISSUE_WATCHDOG_DISCOVERY_KINDS,
  TASK_WATCHDOG_PRODUCT_BUG_ORIGIN_KIND,
  rejectIssueThreadInteractionSchema,
  restoreIssueDocumentRevisionSchema,
  respondIssueThreadInteractionSchema,
  submitIssueThreadInteractionVerdictsSchema,
  updateIssueWorkProductSchema,
  updateDocumentAnnotationThreadSchema,
  upsertIssueDocumentSchema,
  updateIssueSchema,
  getClosedIsolatedExecutionWorkspaceMessage,
  isClosedIsolatedExecutionWorkspace,
  isUuidLike,
  normalizeIssueIdentifier as normalizeIssueReferenceIdentifier,
  type CompactIssue,
  type CompanySearchExtractQuery,
  type CompanySearchExtractResponse,
  type CompanySearchQuery,
  type CompanySearchResponse,
  type ExecutionWorkspace,
  type IssueBlockerDiagnosticFlag,
  type IssueBlockerDiagnosticIssueSummary,
  type IssueBlockerDiagnosticNode,
  type IssueBlockerDiagnosticsReadiness,
  type IssueBlockerDiagnosticsResponse,
  type IssueSubtreeDiagnosticEdge,
  type IssueSubtreeDiagnosticNode,
  type IssueSubtreeDiagnosticsResponse,
  type IssueWakeDiagnosticActivityRecord,
  type IssueWakeDiagnosticEvent,
  type IssueWakeDiagnosticWakeFailureClass,
  type IssueWakeDiagnosticWakeRequest,
  type IssueWakeDiagnosticsResponse,
  type IssueRelationIssueSummary,
  type IssueWatchdogDiscoveryKind,
  type ProjectWorkspace,
  type SourceTrustMetadata,
  type SuccessfulRunHandoffState,
  type WorkspaceRuntimeService,
} from "@paperclipai/shared";
import { trackAgentTaskCompleted } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import type { StorageService } from "../storage/types.js";
import { validate } from "../middleware/validate.js";
import * as serviceIndex from "../services/index.js";
import {
  accessService,
  agentService,
  companySkillService,
  companyService,
  companySearchService,
  executionWorkspaceService,
  goalService,
  heartbeatService,
  issueApprovalService,
  issueRecoveryActionService,
  issueThreadInteractionService,
  inboxAgentPolicyService,
  ISSUE_LIST_DEFAULT_LIMIT,
  ISSUE_LIST_MAX_LIMIT,
  issueReferenceService,
  issueService,
  type IssueFilters,
  clampIssueListLimit,
  documentService,
  documentAnnotationService,
  logActivity,
  projectService,
  routineService,
  workProductService,
} from "../services/index.js";
import { setAgentCapacityEscalationDeps } from "../services/agent-capacity.js";
import { buildPlanReviewContext } from "../services/plan-review-context.js";
import { hydrateSuccessfulRunHandoffLiveness } from "../services/successful-run-handoff-state.js";
import {
  TASK_WATCHDOG_ORIGIN_KIND,
  resolveTaskWatchdogMutationScope,
  taskWatchdogScopeAllowsIssueMutation,
} from "../services/task-watchdog-scope.js";
import type { TaskWatchdogServiceDeps, taskWatchdogService } from "../services/task-watchdogs.js";
import { logger } from "../middleware/logger.js";
import { conflict, forbidden, HttpError, notFound, unauthorized, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource, getActorInfo } from "./authz.js";
import {
  assertNoAgentHostWorkspaceCommandMutation,
  collectIssueWorkspaceCommandPaths,
} from "./workspace-command-authz.js";
import { shouldWakeAssigneeOnCheckout } from "./issues-checkout-wakeup.js";
import {
  GENERIC_ATTACHMENT_CONTENT_TYPES,
  isInlineAttachmentContentType,
  normalizeIssueAttachmentMaxBytes,
  normalizeContentType,
  normalizeUploadAttachmentContentType,
  SVG_CONTENT_TYPE,
} from "../attachment-types.js";
import { queueIssueAssignmentWakeup } from "../services/issue-assignment-wakeup.js";
import {
  ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
  buildIssueBlockersResolvedWakeIdempotencyKey,
  findExistingIssueBlockersResolvedWake,
} from "../services/issue-dependency-wakeups.js";
import { assertEnvironmentSelectionForCompany } from "./environment-selection.js";
import { executionWorkspaceService as executionWorkspaceServiceDirect } from "../services/execution-workspaces.js";
import { decisionTrainingService } from "../services/decision-training.js";
import { feedbackService } from "../services/feedback.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import {
  ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
  ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS,
  ISSUE_WAKE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS,
  ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS,
  readAcceptedPlanConfirmationTarget,
} from "../services/issues.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { environmentService } from "../services/environments.js";
import { environmentRuntimeService } from "../services/environment-runtime.js";
import { redactSensitiveText } from "../redaction.js";
import {
  createCompanySearchRateLimiter,
  type CompanySearchRateLimiter,
} from "../services/company-search-rate-limit.js";
import {
  applyIssueExecutionPolicyTransition,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  redactIssueMonitorExternalRef,
  setIssueExecutionPolicyMonitorScheduledBy,
} from "../services/issue-execution-policy.js";
import { parseIssueExecutionWorkspaceSettings } from "../services/execution-workspace-policy.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  buildPromotedSourceTrust,
  isLowTrustQuarantined,
  redactQuarantinedBodyForHigherTrust,
  resolveActorSourceTrustForIssue,
  sanitizeQuarantinedCommentForHigherTrust,
} from "../services/source-trust.js";
import {
  LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH,
  resolveCoreTrustPreset,
  type TrustPresetResolution,
} from "../services/trust-preset-resolver.js";
import { externalObjectService } from "../services/external-objects.js";

const MAX_ISSUE_COMMENT_LIMIT = 500;
const updateIssueRouteSchema = updateIssueSchema.extend({
  interrupt: z.boolean().optional(),
});
const refreshExternalObjectsSchema = z.object({
  objectIds: z.array(z.string().uuid()).max(50).optional(),
}).strict();
const inboxArchiveBodySchema = z.object({
  userId: z.string().trim().min(1).optional(),
}).strict().default({});
const externalObjectSummariesSchema = z.object({
  issueIds: z.array(z.string().uuid()).max(1000),
}).strict();

const promoteLowTrustOutputSchema = z.object({
  sourceArtifactKind: z.enum(["comment", "document", "work_product", "issue"]),
  sourceArtifactId: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(8_000),
});

async function listIssueLinkedCases(db: Db, companyId: string, issueId: string) {
  const rows = await db
    .select({
      link: pipelineCaseIssueLinks,
      case: pipelineCases,
      pipeline: pipelines,
      stage: pipelineStages,
    })
    .from(pipelineCaseIssueLinks)
    .innerJoin(pipelineCases, eq(pipelineCaseIssueLinks.caseId, pipelineCases.id))
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .where(and(
      eq(pipelineCaseIssueLinks.companyId, companyId),
      eq(pipelineCaseIssueLinks.issueId, issueId),
      eq(pipelineCases.companyId, companyId),
      eq(pipelines.companyId, companyId),
    ));
  return rows.map((row) => ({
    id: row.case.id,
    caseKey: row.case.caseKey,
    title: row.case.title,
    status: row.case.terminalKind ?? "open",
    role: row.link.role,
    pipeline: {
      id: row.pipeline.id,
      key: row.pipeline.key,
      name: row.pipeline.name,
    },
    stage: {
      id: row.stage.id,
      key: row.stage.key,
      name: row.stage.name,
      kind: row.stage.kind,
    },
  }));
}

type ParsedExecutionState = NonNullable<ReturnType<typeof parseIssueExecutionState>>;
type NormalizedExecutionPolicy = NonNullable<ReturnType<typeof normalizeIssueExecutionPolicy>>;
type IssueRouteSnapshot = typeof issueRows.$inferSelect;
type RecoveryRevalidationTrigger =
  | "issue_update"
  | "comment"
  | "document"
  | "work_product"
  | "read_projection";
type CompanySearchService = {
  extract(companyId: string, query: CompanySearchExtractQuery): Promise<CompanySearchExtractResponse>;
  search(companyId: string, query: CompanySearchQuery): Promise<CompanySearchResponse>;
};
type ActivityIssueRelationSummary = {
  id: string;
  identifier: string | null;
  title: string;
};
type ActivityExecutionParticipant = Pick<
  NormalizedExecutionPolicy["stages"][number]["participants"][number],
  "type" | "agentId" | "userId"
>;
type ExecutionStageWakeContext = {
  wakeRole: "reviewer" | "approver" | "executor";
  stageId: string | null;
  stageType: ParsedExecutionState["currentStageType"];
  currentParticipant: ParsedExecutionState["currentParticipant"];
  returnAssignee: ParsedExecutionState["returnAssignee"];
  reviewRequest: ParsedExecutionState["reviewRequest"];
  lastDecisionOutcome: ParsedExecutionState["lastDecisionOutcome"];
  allowedActions: string[];
};
type SuccessfulRunHandoffActivityRow = {
  entityId: string;
  action: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
};
type TaskWatchdogService = ReturnType<typeof taskWatchdogService>;
type TaskWatchdogServiceFactory = typeof taskWatchdogService;

function applyCreateIssueStatusDefault(req: Request, res: Response, next: () => void) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    next();
    return;
  }

  const resolution = resolveCreateIssueStatusDefault(req.body as Record<string, unknown>);
  res.locals.createIssueStatusDefault = resolution;
  if (resolution.defaulted) {
    req.body = {
      ...req.body,
      status: resolution.status,
    };
  }
  next();
}

function noopTaskWatchdogService(): TaskWatchdogService {
  return {
    getActiveForIssue: async () => null,
    listActiveSummariesForIssues: async () => new Map(),
    upsertForIssue: async () => {
      throw unprocessable("Task watchdog service is unavailable");
    },
    disableForIssue: async () => null,
    reconcileTaskWatchdogs: async () => ({
      checked: 0,
      triggered: 0,
      live: 0,
      pendingFirstRun: 0,
      alreadyReviewed: 0,
      skipped: 0,
      watchdogIssueIds: [],
    }),
    reconcileForIssueAndAncestors: async () => ({
      checked: 0,
      triggered: 0,
      pendingFirstRun: 0,
      skipped: 0,
      watchdogIssueIds: [],
    }),
    revalidateMutationScope: async () => ({
      allowed: true,
      classification: {
        state: "stopped",
        reason: "Task watchdog service unavailable in this route context.",
        includedIssueIds: [],
        stopFingerprint: "task_watchdog_stop:unavailable",
        stoppedLeaves: [],
      },
    }),
  };
}

function buildAttachmentContentPath(attachmentId: string): string {
  return `/api/attachments/${attachmentId}/content`;
}

const GENERIC_RESPONSE_ATTACHMENT_CONTENT_TYPES = new Set(GENERIC_ATTACHMENT_CONTENT_TYPES);

function inferVideoContentTypeFromFilename(filename: string | null | undefined): string | null {
  const lower = (filename ?? "").toLowerCase();
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov") || lower.endsWith(".qt") || lower.endsWith(".quicktime")) return "video/quicktime";
  return null;
}

function resolveAttachmentResponseContentType(input: {
  storedContentType: string | null | undefined;
  objectContentType?: string | null;
  originalFilename?: string | null;
}) {
  const storedContentType = normalizeContentType(input.storedContentType || input.objectContentType);
  if (!GENERIC_RESPONSE_ATTACHMENT_CONTENT_TYPES.has(storedContentType)) return storedContentType;
  return inferVideoContentTypeFromFilename(input.originalFilename) ?? storedContentType;
}

function requiresPaperclipAttachmentMetadata(input: {
  type?: unknown;
  provider?: unknown;
}, fallback?: {
  type?: string | null;
  provider?: string | null;
}) {
  const type = typeof input.type === "string" ? input.type : fallback?.type ?? null;
  const provider = typeof input.provider === "string" ? input.provider : fallback?.provider ?? null;
  return type === "artifact" && provider === "paperclip";
}

const attachmentArtifactMetadataInputSchema = z.object({
  attachmentId: z.string().uuid(),
}).passthrough();

function buildCreateIssueActivityStatusDetails(
  issue: { assigneeAgentId: string | null; status: string },
  res: Response,
) {
  const statusDefault = res.locals.createIssueStatusDefault as
    | ReturnType<typeof resolveCreateIssueStatusDefault>
    | undefined;
  const assignmentWakeSkipped = !issue.assigneeAgentId || issue.status === "backlog";
  return {
    status: issue.status,
    statusDefaulted: statusDefault?.defaulted ?? false,
    statusDefaultReason: statusDefault?.reason ?? "explicit",
    assignmentWakeSkipped,
    assignmentWakeSkipReason: assignmentWakeSkipped
      ? issue.assigneeAgentId
        ? "assigned_backlog"
        : "no_agent_assignee"
      : null,
  };
}

const SUCCESSFUL_RUN_HANDOFF_ACTIONS = [
  "issue.successful_run_handoff_required",
  "issue.successful_run_handoff_resolved",
  "issue.successful_run_handoff_escalated",
] as const;

const ISSUE_WORKSPACE_AUDIT_FIELDS = new Set([
  "projectWorkspaceId",
  "executionWorkspaceId",
  "executionWorkspacePreference",
  "executionWorkspaceSettings",
]);

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

async function auditAgentIssueCreateAttributionSpoof(input: {
  db: Db;
  req: Request;
  companyId: string;
  entityId?: string | null;
  surface: string;
  field: "responsibleUserId" | "createdByUserId";
  action: "rejected" | "stripped";
  requestedValue: string | null;
}) {
  const actor = getActorInfo(input.req);
  await logActivity(input.db, {
    companyId: input.companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId,
    runId: actor.runId,
    agentApiKeyId: actor.agentApiKeyId,
    action: input.action === "rejected"
      ? "issue.attribution_spoof_rejected"
      : "issue.attribution_spoof_stripped",
    entityType: input.entityId ? "issue" : "company",
    entityId: input.entityId ?? input.companyId,
    details: {
      surface: input.surface,
      field: input.field,
      requestedValue: input.requestedValue,
      derivedFrom: "authenticated_actor",
    },
  });
}

async function sanitizeIssueCreateAttribution<T extends object>(
  db: Db,
  req: Request,
  res: Response,
  companyId: string,
  input: T,
  options: { surface: string; entityId?: string | null },
) {
  const sanitized = { ...input } as T & Record<string, unknown>;
  if (req.actor.type !== "agent") return sanitized;

  if (hasOwn(sanitized, "responsibleUserId") && sanitized.responsibleUserId != null) {
    await auditAgentIssueCreateAttributionSpoof({
      db,
      req,
      companyId,
      entityId: options.entityId,
      surface: options.surface,
      field: "responsibleUserId",
      action: "rejected",
      requestedValue: readNonEmptyString(sanitized.responsibleUserId),
    });
    res.status(422).json({ error: "Agent-created issues cannot set responsibleUserId" });
    return null;
  }

  if (hasOwn(sanitized, "createdByUserId") && sanitized.createdByUserId != null) {
    await auditAgentIssueCreateAttributionSpoof({
      db,
      req,
      companyId,
      entityId: options.entityId,
      surface: options.surface,
      field: "createdByUserId",
      action: "stripped",
      requestedValue: readNonEmptyString(sanitized.createdByUserId),
    });
    delete sanitized.createdByUserId;
  }

  delete sanitized.responsibleUserId;
  return sanitized;
}

function authenticatedActorResponsibleUserId(req: Request) {
  return req.actor.type === "agent" ? req.actor.onBehalfOfUserId ?? null : null;
}

function readPlanConfirmationTargetForIssue(payload: unknown, issueId: string) {
  const target = readObject(readObject(payload).target);
  if (target.type !== "issue_document" || target.key !== "plan") return null;
  if (readNonEmptyString(target.issueId) !== issueId) return null;
  return {
    issueId,
    documentId: readNonEmptyString(target.documentId),
    key: "plan",
    revisionId: readNonEmptyString(target.revisionId),
    revisionNumber: typeof target.revisionNumber === "number" ? target.revisionNumber : null,
  };
}

function readConfirmationResultForWake(result: unknown) {
  const parsed = readObject(result);
  if (Object.keys(parsed).length === 0) return null;
  return {
    outcome: readNonEmptyString(parsed.outcome),
    reason: readNonEmptyString(parsed.reason) ?? readNonEmptyString(parsed.rejectionReason),
    commentId: readNonEmptyString(parsed.commentId),
  };
}

function hasIssueWorkspaceAuditChange(previous: Record<string, unknown>) {
  return Object.keys(previous).some((key) => ISSUE_WORKSPACE_AUDIT_FIELDS.has(key));
}

function labelIssueWorkspaceMode(mode: string | null) {
  switch (mode) {
    case "shared_workspace":
      return "Project default";
    case "isolated_workspace":
      return "New isolated workspace";
    case "operator_branch":
      return "Operator branch";
    case "reuse_existing":
      return "Reuse existing workspace";
    case "agent_default":
      return "Agent default";
    case "inherit":
      return "Inherited workspace";
    default:
      return "No workspace";
  }
}

type IssueWorkspaceAuditInput = {
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: unknown;
};

type WorkspaceNameMaps = {
  projectWorkspaceNames: Map<string, string>;
  executionWorkspaceNames: Map<string, string>;
};

function emptyWorkspaceNameMaps(): WorkspaceNameMaps {
  return {
    projectWorkspaceNames: new Map(),
    executionWorkspaceNames: new Map(),
  };
}

function summarizeIssueWorkspaceForActivity(
  issue: IssueWorkspaceAuditInput,
  names: WorkspaceNameMaps,
) {
  const settings = parseIssueExecutionWorkspaceSettings(issue.executionWorkspaceSettings, { includeEnvironmentId: true });
  const mode = settings?.mode ?? issue.executionWorkspacePreference ?? null;
  const executionWorkspaceId = issue.executionWorkspaceId ?? null;
  const projectWorkspaceId = issue.projectWorkspaceId ?? null;

  const label = (() => {
    if (executionWorkspaceId) {
      return names.executionWorkspaceNames.get(executionWorkspaceId) ?? `Workspace ${executionWorkspaceId.slice(0, 8)}`;
    }
    if (projectWorkspaceId) {
      return names.projectWorkspaceNames.get(projectWorkspaceId) ?? `Workspace ${projectWorkspaceId.slice(0, 8)}`;
    }
    return labelIssueWorkspaceMode(mode);
  })();

  return {
    label,
    projectWorkspaceId,
    executionWorkspaceId,
    mode,
  };
}

async function buildIssueWorkspaceChangeActivityDetails(
  db: Db,
  companyId: string,
  previousIssue: IssueWorkspaceAuditInput,
  nextIssue: IssueWorkspaceAuditInput,
) {
  const projectWorkspaceIds = [
    previousIssue.projectWorkspaceId,
    nextIssue.projectWorkspaceId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const executionWorkspaceIds = [
    previousIssue.executionWorkspaceId,
    nextIssue.executionWorkspaceId,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  const [projectRows, executionRows] = await Promise.all([
    projectWorkspaceIds.length > 0
      ? db
          .select({ id: projectWorkspaces.id, name: projectWorkspaces.name })
          .from(projectWorkspaces)
          .where(and(eq(projectWorkspaces.companyId, companyId), inArray(projectWorkspaces.id, projectWorkspaceIds)))
      : Promise.resolve([]),
    executionWorkspaceIds.length > 0
      ? db
          .select({ id: executionWorkspaces.id, name: executionWorkspaces.name })
          .from(executionWorkspaces)
          .where(and(eq(executionWorkspaces.companyId, companyId), inArray(executionWorkspaces.id, executionWorkspaceIds)))
      : Promise.resolve([]),
  ]);

  const names: WorkspaceNameMaps = {
    projectWorkspaceNames: new Map(projectRows.map((row) => [row.id, row.name])),
    executionWorkspaceNames: new Map(executionRows.map((row) => [row.id, row.name])),
  };

  return {
    from: summarizeIssueWorkspaceForActivity(previousIssue, names),
    to: summarizeIssueWorkspaceForActivity(nextIssue, names),
  };
}

function hasExecutionParticipant(value: unknown) {
  const state = parseIssueExecutionState(value);
  if (!state || state.status !== "pending") return false;
  const participant = state.currentParticipant;
  if (!participant) return false;
  if (participant.type === "agent") return Boolean(participant.agentId);
  if (participant.type === "user") return Boolean(participant.userId);
  return false;
}

function hasScheduledMonitor(input: {
  existingMonitorNextCheckAt?: Date | null;
  patchMonitorNextCheckAt?: unknown;
  executionPolicy?: unknown;
}) {
  if (input.patchMonitorNextCheckAt instanceof Date && !Number.isNaN(input.patchMonitorNextCheckAt.getTime())) return true;
  if (input.patchMonitorNextCheckAt === undefined && input.existingMonitorNextCheckAt) return true;
  const policy = normalizeIssueExecutionPolicy(input.executionPolicy ?? null);
  return Boolean(policy?.monitor?.nextCheckAt);
}

function successfulRunHandoffStateFromActivity(row: {
  action: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}): SuccessfulRunHandoffState | null {
  const details = row.details ?? {};
  const state =
    row.action === "issue.successful_run_handoff_required"
      ? "required"
      : row.action === "issue.successful_run_handoff_resolved"
        ? "resolved"
        : row.action === "issue.successful_run_handoff_escalated"
          ? "escalated"
          : null;
  if (!state) return null;

  const detectedProgressSummary =
    readNonEmptyString(details.detectedProgressSummary)
    ?? readNonEmptyString(details.detected_progress_summary)
    ?? null;

  return {
    state,
    required: state === "required",
    hasLiveContinuation: false,
    sourceRunId:
      readNonEmptyString(details.sourceRunId)
      ?? readNonEmptyString(details.source_run_id)
      ?? readNonEmptyString(details.resumeFromRunId)
      ?? row.runId
      ?? null,
    correctiveRunId:
      readNonEmptyString(details.correctiveRunId)
      ?? readNonEmptyString(details.corrective_run_id)
      ?? (state !== "required" ? row.runId : null),
    assigneeAgentId:
      readNonEmptyString(details.assigneeAgentId)
      ?? readNonEmptyString(details.agentId)
      ?? row.agentId
      ?? null,
    detectedProgressSummary: detectedProgressSummary
      ? redactSensitiveText(detectedProgressSummary)
      : null,
    createdAt: row.createdAt,
  };
}

async function listSuccessfulRunHandoffStates(
  db: Db,
  companyId: string,
  issueIds: string[],
  options?: { hydrateLiveness?: boolean },
): Promise<Map<string, SuccessfulRunHandoffState>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db
    .select({
      entityId: activityLog.entityId,
      action: activityLog.action,
      agentId: activityLog.agentId,
      runId: activityLog.runId,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, companyId),
      eq(activityLog.entityType, "issue"),
      inArray(activityLog.entityId, issueIds),
      inArray(activityLog.action, [...SUCCESSFUL_RUN_HANDOFF_ACTIONS]),
    ))
    .orderBy(activityLog.entityId, desc(activityLog.createdAt), desc(activityLog.id)) as SuccessfulRunHandoffActivityRow[];

  const states = new Map<string, SuccessfulRunHandoffState>();
  for (const row of rows) {
    if (states.has(row.entityId)) continue;
    const state = successfulRunHandoffStateFromActivity(row);
    if (state) states.set(row.entityId, state);
  }
  return options?.hydrateLiveness === false
    ? states
    : hydrateSuccessfulRunHandoffLiveness(db, companyId, states);
}

type RecoveryActionsLister = {
  listActiveForIssues: (
    companyId: string,
    sourceIssueIds: string[],
  ) => Promise<Map<string, NonNullable<IssueRelationIssueSummary["activeRecoveryAction"]>>>;
};

async function relationRecoveryActionMap(
  recoveryActionsSvc: RecoveryActionsLister,
  companyId: string,
  relations: { blockedBy: IssueRelationIssueSummary[]; blocks: IssueRelationIssueSummary[] },
): Promise<Map<string, NonNullable<IssueRelationIssueSummary["activeRecoveryAction"]>>> {
  const candidates: IssueRelationIssueSummary[] = [];
  const visit = (summary: IssueRelationIssueSummary) => {
    candidates.push(summary);
    for (const terminal of summary.terminalBlockers ?? []) {
      visit(terminal);
    }
  };
  for (const blocker of relations.blockedBy) visit(blocker);
  for (const blocking of relations.blocks) visit(blocking);
  if (candidates.length === 0) return new Map();
  const ids = [...new Set(candidates.map((summary) => summary.id))];
  return recoveryActionsSvc.listActiveForIssues(companyId, ids);
}

function withRecoveryActionsOnRelationSummaries(
  relations: { blockedBy: IssueRelationIssueSummary[]; blocks: IssueRelationIssueSummary[] },
  recoveryActionByIssueId: Map<string, NonNullable<IssueRelationIssueSummary["activeRecoveryAction"]>>,
) {
  const augment = (summary: IssueRelationIssueSummary): IssueRelationIssueSummary => ({
    ...summary,
    activeRecoveryAction: recoveryActionByIssueId.get(summary.id) ?? summary.activeRecoveryAction ?? null,
    terminalBlockers: summary.terminalBlockers?.map(augment),
  });
  return {
    blockedBy: relations.blockedBy.map(augment),
    blocks: relations.blocks.map(augment),
  };
}

type IssueBlockerDiagnosticReadableIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

type IssueBlockerDiagnosticAuthzIssue = IssueBlockerDiagnosticReadableIssue & {
  companyId: string;
  projectId: string | null;
  parentId: string | null;
};

function toIssueBlockerDiagnosticSummary(
  issue: IssueBlockerDiagnosticReadableIssue,
): IssueBlockerDiagnosticIssueSummary {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status as IssueBlockerDiagnosticIssueSummary["status"],
    priority: issue.priority as IssueBlockerDiagnosticIssueSummary["priority"],
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
  };
}

function blockerDiagnosticLabel(issue: IssueBlockerDiagnosticIssueSummary) {
  return issue.identifier ?? issue.title;
}

function buildIssueBlockerDiagnosticsResponse(input: {
  issue: IssueBlockerDiagnosticReadableIssue;
  blockers: IssueBlockerDiagnosticAuthzIssue[];
  visibleBlockers: IssueBlockerDiagnosticAuthzIssue[];
  readiness: {
    allBlockersDone: boolean;
    isDependencyReady: boolean;
    unresolvedBlockerIssueIds: string[];
    pendingFinalizeBlockerIssueIds: string[];
  };
  truncated: boolean;
  maxBlockers?: number;
}): IssueBlockerDiagnosticsResponse {
  const issue = toIssueBlockerDiagnosticSummary(input.issue);
  const visibleBlockerIds = new Set(input.visibleBlockers.map((blocker) => blocker.id));
  const omittedUnauthorizedBlockerCount = input.blockers.filter(
    (blocker) => !visibleBlockerIds.has(blocker.id),
  ).length;
  const completeVisibleSet = !input.truncated && omittedUnauthorizedBlockerCount === 0;
  const unresolvedIds = new Set(input.readiness.unresolvedBlockerIssueIds);
  const pendingFinalizeIds = new Set(input.readiness.pendingFinalizeBlockerIssueIds);

  const blockers: IssueBlockerDiagnosticNode[] = input.visibleBlockers.map((blockerRow) => {
    const blocker = toIssueBlockerDiagnosticSummary(blockerRow);
    const isPendingFinalize = pendingFinalizeIds.has(blocker.id);
    const isUnresolved = unresolvedIds.has(blocker.id);
    const flags: IssueBlockerDiagnosticFlag[] = [];
    if (issue.status === "blocked" && blocker.status === "done") flags.push("done_but_blocking");
    if (blocker.status === "cancelled") flags.push("cancelled_blocker_in_set");
    if (isPendingFinalize) flags.push("workspace_finalize_pending");

    return {
      ...blocker,
      isUnresolved,
      isPendingFinalize,
      isDependencyReady: blocker.status === "done" && !isPendingFinalize,
      flags,
    };
  });

  const readiness: IssueBlockerDiagnosticsReadiness | null = completeVisibleSet
    ? {
        allBlockersDone: input.readiness.allBlockersDone,
        isDependencyReady: input.readiness.isDependencyReady,
        unresolvedBlockerCount: input.readiness.unresolvedBlockerIssueIds.length,
        pendingFinalizeBlockerCount: input.readiness.pendingFinalizeBlockerIssueIds.length,
      }
    : null;
  const reportedOmittedUnauthorizedBlockerCount = input.truncated
    ? null
    : omittedUnauthorizedBlockerCount;

  return {
    issue,
    diagnosis: buildIssueBlockerDiagnosis({
      issue,
      blockers,
      readiness,
      omittedUnauthorizedBlockerCount: reportedOmittedUnauthorizedBlockerCount,
      truncated: input.truncated,
      maxBlockers: input.maxBlockers ?? ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    }),
    readiness,
    blockers,
    omittedUnauthorizedBlockerCount: reportedOmittedUnauthorizedBlockerCount,
    truncated: input.truncated,
    caps: {
      maxBlockers: input.maxBlockers ?? ISSUE_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    },
  };
}

function buildIssueBlockerDiagnosis(input: {
  issue: IssueBlockerDiagnosticIssueSummary;
  blockers: IssueBlockerDiagnosticNode[];
  readiness: IssueBlockerDiagnosticsReadiness | null;
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  maxBlockers: number;
}) {
  if (input.truncated) {
    return `Blocker diagnostics for ${blockerDiagnosticLabel(input.issue)} are truncated at ${
      input.maxBlockers
    } blockers, so readiness is not reported.`;
  }
  const omittedUnauthorizedBlockerCount = input.omittedUnauthorizedBlockerCount ?? 0;
  if (omittedUnauthorizedBlockerCount > 0) {
    return `One or more blockers for ${blockerDiagnosticLabel(
      input.issue,
    )} are outside this actor's authorization boundary, so this diagnosis only covers visible blockers.`;
  }
  if (input.blockers.length === 0) {
    return input.issue.status === "blocked"
      ? `${blockerDiagnosticLabel(input.issue)} is blocked but has no first-class blocker relations.`
      : null;
  }

  const pendingFinalize = input.blockers.find((blocker) => blocker.isPendingFinalize);
  if (pendingFinalize) {
    return `${blockerDiagnosticLabel(input.issue)} is waiting for ${blockerDiagnosticLabel(
      pendingFinalize,
    )} to finish workspace finalization.`;
  }

  const cancelled = input.blockers.find((blocker) => blocker.status === "cancelled");
  if (cancelled) {
    return `${blockerDiagnosticLabel(input.issue)} is blocked by ${blockerDiagnosticLabel(
      cancelled,
    )}, which is cancelled; cancelled blockers do not resolve until the blocker relation is removed or replaced.`;
  }

  const unresolved = input.blockers.find((blocker) => blocker.isUnresolved);
  if (unresolved) {
    return `${blockerDiagnosticLabel(input.issue)} is blocked by ${blockerDiagnosticLabel(
      unresolved,
    )}, which is ${unresolved.status}.`;
  }

  if (input.readiness?.isDependencyReady && input.issue.status === "blocked") {
    return `All blockers for ${blockerDiagnosticLabel(
      input.issue,
    )} are resolved, but the issue is still blocked; this is likely a stale blocker hold.`;
  }
  if (input.readiness?.isDependencyReady) {
    return `All blockers for ${blockerDiagnosticLabel(input.issue)} are resolved.`;
  }

  return null;
}

const ISSUE_WAKE_DIAGNOSTIC_KNOWN_SOURCES = new Set([
  "timer",
  "assignment",
  "on_demand",
  "automation",
]);

const ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS = new Set([
  "issue_assigned",
  "issue_blockers_resolved",
  "issue_commented",
  "issue_comment_mentioned",
  "issue_dependencies_blocked",
  "issue_tree_hold_active",
  "missing_issue_comment",
  "process_lost_retry",
  "run_liveness_continuation",
  "heartbeat.disabled",
  "heartbeat.timer.no_actionable_work",
  "heartbeat.wakeOnDemand.disabled",
]);

const ISSUE_WAKE_DIAGNOSTIC_KNOWN_STATUSES = new Set([
  "queued",
  "claimed",
  "coalesced",
  "skipped",
  "completed",
  "failed",
  "cancelled",
  "deferred_issue_execution",
]);

function dateToIso(value: Date | string | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function projectWakeDiagnosticSource(value: string | null) {
  if (!value) return null;
  return ISSUE_WAKE_DIAGNOSTIC_KNOWN_SOURCES.has(value) ? value : "other";
}

function projectWakeDiagnosticReason(value: string | null) {
  if (!value) return null;
  return ISSUE_WAKE_DIAGNOSTIC_KNOWN_REASONS.has(value) ? value : "other";
}

function projectWakeDiagnosticStatus(value: string) {
  return ISSUE_WAKE_DIAGNOSTIC_KNOWN_STATUSES.has(value) ? value : "other";
}

function wakeFailureClass(
  status: string,
  rawError: string | null,
): IssueWakeDiagnosticWakeFailureClass | null {
  if (status === "failed" || rawError) return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "skipped") return "skipped";
  return null;
}

function projectIssueWakeRequest(row: {
  agentId: string;
  source: string;
  reason: string | null;
  status: string;
  coalescedCount: number;
  runId: string | null;
  requestedAt: Date | string;
  claimedAt: Date | string | null;
  finishedAt: Date | string | null;
  error: string | null;
}, options: { includeInternalIds: boolean }): IssueWakeDiagnosticWakeRequest {
  const status = projectWakeDiagnosticStatus(row.status);
  return {
    kind: "wake_request",
    agentId: options.includeInternalIds ? row.agentId : null,
    source: projectWakeDiagnosticSource(row.source) ?? "other",
    reason: projectWakeDiagnosticReason(row.reason),
    status,
    coalescedCount: row.coalescedCount,
    runId: options.includeInternalIds ? row.runId : null,
    requestedAt: dateToIso(row.requestedAt)!,
    claimedAt: dateToIso(row.claimedAt),
    finishedAt: dateToIso(row.finishedAt),
    failureClass: wakeFailureClass(status, row.error),
  };
}

function wakeDiagnosticActivityAction(action: string) {
  return action === "issue.tree_hold_wakeup_deferred" ? action : "other";
}

function wakeDiagnosticActivityEntityType(entityType: string) {
  return entityType === "issue" || entityType === "agent_wakeup_request" ? entityType : "other";
}

function projectIssueWakeActivityRecord(
  row: {
    action: string;
    entityType: string;
    entityId: string;
    agentId: string | null;
    runId: string | null;
    details: Record<string, unknown> | null;
    createdAt: Date | string;
  },
  issueId: string,
  options: { includeInternalIds: boolean },
): IssueWakeDiagnosticActivityRecord {
  const details = row.details && typeof row.details === "object" ? row.details : {};
  const action = wakeDiagnosticActivityAction(row.action);
  const rootIssueId = readNonEmptyString(details["rootIssueId"]);
  const detailIssueId = readNonEmptyString(details["issueId"]);
  const projectedRootIssueId =
    rootIssueId === issueId || detailIssueId === issueId || (row.entityType === "issue" && row.entityId === issueId)
      ? issueId
      : null;

  return {
    kind: "activity",
    action,
    entityType: wakeDiagnosticActivityEntityType(row.entityType),
    agentId: options.includeInternalIds ? row.agentId ?? readNonEmptyString(details["agentId"]) : null,
    runId: options.includeInternalIds ? row.runId : null,
    createdAt: dateToIso(row.createdAt)!,
    source: projectWakeDiagnosticSource(readNonEmptyString(details["source"])),
    requestedReason: projectWakeDiagnosticReason(readNonEmptyString(details["requestedReason"])),
    previousReason: projectWakeDiagnosticReason(readNonEmptyString(details["previousReason"])),
    rootIssueId: projectedRootIssueId,
    holdId: options.includeInternalIds ? readNonEmptyString(details["holdId"]) : null,
    summary: action === "issue.tree_hold_wakeup_deferred"
      ? "Wake was deferred because an active issue-tree hold was present."
      : "Wake-related activity was recorded.",
  };
}

function issueWakeDiagnosticEventTimestamp(event: IssueWakeDiagnosticEvent) {
  const timestamp = event.kind === "wake_request" ? event.requestedAt : event.createdAt;
  return new Date(timestamp).getTime();
}

function wakeDiagnosticReasonPhrase(reason: string | null) {
  return reason ? ` for ${reason}` : "";
}

function buildIssueWakeDiagnosis(input: {
  issue: IssueBlockerDiagnosticIssueSummary;
  events: IssueWakeDiagnosticEvent[];
  blockerDiagnostics: IssueBlockerDiagnosticsResponse;
  truncated: boolean;
  maxWakeRequests: number;
  maxActivityRecords: number;
  lookbackDays: number;
}) {
  if (input.truncated) {
    return `Wake diagnostics for ${blockerDiagnosticLabel(input.issue)} are truncated to ${
      input.maxWakeRequests
    } wake requests and ${input.maxActivityRecords} activity records over ${
      input.lookbackDays
    } days, so the diagnosis only covers returned records.`;
  }

  const latest = input.events[0];
  if (latest?.kind === "activity" && latest.action === "issue.tree_hold_wakeup_deferred") {
    return `The most recent wake-related activity for ${blockerDiagnosticLabel(
      input.issue,
    )} was deferred by an active issue-tree hold.`;
  }
  if (latest?.kind === "wake_request") {
    if (latest.status === "deferred_issue_execution") {
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} is deferred${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}.`;
    }
    if (latest.status === "failed") {
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} failed${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}; raw error text is withheld.`;
    }
    if (latest.status === "skipped" || latest.status === "cancelled" || latest.status === "coalesced") {
      const coalesced =
        latest.coalescedCount > 0 ? ` and coalesced ${latest.coalescedCount} additional request(s)` : "";
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} was ${latest.status}${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}${coalesced}.`;
    }
    if (latest.status === "queued" || latest.status === "claimed") {
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} is currently ${latest.status}${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}.`;
    }
    if (latest.status === "completed") {
      return `The most recent wake for ${blockerDiagnosticLabel(input.issue)} completed${wakeDiagnosticReasonPhrase(
        latest.reason,
      )}.`;
    }
  }

  if (input.events.length > 0) return null;

  const blockerDiagnostics = input.blockerDiagnostics;
  if (blockerDiagnostics.truncated) {
    return `No wake rows are visible for ${blockerDiagnosticLabel(
      input.issue,
    )} in the bounded window, and blocker diagnostics are truncated, so no wake cause is inferred.`;
  }
  if ((blockerDiagnostics.omittedUnauthorizedBlockerCount ?? 0) > 0) {
    return `No wake rows are visible for ${blockerDiagnosticLabel(
      input.issue,
    )} in the bounded window, and one or more blockers are outside this actor's authorization boundary.`;
  }
  if (input.issue.status !== "blocked" || blockerDiagnostics.blockers.length === 0) return null;

  const pendingFinalize = blockerDiagnostics.blockers.find((blocker) => blocker.isPendingFinalize);
  if (pendingFinalize) {
    return `No wake row exists for ${blockerDiagnosticLabel(input.issue)} in the bounded window. ${blockerDiagnosticLabel(
      input.issue,
    )} is waiting for ${blockerDiagnosticLabel(pendingFinalize)} to finish workspace finalization, so issue_blockers_resolved has not fired.`;
  }

  const cancelled = blockerDiagnostics.blockers.find((blocker) => blocker.status === "cancelled");
  if (cancelled) {
    return `No wake row exists for ${blockerDiagnosticLabel(input.issue)} in the bounded window. ${blockerDiagnosticLabel(
      input.issue,
    )} is blocked by ${blockerDiagnosticLabel(cancelled)}, which is cancelled; cancelled blockers do not fire issue_blockers_resolved.`;
  }

  const unresolved = blockerDiagnostics.blockers.find((blocker) => blocker.isUnresolved);
  if (unresolved) {
    return `No wake row exists for ${blockerDiagnosticLabel(input.issue)} in the bounded window. ${blockerDiagnosticLabel(
      input.issue,
    )} is blocked by ${blockerDiagnosticLabel(unresolved)}, which is ${unresolved.status}, so issue_blockers_resolved has not fired.`;
  }

  if (blockerDiagnostics.readiness?.isDependencyReady) {
    return `No wake row exists for ${blockerDiagnosticLabel(
      input.issue,
    )} in the bounded window. All visible blockers are resolved, but the issue is still blocked; this is likely a stale blocker hold or an older wake outside the lookback window.`;
  }

  return null;
}

function buildIssueWakeDiagnosticsResponse(input: {
  issue: IssueBlockerDiagnosticReadableIssue;
  wakeRequests: Array<{
    agentId: string;
    source: string;
    reason: string | null;
    status: string;
    coalescedCount: number;
    runId: string | null;
    requestedAt: Date | string;
    claimedAt: Date | string | null;
    finishedAt: Date | string | null;
    error: string | null;
  }>;
  activityRecords: Array<{
    action: string;
    entityType: string;
    entityId: string;
    agentId: string | null;
    runId: string | null;
    details: Record<string, unknown> | null;
    createdAt: Date | string;
  }>;
  blockerDiagnostics: IssueBlockerDiagnosticsResponse;
  truncatedWakeRequests: boolean;
  truncatedActivityRecords: boolean;
  includeInternalIds: boolean;
  maxWakeRequests?: number;
  maxActivityRecords?: number;
  lookbackDays?: number;
}): IssueWakeDiagnosticsResponse {
  const issue = toIssueBlockerDiagnosticSummary(input.issue);
  const events: IssueWakeDiagnosticEvent[] = [
    ...input.wakeRequests.map((record) =>
      projectIssueWakeRequest(record, { includeInternalIds: input.includeInternalIds }),
    ),
    ...input.activityRecords.map((record) =>
      projectIssueWakeActivityRecord(record, issue.id, { includeInternalIds: input.includeInternalIds }),
    ),
  ].sort((left, right) => issueWakeDiagnosticEventTimestamp(right) - issueWakeDiagnosticEventTimestamp(left));
  const truncated = input.truncatedWakeRequests || input.truncatedActivityRecords;
  const maxWakeRequests = input.maxWakeRequests ?? ISSUE_WAKE_DIAGNOSTICS_MAX_WAKE_REQUESTS;
  const maxActivityRecords = input.maxActivityRecords ?? ISSUE_WAKE_DIAGNOSTICS_MAX_ACTIVITY_RECORDS;
  const lookbackDays = input.lookbackDays ?? ISSUE_WAKE_DIAGNOSTICS_LOOKBACK_DAYS;
  const diagnosis = buildIssueWakeDiagnosis({
    issue,
    events,
    blockerDiagnostics: input.blockerDiagnostics,
    truncated,
    maxWakeRequests,
    maxActivityRecords,
    lookbackDays,
  });

  return {
    issue,
    diagnosis,
    likelyReason: diagnosis,
    events,
    wakeRequestCount: input.wakeRequests.length,
    activityRecordCount: input.activityRecords.length,
    truncated,
    truncatedSections: {
      wakeRequests: input.truncatedWakeRequests,
      activityRecords: input.truncatedActivityRecords,
    },
    caps: {
      maxWakeRequests,
      maxActivityRecords,
      lookbackDays,
    },
  };
}

type IssueSubtreeDiagnosticAuthzNode = IssueBlockerDiagnosticAuthzIssue & {
  depth: number;
  createdAt: Date | string;
  updatedAt: Date | string;
};

type IssueSubtreeDiagnosticBlockerAuthzRow = IssueBlockerDiagnosticAuthzIssue & {
  blockedIssueId: string;
  relationCreatedAt: Date | string;
};

type IssueSubtreeDiagnosticWakeRequestRow = {
  issueId: string;
  agentId: string;
  source: string;
  reason: string | null;
  status: string;
  coalescedCount: number;
  runId: string | null;
  requestedAt: Date | string;
  claimedAt: Date | string | null;
  finishedAt: Date | string | null;
  error: string | null;
};

type IssueSubtreeDiagnosticActivityRow = {
  issueId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date | string;
};

function groupByIssueId<T extends { issueId: string }>(rows: T[]) {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const issueRows = map.get(row.issueId) ?? [];
    issueRows.push(row);
    map.set(row.issueId, issueRows);
  }
  return map;
}

function groupBlockersByBlockedIssueId(rows: IssueSubtreeDiagnosticBlockerAuthzRow[]) {
  const map = new Map<string, IssueSubtreeDiagnosticBlockerAuthzRow[]>();
  for (const row of rows) {
    const issueRows = map.get(row.blockedIssueId) ?? [];
    issueRows.push(row);
    map.set(row.blockedIssueId, issueRows);
  }
  return map;
}

function issueSubtreeEdgeTimestamp(edge: IssueSubtreeDiagnosticEdge) {
  return edge.timestamp ? new Date(edge.timestamp).getTime() : 0;
}

function buildIssueSubtreeDiagnosis(input: {
  issue: IssueBlockerDiagnosticIssueSummary;
  nodes: IssueSubtreeDiagnosticNode[];
  omittedUnauthorizedNodeCount: number | null;
  truncated: boolean;
  caps: IssueSubtreeDiagnosticsResponse["caps"];
}) {
  if (input.truncated) {
    return `Subtree diagnostics for ${blockerDiagnosticLabel(input.issue)} are bounded to depth ${
      input.caps.maxDepth
    } and ${input.caps.maxNodes} nodes, so the diagnosis only covers returned visible nodes.`;
  }
  if ((input.omittedUnauthorizedNodeCount ?? 0) > 0) {
    return `One or more subtree nodes under ${blockerDiagnosticLabel(
      input.issue,
    )} are outside this actor's authorization boundary, so this diagnosis only covers visible nodes.`;
  }

  const blockedNodeWithDiagnosis = input.nodes.find((node) => node.issue.status === "blocked" && node.diagnosis);
  const firstNodeWithDiagnosis = blockedNodeWithDiagnosis ?? input.nodes.find((node) => node.diagnosis);
  if (!firstNodeWithDiagnosis?.diagnosis) return null;

  return `${blockerDiagnosticLabel(firstNodeWithDiagnosis.issue)} appears to be the subtree stall point: ${
    firstNodeWithDiagnosis.diagnosis
  }`;
}

function buildIssueSubtreeDiagnosticsResponse(input: {
  issue: IssueBlockerDiagnosticReadableIssue;
  nodes: IssueSubtreeDiagnosticAuthzNode[];
  visibleNodes: IssueSubtreeDiagnosticAuthzNode[];
  blockersByIssueId: Map<string, IssueSubtreeDiagnosticBlockerAuthzRow[]>;
  visibleBlockers: IssueSubtreeDiagnosticBlockerAuthzRow[];
  readinessByIssueId: Map<string, {
    allBlockersDone: boolean;
    isDependencyReady: boolean;
    unresolvedBlockerIssueIds: string[];
    pendingFinalizeBlockerIssueIds: string[];
  }>;
  wakeRequestsByIssueId: Map<string, IssueSubtreeDiagnosticWakeRequestRow[]>;
  activityRecordsByIssueId: Map<string, IssueSubtreeDiagnosticActivityRow[]>;
  truncatedNodes: boolean;
  truncatedDepth: boolean;
  truncatedBlockerIssueIds: Set<string>;
  truncatedWakeIssueIds: Set<string>;
  truncatedActivityIssueIds: Set<string>;
  includeInternalIds: boolean;
  caps: IssueSubtreeDiagnosticsResponse["caps"];
}): IssueSubtreeDiagnosticsResponse {
  const issue = toIssueBlockerDiagnosticSummary(input.issue);
  const visibleNodeIds = new Set(input.visibleNodes.map((node) => node.id));
  const visibleBlockerIdsByIssueId = groupBlockersByBlockedIssueId(input.visibleBlockers);
  const omittedUnauthorizedNodeCount = input.truncatedNodes || input.truncatedDepth
    ? null
    : input.nodes.filter((node) => !visibleNodeIds.has(node.id)).length;
  const nodeResponses: IssueSubtreeDiagnosticNode[] = [];
  const edges: IssueSubtreeDiagnosticEdge[] = [];

  for (const node of input.visibleNodes) {
    const rawBlockers = input.blockersByIssueId.get(node.id) ?? [];
    const visibleBlockers = visibleBlockerIdsByIssueId.get(node.id) ?? [];
    const blockerResponse = buildIssueBlockerDiagnosticsResponse({
      issue: node,
      blockers: rawBlockers,
      visibleBlockers,
      readiness: input.readinessByIssueId.get(node.id) ?? {
        allBlockersDone: true,
        isDependencyReady: true,
        unresolvedBlockerIssueIds: [],
        pendingFinalizeBlockerIssueIds: [],
      },
      truncated: input.truncatedBlockerIssueIds.has(node.id),
      maxBlockers: input.caps.maxBlockersPerNode,
    });
    const wakeResponse = buildIssueWakeDiagnosticsResponse({
      issue: node,
      wakeRequests: input.wakeRequestsByIssueId.get(node.id) ?? [],
      activityRecords: input.activityRecordsByIssueId.get(node.id) ?? [],
      blockerDiagnostics: blockerResponse,
      truncatedWakeRequests: input.truncatedWakeIssueIds.has(node.id),
      truncatedActivityRecords: input.truncatedActivityIssueIds.has(node.id),
      includeInternalIds: input.includeInternalIds,
      maxWakeRequests: input.caps.maxWakeRequestsPerNode,
      maxActivityRecords: input.caps.maxActivityRecordsPerNode,
      lookbackDays: input.caps.lookbackDays,
    });
    const nodeDiagnosis = wakeResponse.diagnosis ?? blockerResponse.diagnosis;

    if (node.parentId && visibleNodeIds.has(node.parentId)) {
      edges.push({
        kind: "parent",
        fromIssueId: node.parentId,
        toIssueId: node.id,
        timestamp: dateToIso(node.createdAt),
      });
    }
    for (const blocker of visibleBlockers) {
      edges.push({
        kind: "blocks",
        fromIssueId: blocker.id,
        toIssueId: node.id,
        timestamp: dateToIso(blocker.relationCreatedAt),
      });
    }
    for (const event of wakeResponse.events) {
      if (event.kind === "wake_request") {
        edges.push({
          kind: "wake_request",
          issueId: node.id,
          agentId: event.agentId,
          reason: event.reason,
          status: event.status,
          timestamp: event.requestedAt,
        });
      } else {
        edges.push({
          kind: "activity",
          issueId: node.id,
          action: event.action,
          timestamp: event.createdAt,
        });
      }
    }

    nodeResponses.push({
      issue: toIssueBlockerDiagnosticSummary(node),
      parentId: node.parentId && visibleNodeIds.has(node.parentId) ? node.parentId : null,
      depth: node.depth,
      diagnosis: nodeDiagnosis,
      likelyReason: nodeDiagnosis,
      blockers: blockerResponse.blockers,
      blockerReadiness: blockerResponse.readiness,
      omittedUnauthorizedBlockerCount: blockerResponse.omittedUnauthorizedBlockerCount,
      wakeEvents: wakeResponse.events,
      wakeRequestCount: wakeResponse.wakeRequestCount,
      activityRecordCount: wakeResponse.activityRecordCount,
      truncated: blockerResponse.truncated || wakeResponse.truncated,
      truncatedSections: {
        blockers: blockerResponse.truncated,
        wakeRequests: wakeResponse.truncatedSections.wakeRequests,
        activityRecords: wakeResponse.truncatedSections.activityRecords,
      },
    });
  }

  edges.sort((left, right) => issueSubtreeEdgeTimestamp(right) - issueSubtreeEdgeTimestamp(left));
  const truncatedSections = {
    nodes: input.truncatedNodes,
    depth: input.truncatedDepth,
    blockers: input.truncatedBlockerIssueIds.size > 0,
    wakeRequests: input.truncatedWakeIssueIds.size > 0,
    activityRecords: input.truncatedActivityIssueIds.size > 0,
  };
  const truncated = Object.values(truncatedSections).some(Boolean);
  const diagnosis = buildIssueSubtreeDiagnosis({
    issue,
    nodes: nodeResponses,
    omittedUnauthorizedNodeCount,
    truncated,
    caps: input.caps,
  });

  return {
    issue,
    diagnosis,
    likelyReason: diagnosis,
    nodes: nodeResponses,
    edges,
    nodeCount: nodeResponses.length,
    omittedUnauthorizedNodeCount,
    truncated,
    truncatedSections,
    caps: input.caps,
  };
}

const ACTIVE_REVIEW_APPROVAL_STATUSES = new Set(["pending", "revision_requested"]);

const INVALID_AGENT_IN_REVIEW_DISPOSITION_MESSAGE =
  "invalid_issue_disposition: Agent-authored updates that move an issue to in_review must include a real review path. " +
  "This request would leave the issue in_review without anyone or anything owning the next action. " +
  "Keep working instead of moving to review, create a request_confirmation or ask_user_questions interaction, " +
  "link or request a pending approval, assign a human reviewer with assigneeUserId, set a typed executionState.currentParticipant through an execution policy, " +
  "or schedule an issue monitor for an external review/check. After creating one of those review paths, retry the status update.";

function executionPrincipalsEqual(
  left: ParsedExecutionState["currentParticipant"] | null,
  right: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!left || !right || left.type !== right.type) return false;
  return left.type === "agent" ? left.agentId === right.agentId : left.userId === right.userId;
}

function actorMatchesExecutionParticipant(
  actor: { actorType: "user" | "agent"; actorId: string },
  participant: ParsedExecutionState["currentParticipant"] | null,
) {
  if (!participant) return false;
  // Require the actor kind to match the participant kind before comparing ids. Without this
  // an agent and a user that happen to share an id value would falsely satisfy participant
  // gating on the auto-approval path.
  if (participant.type !== actor.actorType) return false;
  return participant.type === "agent" ? participant.agentId === actor.actorId : participant.userId === actor.actorId;
}

// Negation/rejection markers that invalidate an otherwise approval-looking heading.
// Match common phrasings ("NOT APPROVED", "Do not approve", "Not approving", "Changes requested",
// "Rejected", "Denied", "Blocked") so a reviewer comment intending to reject cannot auto-complete
// the issue. We rely on the heading being a single line, so testing the heading text alone is safe.
const APPROVAL_NEGATION_REGEX =
  /\b(?:NOT|REJECT(?:ED|ING|S)?|DENY|DENIED|DENYING|BLOCK(?:ED|ING|S)?|CHANGES?\s+REQUESTED)\b/i;

function isApprovalReviewComment(body: string) {
  const normalized = body.replace(/\r\n?/g, "\n");
  const headingMatch = normalized.match(/(?:^|\n)##\s*Review:\s*([^\n]*)/i);
  if (headingMatch) {
    const headingText = headingMatch[1];
    if (/\bAPPROVED\b/i.test(headingText) && !APPROVAL_NEGATION_REGEX.test(headingText)) {
      return true;
    }
  }
  // Require the `kind: review` and `decision: approved` lines to appear on truly consecutive
  // lines (no blank-line separation) so prose like "the previous sprint decision: approved"
  // can't combine with an unrelated `kind: review` line elsewhere in the body to trigger
  // auto-approval. Use `[ \t]*` between the lines so `\s*` does not silently swallow a newline.
  return (
    /^[ \t]*kind[ \t]*:[ \t]*review[ \t]*\n[ \t]*decision[ \t]*:[ \t]*approved[ \t]*$/im.test(normalized)
    || /^[ \t]*decision[ \t]*:[ \t]*approved[ \t]*\n[ \t]*kind[ \t]*:[ \t]*review[ \t]*$/im.test(normalized)
  );
}

function buildExecutionStageWakeContext(input: {
  state: ParsedExecutionState;
  wakeRole: ExecutionStageWakeContext["wakeRole"];
  allowedActions: string[];
}): ExecutionStageWakeContext {
  return {
    wakeRole: input.wakeRole,
    stageId: input.state.currentStageId,
    stageType: input.state.currentStageType,
    currentParticipant: input.state.currentParticipant,
    returnAssignee: input.state.returnAssignee,
    reviewRequest: input.state.reviewRequest ?? null,
    lastDecisionOutcome: input.state.lastDecisionOutcome,
    allowedActions: input.allowedActions,
  };
}

function summarizeIssueRelationForActivity(relation: {
  id: string;
  identifier: string | null;
  title: string;
}): ActivityIssueRelationSummary {
  return {
    id: relation.id,
    identifier: relation.identifier,
    title: relation.title,
  };
}

const defaultCompanySearchRateLimiter = createCompanySearchRateLimiter();

function companySearchRateLimitActor(req: Request, companyId: string) {
  if (req.actor.type === "agent") {
    return {
      companyId,
      actorType: "agent" as const,
      actorId: req.actor.agentId ?? req.actor.keyId ?? "unknown-agent",
    };
  }
  return {
    companyId,
    actorType: "board" as const,
    actorId: req.actor.userId ?? req.actor.source ?? "board",
  };
}

function summarizeIssueReferenceActivityDetails(input:
  | {
      addedReferencedIssues: ActivityIssueRelationSummary[];
      removedReferencedIssues: ActivityIssueRelationSummary[];
      currentReferencedIssues: ActivityIssueRelationSummary[];
    }
  | null
  | undefined,
) {
  if (!input) return {};
  return {
    ...(input.addedReferencedIssues.length > 0 ? { addedReferencedIssues: input.addedReferencedIssues } : {}),
    ...(input.removedReferencedIssues.length > 0 ? { removedReferencedIssues: input.removedReferencedIssues } : {}),
    ...(input.currentReferencedIssues.length > 0 ? { currentReferencedIssues: input.currentReferencedIssues } : {}),
  };
}

function monitorPoliciesEqual(left: NormalizedExecutionPolicy | null, right: NormalizedExecutionPolicy | null) {
  return JSON.stringify(left?.monitor ?? null) === JSON.stringify(right?.monitor ?? null);
}

function applyActorMonitorScheduledBy(
  policy: NormalizedExecutionPolicy | null,
  actorType: "agent" | "user",
) {
  return setIssueExecutionPolicyMonitorScheduledBy(policy, actorType === "user" ? "board" : "assignee");
}

async function assertCanManageIssueMonitor(
  accessSvc: ReturnType<typeof accessService>,
  req: Request,
  companyId: string,
  assigneeAgentId: string | null,
  monitorChanged: boolean,
) {
  if (!monitorChanged) return;
  if (req.actor.type === "board") return;
  const runtimeDecision = await accessSvc.decide({
    actor: req.actor,
    action: "runtime:manage",
    resource: { type: "company", companyId },
  });
  if (!runtimeDecision.allowed) {
    throw forbidden(runtimeDecision.explanation, authorizationDeniedDetails(runtimeDecision));
  }
  if (req.actor.type === "agent" && req.actor.agentId && req.actor.agentId === assigneeAgentId) return;
  throw forbidden("Only the assignee agent or a board user can manage issue monitors");
}

function summarizeIssueMonitor(
  issue: {
    monitorNextCheckAt?: Date | null;
    monitorLastTriggeredAt?: Date | null;
    monitorAttemptCount?: number | null;
    monitorNotes?: string | null;
    monitorScheduledBy?: string | null;
    executionState?: unknown;
  },
  policy: NormalizedExecutionPolicy | null,
) {
  const state = parseIssueExecutionState(issue.executionState);
  return {
    nextCheckAt: issue.monitorNextCheckAt?.toISOString() ?? policy?.monitor?.nextCheckAt ?? null,
    lastTriggeredAt: issue.monitorLastTriggeredAt?.toISOString() ?? state?.monitor?.lastTriggeredAt ?? null,
    attemptCount: issue.monitorAttemptCount ?? state?.monitor?.attemptCount ?? 0,
    notes: policy?.monitor?.notes ?? issue.monitorNotes ?? state?.monitor?.notes ?? null,
    scheduledBy: issue.monitorScheduledBy ?? policy?.monitor?.scheduledBy ?? state?.monitor?.scheduledBy ?? null,
    kind: policy?.monitor?.kind ?? state?.monitor?.kind ?? null,
    serviceName: policy?.monitor?.serviceName ?? state?.monitor?.serviceName ?? null,
    externalRef: redactIssueMonitorExternalRef(policy?.monitor?.externalRef ?? state?.monitor?.externalRef ?? null),
    timeoutAt: policy?.monitor?.timeoutAt ?? state?.monitor?.timeoutAt ?? null,
    maxAttempts: policy?.monitor?.maxAttempts ?? state?.monitor?.maxAttempts ?? null,
    recoveryPolicy: policy?.monitor?.recoveryPolicy ?? state?.monitor?.recoveryPolicy ?? null,
    status: state?.monitor?.status ?? (policy?.monitor ? "scheduled" : null),
    clearReason: state?.monitor?.clearReason ?? null,
  };
}

function activityExecutionParticipantKey(participant: ActivityExecutionParticipant): string {
  return participant.type === "agent" ? `agent:${participant.agentId}` : `user:${participant.userId}`;
}

function summarizeExecutionParticipants(
  policy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
): ActivityExecutionParticipant[] {
  const stage = policy?.stages.find((candidate) => candidate.type === stageType);
  return (
    stage?.participants.map((participant) => ({
      type: participant.type,
      agentId: participant.agentId ?? null,
      userId: participant.userId ?? null,
    })) ?? []
  );
}

function isClosedIssueStatus(status: string | null | undefined): status is "done" | "cancelled" {
  return status === "done" || status === "cancelled";
}

function shouldImplicitlyMoveCommentedIssueToTodo(input: {
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
  actorRunId: string | null | undefined;
  checkoutRunId: string | null | undefined;
  executionRunId: string | null | undefined;
}) {
  // Local-CLI agents post comments under user auth, so the actor.type is "user"
  // even though the comment originates from the same heartbeat run that owns
  // the issue lock. Without this guard, an agent that closes its own issue and
  // then posts a follow-up comment in the same run silently reopens it.
  // Suppress the implicit move whenever the comment's source run matches the
  // issue's checkout/execution run.
  if (
    typeof input.actorRunId === "string"
    && input.actorRunId.length > 0
    && (input.actorRunId === input.checkoutRunId || input.actorRunId === input.executionRunId)
  ) {
    return false;
  }
  // Only human comments should implicitly reopen finished work.
  // Agent-authored comments remain communicative unless reopen was explicit.
  if (input.actorType !== "user") return false;
  if (!isClosedIssueStatus(input.issueStatus) && input.issueStatus !== "blocked") return false;
  if (typeof input.assigneeAgentId !== "string" || input.assigneeAgentId.length === 0) return false;
  return true;
}

function shouldHumanCommentResumeInProgressScheduledRetry(input: {
  hasComment: boolean;
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
}) {
  if (!input.hasComment) return false;
  if (input.actorType !== "user") return false;
  if (input.issueStatus !== "in_progress") return false;
  return typeof input.assigneeAgentId === "string" && input.assigneeAgentId.length > 0;
}

function isExplicitResumeCapableStatus(status: string | null | undefined) {
  return status === "done" || status === "blocked" || status === "todo" || status === "in_progress";
}

// Log-class comment from the assignee agent on a terminal (done/cancelled)
// issue is not a reopen signal. When the caller did not pass `resume: true`,
// this forces the reopen path off even if `reopen: true` was sent.
function isAssigneeSelfCommentOnTerminalIssue(input: {
  hasCommentBody: boolean;
  resumeRequested: boolean;
  issueStatus: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  actorType: "agent" | "user";
  actorId: string;
}) {
  if (!input.hasCommentBody) return false;
  if (input.resumeRequested) return false;
  if (!isClosedIssueStatus(input.issueStatus)) return false;
  if (typeof input.assigneeAgentId !== "string" || input.assigneeAgentId.length === 0) return false;
  if (input.actorType !== "agent") return false;
  return input.actorId === input.assigneeAgentId;
}

function readToolActionExecutionStatus(value: unknown) {
  return value === "approved"
    || value === "executing"
    || value === "executed"
    || value === "failed"
    || value === "expired"
    ? value
    : null;
}

function readToolActionContinuationContext(interaction: {
  status: string;
  payload?: unknown;
  result?: unknown;
}) {
  const payload = readObject(interaction.payload);
  const toolActionPayload = readObject(payload.toolAction);
  const toolName = readNonEmptyString(toolActionPayload.toolName);
  const actionRequestId = readNonEmptyString(toolActionPayload.actionRequestId);
  if (!toolName || !actionRequestId) return null;

  const result = readObject(interaction.result);
  const toolActionResult = readObject(result.toolAction);
  const declineReason = interaction.status === "rejected"
    ? readNonEmptyString(result.reason)
    : null;
  const error = readNonEmptyString(toolActionResult.errorMessage);
  const resultSummary = readNonEmptyString(toolActionResult.resultSummary);

  if (interaction.status === "rejected") {
    return {
      toolName,
      actionRequestId,
      decision: "rejected",
      executionStatus: "rejected",
      ...(declineReason ? { declineReason } : {}),
      instructions: `the action was declined${declineReason ? `: ${declineReason}` : ""}; do not retry the same call — adjust your approach or mark the task blocked/in_review with the decline reason.`,
    };
  }

  if (interaction.status !== "accepted") return null;
  const executionStatus = readToolActionExecutionStatus(toolActionResult.status);
  if (!executionStatus) return null;

  if (executionStatus === "executed") {
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(resultSummary ? { resultSummary } : {}),
      instructions: `the approved ${toolName} action already ran — do not call the tool again; continue with this result.`,
    };
  }

  if (executionStatus === "failed") {
    const failureMessage = error ?? "an unknown error";
    return {
      toolName,
      actionRequestId,
      decision: "accepted",
      executionStatus,
      ...(error ? { error } : {}),
      instructions: `the approved action ran and failed with ${failureMessage}; adjust your approach — a fresh call will open a new approval.`,
    };
  }

  return {
    toolName,
    actionRequestId,
    decision: "accepted",
    executionStatus,
    instructions: `the approved ${toolName} action is ${executionStatus}; do not call the tool again while this approval is being processed.`,
  };
}

const REQUEST_ITEM_VERDICTS_WAKE_COALESCE_WINDOW_MS = 2_000;

function buildRequestItemVerdictsWakeIdempotencyKey(args: {
  issueId: string;
  interactionId: string;
  at?: Date;
}) {
  const now = args.at ?? new Date();
  const bucket = Math.floor(now.getTime() / REQUEST_ITEM_VERDICTS_WAKE_COALESCE_WINDOW_MS);
  return `request_item_verdicts:${args.issueId}:${args.interactionId}:${bucket}`;
}

function queueResolvedInteractionContinuationWakeup(input: {
  heartbeat: ReturnType<typeof heartbeatService>;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  interaction: {
    id: string;
    kind: string;
    status: string;
    continuationPolicy: string;
    sourceCommentId?: string | null;
    sourceRunId?: string | null;
    payload?: unknown;
    result?: unknown;
  };
  actor: { actorType: "user" | "agent"; actorId: string };
  source: string;
  forceFreshSession?: boolean;
  workspaceRefreshReason?: string | null;
  newlyResolvedItemIds?: string[];
  idempotencyKey?: string | null;
}) {
  if (
    input.interaction.continuationPolicy !== "wake_assignee"
    && input.interaction.continuationPolicy !== "wake_assignee_on_accept"
  ) return;
  if (
    input.interaction.continuationPolicy === "wake_assignee_on_accept"
    && input.interaction.status !== "accepted"
  ) return;
  if (input.interaction.status === "expired") return;
  if (!input.issue.assigneeAgentId || isClosedIssueStatus(input.issue.status)) return;

  const forceFreshSession = input.forceFreshSession === true;
  const workspaceRefreshReason = readNonEmptyString(input.workspaceRefreshReason);
  const planTarget = readPlanConfirmationTargetForIssue(input.interaction.payload, input.issue.id);
  const interactionResult = readConfirmationResultForWake(input.interaction.result);
  const checkboxSelection = readCheckboxSelectionForWake(input.interaction);
  const toolAction = readToolActionContinuationContext(input.interaction);
  const newlyResolvedItemIds = input.newlyResolvedItemIds?.filter((value) => value.length > 0) ?? [];
  const itemVerdicts = newlyResolvedItemIds.length > 0
    ? {
        newlyResolvedItemIds,
        coalesceWindowMs: REQUEST_ITEM_VERDICTS_WAKE_COALESCE_WINDOW_MS,
      }
    : null;
  const planReviewInteraction =
    planTarget && input.interaction.kind === "request_confirmation"
      ? {
          id: input.interaction.id,
          kind: input.interaction.kind,
          status: input.interaction.status,
          target: planTarget,
          acceptedTargetRevision: input.interaction.status === "accepted" ? planTarget : null,
          result: interactionResult,
        }
      : null;
  void input.heartbeat.wakeup(input.issue.assigneeAgentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: {
      issueId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      ...(planReviewInteraction ? { planReviewInteraction } : {}),
      ...(checkboxSelection ? { checkboxSelection } : {}),
      ...(toolAction ? { toolAction } : {}),
      ...(itemVerdicts ? { itemVerdicts, newlyResolvedItemIds } : {}),
      mutation: "interaction",
    },
    idempotencyKey: input.idempotencyKey ?? null,
    requestedByActorType: input.actor.actorType,
    requestedByActorId: input.actor.actorId,
    contextSnapshot: {
      issueId: input.issue.id,
      taskId: input.issue.id,
      interactionId: input.interaction.id,
      interactionKind: input.interaction.kind,
      interactionStatus: input.interaction.status,
      sourceCommentId: input.interaction.sourceCommentId ?? null,
      sourceRunId: input.interaction.sourceRunId ?? null,
      ...(planReviewInteraction ? { planReviewInteraction } : {}),
      ...(checkboxSelection ? { checkboxSelection } : {}),
      ...(toolAction ? { toolAction } : {}),
      ...(itemVerdicts ? { itemVerdicts, newlyResolvedItemIds } : {}),
      wakeReason: "issue_commented",
      source: input.source,
      ...(forceFreshSession ? { forceFreshSession: true } : {}),
      ...(workspaceRefreshReason ? { workspaceRefreshReason } : {}),
    },
  }).catch((err) => logger.warn({
    err,
    issueId: input.issue.id,
    interactionId: input.interaction.id,
    agentId: input.issue.assigneeAgentId,
  }, "failed to wake assignee on issue interaction resolution"));
}

function readCheckboxSelectionForWake(input: {
  kind: string;
  payload?: unknown;
  result?: unknown;
}) {
  if (input.kind !== "request_checkbox_confirmation") return null;
  const result = readObject(input.result);
  if (result.outcome !== "accepted") return null;
  const selectedOptionIds = Array.isArray(result.selectedOptionIds)
    ? result.selectedOptionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const payload = readObject(input.payload);
  const options = Array.isArray(payload.options)
    ? payload.options
        .map((value) => {
          const option = readObject(value);
          const id = readNonEmptyString(option.id);
          if (!id) return null;
          return {
            id,
            label: readNonEmptyString(option.label) ?? id,
            description: readNonEmptyString(option.description),
          };
        })
        .filter((value): value is { id: string; label: string; description: string | null } => Boolean(value))
    : [];
  const optionById = new Map(options.map((option) => [option.id, option]));

  return {
    prompt: readNonEmptyString(payload.prompt),
    selectedOptionIds,
    selectedOptions: selectedOptionIds.map((id) => optionById.get(id) ?? { id, label: id, description: null }),
  };
}

function diffExecutionParticipants(
  previousPolicy: NormalizedExecutionPolicy | null,
  nextPolicy: NormalizedExecutionPolicy | null,
  stageType: NormalizedExecutionPolicy["stages"][number]["type"],
) {
  const previousParticipants = summarizeExecutionParticipants(previousPolicy, stageType);
  const nextParticipants = summarizeExecutionParticipants(nextPolicy, stageType);
  const previousByKey = new Map(previousParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));
  const nextByKey = new Map(nextParticipants.map((participant) => [
    activityExecutionParticipantKey(participant),
    participant,
  ]));

  return {
    participants: nextParticipants,
    addedParticipants: nextParticipants.filter((participant) => !previousByKey.has(activityExecutionParticipantKey(participant))),
    removedParticipants: previousParticipants.filter((participant) => !nextByKey.has(activityExecutionParticipantKey(participant))),
  };
}

function buildExecutionStageWakeup(input: {
  issueId: string;
  previousState: ParsedExecutionState | null;
  nextState: ParsedExecutionState | null;
  interruptedRunId: string | null;
  requestedByActorType: "user" | "agent";
  requestedByActorId: string;
}) {
  const { issueId, previousState, nextState, interruptedRunId } = input;
  if (!nextState) return null;

  if (nextState.status === "pending") {
    const agentId =
      nextState.currentParticipant?.type === "agent" ? (nextState.currentParticipant.agentId ?? null) : null;
    const stageChanged =
      previousState?.status !== "pending" ||
      previousState?.currentStageId !== nextState.currentStageId ||
      !executionPrincipalsEqual(previousState?.currentParticipant ?? null, nextState.currentParticipant ?? null);
    if (!agentId || !stageChanged) return null;

    const reason =
      nextState.currentStageType === "approval" ? "execution_approval_requested" : "execution_review_requested";
    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: nextState.currentStageType === "approval" ? "approver" : "reviewer",
      allowedActions: ["approve", "request_changes"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason,
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: reason,
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  if (nextState.status === "changes_requested") {
    const agentId = nextState.returnAssignee?.type === "agent" ? (nextState.returnAssignee.agentId ?? null) : null;
    const becameChangesRequested =
      previousState?.status !== "changes_requested" ||
      previousState?.lastDecisionId !== nextState.lastDecisionId ||
      !executionPrincipalsEqual(previousState?.returnAssignee ?? null, nextState.returnAssignee ?? null);
    if (!agentId || !becameChangesRequested) return null;

    const executionStage = buildExecutionStageWakeContext({
      state: nextState,
      wakeRole: "executor",
      allowedActions: ["address_changes", "resubmit"],
    });

    return {
      agentId,
      wakeup: {
        source: "assignment" as const,
        triggerDetail: "system" as const,
        reason: "execution_changes_requested",
        payload: {
          issueId,
          mutation: "update",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "execution_changes_requested",
          source: "issue.execution_stage",
          executionStage,
          ...(interruptedRunId ? { interruptedRunId } : {}),
        },
      },
    };
  }

  return null;
}

class AutoApprovalIssueMissingError extends Error {
  constructor() {
    super("Issue not found during auto-approval transaction");
    this.name = "AutoApprovalIssueMissingError";
  }
}

function toCompactIssue(issue: any): CompactIssue {
  return {
    id: issue.id,
    companyId: issue.companyId,
    projectId: issue.projectId,
    projectWorkspaceId: issue.projectWorkspaceId,
    goalId: issue.goalId,
    parentId: issue.parentId,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    workMode: issue.workMode,
    priority: issue.priority,
    assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    checkoutRunId: issue.checkoutRunId,
    executionRunId: issue.executionRunId,
    executionAgentNameKey: issue.executionAgentNameKey,
    executionLockedAt: issue.executionLockedAt,
    createdByAgentId: issue.createdByAgentId,
    createdByUserId: issue.createdByUserId,
    issueNumber: issue.issueNumber,
    identifier: issue.identifier,
    originKind: issue.originKind,
    originId: issue.originId,
    originRunId: issue.originRunId,
    requestDepth: issue.requestDepth,
    billingCode: issue.billingCode,
    executionWorkspaceId: issue.executionWorkspaceId,
    startedAt: issue.startedAt,
    completedAt: issue.completedAt,
    cancelledAt: issue.cancelledAt,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    ...(issue.labelIds ? { labelIds: issue.labelIds } : {}),
    ...(issue.labels ? { labels: issue.labels } : {}),
    ...(issue.blockedBy ? { blockedBy: issue.blockedBy } : {}),
    ...(issue.blockerAttention ? { blockerAttention: issue.blockerAttention } : {}),
    ...(issue.blockedInboxAttention !== undefined ? { blockedInboxAttention: issue.blockedInboxAttention } : {}),
    ...(issue.productivityReview ? { productivityReview: issue.productivityReview } : {}),
    ...(issue.scheduledRetry …61176 tokens truncated…issue update wake",
          );
        }
        addWakeup(input.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
          payload: {
            issueId: input.dependentIssueId,
            resolvedBlockerIssueId: input.resolvedBlockerIssueId,
            blockerIssueIds: input.blockerIssueIds,
            mutation: input.mutation,
          },
          idempotencyKey,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: input.dependentIssueId,
            taskId: input.dependentIssueId,
            wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            source: input.source,
            resolvedBlockerIssueId: input.resolvedBlockerIssueId,
            blockerIssueIds: input.blockerIssueIds,
          },
        });
      };

      if (executionStageWakeup) {
        addWakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup);
      } else if (assigneeChanged && issue.assigneeAgentId && issue.status !== "backlog") {
        addWakeup(issue.assigneeAgentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assigned",
          payload: {
            issueId: issue.id,
            ...(comment ? { commentId: comment.id } : {}),
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            ...(comment
              ? {
                  taskId: issue.id,
                  commentId: comment.id,
                  wakeCommentId: comment.id,
                }
              : {}),
            source: "issue.update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (
        !assigneeChanged &&
        (statusChangedFromBacklog || statusChangedFromBlockedToTodo || statusChangedFromClosedToTodo) &&
        issue.assigneeAgentId
      ) {
        addWakeup(issue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_status_changed",
          payload: {
            issueId: issue.id,
            mutation: "update",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: issue.id,
            source: "issue.status_change",
            ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
            ...(interruptedRunId ? { interruptedRunId } : {}),
          },
        });
      }

      if (commentBody && comment) {
        const assigneeId = issue.assigneeAgentId;
        const actorIsAgent = actor.actorType === "agent";
        const selfComment = actorIsAgent && actor.actorId === assigneeId;
        const skipAssigneeCommentWake = selfComment || isClosed;

        if (assigneeId && !assigneeChanged && (reopened || !skipAssigneeCommentWake)) {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: reopened ? "issue_reopened_via_comment" : "issue_commented",
            payload: {
              issueId: id,
              commentId: comment.id,
              mutation: "comment",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: reopened ? "issue.comment.reopen" : "issue.comment",
              wakeReason: reopened ? "issue_reopened_via_comment" : "issue_commented",
              ...(reopened ? { reopenedFrom: reopenFromStatus } : {}),
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }

        let mentionedIds: string[] = [];
        try {
          mentionedIds = await svc.findMentionedAgents(issue.companyId, commentBody);
        } catch (err) {
          logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
        }

        for (const mentionedId of mentionedIds) {
          if (actor.actorType === "agent" && actor.actorId === mentionedId) continue;
          addWakeup(mentionedId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_comment_mentioned",
            payload: { issueId: id, commentId: comment.id },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: id,
              taskId: id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              wakeReason: "issue_comment_mentioned",
              source: "comment.mention",
            },
          });
        }
      }

      const becameDone = existing.status !== "done" && issue.status === "done";
      if (becameDone) {
        const dependents = await svc.listWakeableBlockedDependents(issue.id);
        for (const dependent of dependents) {
          await addDependencyResolvedWakeup({
            agentId: dependent.assigneeAgentId,
            dependentIssueId: dependent.id,
            resolvedBlockerIssueId: issue.id,
            blockerIssueIds: dependent.blockerIssueIds,
            source: "issue.blockers_resolved",
            mutation: "blocker_done",
          });
        }
      }

      const restoredBlockedReadyDependency =
        issue.status === "blocked" &&
        issue.assigneeAgentId &&
        (
          existing.status !== "blocked" ||
          Array.isArray(req.body.blockedByIssueIds) ||
          existing.assigneeAgentId !== issue.assigneeAgentId
        );
      if (restoredBlockedReadyDependency && typeof dependencyReadinessSvc.getDependencyReadiness === "function") {
        const readiness = await dependencyReadinessSvc.getDependencyReadiness(issue.id);
        const resolvedBlockerIssueId = readiness.blockerIssueIds[0] ?? null;
        if (
          resolvedBlockerIssueId &&
          readiness.isDependencyReady &&
          readiness.blockerIssueIds.length > 0
        ) {
          await addDependencyResolvedWakeup({
            agentId: issue.assigneeAgentId!,
            dependentIssueId: issue.id,
            resolvedBlockerIssueId,
            blockerIssueIds: readiness.blockerIssueIds,
            source: "issue.blockers_restored",
            mutation: "blocked_dependency_restored",
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(existing.status) && ["done", "cancelled"].includes(issue.status);
      if (becameTerminal) {
        await destroyReusableSandboxLeasesForTerminalIssue(issue);
      }
      if (becameTerminal && issue.parentId) {
        const parent = await svc.getWakeableParentAfterChildCompletion(issue.parentId);
        if (parent) {
          addWakeup(parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_children_completed",
            payload: {
              issueId: parent.id,
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: parent.id,
              taskId: parent.id,
              wakeReason: "issue_children_completed",
              source: "issue.children_completed",
              completedChildIssueId: issue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
          });
        }
      }

      for (const { agentId, wakeup } of wakeups.values()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .then((wakeRun) => {
            if (wakeup.reason !== ISSUE_BLOCKERS_RESOLVED_WAKE_REASON) return;
            const payload = wakeup.payload && typeof wakeup.payload === "object" ? wakeup.payload : {};
            const dependentIssueId = typeof payload.issueId === "string" ? payload.issueId : issue.id;
            return logActivity(db, {
              companyId: issue.companyId,
              actorType: "system",
              actorId: "issue_update",
              agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: "issue.blockers_resolved_wake_emitted",
              entityType: "issue",
              entityId: dependentIssueId,
              details: {
                source: wakeup.contextSnapshot?.source ?? "issue.update",
                wakeupRunId: wakeRun?.id ?? null,
                idempotencyKey: wakeup.idempotencyKey ?? null,
                resolvedBlockerIssueId: typeof payload.resolvedBlockerIssueId === "string"
                  ? payload.resolvedBlockerIssueId
                  : null,
                blockerIssueIds: Array.isArray(payload.blockerIssueIds) ? payload.blockerIssueIds : [],
              },
            });
          })
          .catch((err) => logger.warn({ err, issueId: issue.id, agentId }, "failed to wake agent on issue update"));
      }
    })();

    await queueTaskWatchdogEvaluation(issue, actor.runId);
    res.json({ ...issueResponse, comment });
  });

  router.delete("/issues/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!existing) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const attachments = await svc.listAttachments(id);

    const issue = await svc.remove(id);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.companyId, attachment.objectKey);
      } catch (err) {
        logger.warn({ err, issueId: id, attachmentId: attachment.id }, "failed to delete attachment object during issue delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.deleted",
      entityType: "issue",
      entityId: issue.id,
    });

    await queueTaskWatchdogEvaluation(existing, actor.runId);
    res.json(issue);
  });

  router.post("/issues/:id/checkout", validate(checkoutIssueSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;

    if (issue.projectId) {
      const project = await projectsSvc.getById(issue.projectId);
      if (project?.pausedAt) {
        res.status(409).json({
          error:
            project.pauseReason === "budget"
              ? "Project is paused because its budget hard-stop was reached"
              : "Project is paused",
        });
        return;
      }
    }

    if (req.actor.type === "agent" && req.actor.agentId !== req.body.agentId) {
      res.status(403).json({ error: "Agent can only checkout as itself" });
      return;
    }

    if (issue.assigneeAgentId !== req.body.agentId) {
      await assertCanAssignTasks(req, issue.companyId, {
        issueId: issue.id,
        projectId: issue.projectId ?? null,
        parentIssueId: issue.parentId ?? null,
        assigneeAgentId: req.body.agentId,
        assigneeUserId: null,
      });
    }

    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const checkoutRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !checkoutRunId) return;
    const updated = await svc.checkout(id, req.body.agentId, req.body.expectedStatuses, checkoutRunId, {
      capacityOverride: req.body.capacityOverride,
    });
    const actor = getActorInfo(req);
    if (updated?.harnessKind === "skill_test") {
      await companySkillsSvc.markTestRunRunning(updated.companyId, updated.id);
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.checked_out",
      entityType: "issue",
      entityId: issue.id,
      details: { agentId: req.body.agentId },
    });

    if (
      shouldWakeAssigneeOnCheckout({
        actorType: req.actor.type,
        actorAgentId: req.actor.type === "agent" ? req.actor.agentId ?? null : null,
        checkoutAgentId: req.body.agentId,
        checkoutRunId,
      })
    ) {
      void heartbeat
        .wakeup(req.body.agentId, {
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_checked_out",
          payload: { issueId: issue.id, mutation: "checkout" },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: { issueId: issue.id, source: "issue.checkout" },
        })
        .catch((err) => logger.warn({ err, issueId: issue.id }, "failed to wake assignee on issue checkout"));
    }

    res.json(updated);
  });

  router.post("/issues/:id/release", async (req, res) => {
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!existing) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, existing))) return;
    const actorRunId = requireAgentRunId(req, res);
    if (req.actor.type === "agent" && !actorRunId) return;

    const released = await svc.release(
      id,
      req.actor.type === "agent" ? req.actor.agentId : undefined,
      actorRunId,
    );
    if (!released) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: released.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.released",
      entityType: "issue",
      entityId: released.id,
    });

    res.json(released);
  });

  router.post("/issues/:id/admin/force-release", async (req, res) => {
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Board access required" });
      return;
    }
    if (!req.actor.userId) {
      throw forbidden("Board user context required");
    }

    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!existing) return;

    const clearAssignee = req.query.clearAssignee === "true";
    const result = await svc.adminForceRelease(id, { clearAssignee });
    if (!result) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: result.issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.admin_force_release",
      entityType: "issue",
      entityId: result.issue.id,
      details: {
        issueId: result.issue.id,
        actorUserId: req.actor.userId,
        prevCheckoutRunId: result.previous.checkoutRunId,
        prevExecutionRunId: result.previous.executionRunId,
        clearAssignee,
      },
    });

    res.json(result);
  });

  router.get("/issues/:id/comments", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const afterCommentId =
      typeof req.query.after === "string" && req.query.after.trim().length > 0
        ? req.query.after.trim()
        : typeof req.query.afterCommentId === "string" && req.query.afterCommentId.trim().length > 0
          ? req.query.afterCommentId.trim()
          : null;
    const order =
      typeof req.query.order === "string" && req.query.order.trim().toLowerCase() === "asc"
        ? "asc"
        : "desc";
    const limitRaw =
      typeof req.query.limit === "string" && req.query.limit.trim().length > 0
        ? Number(req.query.limit)
        : null;
    const limit =
      limitRaw && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), MAX_ISSUE_COMMENT_LIMIT)
        : null;
    const comments = await svc.listComments(id, {
      afterCommentId,
      order,
      limit,
    });
    res.json(comments);
  });

  router.get("/issues/:id/interactions", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const actor = getActorInfo(req);
    const interactionSvc = issueThreadInteractionService(db);
    const expiredInteractions = await interactionSvc.expireRequestConfirmationsSupersededByHistoricalComments(issue);
    await logExpiredRequestConfirmations({
      issue,
      interactions: expiredInteractions,
      actor,
      source: "issue.interactions.catchup_superseded_by_comment",
    });

    const interactions = await interactionSvc.listForIssue(id);
    res.json(interactions);
  });

  router.post("/issues/:id/interactions", validate(createIssueThreadInteractionSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type === "agent") {
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
      if (await assertLowTrustControlPlaneDenied(req, res, issue.companyId, issue)) return;
    } else {
      assertBoard(req);
    }

    const actor = getActorInfo(req);
    const agentSourceRunId = req.actor.type === "agent" ? requireAgentRunId(req, res) : null;
    if (req.actor.type === "agent" && !agentSourceRunId) return;
    if (req.body.kind === "request_confirmation" && req.body.payload?.toolAction !== undefined) {
      throw unprocessable("payload.toolAction is server-owned metadata and cannot be supplied when creating an interaction");
    }

    const interaction = await issueThreadInteractionService(db).create(issue, {
      ...req.body,
      sourceRunId: req.actor.type === "agent" ? agentSourceRunId : req.body.sourceRunId ?? null,
    }, {
      agentId: actor.agentId,
      userId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: issue.id,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
      },
    });

    res.status(201).json(interaction);
  });

  router.post(
    "/issues/:id/interactions/:interactionId/accept",
    validate(acceptIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (await rejectAgentIssueThreadInteractionResolution(req, res, issue)) return;
      assertBoard(req);

      const actor = getActorInfo(req);
      const { interaction, createdIssues, continuationIssue } = await issueThreadInteractionService(db).acceptInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      const toolAction = interaction.payload && typeof interaction.payload === "object"
        ? (interaction.payload as { toolAction?: { actionRequestId?: unknown } }).toolAction
        : null;
      let continuationInteraction = interaction;
      if (
        interaction.kind === "request_confirmation"
        && interaction.status === "accepted"
        && typeof toolAction?.actionRequestId === "string"
        && opts.approveToolActionRequest
      ) {
        const approvalResult = await opts.approveToolActionRequest({
          companyId: issue.companyId,
          issueId: issue.id,
          interactionId: interaction.id,
          actionRequestId: toolAction.actionRequestId,
          actor: {
            agentId: actor.agentId,
            userId: actor.actorType === "user" ? actor.actorId : null,
          },
        });
        const approval = readObject(approvalResult);
        const executionStatus = readToolActionExecutionStatus(approval.status);
        if (executionStatus) {
          const currentResult = readObject(interaction.result);
          continuationInteraction = {
            ...interaction,
            result: {
              ...currentResult,
              toolAction: {
                version: 1,
                status: executionStatus,
                errorMessage: readNonEmptyString(approval.error),
                resultSummary: readNonEmptyString(approval.resultSummary),
                updatedAt: new Date().toISOString(),
              },
            } as typeof interaction.result,
          };
        }
      }
      const continuationWakeIssue = continuationIssue ?? issue;

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_accepted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          createdTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.createdTasks?.length ?? 0)
              : 0,
          skippedTaskCount:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.skippedClientKeys?.length ?? 0)
              : 0,
        },
      });

      if (continuationIssue) {
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "issue.updated",
          entityType: "issue",
          entityId: issue.id,
          details: {
            identifier: issue.identifier,
            status: continuationIssue.status,
            assigneeAgentId: continuationIssue.assigneeAgentId ?? null,
            assigneeUserId: continuationIssue.assigneeUserId ?? null,
            source: "request_confirmation_accept",
            interactionId: interaction.id,
            _previous: {
              status: issue.status,
              assigneeAgentId: issue.assigneeAgentId ?? null,
              assigneeUserId: issue.assigneeUserId ?? null,
            },
          },
        });
      }

      for (const createdIssue of createdIssues) {
        void queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "interaction_accept",
          contextSource: "issue.interaction.accept",
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
        });
      }

      const acceptedPlanTarget = interaction.kind === "request_confirmation"
        ? readAcceptedPlanConfirmationTarget(interaction.payload)
        : null;
      const acceptedPlanConfirmation =
        interaction.kind === "request_confirmation" &&
        interaction.status === "accepted" &&
        acceptedPlanTarget?.issueId === issue.id &&
        acceptedPlanTarget.key === "plan";
      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue: continuationWakeIssue,
        interaction: continuationInteraction,
        actor,
        source: "issue.interaction.accept",
        forceFreshSession: acceptedPlanConfirmation,
        workspaceRefreshReason: acceptedPlanConfirmation ? "accepted_plan_confirmation" : null,
      });

      res.json(continuationInteraction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/reject",
    validate(rejectIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (await rejectAgentIssueThreadInteractionResolution(req, res, issue)) return;
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).rejectInteraction(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_rejected",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          rejectionReason:
            interaction.kind === "suggest_tasks"
              ? (interaction.result?.rejectionReason ?? null)
              : interaction.kind === "request_confirmation" || interaction.kind === "request_checkbox_confirmation"
                ? (interaction.result?.reason ?? null)
              : null,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.reject",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/respond",
    validate(respondIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (await rejectAgentIssueThreadInteractionResolution(req, res, issue)) return;
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).answerQuestions(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.thread_interaction_answered",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          answeredQuestionCount:
            interaction.kind === "ask_user_questions"
              ? (interaction.result?.answers?.length ?? 0)
              : 0,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.respond",
      });

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/verdicts",
    validate(submitIssueThreadInteractionVerdictsSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (await rejectAgentIssueThreadInteractionResolution(req, res, issue)) return;
      assertBoard(req);

      const actor = getActorInfo(req);
      const { interaction, newlyResolvedItemIds } = await issueThreadInteractionService(db).submitItemVerdicts(
        issue,
        interactionId,
        req.body,
        {
          agentId: actor.agentId,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
      );

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: interaction.status === "expired"
          ? "issue.thread_interaction_expired"
          : "issue.thread_interaction_item_verdicts_submitted",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          submittedVerdictCount: Array.isArray(req.body?.verdicts) ? req.body.verdicts.length : 0,
          newlyResolvedItemCount: newlyResolvedItemIds.length,
          newlyResolvedItemIds,
          complete:
            interaction.kind === "request_item_verdicts"
              ? (interaction.result?.complete ?? false)
              : false,
        },
      });

      if (newlyResolvedItemIds.length > 0) {
        queueResolvedInteractionContinuationWakeup({
          heartbeat,
          issue,
          interaction,
          actor,
          source: "issue.interaction.verdicts",
          newlyResolvedItemIds,
          idempotencyKey: buildRequestItemVerdictsWakeIdempotencyKey({
            issueId: issue.id,
            interactionId: interaction.id,
          }),
        });
      }

      res.json(interaction);
    },
  );

  router.post(
    "/issues/:id/interactions/:interactionId/cancel",
    validate(cancelIssueThreadInteractionSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const interactionId = req.params.interactionId as string;
      const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
      if (!issue) return;
      if (await rejectAgentIssueThreadInteractionResolution(req, res, issue)) return;
      assertBoard(req);

      const actor = getActorInfo(req);
      const interaction = await issueThreadInteractionService(db).cancelQuestions(issue, interactionId, req.body, {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.thread_interaction_cancelled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          interactionId: interaction.id,
          interactionKind: interaction.kind,
          interactionStatus: interaction.status,
          cancellationReason:
            interaction.kind === "ask_user_questions"
              ? (interaction.result?.cancellationReason ?? null)
              : null,
        },
      });

      queueResolvedInteractionContinuationWakeup({
        heartbeat,
        issue,
        interaction,
        actor,
        source: "issue.interaction.cancel",
      });

      res.json(interaction);
    },
  );

  router.get("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json(comment);
  });

  router.delete("/issues/:id/comments/:commentId", async (req, res) => {
    const id = req.params.id as string;
    const commentId = req.params.commentId as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;

    const comment = await svc.getComment(commentId);
    if (!comment || comment.issueId !== id) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    const actor = getActorInfo(req);
    const actorOwnsComment =
      actor.actorType === "agent"
        ? comment.authorAgentId === actor.agentId
        : comment.authorUserId === actor.actorId;
    const deleteMode = req.query.mode === "cancel" ? "cancel" : "delete";

    const activeRun = await resolveActiveIssueRun(issue);
    const isQueuedComment = activeRun ? isQueuedIssueCommentForActiveRun({ comment, activeRun }) : false;
    if (deleteMode === "cancel" || isQueuedComment) {
      if (!actorOwnsComment) {
        res.status(403).json({ error: "Only the comment author can cancel queued comments" });
        return;
      }

      if (!activeRun) {
        res.status(409).json({ error: "Queued comment can no longer be canceled" });
        return;
      }

      if (!isQueuedComment) {
        res.status(409).json({ error: "Only queued comments can be canceled" });
        return;
      }

      const removed = await svc.removeComment(commentId);
      if (!removed) {
        res.status(404).json({ error: "Comment not found" });
        return;
      }

      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.comment_cancelled",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: removed.id,
          bodySnippet: removed.body.slice(0, 120),
          identifier: issue.identifier,
          issueTitle: issue.title,
          source: "queue_cancel",
          queueTargetRunId: activeRun.id,
        },
      });

      res.json(removed);
      return;
    }

    if (!actorOwnsComment) {
      res.status(403).json({ error: "Only the comment author can delete comments" });
      return;
    }

    if (comment.deletedAt) {
      res.json(comment);
      return;
    }

    let annotationCleanup = { deletedCommentIds: [] as string[], resolvedThreadIds: [] as string[] };
    const deleted = await svc.tombstoneComment(
      commentId,
      {
        actorType: actor.actorType,
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
        runId: actor.runId,
      },
      {
        afterTombstone: async (deletedComment, tx) => {
          await issueReferencesSvc.syncComment(deletedComment.id, tx);
          await externalObjectsSvc.syncCommentSafely(deletedComment.id, tx);
          annotationCleanup = await documentAnnotationsSvc.cleanupForIssueCommentDeletion(issue.id, deletedComment.id, {
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            userId: actor.actorType === "user" ? actor.actorId : null,
            runId: actor.runId,
          }, tx);
          await Promise.all(
            annotationCleanup.deletedCommentIds.map((annotationCommentId) =>
              Promise.all([
                issueReferencesSvc.deleteCommentSource(annotationCommentId, tx),
                externalObjectsSvc.syncCommentSafely(annotationCommentId, tx),
              ])
            ),
          );
          await decisionTrainingSvc.scrubDeletedComments({
            companyId: issue.companyId,
            issueId: issue.id,
            commentIds: [deletedComment.id, ...annotationCleanup.deletedCommentIds],
            deletedAt: deletedComment.deletedAt ?? new Date(),
          }, tx);
        },
      },
    );
    if (!deleted) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.comment_deleted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        commentId: deleted.id,
        identifier: issue.identifier,
        issueTitle: issue.title,
        source: "author_delete",
        deletedByType: actor.actorType,
        deletedByAgentId: actor.actorType === "agent" ? actor.agentId : null,
        deletedByUserId: actor.actorType === "user" ? actor.actorId : null,
        deletedByRunId: actor.runId,
        deletedAt: deleted.deletedAt,
        deletedAnnotationCommentIds: annotationCleanup.deletedCommentIds,
        resolvedAnnotationThreadIds: annotationCleanup.resolvedThreadIds,
      },
    });

    res.json(deleted);
  });

  router.get("/issues/:id/feedback-votes", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback votes" });
      return;
    }

    const votes = await feedback.listIssueVotesForUser(id, req.actor.userId ?? "local-board");
    res.json(votes);
  });

  router.get("/issues/:id/feedback-traces", async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }

    const targetTypeRaw = typeof req.query.targetType === "string" ? req.query.targetType : undefined;
    const voteRaw = typeof req.query.vote === "string" ? req.query.vote : undefined;
    const statusRaw = typeof req.query.status === "string" ? req.query.status : undefined;
    const targetType = targetTypeRaw ? feedbackTargetTypeSchema.parse(targetTypeRaw) : undefined;
    const vote = voteRaw ? feedbackVoteValueSchema.parse(voteRaw) : undefined;
    const status = statusRaw ? feedbackTraceStatusSchema.parse(statusRaw) : undefined;

    const traces = await feedback.listFeedbackTraces({
      companyId: issue.companyId,
      issueId: issue.id,
      targetType,
      vote,
      status,
      from: parseDateQuery(req.query.from, "from"),
      to: parseDateQuery(req.query.to, "to"),
      sharedOnly: parseBooleanQuery(req.query.sharedOnly),
      includePayload: parseBooleanQuery(req.query.includePayload),
    });
    res.json(traces);
  });

  router.get("/feedback-traces/:traceId", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback traces" });
      return;
    }
    const includePayload = parseBooleanQuery(req.query.includePayload) || req.query.includePayload === undefined;
    const trace = await feedback.getFeedbackTraceById(traceId, includePayload);
    if (!trace || !actorCanAccessCompany(req, trace.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(trace);
  });

  router.get("/feedback-traces/:traceId/bundle", async (req, res) => {
    const traceId = req.params.traceId as string;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can view feedback trace bundles" });
      return;
    }
    const bundle = await feedback.getFeedbackTraceBundle(traceId);
    if (!bundle || !actorCanAccessCompany(req, bundle.companyId)) {
      res.status(404).json({ error: "Feedback trace not found" });
      return;
    }
    res.json(bundle);
  });

  router.post("/issues/:id/comments", validate(addIssueCommentSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    const commentAccessDecision = await assertAgentIssueCommentAllowed(req, res, issue);
    if (!commentAccessDecision) return;
    if (!assertStructuredCommentFieldsAllowed(req, res, {
      presentation: req.body.presentation,
      metadata: req.body.metadata,
    })) return;
    const closedExecutionWorkspace = await getClosedIssueExecutionWorkspace(issue);
    if (closedExecutionWorkspace) {
      respondClosedIssueExecutionWorkspace(res, closedExecutionWorkspace);
      return;
    }

    const actor = getActorInfo(req);
    const reopenRequested = req.body.reopen === true;
    const resumeRequested = req.body.resume === true;
    const interruptRequested = req.body.interrupt === true;
    const isClosed = isClosedIssueStatus(issue.status);
    const isBlocked = issue.status === "blocked";
    const mentionGrantedPeerAgentCommentOnly =
      isClosed &&
      req.actor.type === "agent" &&
      issue.assigneeAgentId !== null &&
      issue.assigneeAgentId !== req.actor.agentId &&
      !reopenRequested &&
      !resumeRequested &&
      isIssueMentionGrantDecision(commentAccessDecision);
    const effectiveReopenRequested = mentionGrantedPeerAgentCommentOnly ? false : reopenRequested;
    const effectiveResumeRequested = mentionGrantedPeerAgentCommentOnly ? false : resumeRequested;
    if (
      isClosed &&
      req.actor.type === "agent" &&
      issue.assigneeAgentId !== null &&
      issue.assigneeAgentId !== req.actor.agentId &&
      !mentionGrantedPeerAgentCommentOnly
    ) {
      if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    }
    if (effectiveResumeRequested === true && !(await assertExplicitResumeIntentAllowed(req, res, issue))) return;
    if (effectiveResumeRequested !== true && effectiveReopenRequested === true && req.actor.type === "agent") {
      if (!(await assertExplicitResumeIntentAllowed(req, res, issue))) return;
    }
    const explicitMoveToTodoRequested = effectiveReopenRequested || effectiveResumeRequested === true;
    const scheduledRetryForHumanComment =
      shouldHumanCommentResumeInProgressScheduledRetry({
        hasComment: true,
        issueStatus: issue.status,
        assigneeAgentId: issue.assigneeAgentId,
        actorType: actor.actorType,
      })
        ? await svc.getCurrentScheduledRetry(issue.id)
        : null;
    const shouldResumeInProgressScheduledRetry =
      !!scheduledRetryForHumanComment &&
      scheduledRetryForHumanComment.agentId === issue.assigneeAgentId;
    const assigneeSelfCommentOnTerminal = isAssigneeSelfCommentOnTerminalIssue({
      hasCommentBody: true,
      resumeRequested: resumeRequested === true,
      issueStatus: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      actorType: actor.actorType,
      actorId: actor.actorId,
    });
    const effectiveMoveToTodoRequested =
      !assigneeSelfCommentOnTerminal &&
      (explicitMoveToTodoRequested ||
        shouldImplicitlyMoveCommentedIssueToTodo({
          issueStatus: issue.status,
          assigneeAgentId: issue.assigneeAgentId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          actorRunId: actor.runId,
          checkoutRunId: issue.checkoutRunId,
          executionRunId: issue.executionRunId,
        }) ||
        shouldResumeInProgressScheduledRetry);
    const hasUnresolvedFirstClassBlockers =
      isBlocked && effectiveMoveToTodoRequested
        ? (await svc.getDependencyReadiness(issue.id)).unresolvedBlockerCount > 0
        : false;
    if (resumeRequested === true && isBlocked && hasUnresolvedFirstClassBlockers) {
      res.status(409).json({ error: "Issue follow-up blocked by unresolved blockers" });
      return;
    }
    let reopened = false;
    let reopenFromStatus: string | null = null;
    let interruptedRunId: string | null = null;
    let currentIssue = issue;
    let issueBeforeCommentDecision = issue;
    let commentDecisionStageWakeup: ReturnType<typeof buildExecutionStageWakeup> | null = null;
    const commentReferenceSummaryBefore = await issueReferencesSvc.listIssueReferenceSummary(issue.id);

    let scheduledRetrySupersededByComment = false;
    let cancelledScheduledRetryRunId: string | null = null;
    if (
      effectiveMoveToTodoRequested &&
      (isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers) || shouldResumeInProgressScheduledRetry)
    ) {
      scheduledRetrySupersededByComment = shouldResumeInProgressScheduledRetry && issue.status === "in_progress";
      cancelledScheduledRetryRunId = scheduledRetrySupersededByComment
        ? await cancelScheduledRetrySupersededByComment({
            scheduledRetryRunId: scheduledRetryForHumanComment?.runId,
            issue,
            actor,
          })
        : null;
      const reopenedIssue = await svc.update(id, { status: "todo" });
      if (!reopenedIssue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      reopened = isClosed || (isBlocked && !hasUnresolvedFirstClassBlockers);
      reopenFromStatus = reopened ? issue.status : null;
      currentIssue = reopenedIssue;

      await logActivity(db, {
        companyId: currentIssue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "issue.updated",
        entityType: "issue",
        entityId: currentIssue.id,
        details: {
          status: "todo",
          ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus } : {}),
          ...(scheduledRetrySupersededByComment
            ? {
                scheduledRetrySupersededByComment: true,
                scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
                ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
              }
            : {}),
          source: "comment",
          ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
          identifier: currentIssue.identifier,
        },
      });
    }

    if (interruptRequested) {
      if (req.actor.type !== "board") {
        res.status(403).json({ error: "Only board users can interrupt active runs from issue comments" });
        return;
      }

      const runToInterrupt = await resolveActiveIssueRun(currentIssue);
      if (runToInterrupt) {
        const cancelled = await heartbeat.cancelRun(
          runToInterrupt.id,
          "Interrupted by board comment",
          operatorInterruptCancelOptions({ issueId: currentIssue.id, actor }),
        );
        if (cancelled) {
          interruptedRunId = cancelled.id;
          await logActivity(db, {
            companyId: cancelled.companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "heartbeat.cancelled",
            entityType: "heartbeat_run",
            entityId: cancelled.id,
            issueId: currentIssue.id,
            details: {
              agentId: cancelled.agentId,
              source: "issue_comment_interrupt",
              issueId: currentIssue.id,
              cancellationKind: "operator_interrupted",
              operatorInterrupted: true,
            },
          });
        }
      }
    }

    const currentExecutionState = parseIssueExecutionState(currentIssue.executionState);
    const currentExecutionPolicy = normalizeIssueExecutionPolicy(currentIssue.executionPolicy ?? null);
    const shouldAutoApproveReviewComment =
      currentIssue.status === "in_review" &&
      currentExecutionState?.status === "pending" &&
      actorMatchesExecutionParticipant(actor, currentExecutionState.currentParticipant ?? null) &&
      isApprovalReviewComment(req.body.body);

    // Persist the comment and the auto-approval state transition atomically when both apply.
    // Without a single transaction, a 422 (or any error) thrown by the status update after the
    // comment is inserted would leave an orphan comment without the corresponding state change.
    let comment: Awaited<ReturnType<typeof svc.addComment>>;
    if (shouldAutoApproveReviewComment) {
      const transition = applyIssueExecutionPolicyTransition({
        issue: currentIssue,
        policy: currentExecutionPolicy,
        requestedStatus: "done",
        requestedAssigneePatch: {},
        actor: {
          agentId: actor.agentId ?? null,
          userId: actor.actorType === "user" ? actor.actorId : null,
        },
        commentBody: req.body.body,
      });
      const decisionId = transition.decision ? randomUUID() : null;
      if (decisionId) {
        const nextExecutionState = transition.patch.executionState;
        if (!nextExecutionState || typeof nextExecutionState !== "object") {
          throw new Error("Execution policy decision patch is missing executionState");
        }
        transition.patch.executionState = {
          ...nextExecutionState,
          lastDecisionId: decisionId,
        };
      }

      issueBeforeCommentDecision = currentIssue;
      const updatePatch = {
        ...transition.patch,
        status: typeof transition.patch.status === "string" ? transition.patch.status : "done",
        actorAgentId: actor.agentId ?? null,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
      };

      const sourceTrust = await sourceTrustForActorWrite(currentIssue, actor);
      const commentOptions = {
        authorType: req.body.authorType ?? (actor.actorType === "agent" ? "agent" : "user"),
        presentation: req.body.presentation ?? null,
        metadata: req.body.metadata ?? null,
        sourceTrust,
      };
      let txResult: { comment: Awaited<ReturnType<typeof svc.addComment>>; issue: NonNullable<Awaited<ReturnType<typeof svc.update>>> };
      try {
        txResult = await db.transaction(async (tx) => {
          const insertedComment = await svc.addComment(
            id,
            req.body.body,
            {
              agentId: actor.agentId ?? undefined,
              userId: actor.actorType === "user" ? actor.actorId : undefined,
              runId: actor.runId,
            },
            commentOptions,
            tx,
          );
          const updated = await svc.update(id, updatePatch, tx);
          // Throw (not return null) so drizzle rolls back the inserted comment when the issue
          // has been concurrently deleted between the initial fetch and the in-transaction update.
          if (!updated) throw new AutoApprovalIssueMissingError();

          if (transition.decision && decisionId) {
            await tx.insert(issueExecutionDecisions).values({
              id: decisionId,
              companyId: updated.companyId,
              issueId: updated.id,
              stageId: transition.decision.stageId,
              stageType: transition.decision.stageType,
              actorAgentId: actor.agentId ?? null,
              actorUserId: actor.actorType === "user" ? actor.actorId : null,
              outcome: transition.decision.outcome,
              body: transition.decision.body,
              createdByRunId: actor.runId ?? null,
            });
          }

          return { comment: insertedComment, issue: updated };
        });
      } catch (err) {
        if (err instanceof AutoApprovalIssueMissingError) {
          res.status(404).json({ error: "Issue not found" });
          return;
        }
        throw err;
      }
      comment = txResult.comment;
      currentIssue = txResult.issue;
      // Mirror the normal status-change audit trail: every other in_review -> done path
      // emits an `issue.updated` activity, so emit one here too for the auto-approval path.
      if (issueBeforeCommentDecision.status !== currentIssue.status) {
        await logActivity(db, {
          companyId: currentIssue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          agentApiKeyId: actor.agentApiKeyId,
          action: "issue.updated",
          entityType: "issue",
          entityId: currentIssue.id,
          details: {
            status: currentIssue.status,
            identifier: currentIssue.identifier,
            source: "auto_approval_comment",
            _previous: { status: issueBeforeCommentDecision.status },
          },
        });
      }
      commentDecisionStageWakeup = buildExecutionStageWakeup({
        issueId: currentIssue.id,
        previousState: currentExecutionState,
        nextState: parseIssueExecutionState(currentIssue.executionState),
        interruptedRunId,
        requestedByActorType: actor.actorType,
        requestedByActorId: actor.actorId,
      });
    } else {
      comment = await svc.addComment(id, req.body.body, {
        agentId: actor.agentId ?? undefined,
        userId: actor.actorType === "user" ? actor.actorId : undefined,
        runId: actor.runId,
      }, {
        authorType: req.body.authorType ?? (actor.actorType === "agent" ? "agent" : "user"),
        presentation: req.body.presentation ?? null,
        metadata: req.body.metadata ?? null,
        sourceTrust: await sourceTrustForActorWrite(currentIssue, actor),
      });
    }

    await issueReferencesSvc.syncComment(comment.id);
    await externalObjectsSvc.syncCommentSafely(comment.id);
    const commentReferenceSummaryAfter = await issueReferencesSvc.listIssueReferenceSummary(currentIssue.id);
    const commentReferenceDiff = issueReferencesSvc.diffIssueReferenceSummary(
      commentReferenceSummaryBefore,
      commentReferenceSummaryAfter,
    );

    if (actor.runId) {
      await heartbeat.reportRunActivity(actor.runId).catch((err) =>
        logger.warn({ err, runId: actor.runId }, "failed to clear detached run warning after issue comment"));
    }

    await logActivity(db, {
      companyId: currentIssue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: currentIssue.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: currentIssue.identifier,
        issueTitle: currentIssue.title,
        ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
        ...(reopened ? { reopened: true, reopenedFrom: reopenFromStatus, source: "comment" } : {}),
        ...(scheduledRetrySupersededByComment
          ? {
              scheduledRetrySupersededByComment: true,
              scheduledRetryRunId: scheduledRetryForHumanComment?.runId ?? null,
              ...(cancelledScheduledRetryRunId ? { cancelledScheduledRetryRunId } : {}),
            }
          : {}),
        ...(interruptedRunId ? { interruptedRunId } : {}),
        ...summarizeIssueReferenceActivityDetails({
          addedReferencedIssues: commentReferenceDiff.addedReferencedIssues.map(summarizeIssueRelationForActivity),
          removedReferencedIssues: commentReferenceDiff.removedReferencedIssues.map(summarizeIssueRelationForActivity),
          currentReferencedIssues: commentReferenceDiff.currentReferencedIssues.map(summarizeIssueRelationForActivity),
        }),
      },
    });

    const expiredInteractions = await issueThreadInteractionService(db).expireRequestConfirmationsSupersededByComment(
      currentIssue,
      comment,
      {
        agentId: actor.agentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      },
    );
    await logExpiredRequestConfirmations({
      issue: currentIssue,
      interactions: expiredInteractions,
      actor,
      source: "issue.comment",
    });

    await revalidateActiveSourceRecoveryAfterCommittedWrite({
      issue: currentIssue,
      trigger: "comment",
      actor,
      statusChanged: reopened || scheduledRetrySupersededByComment,
      resumeRequested: resumeRequested === true,
      reopened,
      blockedToTodoRecovery: reopened && reopenFromStatus === "blocked" && currentIssue.status === "todo",
    });

    // Merge all wakeups from this comment into one enqueue per agent to avoid duplicate runs.
    void (async () => {
      type WakeupRequest = NonNullable<Parameters<typeof heartbeat.wakeup>[1]>;
      const wakeups = new Map<string, { agentId: string; wakeup: WakeupRequest }>();
      const addWakeup = (agentId: string, wakeup: WakeupRequest) => {
        const wakeIssueId =
          wakeup.payload && typeof wakeup.payload === "object" && typeof wakeup.payload.issueId === "string"
            ? wakeup.payload.issueId
            : currentIssue.id;
        const key = `${agentId}:${wakeIssueId}`;
        if (wakeups.has(key)) return;
        wakeups.set(key, { agentId, wakeup });
      };
      const addDependencyResolvedWakeup = async (input: {
        agentId: string;
        dependentIssueId: string;
        resolvedBlockerIssueId: string;
        blockerIssueIds: string[];
      }) => {
        const idempotencyKey = buildIssueBlockersResolvedWakeIdempotencyKey({
          dependentIssueId: input.dependentIssueId,
          resolvedBlockerIssueId: input.resolvedBlockerIssueId,
        });
        try {
          const existingWake = await findExistingIssueBlockersResolvedWake(db, {
            companyId: currentIssue.companyId,
            idempotencyKey,
          });
          if (existingWake) return;
        } catch (err) {
          logger.warn(
            { err, issueId: input.dependentIssueId, idempotencyKey },
            "failed to check existing dependency wake before issue comment wake",
          );
        }
        addWakeup(input.agentId, {
          source: "automation",
          triggerDetail: "system",
          reason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
          payload: {
            issueId: input.dependentIssueId,
            resolvedBlockerIssueId: input.resolvedBlockerIssueId,
            blockerIssueIds: input.blockerIssueIds,
            mutation: "comment",
          },
          idempotencyKey,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: input.dependentIssueId,
            taskId: input.dependentIssueId,
            wakeReason: ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
            source: "issue.blockers_resolved",
            resolvedBlockerIssueId: input.resolvedBlockerIssueId,
            blockerIssueIds: input.blockerIssueIds,
          },
        });
      };

      if (commentDecisionStageWakeup) {
        addWakeup(commentDecisionStageWakeup.agentId, commentDecisionStageWakeup.wakeup);
      }

      const assigneeId = currentIssue.assigneeAgentId;
      const actorIsAgent = actor.actorType === "agent";
      const selfComment = actorIsAgent && actor.actorId === assigneeId;
      // Re-derive closed-ness from the post-mutation issue so the auto-approval
      // transition (in_review -> done) suppresses a stale `issue_commented` wake
      // to the returnAssignee for an already-completed issue.
      const skipWake = selfComment || isClosedIssueStatus(currentIssue.status);
      if (assigneeId && (reopened || !skipWake)) {
        if (reopened) {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_reopened_via_comment",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              reopenedFrom: reopenFromStatus,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment.reopen",
              wakeReason: "issue_reopened_via_comment",
              reopenedFrom: reopenFromStatus,
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        } else {
          addWakeup(assigneeId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_commented",
            payload: {
              issueId: currentIssue.id,
              commentId: comment.id,
              mutation: "comment",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: currentIssue.id,
              taskId: currentIssue.id,
              commentId: comment.id,
              wakeCommentId: comment.id,
              source: "issue.comment",
              wakeReason: "issue_commented",
              ...(resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {}),
              ...(interruptedRunId ? { interruptedRunId } : {}),
            },
          });
        }
      }

      let mentionedIds: string[] = [];
      try {
        mentionedIds = await svc.findMentionedAgents(issue.companyId, req.body.body);
      } catch (err) {
        logger.warn({ err, issueId: id }, "failed to resolve @-mentions");
      }

      for (const mentionedId of mentionedIds) {
        if (actorIsAgent && actor.actorId === mentionedId) continue;
        addWakeup(mentionedId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_comment_mentioned",
          payload: { issueId: id, commentId: comment.id },
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          contextSnapshot: {
            issueId: id,
            taskId: id,
            commentId: comment.id,
            wakeCommentId: comment.id,
            wakeReason: "issue_comment_mentioned",
            source: "comment.mention",
          },
        });
      }

      const becameDone = issueBeforeCommentDecision.status !== "done" && currentIssue.status === "done";
      if (becameDone) {
        const dependents = await svc.listWakeableBlockedDependents(currentIssue.id);
        for (const dependent of dependents) {
          await addDependencyResolvedWakeup({
            agentId: dependent.assigneeAgentId,
            dependentIssueId: dependent.id,
            resolvedBlockerIssueId: currentIssue.id,
            blockerIssueIds: dependent.blockerIssueIds,
          });
        }
      }

      const becameTerminal =
        !["done", "cancelled"].includes(issueBeforeCommentDecision.status) &&
        ["done", "cancelled"].includes(currentIssue.status);
      if (becameTerminal) {
        await destroyReusableSandboxLeasesForTerminalIssue(currentIssue);
      }
      if (becameTerminal && currentIssue.parentId) {
        const parent = await svc.getWakeableParentAfterChildCompletion(currentIssue.parentId);
        if (parent) {
          addWakeup(parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "issue_children_completed",
            payload: {
              issueId: parent.id,
              completedChildIssueId: currentIssue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            contextSnapshot: {
              issueId: parent.id,
              taskId: parent.id,
              wakeReason: "issue_children_completed",
              source: "issue.children_completed",
              completedChildIssueId: currentIssue.id,
              childIssueIds: parent.childIssueIds,
              childIssueSummaries: parent.childIssueSummaries,
              childIssueSummaryTruncated: parent.childIssueSummaryTruncated,
            },
          });
        }
      }

      for (const { agentId, wakeup } of wakeups.values()) {
        heartbeat
          .wakeup(agentId, wakeup)
          .then((wakeRun) => {
            if (wakeup.reason !== ISSUE_BLOCKERS_RESOLVED_WAKE_REASON) return;
            const payload = wakeup.payload && typeof wakeup.payload === "object" ? wakeup.payload : {};
            const dependentIssueId = typeof payload.issueId === "string" ? payload.issueId : currentIssue.id;
            return logActivity(db, {
              companyId: currentIssue.companyId,
              actorType: "system",
              actorId: "issue_comment",
              agentId,
              runId: actor.runId,
              agentApiKeyId: actor.agentApiKeyId,
              action: "issue.blockers_resolved_wake_emitted",
              entityType: "issue",
              entityId: dependentIssueId,
              details: {
                source: wakeup.contextSnapshot?.source ?? "issue.comment",
                wakeupRunId: wakeRun?.id ?? null,
                idempotencyKey: wakeup.idempotencyKey ?? null,
                resolvedBlockerIssueId: typeof payload.resolvedBlockerIssueId === "string"
                  ? payload.resolvedBlockerIssueId
                  : null,
                blockerIssueIds: Array.isArray(payload.blockerIssueIds) ? payload.blockerIssueIds : [],
              },
            });
          })
          .catch((err) => logger.warn({ err, issueId: currentIssue.id, agentId }, "failed to wake agent on issue comment"));
      }
    })();

    await queueTaskWatchdogEvaluation(currentIssue, actor.runId);
    res.status(201).json(comment);
  });

  router.post("/issues/:id/feedback-votes", validate(upsertIssueFeedbackVoteSchema), async (req, res) => {
    const id = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(id), "Issue not found");
    if (!issue) return;
    if (req.actor.type !== "board") {
      res.status(403).json({ error: "Only board users can vote on AI feedback" });
      return;
    }

    const actor = getActorInfo(req);
    const result = await feedback.saveIssueVote({
      issueId: id,
      targetType: req.body.targetType,
      targetId: req.body.targetId,
      vote: req.body.vote,
      reason: req.body.reason,
      authorUserId: req.actor.userId ?? "local-board",
      allowSharing: req.body.allowSharing === true,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.feedback_vote_saved",
      entityType: "issue",
      entityId: issue.id,
      details: {
        identifier: issue.identifier,
        targetType: result.vote.targetType,
        targetId: result.vote.targetId,
        vote: result.vote.vote,
        hasReason: Boolean(result.vote.reason),
        sharingEnabled: result.sharingEnabled,
      },
    });

    if (result.consentEnabledNow) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action: "company.feedback_data_sharing_updated",
        entityType: "company",
        entityId: issue.companyId,
        details: {
          feedbackDataSharingEnabled: true,
          source: "issue_feedback_vote",
        },
      });
    }

    if (result.persistedSharingPreference) {
      const settings = await instanceSettings.get();
      const companyIds = await instanceSettings.listCompanyIds();
      await Promise.all(
        companyIds.map((companyId) =>
          logActivity(db, {
            companyId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            agentApiKeyId: actor.agentApiKeyId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: settings.id,
            details: {
              general: settings.general,
              changedKeys: ["feedbackDataSharingPreference"],
              source: "issue_feedback_vote",
            },
          }),
        ),
      );
    }

    if (result.sharingEnabled && result.traceId && feedbackExportService) {
      try {
        await feedbackExportService.flushPendingFeedbackTraces({
          companyId: issue.companyId,
          traceId: result.traceId,
          limit: 1,
        });
      } catch (err) {
        logger.warn({ err, issueId: issue.id, traceId: result.traceId }, "failed to flush shared feedback trace immediately");
      }
    }

    res.status(201).json(result.vote);
  });

  router.get("/issues/:id/attachments", async (req, res) => {
    const issueId = req.params.id as string;
    const issue = await getAccessibleResource(req, res, svc.getById(issueId), "Issue not found");
    if (!issue) return;
    if (!(await assertIssueReadAllowed(req, res, issue))) return;
    const attachments = await svc.listAttachments(issueId);
    res.json(attachments.map(withContentPath));
  });

  router.post("/companies/:companyId/issues/:issueId/attachments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const issueId = req.params.issueId as string;
    assertCompanyAccess(req, companyId);
    const issue = await svc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (issue.companyId !== companyId) {
      res.status(422).json({ error: "Issue does not belong to company" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

    const company = await companiesSvc.getById(companyId);
    const attachmentMaxBytes = normalizeIssueAttachmentMaxBytes(company?.attachmentMaxBytes);

    try {
      await runSingleFileUpload(req, res, attachmentMaxBytes);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${attachmentMaxBytes} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = normalizeUploadAttachmentContentType({
      contentType: file.mimetype,
      originalFilename: file.originalname,
    });
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createIssueAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      companyId,
      namespace: `issues/${issueId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      issueId,
      issueCommentId: parsedMeta.data.issueCommentId ?? null,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.attachment_added",
      entityType: "issue",
      entityId: issueId,
      details: {
        attachmentId: attachment.id,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
      },
    });

    res.status(201).json(withContentPath(attachment));
  });

  router.get("/attachments/:attachmentId/content", async (req, res, next) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await getAccessibleResource(req, res, svc.getAttachmentById(attachmentId), "Attachment not found");
    if (!attachment) return;
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertIssueReadAllowed(req, res, issue))) return;

    const contentLength = attachment.byteSize;
    const range = parseAttachmentRangeHeader(
      typeof req.headers.range === "string" ? req.headers.range : undefined,
      contentLength,
    );
    res.setHeader("Accept-Ranges", "bytes");
    if (range.kind === "invalid") {
      res.setHeader("Content-Range", `bytes */${contentLength}`);
      res.status(416).end();
      return;
    }

    const object = await storage.getObject(
      attachment.companyId,
      attachment.objectKey,
      range.kind === "range" ? { range: { start: range.start, end: range.end } } : undefined,
    );
    const responseContentType = resolveAttachmentResponseContentType({
      storedContentType: attachment.contentType,
      objectContentType: object.contentType,
      originalFilename: attachment.originalFilename,
    });
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responseContentType === SVG_CONTENT_TYPE) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    }
    const filename = attachment.originalFilename ?? "attachment";
    const disposition = parseBooleanQuery(req.query.download)
      ? "attachment"
      : isInlineAttachmentContentType(responseContentType) ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename=\"${filename.replaceAll("\"", "")}\"`);

    object.stream.on("error", (err) => {
      next(err);
    });
    if (range.kind === "range") {
      const rangeLength = range.end - range.start + 1;
      res.status(206);
      res.setHeader("Content-Length", String(rangeLength));
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${contentLength}`);
      object.stream.pipe(res);
      return;
    }

    res.setHeader("Content-Length", String(contentLength || object.contentLength || 0));
    object.stream.pipe(res);
  });

  router.delete("/attachments/:attachmentId", async (req, res) => {
    const attachmentId = req.params.attachmentId as string;
    const attachment = await getAccessibleResource(req, res, svc.getAttachmentById(attachmentId), "Attachment not found");
    if (!attachment) return;
    const issue = await svc.getById(attachment.issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    if (!(await assertAgentIssueMutationAllowed(req, res, issue))) return;
    if (!(await assertDeliverableMutationAllowedByRunContext(req, res, issue))) return;

    try {
      await storage.deleteObject(attachment.companyId, attachment.objectKey);
    } catch (err) {
      logger.warn({ err, attachmentId }, "storage delete failed while removing attachment");
    }

    const removed = await svc.removeAttachment(attachmentId);
    if (!removed) {
      res.status(404).json({ error: "Attachment not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: removed.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: "issue.attachment_removed",
      entityType: "issue",
      entityId: removed.issueId,
      details: {
        attachmentId: removed.id,
      },
    });

    res.json({ ok: true });
  });

  return router;
}
