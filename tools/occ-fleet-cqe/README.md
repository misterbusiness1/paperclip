# OCC fleet CQE coverage collector

This isolated operations tool produces a deterministic, report-only inventory for the 38 repositories installed on the governed `occ-review-bot` GitHub App. It does not import Paperclip server modules and it never mutates GitHub, repositories, workflows, dependencies, Paperclip tasks, staging, or production.

## Scheduled invocation

The existing **OCC PR Review Queue and Weekly Quality Sweep** Paperclip routine invokes the collector during its Monday 09:00 ET quality-sweep leg. Do not create another schedule. The routine must invoke an immutable collector commit through OneCLI:

```sh
/usr/local/bin/onecli run -- node tools/occ-fleet-cqe/src/collect.mjs \
  --collector-sha "$COLLECTOR_SHA" \
  --run-issue "$RUN_ISSUE" \
  --repository-owner misterbusiness1 \
  --output fleet-cqe-coverage.v1.json \
  --summary fleet-cqe-coverage.md
```

The routine owns overlap prevention and uploads both artifacts to its execution issue with 13-month retention. The JSON is canonical and the Markdown is derived. Generated reports must not be committed.

## Coverage semantics

- Branch protection checks the default branch plus `main` and `production` when present. Required `OCC Review Bot` or `CQE` is `pass`; an accessible protection response without it is `fail`; denied access is `unknown`.
- Up to 100 recently updated closed PRs per repository are inspected by default. Merged PR bot-review states are `approved`, `stale_head`, `non_approve`, `missing`, or `unknown`.
- Dependency coverage passes only when `composer.lock`, `package-lock.json`, an explicit npm audit script, or an enabled vulnerability-alert feed is verified. Denied or disabled/unavailable alert access is `unknown`, never clean.
- Owner-assignment records are bounded by the inspected repositories/branches/PRs and keyed as `owner/name:kind:subject`. They are proposals only; v1 does not emit Paperclip or GitHub issues.

Collector/runtime/schema failure, a repository count other than 38, duplicate repositories, or artifact-upload failure is operational failure and must exit non-zero. Coverage findings and explicit unknowns remain report findings and do not by themselves change the collector exit status. The scheduler must treat upload failure as non-zero because upload occurs outside this process.

## Verification and rollback

Run deterministic tests with `npm test` from this directory. A live dry run must use the governed OneCLI identity and record the exact collector SHA and run issue.

Rollback removes the single invocation from the existing Monday routine and removes `tools/occ-fleet-cqe/` from a later repository commit. Delete only the generated artifact pair from a run issue if policy requires removing that run's output; historical artifacts otherwise remain audit evidence. No repository-local cleanup is required because the collector performs no target writes.
