import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, approvalComments, approvals, issueApprovals } from "@paperclipai/db";
import type { ApprovalType } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { redactEventPayload } from "../redaction.js";
import { agentService } from "./agents.js";
import { budgetService } from "./budgets.js";
import { notifyHireApproved } from "./hire-hook.js";
import { instanceSettingsService } from "./instance-settings.js";

export function approvalService(db: Db) {
  const agentsSvc = agentService(db);
  const budgets = budgetService(db);
  const instanceSettings = instanceSettingsService(db);
  const canResolveStatuses = new Set(["pending", "revision_requested"]);
  const resolvableStatuses = Array.from(canResolveStatuses);
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  async function getExistingApproval(id: string) {
    const existing = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    decidedByUserId: string,
    decisionNote: string | null | undefined,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await db
      .update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id);
    if (latest.status === targetStatus) {
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return {
    list: (companyId: string, status?: string) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId">) =>
      db
        .insert(approvals)
        .values({ ...data, companyId })
        .returning()
        .then((rows) => rows[0]),

    approve: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "approved",
        decidedByUserId,
        decisionNote,
      );

      let hireApprovedAgentId: string | null = null;
      const now = new Date();
      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.activatePendingApproval(payloadAgentId);
          hireApprovedAgentId = payloadAgentId;
        } else {
          const created = await agentsSvc.create(updated.companyId, {
            name: String(payload.name ?? "New Agent"),
            role: String(payload.role ?? "general"),
            title: typeof payload.title === "string" ? payload.title : null,
            reportsTo: typeof payload.reportsTo === "string" ? payload.reportsTo : null,
            capabilities: typeof payload.capabilities === "string" ? payload.capabilities : null,
            adapterType: String(payload.adapterType ?? "process"),
            adapterConfig:
              typeof payload.adapterConfig === "object" && payload.adapterConfig !== null
                ? (payload.adapterConfig as Record<string, unknown>)
                : {},
            budgetMonthlyCents:
              typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0,
            metadata:
              typeof payload.metadata === "object" && payload.metadata !== null
                ? (payload.metadata as Record<string, unknown>)
                : null,
            status: "idle",
            spentMonthlyCents: 0,
            permissions: undefined,
            lastHeartbeatAt: null,
          });
          hireApprovedAgentId = created?.id ?? null;
        }
        if (hireApprovedAgentId) {
          const budgetMonthlyCents =
            typeof payload.budgetMonthlyCents === "number" ? payload.budgetMonthlyCents : 0;
          if (budgetMonthlyCents > 0) {
            await budgets.upsertPolicy(
              updated.companyId,
              {
                scopeType: "agent",
                scopeId: hireApprovedAgentId,
                amount: budgetMonthlyCents,
                windowKind: "calendar_month_utc",
              },
              decidedByUserId,
            );
          }
          void notifyHireApproved(db, {
            companyId: updated.companyId,
            agentId: hireApprovedAgentId,
            source: "approval",
            sourceId: id,
            approvedAt: now,
          }).catch(() => {});
        }
      }

      return { approval: updated, applied };
    },

    reject: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const { approval: updated, applied } = await resolveApproval(
        id,
        "rejected",
        decidedByUserId,
        decisionNote,
      );

      if (applied && updated.type === "hire_agent") {
        const payload = updated.payload as Record<string, unknown>;
        const payloadAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
        if (payloadAgentId) {
          await agentsSvc.terminate(payloadAgentId);
        }
      }

      return { approval: updated, applied };
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      return db
        .update(approvals)
        .set({
          status: "pending",
          payload: payload ?? existing.payload,
          decisionNote: null,
          decidedByUserId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },

    getHydratedDetail: async (id: string) => {
      const approval = await getExistingApproval(id);

      const requesterAgentId = approval.requestedByAgentId;
      const requesterUserId = approval.requestedByUserId;
      const requesterName = requesterAgentId
        ? (await agentsSvc.getById(requesterAgentId))?.name ?? null
        : null;

      const linkedIssueRows = await db
        .select({ issueId: issueApprovals.issueId })
        .from(issueApprovals)
        .where(eq(issueApprovals.approvalId, id));
      const linkedIssueIds = linkedIssueRows.map((r) => r.issueId);

      const activityRows = await db
        .select({
          id: activityLog.id,
          actorType: activityLog.actorType,
          actorId: activityLog.actorId,
          action: activityLog.action,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(and(eq(activityLog.entityType, "approval"), eq(activityLog.entityId, id)))
        .orderBy(desc(activityLog.createdAt));

      const sideEffects: Array<{ label: string; detail: string | null }> = [];
      if (approval.status === "approved" && approval.type === "hire_agent") {
        sideEffects.push({
          label: "Agent activated",
          detail: "Agent account will be activated following approval",
        });
      }
      if (approval.status === "rejected" && approval.type === "hire_agent") {
        sideEffects.push({
          label: "Agent terminated",
          detail: "Agent account will be terminated following rejection",
        });
      }

      const payload = approval.payload as Record<string, unknown>;
      const actionType = normalizeActionType(payload, approval.type);
      const amountCents = typeof payload.amountCents === "number" ? payload.amountCents : null;
      const currency =
        typeof payload.currency === "string" && payload.currency.length > 0 ? payload.currency : null;
      const channel =
        typeof payload.channel === "string" && payload.channel.length > 0 ? payload.channel : null;
      const gateway = payload.gateway as Record<string, unknown> | undefined;
      const cardLast4 = typeof gateway?.cardLast4 === "string" ? gateway.cardLast4 : null;

      if (
        (actionType === "refund_full" || actionType === "refund_partial") &&
        amountCents !== null &&
        currency !== null
      ) {
        const refundLabel = actionType === "refund_full" ? "Full refund" : "Partial refund";
        const cardInfo = cardLast4 ? ` to card ending in ${cardLast4}` : "";
        if (approval.status === "pending") {
          sideEffects.push({
            label: `${refundLabel} pending`,
            detail: `${refundLabel} of ${(amountCents / 100).toFixed(2)} ${currency} will be processed${cardInfo}`,
          });
        } else if (approval.status === "approved") {
          sideEffects.push({
            label: `${refundLabel} processed`,
            detail: `${refundLabel} of ${(amountCents / 100).toFixed(2)} ${currency} has been processed${cardInfo}`,
          });
        } else if (approval.status === "rejected") {
          sideEffects.push({
            label: `${refundLabel} declined`,
            detail: `${refundLabel} request has been declined`,
          });
        }
      }

      if (actionType === "reply" && channel !== null) {
        if (approval.status === "pending") {
          sideEffects.push({
            label: "Reply pending",
            detail: `Reply via ${channel} will be sent`,
          });
        } else if (approval.status === "approved") {
          sideEffects.push({
            label: "Reply sent",
            detail: `Reply via ${channel} has been sent`,
          });
        } else if (approval.status === "rejected") {
          sideEffects.push({
            label: "Reply not sent",
            detail: "Reply will not be sent",
          });
        }
      }

      const title = typeof payload.title === "string" && payload.title.length > 0 ? payload.title : null;
      const summary = typeof payload.summary === "string" && payload.summary.length > 0 ? payload.summary : null;
      const reason = typeof payload.reason === "string" && payload.reason.length > 0 ? payload.reason : null;
      const rationale = extractRationale(payload);
      const model = extractModel(payload);
      const runId = extractRunId(payload);
      const confidence = extractConfidence(payload);
      const toolTrace = extractToolTrace(payload);
      const proposedReply =
        typeof payload.proposedReply === "string" && payload.proposedReply.length > 0 ? payload.proposedReply : null;
      const originalMessage =
        typeof payload.originalMessage === "string" && payload.originalMessage.length > 0
          ? payload.originalMessage
          : null;

      const context = extractContext(payload, linkedIssueIds);

      const comments = await db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, id),
            eq(approvalComments.companyId, approval.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt));

      const activity: Array<{
        id: string;
        kind: "created" | "status_change" | "comment" | "system";
        description: string;
        actorLabel: string | null;
        createdAt: Date;
      }> = [
        {
          id: `created-${approval.id}`,
          kind: "created",
          description: "Approval created",
          actorLabel: requesterName ?? (requesterAgentId ?? requesterUserId)?.slice(0, 8) ?? null,
          createdAt: approval.createdAt,
        },
        ...activityRows.map((row) => ({
          id: row.id,
          kind: "system" as const,
          description: row.action,
          actorLabel: null,
          createdAt: row.createdAt,
        })),
        ...comments.map((c) => ({
          id: c.id,
          kind: "comment" as const,
          description: "Comment added",
          actorLabel: null,
          createdAt: c.createdAt,
        })),
      ];

      return {
        id: approval.id,
        companyId: approval.companyId,
        type: approval.type,
        status: approval.status,
        request: {
          actionType,
          title,
          summary,
          amountCents,
          currency,
          rationale,
          model,
          runId,
          confidence,
          toolTrace,
          reason,
          proposedReply,
          originalMessage,
          channel,
        },
        context,
        requester: {
          agentId: requesterAgentId,
          agentName: requesterName,
          userId: requesterUserId,
          userName: null,
        },
        sideEffects,
        activity,
        rawPayload: redactEventPayload(approval.payload) ?? {},
        decisionNote: approval.decisionNote,
        decidedByUserId: approval.decidedByUserId,
        decidedAt: approval.decidedAt,
        createdAt: approval.createdAt,
        updatedAt: approval.updatedAt,
      };
    },
  };
}

function normalizeActionType(
  payload: Record<string, unknown>,
  approvalType: string,
): string {
  if (typeof payload.actionType === "string" && payload.actionType.length > 0) {
    return payload.actionType;
  }
  return approvalType;
}

function extractRationale(payload: Record<string, unknown>): string | null {
  if (typeof payload.rationale === "string" && payload.rationale.length > 0) {
    return payload.rationale;
  }
  if (typeof payload.reason === "string" && payload.reason.length > 0) {
    return payload.reason;
  }
  return null;
}

function extractModel(payload: Record<string, unknown>): string | null {
  if (typeof payload.model === "string" && payload.model.length > 0) {
    return payload.model;
  }
  if (typeof payload.modelName === "string" && payload.modelName.length > 0) {
    return payload.modelName;
  }
  return null;
}

function extractRunId(payload: Record<string, unknown>): string | null {
  if (typeof payload.runId === "string" && payload.runId.length > 0) {
    return payload.runId;
  }
  if (typeof payload.run_id === "string" && payload.run_id.length > 0) {
    return payload.run_id;
  }
  return null;
}

function extractConfidence(payload: Record<string, unknown>): number | null {
  if (typeof payload.confidence === "number") {
    return payload.confidence;
  }
  return null;
}

function extractToolTrace(payload: Record<string, unknown>): string | null {
  if (typeof payload.toolTrace === "string" && payload.toolTrace.length > 0) {
    return payload.toolTrace;
  }
  if (typeof payload.tool_trace === "string" && payload.tool_trace.length > 0) {
    return payload.tool_trace;
  }
  if (typeof payload.toolTraceRaw === "string" && payload.toolTraceRaw.length > 0) {
    return payload.toolTraceRaw;
  }
  return null;
}

function extractContext(
  payload: Record<string, unknown>,
  _linkedIssueIds: string[],
): {
  order: { number: string | null; status: string | null; totalCents: number | null; currency: string | null };
  customer: { name: string | null; email: string | null; ltvCents: number | null; priorRefundCount: number | null };
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
} {
  const order = payload.order as Record<string, unknown> | undefined;
  const customer = payload.customer as Record<string, unknown> | undefined;
  const gateway = payload.gateway as Record<string, unknown> | undefined;
  const recipient = payload.recipient as Record<string, unknown> | undefined;
  const thread = payload.thread as Record<string, unknown> | undefined;
  return {
    order: {
      number: typeof order?.number === "string" ? order.number : null,
      status: typeof order?.status === "string" ? order.status : null,
      totalCents: typeof order?.totalCents === "number" ? order.totalCents : null,
      currency: typeof order?.currency === "string" ? order.currency : null,
    },
    customer: {
      name: typeof customer?.name === "string" ? customer.name : null,
      email: typeof customer?.email === "string" ? customer.email : null,
      ltvCents: typeof customer?.ltvCents === "number" ? customer.ltvCents : null,
      priorRefundCount: typeof customer?.priorRefundCount === "number" ? customer.priorRefundCount : null,
    },
    gateway: {
      name: typeof gateway?.name === "string" ? gateway.name : null,
      cardLast4: typeof gateway?.cardLast4 === "string" ? gateway.cardLast4 : null,
      reason: typeof gateway?.reason === "string" ? gateway.reason : null,
      amountCents: typeof gateway?.amountCents === "number" ? gateway.amountCents : null,
      currency: typeof gateway?.currency === "string" ? gateway.currency : null,
    },
    recipient: {
      name: typeof recipient?.name === "string" ? recipient.name : null,
      address: typeof recipient?.address === "string" ? recipient.address : null,
      email: typeof recipient?.email === "string" ? recipient.email : null,
    },
    thread: {
      channel: typeof thread?.channel === "string" ? thread.channel : null,
      subject: typeof thread?.subject === "string" ? thread.subject : null,
      id: typeof thread?.id === "string" ? thread.id : null,
      latestMessage: typeof thread?.latestMessage === "string" ? thread.latestMessage : null,
      customerName: typeof thread?.customerName === "string" ? thread.customerName : null,
      orderNumber: typeof thread?.orderNumber === "string" ? thread.orderNumber : null,
      originalMessage: typeof thread?.originalMessage === "string" ? thread.originalMessage : null,
      proposedReply: typeof thread?.proposedReply === "string" ? thread.proposedReply : null,
    },
  };
}
