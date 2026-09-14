import { classifyBotReview } from "./classify.mjs";
import { reviewLatency, staticAnalysisEvidence } from "./trends.mjs";

export const REVIEW_PAGE_SIZE = 100;
export const REVIEW_PAGE_LIMIT = 5;

export function collectPullReviews(repo, number, gh, { pageLimit = REVIEW_PAGE_LIMIT } = {}) {
  const reviews = [];
  for (let page = 1; page <= pageLimit; page += 1) {
    const response = gh(`/repos/${repo}/pulls/${number}/reviews?per_page=${REVIEW_PAGE_SIZE}&page=${page}`, {
      allow: [403, 404],
    });
    if (response.status !== 200) return { state: "unknown", status: response.status, reviews: [] };
    const batch = response.data ?? [];
    reviews.push(...batch);
    if (batch.length < REVIEW_PAGE_SIZE) return { state: "complete", status: 200, reviews };
  }
  return { state: "bounded", status: 0, reviews };
}

export function mergedReviewRecord(repo, pr, gh, options) {
  const result = collectPullReviews(repo, pr.number, gh, options);
  const checks = gh(`/repos/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`, { allow: [401, 403, 404] });
  const files = gh(`/repos/${repo}/pulls/${pr.number}/files?per_page=100`, { allow: [401, 403, 404] });
  const annotations = new Map();
  if (checks.status === 200) {
    for (const check of checks.data?.check_runs ?? []) {
      if (/phpstan|phpcs|code sniffer/i.test(check.name ?? "")) {
        annotations.set(check.id, gh(`/repos/${repo}/check-runs/${check.id}/annotations?per_page=100`, { allow: [401, 403, 404] }));
      }
    }
  }
  const reviewsEvidence = { status: result.status, data: result.state === "complete" ? result.reviews : [] };
  return {
    number: pr.number,
    head_sha: pr.head.sha,
    merged_at: pr.merged_at,
    review_state: result.state === "complete"
      ? classifyBotReview(pr.head.sha, result.reviews)
      : "unknown",
    review_collection: result.state,
    evidence: pr.html_url,
    cqe_latency: reviewLatency(repo, pr, reviewsEvidence, checks),
    static_analysis: staticAnalysisEvidence(checks, annotations, files),
  };
}
