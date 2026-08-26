import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

describe("patched codex-acp error handling", () => {
  it("fails a non-retryable structured error and leaves retrying errors non-terminal", async () => {
    const bundle = await fs.readFile(createRequire(import.meta.url).resolve("@agentclientprotocol/codex-acp"), "utf8");
    const marker = "  async createErrorEvent(params) {";
    const methodStart = bundle.indexOf(marker);
    const methodEnd = bundle.indexOf("\n  isAuthenticationRequiredError", methodStart);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(methodEnd).toBeGreaterThan(methodStart);
    const method = bundle.slice(methodStart, methodEnd);
    const body = method.slice(marker.length, method.lastIndexOf("\n  }"));
    const createErrorEvent = new Function(
      "RequestError",
      "createAgentTextMessageChunk",
      `return async function(params) {${body}}`,
    )(
      { internalError: (data: unknown) => ({ kind: "internal", data }) },
      (text: string) => ({ text }),
    ) as (this: Record<string, unknown>, params: Record<string, unknown>) => Promise<unknown>;
    const context = {
      failure: null,
      sessionState: { authConfigured: true },
      createCodexSessionInfoUpdate: (value: unknown) => value,
      createTurnErrorData: (error: unknown) => error,
      isAuthenticationRequiredError: () => false,
    };
    const error = { message: "provider rejected request", codexErrorInfo: null, additionalDetails: null };

    await createErrorEvent.call(context, { willRetry: false, error });
    expect(context.failure).toEqual({ kind: "internal", data: error });

    context.failure = null;
    await createErrorEvent.call(context, { willRetry: true, turnId: "turn-1", error });
    expect(context.failure).toBeNull();
  });
});
