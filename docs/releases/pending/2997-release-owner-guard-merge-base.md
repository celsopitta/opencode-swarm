---
issue: 2997
---

# release-owner-guard: merge-base diff semantics

## What

The CI release-owner guard (`scripts/check-required-check-contract.ts`,
`--release-owner` mode) now resolves `git merge-base <base.sha> <head.sha>`
before diffing the release-please-owned files (`package.json`, `CHANGELOG.md`,
`.release-please-manifest.json`) instead of running a two-dot diff directly
against the trusted base SHA. The merge-base result is validated as a single
40-hex SHA (fail closed otherwise), and merge-group events additionally assert
that their declared `base_sha` is the merge-base of the group head — failing
closed on any mismatch rather than silently drifting from the declared-base
range. `changedFilesForGuard` and `TrustedGitHubContext` are exported for the
new regression suite, and `docs/ci-required-check-contract.md` documents the
semantics.

## Why

GitHub's `pull_request.base.sha` is the current `main` tip at event time — a
moving target. A two-dot diff against it contains the reversed diff of every
commit `main` gained after the PR forked, so whenever a release-please merge
landed while a PR was open, the guard accused that PR of "unauthorized edit to
release-please-owned file(s)" it never touched, failing `release-owner-guard`,
`quality`, and `unit-passed`. Observed on PRs #2798, #2940, and #2993 (plus a
#2917-era incident worked around by rebase); at the repo's release cadence
(~20 release commits since 2026-09-01) this fired at essentially every release
boundary. Sibling change-detection consumers (`check-pending-fragment.ts`
BOT-H1, `check-skill-assertions.ts`, `src/review/diff-source.ts`) already used
merge-base for exactly this reason. As a side effect, a genuine violation's
message now names only the files the PR actually edited (previously the
main-side edits inflated the accusation list).

## Caveats

- The issue's optional stale-base advisory ("rebase required" notice) is
  deliberately not implemented: at ~20 release commits/month it would fire on
  nearly every PR open across a release boundary, and its mandatory clause
  (never an unauthorized-edit accusation for staleness) is satisfied by the
  merge-base semantics itself.
- The merge-group equivalence assert fails closed if GitHub ever changes how
  group heads are constructed; an emergency fix on `main` activates
  immediately for all runs because the guard job executes the protected base
  copy of the checker.
- The `release-owner-guard` job's bootstrap `else` leg (checker absent at the
  base SHA) still uses a two-dot shell diff; it is unreachable for any PR
  based on current `main` and was left untouched (no workflow hash churn).

## Tests

New suite `tests/unit/scripts/required-check-contract-2997.test.ts`: the
issue-requested two-dot vs merge-base contrast across a release-please-style
merge (clean PR accepted), genuine-edit true positive with message precision,
merge_group equivalence for single-PR and chained two-PR batches, and both
fail-closed legs (unresolvable merge-base; merge_group base that is not the
merge-base). The existing `required-check-contract-wiring-2677.test.ts` pins
are unchanged (`releaseOwnerDiffArgs` still emits the bounded two-dot pathspec
diff; it now receives the resolved merge-base).
