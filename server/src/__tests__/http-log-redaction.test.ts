import { describe, expect, it } from "vitest";
import { HTTP_LOG_REDACTED, redactHttpHeaders } from "../middleware/http-log-redaction.js";

describe("HTTP log header redaction", () => {
  it("redacts sensitive request and response header values while preserving operational metadata", () => {
    const headers = redactHttpHeaders({
      authorization: "Bearer secret-token",
      cookie: "paperclip_session=session-secret",
      "set-cookie": ["paperclip_session=session-secret"],
      "x-api-key": "api-key-secret",
      "x-auth-token": "auth-token-secret",
      "x-paperclip-api-key": "paperclip-api-key-secret",
      "x-paperclip-cloud-tenant-token": "cloud-tenant-token-secret",
      "x-csrf-token": "csrf-secret",
      "x-xsrf-token": "xsrf-secret",
      "x-openclaw-token": "gateway-secret",
      "x-custom-session-id": "session-secret",
      "x-custom-bearer-metadata": "bearer-secret",
      "x-paperclip-run-id": "run-123",
      "x-paperclip-issue-id": "issue-123",
      "x-request-id": "request-123",
      "user-agent": "supertest",
      host: "127.0.0.1:3000",
    });

    expect(headers).toMatchObject({
      authorization: HTTP_LOG_REDACTED,
      cookie: HTTP_LOG_REDACTED,
      "set-cookie": HTTP_LOG_REDACTED,
      "x-api-key": HTTP_LOG_REDACTED,
      "x-auth-token": HTTP_LOG_REDACTED,
      "x-paperclip-api-key": HTTP_LOG_REDACTED,
      "x-paperclip-cloud-tenant-token": HTTP_LOG_REDACTED,
      "x-csrf-token": HTTP_LOG_REDACTED,
      "x-xsrf-token": HTTP_LOG_REDACTED,
      "x-openclaw-token": HTTP_LOG_REDACTED,
      "x-custom-session-id": HTTP_LOG_REDACTED,
      "x-custom-bearer-metadata": HTTP_LOG_REDACTED,
      "x-paperclip-run-id": "run-123",
      "x-paperclip-issue-id": "issue-123",
      "x-request-id": "request-123",
      "user-agent": "supertest",
      host: "127.0.0.1:3000",
    });

    expect(JSON.stringify(headers)).not.toContain("secret");
  });
});
