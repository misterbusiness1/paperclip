import { classifyBotReview } from "./classify.mjs";

export const REVIEW_PAGE_SIZE = 100;
export const REVIEW_PAGE_LIMIT = 5;

export function collectPullReviews(repo, number, gh, { pageLimit = REVIEW_PAGE_LIMIT } = {}) {
  const reviews = [];
  for (let page = 1; page <= pageLimit; page += 1) {
    const response = gh(`/repos/${repo}/pulls/${number}/reviews?per_page=${REVIEW_PAGE_SIZE}&page=${page}`, {
      allow: [403, 404],
    });
    if (response.status !== 200) return { state: "unknown", reviews: [] };
    const batch = response.data ?? [];
    reviews.push(...batch);
    if (batch.length < REVIEW_PAGE_SIZE) return { state: "complete", reviews };
  }
  return { state: "bounded", reviews };
}

export function mergedReviewRecord(repo, pr, gh, options) {
  const result = collectPullReviews(repo, pr.number, gh, options);
  return {
    number: pr.number,
    head_sha: pr.head.sha,
    merged_at: pr.merged_at,
    review_state: result.state === "complete"
      ? classifyBotReview(pr.head.sha, result.reviews)
      : "unknown",
    review_collection: result.state,
    evidence: pr.html_url,
  };
}
