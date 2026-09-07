#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { classifyAlertAccess, classifyBotReview, classifyProtection, gapRecords } from "./classify.mjs";

const SCHEMA_VERSION = "1.0.0";
const args = parseArgs(process.argv.slice(2));
const observedAt = args.observedAt ?? new Date().toISOString();
const startedAt = new Date().toISOString();

function parseArgs(argv) {
  const result = { output: "fleet-cqe-coverage.v1.json", summary: "fleet-cqe-coverage.md", prLimit: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--output") result.output = argv[++i];
    else if (key === "--summary") result.summary = argv[++i];
    else if (key === "--collector-sha") result.collectorSha = argv[++i];
    else if (key === "--run-issue") result.runIssue = argv[++i];
    else if (key === "--repository-owner") result.repositoryOwner = argv[++i];
    else if (key === "--observed-at") result.observedAt = argv[++i];
    else if (key === "--pr-limit") result.prLimit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!result.collectorSha || !/^[0-9a-f]{40}$/.test(result.collectorSha)) throw new Error("--collector-sha must be a full commit SHA");
  if (!result.runIssue) throw new Error("--run-issue is required");
  if (!result.repositoryOwner || !/^[A-Za-z0-9-]+$/.test(result.repositoryOwner)) throw new Error("--repository-owner is required");
  if (!Number.isInteger(result.prLimit) || result.prLimit < 1 || result.prLimit > 500) throw new Error("--pr-limit must be 1..500");
  return result;
}

function gh(endpoint, { method = "GET", allow = [] } = {}) {
  try {
    const stdout = execFileSync("gh", ["api", "--method", method, "-H", "Accept: application/vnd.github+json", endpoint], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return { status: method === "GET" && endpoint.endsWith("/vulnerability-alerts") ? 204 : 200, data: stdout.trim() ? JSON.parse(stdout) : null };
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    const match = stderr.match(/HTTP (\d{3})/);
    const status = match ? Number(match[1]) : 0;
    if (allow.includes(status)) return { status, data: null };
    throw new Error(`GitHub API ${endpoint} failed (${status || "runtime"})`);
  }
}

function listInstalledRepositories() {
  const result = execFileSync("gh", ["repo", "list", args.repositoryOwner, "--limit", "100", "--json", "nameWithOwner,defaultBranchRef,url"], { encoding: "utf8" });
  return JSON.parse(result).map((repo) => ({
    repository: repo.nameWithOwner,
    owner: repo.nameWithOwner.split("/", 1)[0],
    default_branch: repo.defaultBranchRef?.name,
    html_url: repo.url,
  })).sort((a, b) => a.repository.localeCompare(b.repository));
}

function getJsonContent(repo, path) {
  const response = gh(`/repos/${repo}/contents/${path}`, { allow: [403, 404] });
  if (response.status !== 200 || !response.data?.content) return null;
  try { return JSON.parse(Buffer.from(response.data.content, "base64").toString("utf8")); } catch { return null; }
}

function dependencyCoverage(repo) {
  const composer = gh(`/repos/${repo}/contents/composer.lock`, { allow: [403, 404] });
  if (composer.status === 200) return { state: "pass", detail: "composer_audit_executable", evidence: "composer.lock" };
  const npm = gh(`/repos/${repo}/contents/package-lock.json`, { allow: [403, 404] });
  if (npm.status === 200) return { state: "pass", detail: "npm_audit_executable", evidence: "package-lock.json" };
  const packageJson = getJsonContent(repo, "package.json");
  if (packageJson?.scripts?.audit) return { state: "pass", detail: "npm_audit_script", evidence: "package.json#scripts.audit" };
  const alerts = gh(`/repos/${repo}/vulnerability-alerts`, { allow: [401, 403, 404] });
  const classified = classifyAlertAccess(alerts.status);
  return { ...classified, evidence: "repository_vulnerability_alerts" };
}

function protection(repo, branch) {
  const response = gh(`/repos/${repo}/branches/${branch}/protection`, { allow: [403, 404] });
  if (response.status === 200) return classifyProtection(response.data);
  return response.status === 404
    ? { state: "fail", detail: "absent", contexts: [] }
    : { state: "unknown", detail: response.status === 403 ? "denied" : "unavailable", contexts: [] };
}

function mergedReviews(repo) {
  const pulls = gh(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${args.prLimit}`).data ?? [];
  return pulls.filter((pr) => pr.merged_at).map((pr) => {
    const response = gh(`/repos/${repo}/pulls/${pr.number}/reviews`, { allow: [403, 404] });
    const state = response.status === 200 ? classifyBotReview(pr.head.sha, response.data ?? []) : "unknown";
    return { number: pr.number, head_sha: pr.head.sha, merged_at: pr.merged_at, review_state: state, evidence: pr.html_url };
  }).sort((a, b) => a.number - b.number);
}

try {
  const installed = listInstalledRepositories();
  const unique = new Set(installed.map((repo) => repo.repository));
  if (unique.size !== installed.length) throw new Error("duplicate repositories returned by installation inventory");
  if (installed.length !== 38) throw new Error(`incomplete installation inventory: expected 38, received ${installed.length}`);

  const repositories = installed.map((repo) => {
    const names = [...new Set([repo.default_branch, "main", "production"])];
    const branches = names.map((name) => {
      const exists = gh(`/repos/${repo.repository}/branches/${name}`, { allow: [403, 404] });
      if (exists.status === 404 && name !== repo.default_branch) return null;
      if (exists.status === 403) return { name, protection: { state: "unknown", detail: "denied", contexts: [] } };
      return { name, protection: protection(repo.repository, name) };
    }).filter(Boolean);
    const record = { ...repo, observed_at: observedAt, branches, merged_pr_reviews: mergedReviews(repo.repository), dependency_coverage: dependencyCoverage(repo.repository), collection_errors: [] };
    return { ...record, proposed_owner_assignments: gapRecords(record) };
  });

  const totals = {
    repositories: repositories.length,
    coverage_gaps: repositories.reduce((sum, repo) => sum + repo.proposed_owner_assignments.length, 0),
    unknowns: repositories.reduce((sum, repo) => sum + repo.proposed_owner_assignments.filter((gap) => gap.state === "unknown").length, 0),
    errors: repositories.reduce((sum, repo) => sum + repo.collection_errors.length, 0),
  };
  const report = { schema_version: SCHEMA_VERSION, collector_sha: args.collectorSha, run_issue: args.runIssue, started_at: startedAt, completed_at: new Date().toISOString(), observed_at: observedAt, installed_repository_count: installed.length, totals, repositories };
  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = `# Fleet CQE coverage\n\n- Schema: ${SCHEMA_VERSION}\n- Collector SHA: \`${args.collectorSha}\`\n- Run issue: ${args.runIssue}\n- Installed repositories: ${totals.repositories}\n- Coverage gaps: ${totals.coverage_gaps}\n- Unknowns: ${totals.unknowns}\n- Collection errors: ${totals.errors}\n\nThe JSON artifact is canonical. Findings are report-only proposals; no tasks or repository settings were changed.\n`;
  writeFileSync(args.summary, markdown);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
