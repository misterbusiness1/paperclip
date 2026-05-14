import type { ApprovalStatus, ApprovalType } from "../constants.js";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

export type ApprovalActionType = string;

export interface HydratedApprovalRequest {
  actionType: ApprovalActionType;
  title: string | null;
  summary: string | null;
  amountCents: number | null;
  currency: string | null;
  rationale: string | null;
  model: string | null;
  runId: string | null;
  confidence: number | null;
  toolTrace: string | null;
  reason: string | null;
  proposedReply: string | null;
  originalMessage: string | null;
  channel: string | null;
}

export interface HydratedApprovalContext {
  order: {
    number: string | null;
    status: string | null;
    totalCents: number | null;
    currency: string | null;
  };
  customer: {
    name: string | null;
    email: string | null;
    ltvCents: number | null;
    priorRefundCount: number | null;
  };
  gateway: {
    name: string | null;
    cardLast4: string | null;
    reason: string | null;
    amountCents: number | null;
    currency: string | null;
  };
  recipient: {
    name: string | null;
    address: string | null;
    email: string | null;
  };
  thread: {
    channel: string | null;
    subject: string | null;
    id: string | null;
    latestMessage: string | null;
    customerName: string | null;
    orderNumber: string | null;
    originalMessage: string | null;
    proposedReply: string | null;
  };
}

export interface HydratedApprovalSideEffect {
  label: string;
  detail: string | null;
}

export interface HydratedApprovalActivity {
  id: string;
  kind: "created" | "status_change" | "comment" | "system";
  description: string;
  actorLabel: string | null;
  createdAt: Date;
}

export interface HydratedApprovalRequester {
  agentId: string | null;
  agentName: string | null;
  userId: string | null;
  userName: string | null;
}

export interface HydratedApprovalDetail {
  id: string;
  companyId: string;
  type: ApprovalType;
  status: ApprovalStatus;
  request: HydratedApprovalRequest;
  context: HydratedApprovalContext;
  requester: HydratedApprovalRequester;
  sideEffects: HydratedApprovalSideEffect[];
  activity: HydratedApprovalActivity[];
  rawPayload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
