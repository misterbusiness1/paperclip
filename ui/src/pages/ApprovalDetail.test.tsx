// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDetail } from "./ApprovalDetail";

const approvalsApiMock = vi.hoisted(() => ({
  get: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
  requestRevision: vi.fn(),
  resubmit: vi.fn(),
  listComments: vi.fn(),
  listIssues: vi.fn(),
  addComment: vi.fn(),
}));

const agentsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const accessApiMock = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

const navigateMock = vi.hoisted(() => vi.fn());
const setSelectedCompanyIdMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

let currentSearch = "";

vi.mock("../api/approvals", () => ({
  approvalsApi: approvalsApiMock,
}));

vi.mock("../api/agents", () => ({
  agentsApi: agentsApiMock,
}));

vi.mock("../api/access", () => ({
  accessApi: accessApiMock,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    setSelectedCompanyId: setSelectedCompanyIdMock,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: setBreadcrumbsMock,
  }),
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useNavigate: () => navigateMock,
  useParams: () => ({ approvalId: "approval-1" }),
  useSearchParams: () => [new URLSearchParams(currentSearch), vi.fn()],
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function approvalSummary(status: "pending" | "approved" | "revision_requested" = "pending") {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "request_board_approval",
    requestedByAgentId: "agent-1",
    requestedByUserId: null,
    status,
    payload: { title: "Legacy approval title", summary: "Legacy summary" },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-05-14T00:00:00.000Z"),
    updatedAt: new Date("2026-05-14T00:00:00.000Z"),
  };
}

describe("ApprovalDetail", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    currentSearch = "";

    approvalsApiMock.approve.mockResolvedValue(approvalSummary("approved"));
    approvalsApiMock.reject.mockResolvedValue(approvalSummary("approved"));
    approvalsApiMock.requestRevision.mockResolvedValue(approvalSummary("revision_requested"));
    approvalsApiMock.resubmit.mockResolvedValue(approvalSummary("pending"));
    approvalsApiMock.listComments.mockResolvedValue([]);
    approvalsApiMock.listIssues.mockResolvedValue([
      { id: "issue-1", identifier: "OXFA-1", title: "Linked issue" },
    ]);
    approvalsApiMock.addComment.mockResolvedValue({
      id: "comment-1",
      approvalId: "approval-1",
      companyId: "company-1",
      authorAgentId: null,
      authorUserId: "board-user",
      body: "Looks good.",
      createdAt: new Date("2026-05-14T00:01:00.000Z"),
      updatedAt: new Date("2026-05-14T00:01:00.000Z"),
    });

    agentsApiMock.list.mockResolvedValue([
      { id: "agent-1", name: "Plugin Engineer" },
    ]);

    accessApiMock.getCurrentBoardAccess.mockResolvedValue({
      user: null,
      userId: "board-user",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });
  });

  afterEach(async () => {
    root.unmount();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the refund v2 registry view without exposing raw payload by default", async () => {
    approvalsApiMock.get.mockResolvedValue({
      request: {
        actionType: "refund_partial",
        rationale: "Customer supplied photo evidence and prior support context matched the order.",
        confidence: 0.82,
        model: "gpt-5",
        runId: "run-123",
        toolTrace: JSON.stringify([
          { id: "tool-1", label: "Fetch order", status: "ok", detail: "Loaded order context" },
        ]),
      },
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      context: {
        order: { number: "1001", status: "processing", totalCents: 5500, currency: "USD" },
        customer: { name: "Ada Lovelace", email: "ada@example.com", ltvCents: 125000, priorRefundCount: 1 },
        gateway: { name: "Stripe", cardLast4: "4242" },
        thread: { channel: "email", subject: "Order 1001" },
      },
      requester: {
        agentId: "agent-1",
        agentName: "Plugin Engineer",
        userId: null,
        userName: null,
      },
      sideEffects: [{ label: "Refund $12.00 to card", detail: "Does not modify fulfillment." }],
      activity: [
        {
          id: "evt-1",
          kind: "created",
          description: "Approval requested",
          actorLabel: "Plugin Engineer",
          createdAt: "2026-05-14T00:00:00.000Z",
        },
      ],
      rawPayload: { apiKey: "***REDACTED***", orderNumber: "1001" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("refund_partial");
    expect(container.textContent).toContain("Partial refund");
    expect(container.textContent).toContain("$12.00");
    expect(container.textContent).toContain("Stripe");
    expect(container.textContent).toContain("Ada Lovelace");
    expect(container.textContent).toContain("Agent rationale");
    expect(container.textContent).toContain("Plugin Engineer");
    expect(container.textContent).toContain("Customer supplied photo evidence");
    expect(container.textContent).toContain("Fetch order");
    expect(container.textContent).toContain("Refund $12.00 to card");
    expect(container.textContent).not.toContain("No side-effect preview was provided.");
    expect(container.textContent).not.toContain("Debug payload");
    expect(container.textContent).not.toContain("apiKey");
  });

  it("renders restored reply recipient and message context from the hydrated v2 envelope", async () => {
    approvalsApiMock.get.mockResolvedValue({
      request: {
        actionType: "reply",
        title: "Reply to shipping complaint",
        summary: "Customer asked for a shipment update and tone-safe apology.",
        channel: "email",
      },
      id: "approval-2",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      context: {
        recipient: {
          name: "Ada Lovelace",
          address: "ada@example.com",
        },
        thread: {
          channel: "email",
          subject: "Where is order 1001?",
          id: "thread-77",
          customerName: "Ada Lovelace",
          orderNumber: "1001",
          originalMessage: "Checking in on the shipment for order 1001.",
          proposedReply: "Thanks for the follow-up. We have rechecked the carrier scan and your package is moving today.",
        },
      },
      requester: {
        agentId: "agent-1",
        agentName: "Plugin Engineer",
        userId: null,
        userName: null,
      },
      sideEffects: [],
      activity: [
        {
          id: "evt-2",
          kind: "created",
          description: "Approval requested",
          actorLabel: "Plugin Engineer",
          createdAt: "2026-05-14T00:00:00.000Z",
        },
      ],
      rawPayload: { threadId: "thread-77" },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Customer message reply");
    expect(container.textContent).toContain("Ada Lovelace");
    expect(container.textContent).toContain("ada@example.com");
    expect(container.textContent).toContain("Where is order 1001?");
    expect(container.textContent).toContain("Checking in on the shipment for order 1001.");
    expect(container.textContent).toContain("Thanks for the follow-up. We have rechecked the carrier scan and your package is moving today.");
    expect(container.textContent).not.toContain("Original message not provided.");
    expect(container.textContent).not.toContain("Proposed reply not provided.");
  });

  it("shows legacy fallback, unlocks debug payload for instance admins, and wires A/R/V/C shortcuts", async () => {
    currentSearch = "debug=1";
    accessApiMock.getCurrentBoardAccess.mockResolvedValue({
      user: null,
      userId: "board-user",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
    });
    approvalsApiMock.get.mockResolvedValue(approvalSummary());

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Legacy detail fallback active");
    expect(container.textContent).toContain("Debug payload");

    const debugToggle = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Debug payload"),
    );
    expect(debugToggle).toBeTruthy();

    debugToggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushReact();
    expect(container.textContent).toContain("Legacy approval title");

    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    await flushReact();
    expect(document.activeElement).toBe(textarea);

    textarea?.blur();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "v", bubbles: true }));
    await flushReact();

    expect(approvalsApiMock.approve).toHaveBeenCalledWith("approval-1");
    expect(approvalsApiMock.reject).toHaveBeenCalledWith("approval-1");
    expect(approvalsApiMock.requestRevision).toHaveBeenCalledWith("approval-1");
  });

  it("renders restored reply detail fields in the structured reply view", async () => {
    approvalsApiMock.get.mockResolvedValue({
      request: {
        actionType: "reply",
        title: "Reply to customer about order 1001",
        summary: "Board review is required before sending the message.",
        proposedReply: "We can ship a replacement today.",
        originalMessage: "My order arrived damaged. What can you do?",
        channel: "email",
        rationale: "The support agent drafted a replacement offer based on order history.",
        confidence: 0.91,
        model: "gpt-5",
        runId: "run-456",
        toolTrace: JSON.stringify([{ id: "tool-2", label: "Load thread", status: "ok", detail: "Loaded email thread" }]),
      },
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      context: {
        recipient: { name: "Ada Lovelace", address: "ada@example.com" },
        thread: {
          id: "thread-1001",
          channel: "email",
          subject: "Order 1001",
          customerName: "Ada Lovelace",
          orderNumber: "1001",
          originalMessage: "My order arrived damaged. What can you do?",
          proposedReply: "We can ship a replacement today.",
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
      rawPayload: {},
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Customer message reply");
    expect(container.textContent).toContain("Ada Lovelace");
    expect(container.textContent).toContain("ada@example.com");
    expect(container.textContent).toContain("Order 1001");
    expect(container.textContent).toContain("My order arrived damaged. What can you do?");
    expect(container.textContent).toContain("We can ship a replacement today.");
    expect(container.textContent).toContain("Load thread");
  });

  it("uses sanitized raw payload fallbacks when Sevalla serves a partial hydrated envelope", async () => {
    approvalsApiMock.get.mockResolvedValue({
      request: {
        actionType: "refund_partial",
        title: "Partial refund for order 1001",
        summary: "Hydrated request exists, but detail richness still depends on payload fallback.",
      },
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      context: {
        order: { number: "1001", status: "processing", totalCents: 5500, currency: "USD" },
        gateway: { name: "Stripe", cardLast4: "4242" },
        thread: { channel: "email", subject: "Order 1001" },
      },
      requester: {
        agentId: "agent-1",
        agentName: "Plugin Engineer",
        userId: null,
        userName: null,
      },
      sideEffects: [],
      activity: [],
      rawPayload: {
        amountCents: 1200,
        currency: "USD",
        sideEffects: [{ label: "Refund $12.00 to card", detail: "Does not modify fulfillment." }],
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Refund $12.00 to card");
    expect(container.textContent).not.toContain("No side-effect preview was provided.");
  });

  it("restores reply recipient and message fields from sanitized payload fallbacks", async () => {
    approvalsApiMock.get.mockResolvedValue({
      request: {
        actionType: "reply",
        title: "Reply to shipping complaint",
        summary: "Thread summary still hydrates even when recipient/message fields lag behind.",
        channel: "email",
      },
      id: "approval-2",
      companyId: "company-1",
      type: "request_board_approval",
      status: "pending",
      context: {
        thread: {
          channel: "email",
          subject: "Where is order 1001?",
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
      rawPayload: {
        recipient: {
          name: "Ada Lovelace",
          email: "ada@example.com",
        },
        thread: {
          id: "thread-77",
          customerName: "Ada Lovelace",
          orderNumber: "1001",
          originalMessage: "Checking in on the shipment for order 1001.",
          proposedReply: "Thanks for the follow-up. We have rechecked the carrier scan and your package is moving today.",
        },
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ApprovalDetail />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Ada Lovelace");
    expect(container.textContent).toContain("ada@example.com");
    expect(container.textContent).toContain("Checking in on the shipment for order 1001.");
    expect(container.textContent).toContain(
      "Thanks for the follow-up. We have rechecked the carrier scan and your package is moving today.",
    );
    expect(container.textContent).not.toContain("Original message not provided.");
    expect(container.textContent).not.toContain("Proposed reply not provided.");
  });
});
