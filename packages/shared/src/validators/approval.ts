import { z } from "zod";
import { APPROVAL_TYPES, APPROVAL_STATUSES } from "../constants.js";
import { multilineTextSchema } from "./text.js";

export const createApprovalSchema = z.object({
  type: z.enum(APPROVAL_TYPES),
  requestedByAgentId: z.string().uuid().optional().nullable(),
  payload: z.record(z.unknown()),
  issueIds: z.array(z.string().uuid()).optional(),
});

export type CreateApproval = z.infer<typeof createApprovalSchema>;

export const resolveApprovalSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type ResolveApproval = z.infer<typeof resolveApprovalSchema>;

export const requestApprovalRevisionSchema = z.object({
  decisionNote: multilineTextSchema.optional().nullable(),
});

export type RequestApprovalRevision = z.infer<typeof requestApprovalRevisionSchema>;

export const resubmitApprovalSchema = z.object({
  payload: z.record(z.unknown()).optional(),
});

export type ResubmitApproval = z.infer<typeof resubmitApprovalSchema>;

export const addApprovalCommentSchema = z.object({
  body: multilineTextSchema.pipe(z.string().min(1)),
});

export type AddApprovalComment = z.infer<typeof addApprovalCommentSchema>;

export const hydratedApprovalRequestSchema = z.object({
  actionType: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  amountCents: z.number().nullable(),
  currency: z.string().nullable(),
  rationale: z.string().nullable(),
  model: z.string().nullable(),
  runId: z.string().nullable(),
  confidence: z.number().nullable(),
  toolTrace: z.string().nullable(),
  reason: z.string().nullable(),
  proposedReply: z.string().nullable(),
  originalMessage: z.string().nullable(),
  channel: z.string().nullable(),
});

export type HydratedApprovalRequest = z.infer<typeof hydratedApprovalRequestSchema>;

export const hydratedApprovalContextSchema = z.object({
  order: z
    .object({
      number: z.string().nullable(),
      status: z.string().nullable(),
      totalCents: z.number().nullable(),
      currency: z.string().nullable(),
    })
    .nullable(),
  customer: z
    .object({
      name: z.string().nullable(),
      email: z.string().nullable(),
      ltvCents: z.number().nullable(),
      priorRefundCount: z.number().nullable(),
    })
    .nullable(),
  gateway: z
    .object({
      name: z.string().nullable(),
      cardLast4: z.string().nullable(),
      reason: z.string().nullable(),
      amountCents: z.number().nullable(),
      currency: z.string().nullable(),
    })
    .nullable(),
  recipient: z
    .object({
      name: z.string().nullable(),
      address: z.string().nullable(),
      email: z.string().nullable(),
    })
    .nullable(),
  thread: z
    .object({
      channel: z.string().nullable(),
      subject: z.string().nullable(),
      id: z.string().nullable(),
      latestMessage: z.string().nullable(),
      customerName: z.string().nullable(),
      orderNumber: z.string().nullable(),
      originalMessage: z.string().nullable(),
      proposedReply: z.string().nullable(),
    })
    .nullable(),
});

export type HydratedApprovalContext = z.infer<typeof hydratedApprovalContextSchema>;

export const hydratedApprovalSideEffectSchema = z.object({
  label: z.string(),
  detail: z.string().nullable(),
});

export type HydratedApprovalSideEffect = z.infer<typeof hydratedApprovalSideEffectSchema>;

export const hydratedApprovalActivitySchema = z.object({
  id: z.string(),
  kind: z.enum(["created", "status_change", "comment", "system"]),
  description: z.string(),
  actorLabel: z.string().nullable(),
  createdAt: z.date(),
});

export type HydratedApprovalActivity = z.infer<typeof hydratedApprovalActivitySchema>;

export const hydratedApprovalRequesterSchema = z.object({
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
});

export type HydratedApprovalRequester = z.infer<typeof hydratedApprovalRequesterSchema>;

export const hydratedApprovalDetailSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  type: z.enum(APPROVAL_TYPES),
  status: z.enum(APPROVAL_STATUSES),
  request: hydratedApprovalRequestSchema,
  context: hydratedApprovalContextSchema,
  requester: hydratedApprovalRequesterSchema,
  sideEffects: z.array(hydratedApprovalSideEffectSchema),
  activity: z.array(hydratedApprovalActivitySchema),
  rawPayload: z.record(z.unknown()),
  decisionNote: z.string().nullable(),
  decidedByUserId: z.string().nullable(),
  decidedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type HydratedApprovalDetail = z.infer<typeof hydratedApprovalDetailSchema>;
