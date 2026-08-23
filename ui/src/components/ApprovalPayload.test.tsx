// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalCard } from "./ApprovalCard";
import {
  ApprovalPayloadRenderer,
  approvalDecisionBrief,
  approvalExcerpt,
  approvalLabel,
  isEmailReplyPayload,
} from "./ApprovalPayload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("approvalLabel", () => {
  it("uses payload titles for generic board approvals", () => {
    expect(
      approvalLabel("request_board_approval", {
        title: "Reply with an ASCII frog",
      }),
    ).toBe("Board Approval: Reply with an ASCII frog");
  });
});

describe("approvalDecisionBrief", () => {
  it("normalizes explicit reasoning, benefits, and tradeoffs without duplicates", () => {
    expect(
      approvalDecisionBrief({
        recommendedAction: "Approve the bounded test.",
        rationale: "It isolates the decision.",
        benefits: ["Fast feedback", "Fast feedback", "  Reversible  "],
        risks: ["May miss a long-tail case"],
        riskAssessment: "Rollback must remain available",
        tradeoffs: "Requires one follow-up check",
        nextActionOnApproval: "Run the dry test.",
      }),
    ).toEqual({
      recommendation: "Approve the bounded test.",
      reasoning: "It isolates the decision.",
      pros: ["Fast feedback", "Reversible"],
      cons: [
        "May miss a long-tail case",
        "Rollback must remain available",
        "Requires one follow-up check",
      ],
      nextAction: "Run the dry test.",
    });
  });

  it("uses the summary as reasoning when no explicit rationale is supplied", () => {
    expect(approvalDecisionBrief({ summary: "A concise decision summary." }).reasoning).toBe(
      "A concise decision summary.",
    );
  });
});

describe("approvalExcerpt", () => {
  it("removes lightweight markdown and truncates at a word boundary", () => {
    expect(approvalExcerpt("**Approve:** [Run the bounded check](https://example.test) now.", 32)).toBe(
      "Approve: Run the bounded check…",
    );
  });

  it("preserves order numbers and comparison symbols", () => {
    expect(approvalExcerpt("Order #90210: margin > cost")).toBe("Order #90210: margin > cost");
  });
});

describe("ApprovalCard", () => {
  it("labels missing legacy benefits instead of hiding or inventing them", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalCard
          approval={{
            id: "approval-legacy",
            companyId: "company-1",
            type: "request_board_approval",
            requestedByAgentId: null,
            requestedByUserId: null,
            status: "pending",
            payload: { title: "Legacy decision" },
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            createdAt: new Date("2026-03-11T09:00:00.000Z"),
            updatedAt: new Date("2026-03-11T09:00:00.000Z"),
          } satisfies Approval}
          requesterAgent={null}
        />,
      );
    });

    expect(container.textContent).toContain("BenefitNot supplied.");
    expect(container.textContent).toContain("TradeoffNot supplied.");
    act(() => root.unmount());
    container.remove();
  });
});

describe("isEmailReplyPayload", () => {
  it("detects email replies by a body plus at least one envelope field", () => {
    expect(isEmailReplyPayload({ body: "Hi there", subject: "Re: order #90210" })).toBe(true);
    expect(isEmailReplyPayload({ body: "Hi there", recipient: "a@example.com" })).toBe(true);
    expect(isEmailReplyPayload({ body: "Hi there", channel: "email from info@" })).toBe(true);
  });

  it("ignores payloads without a body or without an envelope field", () => {
    expect(isEmailReplyPayload({ subject: "Re: order #90210", recipient: "a@example.com" })).toBe(false);
    expect(isEmailReplyPayload({ body: "Hi there" })).toBe(false);
    expect(isEmailReplyPayload({ body: "   ", subject: "Re: order #90210" })).toBe(false);
    expect(isEmailReplyPayload({})).toBe(false);
    expect(isEmailReplyPayload(null)).toBe(false);
  });
});

describe("ApprovalPayloadRenderer", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders request_board_approval payload fields without falling back to raw JSON", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
            reasoning: "The bounded reply is reversible and has no external side effects.",
            recommendedAction: "Approve the frog reply.",
            nextActionOnApproval: "Post the frog comment on the issue.",
            pros: ["The reply is clear and scoped."],
            risks: "The frog might be too powerful.",
            proposedComment: "(o)<",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Reply with an ASCII frog");
    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).toContain("The bounded reply is reversible and has no external side effects.");
    expect(container.textContent).toContain("Approve the frog reply.");
    expect(container.textContent).toContain("Post the frog comment on the issue.");
    expect(container.textContent).toContain("Pros");
    expect(container.textContent).toContain("The reply is clear and scoped.");
    expect(container.textContent).toContain("Cons & risks");
    expect(container.textContent).toContain("The frog might be too powerful.");
    expect(container.textContent).toContain("(o)<");
    expect(container.textContent).not.toContain("\"recommendedAction\"");

    act(() => {
      root.unmount();
    });
  });

  it("renders an email-reply approval as an email preview with reasoning beneath", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          payload={{
            title: "Gate B approval: info@ reply for order #90210",
            channel: "email from info@",
            recipient: "Marcus Bellweather <m@example.com>",
            subject: "Update on Oxford Cigar order #90210",
            threadOrOrderRef: "WooCommerce order #90210",
            gate: "Gate B",
            intent: "Hold-vs-cancel choice for backordered Padrón lines.",
            recommendedAction: "Send as written.",
            pros: ["The customer gets a direct choice."],
            risks: "Customer may expect a firm restock date.",
            body: "Hi Marcus,\n\nThank you for your order #90210. The three boxes are briefly on backorder.",
          }}
        />,
      );
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Update on Oxford Cigar order #90210");
    expect(text).toContain("Marcus Bellweather <m@example.com>");
    expect(text).toContain("email from info@");
    expect(text).toContain("WooCommerce order #90210");
    expect(text).toContain("Gate B");
    expect(text).toContain("Hi Marcus,");
    expect(text).toContain("Thank you for your order #90210.");
    expect(text).not.toContain("\"body\":");
    expect(text).toContain("Hold-vs-cancel choice for backordered Padrón lines.");
    expect(text).toContain("Send as written.");
    expect(text).toContain("The customer gets a direct choice.");
    expect(text).toContain("Customer may expect a firm restock date.");

    act(() => {
      root.unmount();
    });
  });

  it("can hide the repeated title when the card header already shows it", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <ApprovalPayloadRenderer
          type="request_board_approval"
          hidePrimaryTitle
          payload={{
            title: "Reply with an ASCII frog",
            summary: "Board asked for approval before posting the frog.",
          }}
        />,
      );
    });

    expect(container.textContent).toContain("Board asked for approval before posting the frog.");
    expect(container.textContent).not.toContain("TitleReply with an ASCII frog");

    act(() => {
      root.unmount();
    });
  });
});
