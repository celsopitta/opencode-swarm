## test-clock ratchet now covers in-tree src/** tests

The `bun run check:test-clock` gate (CI quality job) now scans the in-tree
`src/**` test files the CI unit job executes, in addition to `tests/**` — until
now a new `Date.now()` / `new Date()` / `spyOn(Date` in a src test passed the
gate completely invisible (99 of 322 src test files already used the raw clock
without the freezeClock helper, none of them counted anywhere). New raw-clock
additions in src tests block exactly like tests/ additions; the 99 pre-existing
src files (like the 415 pre-existing tests/ files) are grandfathered as
non-blocking warnings. The summary also emits a stable, machine-readable
`Raw-clock-no-helper files (ratchet): <N>` line counting every raw-clock-no-helper
file across both trees (514 at the 2026-09-30 census: 415 tests/ + 99 src/ — the
census moves with merges, recompute before comparing) so CI can pin the backlog
to a monotone ceiling later. The scan surface is pinned by regression tests
covering both roots, the exclusions under src/, the probe differential, the
grandfather arm for diff-touched src files, and ratchet monotonicity.
