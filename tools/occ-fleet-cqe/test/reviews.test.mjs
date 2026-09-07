import assert from "node:assert/strict";
import test from "node:test";
import { collectPullReviews, mergedReviewRecord, REVIEW_PAGE_SIZE } from "../src/reviews.mjs";

const review = (id) => ({ id, state: "COMMENTED", commit_id: "head", user: { login: "someone" } });

test("review retrieval continues beyond GitHub's default 30 records", () => {
  const endpoints = [];
  const gh = (endpoint) => {
    endpoints.push(endpoint);
    return { status: 200, data: endpoints.length === 1
      ? Array.from({ length: REVIEW_PAGE_SIZE }, (_, index) => review(index + 1))
      : [review(REVIEW_PAGE_SIZE + 1)] };
  };
  const result = collectPullReviews("acme/widget", 7, gh);
  assert.equal(result.state, "complete");
  assert.equal(result.reviews.length, REVIEW_PAGE_SIZE + 1);
  assert.deepEqual(endpoints, [
    "/repos/acme/widget/pulls/7/reviews?per_page=100&page=1",
    "/repos/acme/widget/pulls/7/reviews?per_page=100&page=2",
  ]);
});

test("review retrieval is bounded and never reports truncated evidence as clean", () => {
  let calls = 0;
  const gh = () => {
    calls += 1;
    return { status: 200, data: Array.from({ length: REVIEW_PAGE_SIZE }, (_, index) => review(index + 1)) };
  };
  const pr = { number: 9, head: { sha: "head" }, merged_at: "2026-09-07T00:00:00Z", html_url: "https://example.test/pr/9" };
  const record = mergedReviewRecord("acme/widget", pr, gh, { pageLimit: 2 });
  assert.equal(calls, 2);
  assert.equal(record.review_collection, "bounded");
  assert.equal(record.review_state, "unknown");
});
