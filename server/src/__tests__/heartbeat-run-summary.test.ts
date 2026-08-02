import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  mergeHeartbeatRunResultJson,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });

  it("redacts credential-bearing GitHub HTTPS remote URLs from summarized result fields", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "remote https://synthetic-user:synthetic-pass@github.com/paperclipai/paperclip.git",
    });

    expect(summary?.summary).toBe("remote https://***REDACTED***@github.com/paperclipai/paperclip.git");
    expect(JSON.stringify(summary)).not.toContain("synthetic-user");
    expect(JSON.stringify(summary)).not.toContain("synthetic-pass");
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe("completed");
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });

  it("redacts credential-bearing GitHub HTTPS remote URLs from issue comments", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "pushed https://synthetic-user:synthetic-pass@github.com/paperclipai/paperclip.git",
    });

    expect(comment).toBe("pushed https://***REDACTED***@github.com/paperclipai/paperclip.git");
    expect(comment).not.toContain("synthetic-user");
    expect(comment).not.toContain("synthetic-pass");
  });
});

describe("mergeHeartbeatRunResultJson", () => {
  it("adds adapter summaries into stored result json for comment posting", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "raw stdout", stderr: "" },
      "## Summary\n\n1. first thing\n2. second thing",
    );

    expect(merged).toEqual({
      stdout: "raw stdout",
      stderr: "",
      summary: "## Summary\n\n1. first thing\n2. second thing",
    });
    expect(buildHeartbeatRunIssueComment(merged)).toBe("## Summary\n\n1. first thing\n2. second thing");
  });

  it("creates a result payload when only a summary exists", () => {
    expect(mergeHeartbeatRunResultJson(null, "done")).toEqual({ summary: "done" });
  });

  it("redacts credential-bearing GitHub HTTPS remote URLs before run result persistence", () => {
    const merged = mergeHeartbeatRunResultJson(
      {
        result: "clone https://synthetic-user:synthetic-pass@github.com/paperclipai/paperclip.git",
        nested: {
          message: "mirror https://synthetic-token@github.com/paperclipai/private-repo",
        },
      },
      null,
    );

    expect(merged?.result).toBe("clone https://***REDACTED***@github.com/paperclipai/paperclip.git");
    expect(JSON.stringify(merged)).not.toContain("synthetic-user");
    expect(JSON.stringify(merged)).not.toContain("synthetic-pass");
    expect(JSON.stringify(merged)).not.toContain("synthetic-token");
  });

  it("does not overwrite an explicit summary already returned by the adapter", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "adapter result", stdout: "raw stdout" },
        "fallback summary",
      ),
    ).toEqual({
      summary: "adapter result",
      stdout: "raw stdout",
    });
  });
});
