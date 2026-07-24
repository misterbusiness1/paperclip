import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

export const HTTP_LOG_REDACTED = "[REDACTED]";

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-paperclip-api-key",
  "x-paperclip-cloud-tenant-token",
  "x-xsrf-token",
  "x-openclaw-token",
  "x-amz-security-token",
]);

const SENSITIVE_HEADER_NAME_RE = /(?:^|[-_])(?:api[-_]?key|auth(?:orization)?|bearer|cookie|csrf|secret|session|token|xsrf)(?:$|[-_])/i;

function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(normalized) || SENSITIVE_HEADER_NAME_RE.test(normalized);
}

export function redactHttpHeaders<T extends IncomingHttpHeaders | OutgoingHttpHeaders | undefined>(headers: T): T {
  if (!headers || typeof headers !== "object") return headers;

  const redacted: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = isSensitiveHeaderName(name) ? HTTP_LOG_REDACTED : value;
  }
  return redacted as T;
}
