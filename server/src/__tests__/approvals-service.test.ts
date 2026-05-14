import { beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, approvalComments, approvals, issueApprovals } from "@paperclipai/db";
import { REDACTED_EVENT_VALUE } from "../redaction.ts";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  create: vi.fn(),
  terminate: vi.fn(),
  getById: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

function createHydratedDetailDbStub(approval: ApprovalRecord) {
  const select = vi.fn((selection?: Record<string, unknown>) => ({
    from: vi.fn((table: unknown) => {
      if (table === approvals) {
        return {
          where: vi.fn(() =>
            Promise.resolve([
              {
                ...approval,
                requestedByUserId: null,
                decisionNote: null,
                decidedByUserId: null,
                decidedAt: null,
                createdAt: new Date("2026-05-14T00:00:00.000Z"),
                updatedAt: new Date("2026-05-14T00:05:00.000Z"),
              },
            ]),
          ),
        };
      }

      if (table === issueApprovals) {
        return {
          where: vi.fn(() => Promise.resolve([{ issueId: "issue-1" }])),
        };
      }

      if (table === activityLog) {
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() =>
              Promise.resolve([
                {
                  id: "activity-1",
                  actorType: "user",
                  actorId: "board-user",
                  action: "approval.reviewed",
                  details: {},
                  createdAt: new Date("2026-05-14T00:02:00.000Z"),
                },
              ]),
            ),
          })),
        };
      }

      if (table === approvalComments) {
        if (selection) {
          throw new Error("approval comments should not use a shaped select");
        }
        return {
          where: vi.fn(() => ({
            orderBy: vi.fn(() =>
              Promise.resolve([
                {
                  id: "comment-1",
                  companyId: approval.companyId,
                  approvalId: approval.id,
                  authorAgentId: null,
                  authorUserId: "board-user",
                  body: "Reviewed by board",
                  createdAt: new Date("2026-05-14T00:03:00.000Z"),
                  updatedAt: new Date("2026-05-14T00:03:00.000Z"),
                },
              ]),
            ),
          })),
        };
      }

      throw new Error("Unexpected table in select");
    }),
  }));

  return { db: { select, update: vi.fn() } };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });
});

describe("approvalService getHydratedDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", name: "Test Agent" });
  });

  it("getHydratedDetail method exists on the service", () => {
    const dbStub = createDbStub([[createApproval("pending")]], []);
    const svc = approvalService(dbStub.db as any);
    expect(typeof svc.getHydratedDetail).toBe("function");
  });

  it("returns the flat v2 detail contract with request metadata and redacted raw payload", async () => {
    const dbStub = createHydratedDetailDbStub({
      ...createApproval("pending"),
      type: "request_board_approval",
      payload: {
        actionType: "refund_partial",
        title: "Partial refund for order 1001",
        summary: "Customer reported damage on arrival.",
        amountCents: 1200,
        currency: "USD",
        rationale: "Customer sent damaged item photos.",
        model: "gpt-5",
        runId: "run-123",
        confidence: 0.82,
        toolTrace: JSON.stringify([
          { id: "tool-1", label: "Fetch order", status: "ok", detail: "Loaded order context" },
        ]),
        reason: "Damaged box",
        order: {
          number: "1001",
          status: "processing",
          totalCents: 5500,
          currency: "USD",
        },
        customer: {
          name: "Ada Lovelace",
          email: "ada@example.com",
          ltvCents: 125000,
          priorRefundCount: 1,
        },
        gateway: {
          name: "Stripe",
          cardLast4: "4242",
          reason: "Damaged box",
          amountCents: 1200,
          currency: "USD",
        },
        thread: {
          channel: "email",
          subject: "Order 1001",
          id: "thread-1001",
          latestMessage: "Customer reported damage on arrival.",
          customerName: "Ada Lovelace",
          orderNumber: "1001",
          originalMessage: "The box arrived damaged.",
          proposedReply: "We can issue a partial refund.",
        },
        apiKey: "secret-token",
      },
    });

    const svc = approvalService(dbStub.db as any);
    const detail = await svc.getHydratedDetail("approval-1");

    expect(detail).toMatchObject({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      request: {
        actionType: "refund_partial",
        title: "Partial refund for order 1001",
        summary: "Customer reported damage on arrival.",
        amountCents: 1200,
        currency: "USD",
        rationale: "Customer sent damaged item photos.",
        model: "gpt-5",
        runId: "run-123",
        confidence: 0.82,
        toolTrace: JSON.stringify([
          { id: "tool-1", label: "Fetch order", status: "ok", detail: "Loaded order context" },
        ]),
        reason: "Damaged box",
        proposedReply: null,
        originalMessage: null,
        channel: null,
      },
      context: {
        order: {
          number: "1001",
          status: "processing",
          totalCents: 5500,
          currency: "USD",
        },
        customer: {
          name: "Ada Lovelace",
          email: "ada@example.com",
          ltvCents: 125000,
          priorRefundCount: 1,
        },
        gateway: {
          name: "Stripe",
          cardLast4: "4242",
          reason: "Damaged box",
          amountCents: 1200,
          currency: "USD",
        },
        thread: {
          channel: "email",
          subject: "Order 1001",
          id: "thread-1001",
          latestMessage: "Customer reported damage on arrival.",
          customerName: "Ada Lovelace",
          orderNumber: "1001",
          originalMessage: "The box arrived damaged.",
          proposedReply: "We can issue a partial refund.",
        },
      },
      requester: {
        agentId: "requester-1",
        agentName: "Test Agent",
        userId: null,
        userName: null,
      },
      rawPayload: {
        actionType: "refund_partial",
        title: "Partial refund for order 1001",
        summary: "Customer reported damage on arrival.",
        amountCents: 1200,
        currency: "USD",
        rationale: "Customer sent damaged item photos.",
        model: "gpt-5",
        runId: "run-123",
        confidence: 0.82,
        toolTrace: JSON.stringify([
          { id: "tool-1", label: "Fetch order", status: "ok", detail: "Loaded order context" },
        ]),
        reason: "Damaged box",
        order: {
          number: "1001",
          status: "processing",
          totalCents: 5500,
          currency: "USD",
        },
        customer: {
          name: "Ada Lovelace",
          email: "ada@example.com",
          ltvCents: 125000,
          priorRefundCount: 1,
        },
        gateway: {
          name: "Stripe",
          cardLast4: "4242",
          reason: "Damaged box",
          amountCents: 1200,
          currency: "USD",
        },
        thread: {
          channel: "email",
          subject: "Order 1001",
          id: "thread-1001",
          latestMessage: "Customer reported damage on arrival.",
          customerName: "Ada Lovelace",
          orderNumber: "1001",
          originalMessage: "The box arrived damaged.",
          proposedReply: "We can issue a partial refund.",
        },
        apiKey: REDACTED_EVENT_VALUE,
      },
    });
    expect(detail.activity.map((entry) => entry.kind)).toEqual(["created", "system", "comment"]);
  });

  it("synthesizes side effects for pending refund_partial approval", async () => {
    const dbStub = createHydratedDetailDbStub({
      ...createApproval("pending"),
      type: "request_board_approval",
      payload: {
        actionType: "refund_partial",
        amountCents: 1500,
        currency: "USD",
        gateway: { name: "Stripe", cardLast4: "1234" },
      },
    });

    const svc = approvalService(dbStub.db as any);
    const detail = await svc.getHydratedDetail("approval-1");

    expect(detail.sideEffects).toContainEqual({
      label: "Partial refund pending",
      detail: "Partial refund of 15.00 USD will be processed to card ending in 1234",
    });
  });

  it("synthesizes side effects for approved refund_full approval", async () => {
    const dbStub = createHydratedDetailDbStub({
      ...createApproval("approved"),
      type: "request_board_approval",
      payload: {
        actionType: "refund_full",
        amountCents: 5500,
        currency: "USD",
        gateway: { name: "Stripe", cardLast4: "5678" },
      },
    });

    const svc = approvalService(dbStub.db as any);
    const detail = await svc.getHydratedDetail("approval-1");

    expect(detail.sideEffects).toContainEqual({
      label: "Full refund processed",
      detail: "Full refund of 55.00 USD has been processed to card ending in 5678",
    });
  });

  it("synthesizes side effects for rejected refund_partial approval", async () => {
    const dbStub = createHydratedDetailDbStub({
      ...createApproval("rejected"),
      type: "request_board_approval",
      payload: {
        actionType: "refund_partial",
        amountCents: 1200,
        currency: "EUR",
      },
    });

    const svc = approvalService(dbStub.db as any);
    const detail = await svc.getHydratedDetail("approval-1");

    expect(detail.sideEffects).toContainEqual({
      label: "Partial refund declined",
      detail: "Partial refund request has been declined",
    });
  });

  it("synthesizes side effects for pending reply approval", async () => {
    const dbStub = createHydratedDetailDbStub({
      ...createApproval("pending"),
      type: "request_board_approval",
      payload: {
        actionType: "reply",
        channel: "email",
        proposedReply: "Thank you for your order.",
      },
    });

    const svc = approvalService(dbStub.db as any);
    const detail = await svc.getHydratedDetail("approval-1");

    expect(detail.sideEffects).toContainEqual({
      label: "Reply pending",
      detail: "Reply via email will be sent",
    });
  });

  it("synthesizes side effects for approved reply approval", async () => {
    const dbStub = createHydratedDetailDbStub({
      ...createApproval("approved"),
      type: "request_board_approval",
      payload: {
        actionType: "reply",
        channel: "email",
      },
    });

    const svc = approvalService(dbStub.db as any);
    const detail = await svc.getHydratedDetail("approval-1");

    expect(detail.sideEffects).toContainEqual({
      label: "Reply sent",
      detail: "Reply via email has been sent",
    });
  });

  it("synthesizes side effects for rejected reply approval", async () => {
    const dbStub = createHydratedDetailDbStub({
      ...createApproval("rejected"),
      type: "request_board_approval",
      payload: {
        actionType: "reply",
        channel: "sms",
      },
    });

    const svc = approvalService(dbStub.db as any);
    const detail = await svc.getHydratedDetail("approval-1");

    expect(detail.sideEffects).toContainEqual({
      label: "Reply not sent",
      detail: "Reply will not be sent",
    });
  });

  it("reply approvals preserve original/proposed message context in request without raw payload", async () => {
    const dbStub = createHydratedDetailDbStub({
      ...createApproval("pending"),
      type: "request_board_approval",
      payload: {
        actionType: "reply",
        channel: "email",
        originalMessage: "Where is my order?",
        proposedReply: "Your order is on its way.",
        apiKey: "secret-token",
      },
    });

    const svc = approvalService(dbStub.db as any);
    const detail = await svc.getHydratedDetail("approval-1");

    expect(detail.request.originalMessage).toBe("Where is my order?");
    expect(detail.request.proposedReply).toBe("Your order is on its way.");
    expect(detail.request.channel).toBe("email");
    expect(detail.rawPayload.apiKey).toBe(REDACTED_EVENT_VALUE);
  });
});
