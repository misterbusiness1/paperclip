import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApprovalComment, ApprovalStatus } from "@paperclipai/shared";
import { CheckCircle2, ChevronRight, Sparkles } from "lucide-react";
import { approvalsApi } from "../api/approvals";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";
import {
  isSupportedApprovalActionType,
  normalizeApprovalDetail,
  type ApprovalDetailActivityEntry,
  type ApprovalDetailEnvelope,
} from "../lib/approval-detail";
import { ApprovalPayloadRenderer } from "../components/ApprovalPayload";
import { Identity } from "../components/Identity";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatCents, formatDateTime, issueUrl } from "../lib/utils";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function readPath(root: unknown, ...path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) return null;
    current = record[segment];
  }
  return current;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function firstRecord(...values: unknown[]): JsonRecord | null {
  for (const value of values) {
    const record = asRecord(value);
    if (record) return record;
  }
  return null;
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return [];
}

function firstNestedString(
  roots: Array<JsonRecord | null | undefined>,
  paths: string[][],
): string | null {
  for (const root of roots) {
    for (const path of paths) {
      const value = readPath(root, ...path);
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
  }
  return null;
}

function formatOptionalMoney(cents: number | null, currency: string | null = null) {
  if (cents === null) return "—";
  if (currency && currency.toUpperCase() !== "USD") {
    return `${(cents / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ${currency.toUpperCase()}`;
  }
  return formatCents(cents);
}

function actionStatusLabel(status: ApprovalStatus) {
  switch (status) {
    case "revision_requested":
      return "Revision requested";
    default:
      return status.replace(/_/g, " ");
  }
}

function agentLabel(agentNameById: Map<string, string>, agentId: string | null | undefined, fallback: string) {
  if (!agentId) return fallback;
  return agentNameById.get(agentId) ?? agentId.slice(0, 8);
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="text-xs uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
      <span className={cn("text-sm text-right text-foreground", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

function InfoCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-background/70 p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3 space-y-1">{children}</div>
    </section>
  );
}

function ApprovalDebugPanel({
  open,
  onToggle,
  payload,
}: {
  open: boolean;
  onToggle: () => void;
  payload: JsonRecord | null;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-3">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={onToggle}
      >
        <ChevronRight className={cn("h-3 w-3 transition-transform", open && "rotate-90")} />
        Debug payload
      </button>
      {open ? (
        <pre className="mt-3 overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">
          {JSON.stringify(payload ?? {}, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function ApprovalTimeline({ activity }: { activity: ApprovalDetailActivityEntry[] }) {
  if (activity.length === 0) {
    return <p className="text-sm text-muted-foreground">No timeline entries yet.</p>;
  }

  return (
    <div className="space-y-3">
      {activity.map((entry) => (
        <div key={entry.id} className="rounded-lg border border-border/70 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{entry.title}</p>
              {entry.actorLabel ? <p className="text-xs text-muted-foreground">{entry.actorLabel}</p> : null}
            </div>
            <span className="text-xs text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
          </div>
          {entry.body ? <MarkdownBody className="mt-3 text-sm">{entry.body}</MarkdownBody> : null}
        </div>
      ))}
    </div>
  );
}

function AgentRationalePanel({ detail }: { detail: ApprovalDetailEnvelope }) {
  const requester = detail.requester;
  if (!requester) {
    return (
      <InfoCard title="Agent rationale">
        <p className="text-sm text-muted-foreground">
          {detail.legacyFallback
            ? "Hydrated rationale is not available until the v2 approval detail contract is enabled."
            : "No rationale metadata was provided for this approval."}
        </p>
      </InfoCard>
    );
  }

  const confidenceLabel =
    requester.confidence === null
      ? null
      : `${Math.round(requester.confidence * (requester.confidence <= 1 ? 100 : 1))}%`;

  return (
    <InfoCard title="Agent rationale">
      <InfoRow label="Model" value={requester.model} />
      <InfoRow label="Run ID" value={requester.runId} mono />
      <InfoRow label="Confidence" value={confidenceLabel} />
      {requester.rationale ? (
        <div className="pt-2">
          <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Rationale</p>
          <MarkdownBody className="mt-2 text-sm">{requester.rationale}</MarkdownBody>
        </div>
      ) : null}
      {requester.toolTrace.length > 0 ? (
        <details className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Tool trace</summary>
          <div className="mt-3 space-y-2">
            {requester.toolTrace.map((entry) => (
              <div key={entry.id} className="rounded border border-border/60 bg-background/80 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">{entry.label}</span>
                  {entry.status ? (
                    <span className="text-xs uppercase tracking-[0.08em] text-muted-foreground">
                      {entry.status}
                    </span>
                  ) : null}
                </div>
                {entry.detail ? <p className="mt-1 text-sm text-muted-foreground">{entry.detail}</p> : null}
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </InfoCard>
  );
}

function RefundApprovalView({ detail }: { detail: ApprovalDetailEnvelope }) {
  const request = detail.request.raw;
  const context = detail.context;
  const rawPayload = detail.rawPayload;
  const order = firstRecord(readPath(context, "order"), readPath(request, "order"), readPath(rawPayload, "order"));
  const customer = firstRecord(
    readPath(context, "customer"),
    readPath(request, "customer"),
    readPath(rawPayload, "customer"),
  );
  const gateway = firstRecord(
    readPath(context, "gateway"),
    readPath(request, "gateway"),
    readPath(rawPayload, "gateway"),
    readPath(order, "gateway"),
  );
  const thread = firstRecord(readPath(context, "thread"), readPath(request, "thread"), readPath(rawPayload, "thread"));
  const sideEffects = firstArray(
    detail.sideEffects,
    readPath(request, "sideEffects"),
    readPath(context, "sideEffects"),
    readPath(rawPayload, "sideEffects"),
    readPath(rawPayload, "refund", "sideEffects"),
  );
  const amountCents = firstNumber(
    readPath(request, "amountCents"),
    readPath(request, "refundAmountCents"),
    readPath(rawPayload, "amountCents"),
    readPath(rawPayload, "refundAmountCents"),
    readPath(gateway, "amountCents"),
  );
  const currency = firstString(
    readPath(request, "currency"),
    readPath(order, "currency"),
    readPath(rawPayload, "currency"),
    readPath(gateway, "currency"),
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
        <p className="text-[11px] uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">Refund request</p>
        <p className="mt-1 text-base font-semibold text-foreground">
          {detail.request.actionType === "refund_partial" ? "Partial refund" : "Full refund"}
        </p>
        <p className="mt-1 text-sm text-foreground/90">Amount: {formatOptionalMoney(amountCents, currency)}</p>
        {detail.request.summary ? <p className="mt-2 text-sm text-muted-foreground">{detail.request.summary}</p> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <InfoCard title="Order">
          <InfoRow label="Order" value={firstString(readPath(order, "number"), readPath(order, "id"))} />
          <InfoRow label="Status" value={firstString(readPath(order, "status"))} />
          <InfoRow
            label="Total"
            value={formatOptionalMoney(firstNumber(readPath(order, "totalCents")), firstString(readPath(order, "currency")))}
          />
        </InfoCard>

        <InfoCard title="Gateway">
          <InfoRow label="Provider" value={firstString(readPath(gateway, "name"), readPath(gateway, "provider"))} />
          <InfoRow label="Card" value={firstString(readPath(gateway, "cardLast4"), readPath(gateway, "last4"))} />
          <InfoRow label="Reason" value={firstString(readPath(request, "reason"), readPath(gateway, "reason"))} />
        </InfoCard>

        <InfoCard title="Customer">
          <InfoRow label="Name" value={firstString(readPath(customer, "name"))} />
          <InfoRow label="Email" value={firstString(readPath(customer, "email"))} />
          <InfoRow
            label="LTV"
            value={formatOptionalMoney(firstNumber(readPath(customer, "ltvCents")), firstString(readPath(customer, "currency")))}
          />
          <InfoRow label="Prior refunds" value={String(firstNumber(readPath(customer, "priorRefundCount")) ?? 0)} />
        </InfoCard>

        <InfoCard title="Linked context">
          <InfoRow label="Thread" value={firstString(readPath(thread, "subject"), readPath(thread, "id"))} />
          <InfoRow label="Channel" value={firstString(readPath(thread, "channel"))} />
          <InfoRow label="Customer note" value={firstString(readPath(thread, "latestMessage"))} />
        </InfoCard>
      </div>

      <InfoCard title="Side effects">
        {sideEffects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No side-effect preview was provided.</p>
        ) : (
          <ul className="space-y-2">
            {sideEffects.map((item, index) => {
              const record = asRecord(item);
              const label =
                firstString(record?.label, record?.title, record?.summary) ??
                (typeof item === "string" ? item : `Side effect ${index + 1}`);
              const detailText = firstString(record?.detail, record?.description);
              return (
                <li key={`${label}:${index}`} className="rounded border border-border/60 bg-background/70 px-3 py-2">
                  <p className="text-sm font-medium">{label}</p>
                  {detailText ? <p className="mt-1 text-sm text-muted-foreground">{detailText}</p> : null}
                </li>
              );
            })}
          </ul>
        )}
      </InfoCard>
    </div>
  );
}

function MessageReplyApprovalView({ detail }: { detail: ApprovalDetailEnvelope }) {
  const request = detail.request.raw;
  const context = detail.context;
  const rawPayload = detail.rawPayload;
  const recipient = firstRecord(
    readPath(context, "recipient"),
    readPath(request, "recipient"),
    readPath(rawPayload, "recipient"),
  );
  const thread = firstRecord(readPath(context, "thread"), readPath(request, "thread"), readPath(rawPayload, "thread"));
  const recipientName = firstNestedString(
    [recipient, thread, request, rawPayload],
    [["name"], ["fullName"], ["customerName"], ["recipientName"]],
  );
  const recipientAddress = firstNestedString(
    [recipient, thread, request, rawPayload],
    [
      ["address"],
      ["email"],
      ["addressLine1"],
      ["replyTo"],
      ["to"],
      ["recipientAddress"],
      ["recipientEmail"],
      ["customerEmail"],
    ],
  );
  const originalMessage = firstNestedString(
    [request, context, thread, rawPayload],
    [["originalMessage"], ["message"], ["incomingMessage"], ["latestMessage"], ["body"], ["thread", "originalMessage"]],
  );
  const proposedReply = firstNestedString(
    [request, context, thread, rawPayload],
    [["proposedReply"], ["reply"], ["draftReply"], ["suggestedReply"], ["body"], ["thread", "proposedReply"]],
  );

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-4 py-3">
        <p className="text-[11px] uppercase tracking-[0.08em] text-sky-700 dark:text-sky-300">Reply request</p>
        <p className="mt-1 text-base font-semibold text-foreground">Customer message reply</p>
        {detail.request.summary ? <p className="mt-2 text-sm text-muted-foreground">{detail.request.summary}</p> : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <InfoCard title="Recipient">
          <InfoRow label="Name" value={recipientName} />
          <InfoRow label="Address" value={recipientAddress} />
          <InfoRow label="Channel" value={firstString(readPath(thread, "channel"), readPath(request, "channel"))} />
        </InfoCard>

        <InfoCard title="Thread context">
          <InfoRow label="Thread" value={firstString(readPath(thread, "subject"), readPath(thread, "id"))} />
          <InfoRow label="Customer" value={firstString(readPath(thread, "customerName"))} />
          <InfoRow label="Order" value={firstString(readPath(thread, "orderNumber"))} />
        </InfoCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <InfoCard title="Original message">
          {originalMessage ? (
            <MarkdownBody className="text-sm">{originalMessage}</MarkdownBody>
          ) : (
            <p className="text-sm text-muted-foreground">Original message not provided.</p>
          )}
        </InfoCard>

        <InfoCard title="Proposed reply">
          {proposedReply ? (
            <MarkdownBody className="text-sm">{proposedReply}</MarkdownBody>
          ) : (
            <p className="text-sm text-muted-foreground">Proposed reply not provided.</p>
          )}
        </InfoCard>
      </div>
    </div>
  );
}

function UnsupportedApprovalView({ detail }: { detail: ApprovalDetailEnvelope }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-3">
        <p className="text-sm font-medium">Structured detail is not available for this approval yet.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {detail.legacyFallback
            ? "The server is still returning the legacy approval payload instead of the hydrated v2 detail envelope."
            : `No renderer is registered for action type \`${detail.request.actionType}\`.`}
        </p>
      </div>
      <ApprovalPayloadRenderer
        type={detail.approval.type}
        payload={detail.approval.payload as Record<string, unknown>}
        hidePrimaryTitle
      />
    </div>
  );
}

export function ApprovalDetail() {
  const { approvalId } = useParams<{ approvalId: string }>();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [commentBody, setCommentBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showRawPayload, setShowRawPayload] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement | null>(null);

  const { data: detailResponse, isLoading } = useQuery({
    queryKey: queryKeys.approvals.detail(approvalId!, "v2"),
    queryFn: () => approvalsApi.get(approvalId!, { version: 2 }),
    enabled: !!approvalId,
  });

  const { data: comments } = useQuery({
    queryKey: queryKeys.approvals.comments(approvalId!),
    queryFn: () => approvalsApi.listComments(approvalId!),
    enabled: !!approvalId,
  });

  const detail = useMemo(
    () => (detailResponse ? normalizeApprovalDetail(detailResponse, comments ?? []) : null),
    [comments, detailResponse],
  );

  const approval = detail?.approval ?? null;
  const resolvedCompanyId = approval?.companyId ?? selectedCompanyId;

  const { data: linkedIssues } = useQuery({
    queryKey: queryKeys.approvals.issues(approvalId!),
    queryFn: () => approvalsApi.listIssues(approvalId!),
    enabled: !!approvalId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(resolvedCompanyId ?? ""),
    queryFn: () => agentsApi.list(resolvedCompanyId ?? ""),
    enabled: !!resolvedCompanyId,
  });

  const { data: boardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
  });

  useEffect(() => {
    if (!approval?.companyId || approval.companyId === selectedCompanyId) return;
    setSelectedCompanyId(approval.companyId, { source: "route_sync" });
  }, [approval?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents ?? []) map.set(agent.id, agent.name);
    return map;
  }, [agents]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Approvals", href: "/approvals" },
      { label: detail?.request.title ?? approvalId ?? "Approval" },
    ]);
  }, [approvalId, detail?.request.title, setBreadcrumbs]);

  const refresh = () => {
    if (!approvalId) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.detail(approvalId, "v2") });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.comments(approvalId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.approvals.issues(approvalId) });
    if (approval?.companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(approval.companyId, "pending") });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(approval.companyId) });
    }
  };

  const approveMutation = useMutation({
    mutationFn: () => approvalsApi.approve(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
      navigate(`/approvals/${approvalId}?resolved=approved`, { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Approve failed"),
  });

  const rejectMutation = useMutation({
    mutationFn: () => approvalsApi.reject(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Reject failed"),
  });

  const revisionMutation = useMutation({
    mutationFn: () => approvalsApi.requestRevision(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Revision request failed"),
  });

  const resubmitMutation = useMutation({
    mutationFn: () => approvalsApi.resubmit(approvalId!),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Resubmit failed"),
  });

  const addCommentMutation = useMutation({
    mutationFn: () => approvalsApi.addComment(approvalId!, commentBody.trim()),
    onSuccess: () => {
      setCommentBody("");
      setError(null);
      refresh();
      commentRef.current?.focus();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Comment failed"),
  });

  useEffect(() => {
    if (!approvalId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isKeyboardShortcutTextInputTarget(event.target)) return;
      if (hasBlockingShortcutDialog(document)) return;

      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        commentRef.current?.focus();
        return;
      }

      if (!approval) return;
      const actionable = approval.status === "pending" || approval.status === "revision_requested";
      if (!actionable) return;

      if (key === "a" && approval.status === "pending") {
        event.preventDefault();
        approveMutation.mutate();
        return;
      }
      if (key === "r" && approval.status === "pending") {
        event.preventDefault();
        rejectMutation.mutate();
        return;
      }
      if (key === "v" && approval.status === "pending") {
        event.preventDefault();
        revisionMutation.mutate();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [approval, approvalId, approveMutation, rejectMutation, revisionMutation]);

  if (isLoading || !detail) return <PageSkeleton variant="detail" />;
  if (!approval) return <p className="text-sm text-muted-foreground">Approval not found.</p>;

  const payload = approval.payload as Record<string, unknown>;
  const linkedAgentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const isActionable = approval.status === "pending" || approval.status === "revision_requested";
  const isBudgetApproval = approval.type === "budget_override_required";
  const showApprovedBanner = searchParams.get("resolved") === "approved" && approval.status === "approved";
  const primaryLinkedIssue = linkedIssues?.[0] ?? null;
  const debugRawPayloadEnabled =
    import.meta.env.DEV || (searchParams.get("debug") === "1" && Boolean(boardAccess?.isInstanceAdmin));
  const resolvedCta =
    primaryLinkedIssue
      ? {
          label: (linkedIssues?.length ?? 0) > 1 ? "Review linked issues" : "Review linked issue",
          to: issueUrl(primaryLinkedIssue),
        }
      : linkedAgentId
        ? {
            label: "Open hired agent",
            to: `/agents/${linkedAgentId}`,
          }
        : {
            label: "Back to approvals",
            to: "/approvals",
          };

  const detailView = (() => {
    if (detail.request.actionType === "refund_full" || detail.request.actionType === "refund_partial") {
      return <RefundApprovalView detail={detail} />;
    }
    if (detail.request.actionType === "reply") {
      return <MessageReplyApprovalView detail={detail} />;
    }
    return <UnsupportedApprovalView detail={detail} />;
  })();

  return (
    <div className="max-w-5xl space-y-6">
      {showApprovedBanner ? (
        <div className="rounded-lg border border-green-300 bg-green-50 px-4 py-3 dark:border-green-700/40 dark:bg-green-900/20">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <div className="relative mt-0.5">
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-300" />
                <Sparkles className="absolute -right-2 -top-1 h-3 w-3 text-green-500 dark:text-green-200" />
              </div>
              <div>
                <p className="text-sm font-medium text-green-800 dark:text-green-100">Approval confirmed</p>
                <p className="text-xs text-green-700 dark:text-green-200/90">
                  Requesting agent was notified to review this approval and linked issues.
                </p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="border-green-400 text-green-800 hover:bg-green-100 dark:border-green-600/50 dark:text-green-100 dark:hover:bg-green-900/30"
              onClick={() => navigate(resolvedCta.to)}
            >
              {resolvedCta.label}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-border bg-background/80 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <StatusBadge status={approval.status} />
              <span className="font-mono text-xs text-muted-foreground">{approval.id}</span>
              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                {detail.request.actionType}
              </span>
            </div>
            <div>
              <h2 className="text-xl font-semibold">{detail.request.title}</h2>
              {detail.request.summary ? <p className="mt-1 text-sm text-muted-foreground">{detail.request.summary}</p> : null}
            </div>
          </div>

          <div className="min-w-[220px] rounded-lg border border-border/70 bg-muted/20 px-4 py-3">
            {approval.requestedByAgentId ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Requested by</span>
                <Identity
                  name={agentLabel(agentNameById, approval.requestedByAgentId, approval.requestedByAgentId.slice(0, 8))}
                  size="sm"
                />
              </div>
            ) : null}
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span>A approve</span>
              <span>R reject</span>
              <span>V revision</span>
              <span>C comment</span>
            </div>
          </div>
        </div>

        {detail.legacyFallback ? (
          <div className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Legacy detail fallback active</p>
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
              This page is ready for the v2 hydrated contract, but the current backend response is still the legacy approval payload.
            </p>
          </div>
        ) : null}

        {linkedIssues && linkedIssues.length > 0 ? (
          <div className="mt-4 border-t border-border/60 pt-4">
            <p className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Linked issues</p>
            <div className="mt-2 space-y-2">
              {linkedIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={issueUrl(issue)}
                  className="block rounded border border-border/70 px-3 py-2 text-sm hover:bg-accent/20"
                >
                  <span className="mr-2 font-mono text-xs text-muted-foreground">
                    {issue.identifier ?? issue.id.slice(0, 8)}
                  </span>
                  <span>{issue.title}</span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <section className="rounded-xl border border-border bg-background/80 p-5">
            {detailView}
          </section>

          <section className="rounded-xl border border-border bg-background/80 p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">Timeline</h3>
              <span className="text-xs text-muted-foreground">
                {detail.activity.length} {detail.activity.length === 1 ? "entry" : "entries"}
              </span>
            </div>
            <div className="mt-4">
              <ApprovalTimeline activity={detail.activity} />
            </div>

            <div className="mt-5 border-t border-border/60 pt-4">
              <Textarea
                ref={commentRef}
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                placeholder="Add a comment..."
                rows={4}
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Shortcuts: <span className="font-mono">A</span> approve, <span className="font-mono">R</span> reject, <span className="font-mono">V</span> revision, <span className="font-mono">C</span> comment
                </p>
                <Button
                  size="sm"
                  onClick={() => addCommentMutation.mutate()}
                  disabled={!commentBody.trim() || addCommentMutation.isPending}
                >
                  {addCommentMutation.isPending ? "Posting..." : "Post comment"}
                </Button>
              </div>
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <AgentRationalePanel detail={detail} />

          <InfoCard title="Decision controls">
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <p className="text-sm text-muted-foreground">Status: {actionStatusLabel(approval.status)}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {isActionable && !isBudgetApproval ? (
                <>
                  <Button
                    size="sm"
                    className="bg-green-700 text-white hover:bg-green-600"
                    onClick={() => approveMutation.mutate()}
                    disabled={approveMutation.isPending || approval.status !== "pending"}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => rejectMutation.mutate()}
                    disabled={rejectMutation.isPending || approval.status !== "pending"}
                  >
                    Reject
                  </Button>
                </>
              ) : null}
              {approval.status === "pending" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => revisionMutation.mutate()}
                  disabled={revisionMutation.isPending}
                >
                  Request revision
                </Button>
              ) : null}
              {approval.status === "revision_requested" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => resubmitMutation.mutate()}
                  disabled={resubmitMutation.isPending}
                >
                  Mark resubmitted
                </Button>
              ) : null}
            </div>
            {isBudgetApproval && approval.status === "pending" ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Resolve this budget stop from the budget controls on <Link to="/costs" className="underline underline-offset-2">/costs</Link>.
              </p>
            ) : null}
          </InfoCard>

          {debugRawPayloadEnabled ? (
            <ApprovalDebugPanel
              open={showRawPayload}
              onToggle={() => setShowRawPayload((value) => !value)}
              payload={detail.rawPayload}
            />
          ) : null}

          {!debugRawPayloadEnabled && !isSupportedApprovalActionType(detail.request.actionType) ? (
            <div className="rounded-lg border border-border/70 bg-muted/20 px-4 py-3">
              <p className="text-sm text-muted-foreground">Raw payload is hidden outside debug/dev access.</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
