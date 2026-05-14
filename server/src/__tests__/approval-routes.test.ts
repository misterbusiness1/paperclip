import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalRoutes } from "../routes/approvals.ts";

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getHydratedDetail: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  approvalService: vi.fn(() => mockApprovalService),
  heartbeatService: vi.fn(() => ({ wakeup: vi.fn() })),
  issueApprovalService: vi.fn(() => ({ linkManyForApproval: vi.fn(), listIssuesForApproval: vi.fn() })),
  logActivity: vi.fn(),
  secretService: vi.fn(() => ({ normalizeHireApprovalPayloadForPersistence: vi.fn() })),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      userId: "board-user",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", approvalRoutes({} as never));
  return app;
}

describe("approvalRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the flat v2 approval detail envelope for GET /approvals/:id?v=2", async () => {
    mockApprovalService.getById.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      payload: {},
    });
    mockApprovalService.getHydratedDetail.mockResolvedValue({
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      request: {
        actionType: "refund_partial",
        rationale: "Customer sent damaged item photos.",
        model: "gpt-5",
        runId: "run-123",
        confidence: 0.82,
        toolTrace: "[{\"id\":\"tool-1\"}]",
      },
      context: {
        order: {
          number: "order-1001",
          status: null,
          totalCents: null,
          currency: null,
        },
        customer: {
          name: null,
          email: null,
          ltvCents: null,
          priorRefundCount: null,
        },
        gateway: {
          name: null,
          cardLast4: null,
        },
        thread: {
          channel: null,
          subject: null,
        },
      },
      requester: {
        agentId: "agent-1",
        agentName: "Plugin Engineer",
        userId: null,
        userName: null,
      },
      sideEffects: [],
      activity: [],
      rawPayload: { apiKey: "***REDACTED***" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-05-14T00:00:00.000Z"),
      updatedAt: new Date("2026-05-14T00:05:00.000Z"),
    });

    const res = await request(createApp()).get("/api/approvals/approval-1?v=2");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "approval-1",
      request: { actionType: "refund_partial" },
      requester: { agentName: "Plugin Engineer" },
      rawPayload: { apiKey: "***REDACTED***" },
    });
    expect(res.body.approval).toBeUndefined();
  });

  it("keeps legacy detail and list routes on the redacted summary contract", async () => {
    const summary = {
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: { apiKey: "secret-token", safe: "value" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-05-14T00:00:00.000Z"),
      updatedAt: new Date("2026-05-14T00:05:00.000Z"),
    };
    mockApprovalService.getById.mockResolvedValue(summary);
    mockApprovalService.list.mockResolvedValue([summary]);

    const app = createApp();
    const [detailRes, listRes] = await Promise.all([
      request(app).get("/api/approvals/approval-1"),
      request(app).get("/api/companies/company-1/approvals"),
    ]);

    expect(detailRes.status).toBe(200);
    expect(detailRes.body).toMatchObject({
      id: "approval-1",
      payload: { apiKey: "***REDACTED***", safe: "value" },
    });
    expect(detailRes.body.request).toBeUndefined();

    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual([
      expect.objectContaining({
        id: "approval-1",
        payload: { apiKey: "***REDACTED***", safe: "value" },
      }),
    ]);
  });
});
