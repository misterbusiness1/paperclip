import type { Approval, ApprovalComment, HydratedApprovalDetail, HydratedApprovalRequest } from "@paperclipai/shared";
import { approvalLabel } from "../components/ApprovalPayload";

type JsonRecord = Record<string, unknown>;

export interface ApprovalDetailRequest {
  actionType: string;
  title: string;
  summary: string | null;
  raw: JsonRecord;
}

export interface ApprovalDetailToolTraceEntry {
  id: string;
  label: string;
  detail: string | null;
  status: string | null;
}

export interface ApprovalDetailRequester {
  agentId: string | null;
  agentName: string | null;
  userId: string | null;
  userName: string | null;
  rationale: string | null;
  confidence: number | null;
  model: string | null;
  runId: string | null;
  toolTrace: ApprovalDetailToolTraceEntry[];
  raw: JsonRecord;
}

export interface ApprovalDetailActivityEntry {
  id: string;
  kind: "system" | "comment";
  title: string;
  body: string | null;
  actorLabel: string | null;
  createdAt: Date | string;
}

export interface ApprovalDetailEnvelope {
  approval: Approval;
  request: ApprovalDetailRequest;
  requester: ApprovalDetailRequester | null;
  context: JsonRecord | null;
  sideEffects: unknown[];
  activity: ApprovalDetailActivityEntry[];
  rawPayload: JsonRecord | null;
  legacyFallback: boolean;
}

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseToolTraceString(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [{ detail: value, label: "Tool trace" }];
  }
}

function fallbackActionType(approval: Approval) {
  return `legacy:${approval.type}`;
}

function buildLegacyActivity(approval: Approval, comments: ApprovalComment[]): ApprovalDetailActivityEntry[] {
  const timeline: ApprovalDetailActivityEntry[] = [
    {
      id: `${approval.id}:created`,
      kind: "system",
      title: "Approval requested",
      body: null,
      actorLabel: approval.requestedByAgentId ? "Agent" : approval.requestedByUserId ? "Board" : null,
      createdAt: approval.createdAt,
    },
  ];

  if (approval.decisionNote || approval.decidedAt) {
    const decisionTitle =
      approval.status === "approved"
        ? "Approved"
        : approval.status === "rejected"
          ? "Rejected"
          : approval.status === "revision_requested"
            ? "Revision requested"
            : `Status changed to ${approval.status}`;
    timeline.push({
      id: `${approval.id}:decision`,
      kind: "system",
      title: decisionTitle,
      body: approval.decisionNote,
      actorLabel: approval.decidedByUserId ? "Board" : null,
      createdAt: approval.decidedAt ?? approval.updatedAt,
    });
  }

  for (const comment of comments) {
    timeline.push({
      id: comment.id,
      kind: "comment",
      title: "Comment",
      body: comment.body,
      actorLabel: comment.authorAgentId ? "Agent" : comment.authorUserId ? "Board" : null,
      createdAt: comment.createdAt,
    });
  }

  return timeline.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

function normalizeToolTrace(input: unknown): ApprovalDetailToolTraceEntry[] {
  return asArray(input)
    .map((entry, index) => {
      const record = asRecord(entry);
      if (!record) return null;
      return {
        id: asString(record.id) ?? `tool-trace-${index}`,
        label: asString(record.label) ?? asString(record.name) ?? asString(record.tool) ?? `Tool ${index + 1}`,
        detail: asString(record.detail) ?? asString(record.summary) ?? asString(record.input),
        status: asString(record.status),
      } satisfies ApprovalDetailToolTraceEntry;
    })
    .filter((entry): entry is ApprovalDetailToolTraceEntry => entry !== null);
}

function normalizeRequester(input: unknown): ApprovalDetailRequester | null {
  const record = asRecord(input);
  if (!record) return null;
  return {
    agentId: asString(record.agentId),
    agentName: asString(record.agentName),
    userId: asString(record.userId),
    userName: asString(record.userName),
    rationale:
      asString(record.rationale) ??
      asString(record.summary) ??
      asString(record.reasoning) ??
      asString(record.explanation),
    confidence: asNumber(record.confidence),
    model: asString(record.model),
    runId: asString(record.runId),
    toolTrace: normalizeToolTrace(record.toolTrace),
    raw: record,
  };
}

function normalizeActivity(input: unknown): ApprovalDetailActivityEntry[] {
  const entries: ApprovalDetailActivityEntry[] = [];
  for (const [index, entry] of asArray(input).entries()) {
      const record = asRecord(entry);
      if (!record) continue;
      entries.push({
        id: asString(record.id) ?? `activity-${index}`,
        kind: asString(record.kind) === "comment" ? "comment" : "system",
        title:
          asString(record.title) ??
          asString(record.label) ??
          asString(record.statusLabel) ??
          "Activity",
        body:
          asString(record.body) ??
          asString(record.note) ??
          asString(record.summary) ??
          asString(record.detail),
        actorLabel:
          asString(record.actorLabel) ??
          asString(record.actorName) ??
          (asString(record.actorType) === "user" ? "Board" : null),
        createdAt: asString(record.createdAt) ?? new Date(0).toISOString(),
      });
  }
  return entries.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function isFlatV2HydratedDetail(
  record: JsonRecord | null,
): record is HydratedApprovalDetail & JsonRecord {
  if (!record) return false;
  return (
    typeof record.id === "string" &&
    typeof record.type === "string" &&
    typeof record.status === "string" &&
    typeof record.request === "object" &&
    record.request !== null
  );
}

function normalizeHydratedRequester(
  requesterInput: unknown,
  requestInput: HydratedApprovalRequest,
): ApprovalDetailRequester | null {
  const requester = normalizeRequester(requesterInput) ?? {
    agentId: null,
    agentName: null,
    userId: null,
    userName: null,
    rationale: null,
    confidence: null,
    model: null,
    runId: null,
    toolTrace: [],
    raw: {},
  };

  const parsedToolTrace = normalizeToolTrace(parseToolTraceString(requestInput.toolTrace));
  const hydratedRequester = {
    ...requester,
    rationale: requestInput.rationale ?? requester.rationale,
    confidence: requestInput.confidence ?? requester.confidence,
    model: requestInput.model ?? requester.model,
    runId: requestInput.runId ?? requester.runId,
    toolTrace: parsedToolTrace.length > 0 ? parsedToolTrace : requester.toolTrace,
    raw: {
      ...requester.raw,
      rationale: requestInput.rationale,
      confidence: requestInput.confidence,
      model: requestInput.model,
      runId: requestInput.runId,
      toolTrace: requestInput.toolTrace,
    },
  } satisfies ApprovalDetailRequester;

  return hydratedRequester.rationale ||
    hydratedRequester.confidence !== null ||
    hydratedRequester.model ||
    hydratedRequester.runId ||
    hydratedRequester.toolTrace.length > 0 ||
    hydratedRequester.agentId ||
    hydratedRequester.userId
    ? hydratedRequester
    : null;
}

export function normalizeApprovalDetail(
  input: Approval | HydratedApprovalDetail | Record<string, unknown>,
  comments: ApprovalComment[] = [],
): ApprovalDetailEnvelope | null {
  const envelope = asRecord(input);
  const approvalRecord = asRecord(envelope?.approval);

  if (isFlatV2HydratedDetail(envelope)) {
    const request = envelope.request;
    const requestRecord = request as unknown as JsonRecord;
    return {
      approval: {
        id: envelope.id as string,
        companyId: envelope.companyId as string,
        type: envelope.type as Approval["type"],
        status: envelope.status as Approval["status"],
        requestedByAgentId: ((envelope.requester as unknown as JsonRecord | null)?.agentId as string | null) ?? null,
        requestedByUserId: ((envelope.requester as unknown as JsonRecord | null)?.userId as string | null) ?? null,
        payload: (envelope.rawPayload ?? {}) as Record<string, unknown>,
        decisionNote: (envelope.decisionNote as string) ?? null,
        decidedByUserId: (envelope.decidedByUserId as string) ?? null,
        decidedAt: envelope.decidedAt ? new Date(envelope.decidedAt as unknown as string | Date) : null,
        createdAt: new Date(envelope.createdAt as unknown as string | Date),
        updatedAt: new Date(envelope.updatedAt as unknown as string | Date),
      },
      request: {
        actionType: asString(request.actionType) ?? "unknown",
        title: asString(requestRecord.title) ?? approvalLabel(envelope.type as Approval["type"], null),
        summary: asString(request.summary),
        raw: requestRecord,
      },
      requester: normalizeHydratedRequester(envelope.requester, request),
      context: asRecord(envelope.context),
      sideEffects: asArray(envelope.sideEffects),
      activity: normalizeActivity(envelope.activity),
      rawPayload: asRecord(envelope.rawPayload),
      legacyFallback: false,
    };
  }

  if (approvalRecord && envelope?.request) {
    const approval = approvalRecord as unknown as Approval;
    const request = asRecord(envelope.request) ?? {};
    return {
      approval,
      request: {
        actionType: asString(request.actionType) ?? fallbackActionType(approval),
        title:
          asString(request.title) ??
          approvalLabel(approval.type, approval.payload as Record<string, unknown> | null),
        summary: asString(request.summary),
        raw: request,
      },
      requester: normalizeRequester(envelope.requester),
      context: asRecord(envelope.context),
      sideEffects: asArray(envelope.sideEffects),
      activity: normalizeActivity(envelope.activity),
      rawPayload: asRecord(envelope.rawPayload),
      legacyFallback: false,
    };
  }

  const approval = input as Approval;
  return {
    approval,
    request: {
      actionType: fallbackActionType(approval),
      title: approvalLabel(approval.type, approval.payload as Record<string, unknown> | null),
      summary: asString((approval.payload as Record<string, unknown> | null)?.summary),
      raw: (approval.payload as Record<string, unknown> | null) ?? {},
    },
    requester: null,
    context: null,
    sideEffects: [],
    activity: buildLegacyActivity(approval, comments),
    rawPayload: (approval.payload as Record<string, unknown> | null) ?? {},
    legacyFallback: true,
  };
}

export function isSupportedApprovalActionType(actionType: string) {
  return actionType === "refund_full" || actionType === "refund_partial" || actionType === "reply";
}
