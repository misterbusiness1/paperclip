import { randomUUID } from "node:crypto";
import type { IssueWorkProduct } from "@paperclipai/shared";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";

type GitHubHeadCheckState = "passed" | "pending" | "failed" | "no_evidence";
type GitHubHeadCheckSource = "commit_status" | "workflow_run" | "pr_comment" | "none";

type GitHubHeadCheck = {
  state: GitHubHeadCheckState;
  source: GitHubHeadCheckSource;
  repoFullName: string | null;
  prNumber: number | null;
  headSha: string | null;
  url: string | null;
  summary: string;
};

type IssueToolContext = {
  id: string;
  companyId: string;
  projectId: string | null;
};

type ToolDescriptor = Pick<ReturnType<PluginToolDispatcher["listToolsForAgent"]>[number], "name">;
type MinimalToolDispatcher = Pick<PluginToolDispatcher, "listToolsForAgent" | "executeTool">;

type PullRequestRef = {
  repoFullName: string;
  prNumber: number;
  headSha: string | null;
};

const GITHUB_PR_URL_RE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/i;
const PASS_RE = /\b(pass(?:ed|ing)?|green|clear|success(?:ful|fully)?|succeed(?:ed|ing)?)\b/i;
const PENDING_RE = /\b(pending|queued|queueing|running|waiting|in[\s_-]?progress)\b/i;
const FAIL_RE = /\b(fail(?:ed|ure|ing)?|error|red|blocked|broken|cancelled|canceled|timed[\s_-]?out)\b/i;
const NO_EVIDENCE_RE = /\b(no[\s_-]?evidence|no[\s_-]?checks?|native[\s_-]?checks? empty)\b/i;
const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const FAILED_CONCLUSIONS = new Set(["action_required", "cancelled", "failure", "startup_failure", "stale", "timed_out"]);
const PENDING_STATUSES = new Set(["in_progress", "pending", "queued", "requested", "waiting"]);
const SUCCESS_STATUS_STATES = new Set(["success", "passed"]);
const FAILED_STATUS_STATES = new Set(["error", "failed", "failure"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toBareToolName(name: string): string {
  const lastColon = name.lastIndexOf(":");
  const lastDot = name.lastIndexOf(".");
  const start = Math.max(lastColon, lastDot);
  return start >= 0 ? name.slice(start + 1) : name;
}

function buildNoEvidence(input: {
  repoFullName: string | null;
  prNumber: number | null;
  headSha: string | null;
  summary: string;
}): GitHubHeadCheck {
  return {
    state: "no_evidence",
    source: "none",
    repoFullName: input.repoFullName,
    prNumber: input.prNumber,
    headSha: input.headSha,
    url: null,
    summary: input.summary,
  };
}

function mergeMetadata(
  workProduct: IssueWorkProduct,
  githubHeadCheck: GitHubHeadCheck,
): IssueWorkProduct {
  return {
    ...workProduct,
    metadata: {
      ...(workProduct.metadata ?? {}),
      githubHeadCheck,
    },
  };
}

function resolvePullRequestRef(workProduct: IssueWorkProduct): PullRequestRef | null {
  if (workProduct.type !== "pull_request" || workProduct.provider !== "github") return null;

  const metadata = asRecord(workProduct.metadata);
  const github = asRecord(metadata?.github);
  const repoFullName =
    asString(metadata?.repoFullName)
    ?? asString(metadata?.githubRepoFullName)
    ?? asString(github?.repoFullName);
  const prNumber =
    asNumber(metadata?.prNumber)
    ?? asNumber(metadata?.githubPrNumber)
    ?? asNumber(github?.prNumber);
  const headSha =
    asString(metadata?.headSha)
    ?? asString(metadata?.githubHeadSha)
    ?? asString(github?.headSha)
    ?? null;

  if (repoFullName && prNumber) {
    return { repoFullName, prNumber, headSha };
  }

  const url = asString(workProduct.url);
  if (!url) return null;
  const match = url.match(GITHUB_PR_URL_RE);
  if (!match) return null;
  return {
    repoFullName: match[1]!,
    prNumber: Number.parseInt(match[2]!, 10),
    headSha,
  };
}

function mapCombinedStatusState(payload: Record<string, unknown> | null): GitHubHeadCheckState | null {
  if (!payload) return null;
  const topLevelState = asString(payload.state)?.toLowerCase() ?? null;
  const statuses = Array.isArray(payload.statuses) ? payload.statuses : [];

  for (const statusRaw of statuses) {
    const status = asRecord(statusRaw);
    const state = asString(status?.state)?.toLowerCase() ?? null;
    if (state && FAILED_STATUS_STATES.has(state)) return "failed";
  }
  for (const statusRaw of statuses) {
    const status = asRecord(statusRaw);
    const state = asString(status?.state)?.toLowerCase() ?? null;
    if (state && PENDING_STATUSES.has(state)) return "pending";
  }
  if (statuses.length > 0) return "passed";

  if (!topLevelState) return null;
  if (FAILED_STATUS_STATES.has(topLevelState)) return "failed";
  if (PENDING_STATUSES.has(topLevelState)) return "pending";
  if (SUCCESS_STATUS_STATES.has(topLevelState)) return "passed";
  return null;
}

function mapWorkflowRunsState(payload: Record<string, unknown> | null): GitHubHeadCheckState | null {
  if (!payload) return null;
  const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
  if (runs.length === 0) return null;

  for (const runRaw of runs) {
    const run = asRecord(runRaw);
    const status = asString(run?.status)?.toLowerCase() ?? null;
    if (status && PENDING_STATUSES.has(status)) return "pending";
  }
  for (const runRaw of runs) {
    const run = asRecord(runRaw);
    const conclusion = asString(run?.conclusion)?.toLowerCase() ?? null;
    if (conclusion && FAILED_CONCLUSIONS.has(conclusion)) return "failed";
  }
  for (const runRaw of runs) {
    const run = asRecord(runRaw);
    const conclusion = asString(run?.conclusion)?.toLowerCase() ?? null;
    if (conclusion && SUCCESS_CONCLUSIONS.has(conclusion)) return "passed";
  }
  return null;
}

function commentReferencesHeadSha(body: string, headSha: string): boolean {
  const escapedHeadSha = headSha.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b${escapedHeadSha}\\b`, "i").test(body)) return true;
  const shortHeadSha = headSha.slice(0, 7);
  return shortHeadSha.length >= 7 && new RegExp(`\\b${shortHeadSha}\\b`, "i").test(body);
}

function mapCommentState(body: string): GitHubHeadCheckState | null {
  if (NO_EVIDENCE_RE.test(body)) return "no_evidence";
  if (FAIL_RE.test(body)) return "failed";
  if (PENDING_RE.test(body)) return "pending";
  if (PASS_RE.test(body)) return "passed";
  return null;
}

function resolveCommentFallback(payload: Record<string, unknown> | null, headSha: string) {
  if (!payload) return null;
  const comments = Array.isArray(payload.comments) ? payload.comments : [];

  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = asRecord(comments[index]);
    const body = asString(comment?.body) ?? asString(comment?.comment) ?? asString(comment?.text);
    if (!body || !commentReferencesHeadSha(body, headSha)) continue;
    const state = mapCommentState(body);
    if (!state) continue;
    return {
      state,
      url: asString(comment?.html_url) ?? asString(comment?.url) ?? null,
      summary: state === "no_evidence"
        ? `PR comment references ${headSha.slice(0, 7)} but reports no evidence.`
        : `PR comment references ${headSha.slice(0, 7)} and reports ${state}.`,
    };
  }

  return null;
}

async function executeToolData(
  dispatcher: MinimalToolDispatcher,
  toolName: string | null,
  params: Record<string, unknown>,
  runContext: ToolRunContext,
): Promise<Record<string, unknown> | null> {
  if (!toolName) return null;
  try {
    const response = await dispatcher.executeTool(toolName, params, runContext);
    if (response.result?.error) return null;
    return asRecord(response.result?.data);
  } catch {
    return null;
  }
}

function findToolName(tools: ToolDescriptor[], candidates: string[]): string | null {
  const wanted = new Set(candidates);
  for (const tool of tools) {
    const bare = toBareToolName(tool.name);
    if (wanted.has(bare)) return tool.name;
  }
  return null;
}

export function createGitHubPrHeadCheckService(toolDispatcher?: MinimalToolDispatcher | null) {
  function resolveToolNames() {
    if (!toolDispatcher) return null;
    const tools = toolDispatcher.listToolsForAgent();
    return {
      getPrInfo: findToolName(tools, ["_get_pr_info", "get_pr_info"]),
      getCommitCombinedStatus: findToolName(tools, ["_get_commit_combined_status", "get_commit_combined_status"]),
      fetchCommitWorkflowRuns: findToolName(tools, ["_fetch_commit_workflow_runs", "fetch_commit_workflow_runs"]),
      fetchPrComments: findToolName(tools, ["_fetch_pr_comments", "fetch_pr_comments"]),
    };
  }

  async function enrichOne(
    issue: IssueToolContext,
    workProduct: IssueWorkProduct,
  ): Promise<IssueWorkProduct> {
    const prRef = resolvePullRequestRef(workProduct);
    const toolNames = resolveToolNames();
    if (!prRef || !toolDispatcher || !toolNames?.getPrInfo) return workProduct;

    const runContext: ToolRunContext = {
      agentId: issue.id,
      runId: randomUUID(),
      companyId: issue.companyId,
      projectId: issue.projectId ?? issue.id,
    };

    const prInfo = await executeToolData(
      toolDispatcher,
      toolNames.getPrInfo,
      {
        repository_full_name: prRef.repoFullName,
        pr_number: prRef.prNumber,
      },
      runContext,
    );

    const repoFullName = asString(prInfo?.repository_full_name) ?? prRef.repoFullName;
    const prNumber = asNumber(prInfo?.pr_number) ?? prRef.prNumber;
    const headSha = asString(prInfo?.head_sha) ?? prRef.headSha;

    if (!headSha) {
      return mergeMetadata(workProduct, buildNoEvidence({
        repoFullName,
        prNumber,
        headSha: null,
        summary: "GitHub PR head SHA could not be determined.",
      }));
    }

    const combinedStatus = await executeToolData(
      toolDispatcher,
      toolNames.getCommitCombinedStatus,
      {
        repo_full_name: repoFullName,
        commit_sha: headSha,
      },
      runContext,
    );
    const combinedState = mapCombinedStatusState(combinedStatus);
    if (combinedState) {
      return mergeMetadata(workProduct, {
        state: combinedState,
        source: "commit_status",
        repoFullName,
        prNumber,
        headSha,
        url: null,
        summary: `GitHub commit status resolved ${combinedState} for ${headSha.slice(0, 7)}.`,
      });
    }

    const workflowRuns = await executeToolData(
      toolDispatcher,
      toolNames.fetchCommitWorkflowRuns,
      {
        repo_full_name: repoFullName,
        commit_sha: headSha,
      },
      runContext,
    );
    const workflowState = mapWorkflowRunsState(workflowRuns);
    if (workflowState) {
      return mergeMetadata(workProduct, {
        state: workflowState,
        source: "workflow_run",
        repoFullName,
        prNumber,
        headSha,
        url: null,
        summary: `GitHub workflow runs resolved ${workflowState} for ${headSha.slice(0, 7)}.`,
      });
    }

    const prComments = await executeToolData(
      toolDispatcher,
      toolNames.fetchPrComments,
      {
        repo_full_name: repoFullName,
        pr_number: prNumber,
      },
      runContext,
    );
    const commentFallback = resolveCommentFallback(prComments, headSha);
    if (commentFallback) {
      return mergeMetadata(workProduct, {
        state: commentFallback.state,
        source: "pr_comment",
        repoFullName,
        prNumber,
        headSha,
        url: commentFallback.url,
        summary: commentFallback.summary,
      });
    }

    return mergeMetadata(workProduct, buildNoEvidence({
      repoFullName,
      prNumber,
      headSha,
      summary: `No GitHub head-check evidence found for ${headSha.slice(0, 7)}.`,
    }));
  }

  return {
    enrichForIssue: async (
      issue: IssueToolContext,
      workProducts: IssueWorkProduct[],
    ): Promise<IssueWorkProduct[]> => Promise.all(workProducts.map((workProduct) => enrichOne(issue, workProduct))),
  };
}
