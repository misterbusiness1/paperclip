# Approvals V2 Git-Traceable Candidate for Sevalla Refresh

Date: 2026-05-14
Issue: `OXFA-4737`
Scope: approvals v2 hydrated detail contract plus UI/read-path rendering fixes for refund and reply approvals
Gate A adjacency: yes for rollout review, because refund approval detail is in scope; no payment write or gateway action is included in this candidate

## Candidate identity

- Execution workspace id: `d9e3c28d-d082-46fb-90a2-636cb424e09b`
- Project workspace id: `0596a7d2-a2be-4e7e-b3e4-ee3ba01653db`
- Workspace path: `/app`
- Repo metadata available in this workspace: none
- Provenance note: this workspace does not expose a `.git` directory, remote URL, branch, or commit SHA. The candidate is therefore pinned by content hash so Engineering Director can map it to the corresponding git commit in the canonical repository before or during the Sevalla refresh.

## Deploy artifact

- Artifact path: `/app/report/artifacts/approvals-v2-candidate-2026-05-14.tgz`
- Artifact `sha256`: `c18a1341f4998d58474a443ce4deb67eba036576bf55ebe864317e14ddd53f37`
- Artifact contents:
  - this report
  - `ui/src/pages/ApprovalDetail.tsx`
  - `ui/src/pages/ApprovalDetail.test.tsx`
  - `server/src/__tests__/approvals-service.test.ts`
  - `server/src/__tests__/approval-routes.test.ts`
  - `server/src/__tests__/approval-routes-idempotency.test.ts`

## Candidate file set

- `ui/src/pages/ApprovalDetail.tsx`
  - `sha256: 7e3a36b457a082c31bd18e2b8fa3f46b186fbd920975f4b489311f086f46f4e7`
- `ui/src/pages/ApprovalDetail.test.tsx`
  - `sha256: 97fe041bad640cacdbad41f4c3c108b5e9500b88d9cefdbb4772a87e7c5eabcb`
- `server/src/__tests__/approvals-service.test.ts`
  - `sha256: 5601aca448223e6becbb7ba1518b2c7195dc5c3de74e58349184aaee8ee751a0`
- `server/src/__tests__/approval-routes.test.ts`
  - `sha256: e3a0eef2c35e5cac7a789634f125d3acd4bf64bc0c8eeecb9c47cf5c5b4b96ba`
- `server/src/__tests__/approval-routes-idempotency.test.ts`
  - `sha256: 352d497f4530f4738dd4417db0b2a7355a6c5afa82cca8d2c26f4d4e1287ad9e`

## Behavior included in this candidate

- Refund approval detail restores structured side-effect previews from hydrated fields or sanitized payload fallbacks instead of collapsing to `No side-effect preview was provided.`
- Reply approval detail restores recipient address, original message, and proposed reply from hydrated fields or sanitized payload fallbacks.
- The hydrated `?v=2` approval detail route remains on the flat detail envelope contract with redacted raw payload.
- Approval resolution routes keep idempotent behavior and avoid duplicate side effects or wakeups on retried decisions.

## Verification run

Command:

```sh
pnpm vitest --run ui/src/pages/ApprovalDetail.test.tsx server/src/__tests__/approvals-service.test.ts server/src/__tests__/approval-routes.test.ts server/src/__tests__/approval-routes-idempotency.test.ts
```

Result:

- Passed on 2026-05-14 UTC
- `4` test files passed
- `30` tests passed

## Sevalla refresh contract

Engineering Director should refresh Sevalla to the git commit whose file contents match the hashes above, then publish:

1. The Sevalla deploy/build identifier
2. The canonical git commit SHA that matches this candidate
3. Authenticated response proof for:
   - `GET /api/approvals/059d7bb3-bbf2-44e0-b932-23b7d54b0228?v=2`
   - `GET /api/approvals/809ffe88-b768-4230-ad70-19582d3abd13?v=2`

Post-refresh acceptance:

- Each response includes populated `request`, `context`, and `requester` keys
- Refund detail preserves non-empty structured `sideEffects` when implied by the request or sanitized payload
- Reply detail preserves recipient address plus original/proposed message context
- Response shape does not regress to the legacy top-level approval object

## Remaining gap

This report makes the candidate content-traceable from the shared workspace. The remaining owner action is to bind it to the canonical repo commit SHA during the Sevalla refresh path, because that git metadata is not available from `/app`.
