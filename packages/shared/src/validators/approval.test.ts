import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";

const validGateAPayload = {
  gate: "gate_a",
  actionType: "refund_full",
  currency: "USD",
  wooCommerceTransactionRef: "wc-order-1001:txn-2002",
  reason: {
    code: "customer_request",
    description: "Customer requested a full refund before fulfillment.",
  },
};

const validGateBPayload = {
  gate: "gate_b",
  channel: "email",
  contentType: "text/plain",
  body: "Send the approved customer response.",
  bodyHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  threadRef: {
    ticketId: "ticket-1001",
    orderRef: "order-2002",
  },
  priority: "high",
  slaDeadline: "2026-08-04T12:00:00.000Z",
  contextPulled: {
    at: "2026-08-03T12:00:00.000Z",
    sources: ["gmail:thread-1001"],
  },
  risks: [
    {
      code: "customer_confusion",
      description: "Customer may need clarification about refund timing.",
    },
  ],
};

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body).toBe(
      "Looks good\n\nApproved.",
    );
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote).toBe(
      "Decision\n\nApproved.",
    );
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body).toBe(
      "Looks good\n\nApproved.",
    );
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote).toBe(
      "Decision\n\nApproved.",
    );
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote).toBe(
      "Decision\nRevise.",
    );
  });

  it("accepts representative Gate A board approval payloads", () => {
    const parsed = createApprovalSchema.parse({
      type: "request_board_approval",
      requestedByAgentId: "00000000-0000-0000-0000-000000000001",
      payload: validGateAPayload,
    });

    expect(parsed.type).toBe("request_board_approval");
    expect(parsed.payload.gate).toBe("gate_a");
  });

  it("rejects malformed Gate A board approval payloads with field-specific errors", () => {
    const result = createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: {
        ...validGateAPayload,
        actionType: "invalid_action",
        currency: "usd",
        wooCommerceTransactionRef: "",
        reason: { code: "unknown", description: "" },
      },
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["payload", "actionType"] }),
        expect.objectContaining({ path: ["payload", "currency"] }),
        expect.objectContaining({ path: ["payload", "wooCommerceTransactionRef"] }),
        expect.objectContaining({ path: ["payload", "reason", "code"] }),
        expect.objectContaining({ path: ["payload", "reason", "description"] }),
      ]),
    );
  });

  it("accepts representative Gate B board approval payloads", () => {
    const parsed = createApprovalSchema.parse({
      type: "request_board_approval",
      payload: validGateBPayload,
    });

    expect(parsed.type).toBe("request_board_approval");
    expect(parsed.payload.gate).toBe("gate_b");
  });

  it("rejects arbitrary request_board_approval payloads", () => {
    const result = createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: { title: "Approve something" },
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["payload", "gate"] })]),
    );
  });
});
