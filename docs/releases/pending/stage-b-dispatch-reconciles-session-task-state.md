# Stage B admission repairs a session view from an older generation; rework recovery refreshes the caller

## What

**Stage B admission (`src/hooks/delegation-gate.ts`).** When a `reviewer` or
`test_engineer` dispatch is admitted from a durable `pre_check_passed` or
`reviewer_run`, two local additions run inside upstream's #3032 admission
repair:

- A Stage B completion marker in the session whose durable gate no longer
  exists is dropped. Removing a marker can only make the session stricter.
- A session view that ranks at or above the durable state is repaired from the
  durable state when it is provably from an older generation: a completion
  marker it relied on was just dropped, or its cached generation differs from
  the durable one. Terminal views (`blocked`, `closed`, `complete`) are never
  overwritten. Every other case keeps upstream's `isRepairableStageBView` rule.

**`recover_rework_task` (`src/workflow/rework-recovery.ts`).** After its
durable `stage_a_passed` write it refreshes the calling session's view with the
same writer-side rule as the Stage A recovery writers
(`shouldRefreshStageARecoveryView` / `applySessionWorkflowView` in
`src/workflow/session-view.ts`, issue #3043).

## Why

A session that had settled the reviewer in an older generation kept
`reviewer_run` plus a `reviewer` completion marker after the durable workflow
was rotated elsewhere to a new `pre_check_passed` with no reviewer gate. The
next test_engineer verdict advanced the view to `tests_run` on the stale
marker, and the reviewer verdict that followed was skipped as "not Stage B
eligible" forever, because the #3032 settlement-time resync never downgrades
`tests_run`. Durable completion checks still blocked the task correctly, so
nothing was wrongly completed; the task simply could not finish in that
session.

For rework recovery, upstream's admission repair already fixes a
`rework_required` view on the next Stage B dispatch; refreshing at the writer
makes the session consistent as soon as the tool returns.

## History and narrowed coverage

An earlier local version overwrote the session view unconditionally at Stage B
admission and in both recovery tools. Upstream fixed the same split-brain in
#3032/#3038 (consumer-side) and #3043 (writer-side) with guarded rules that
never downgrade a view ahead of durable. When upstream was merged, the local
helper was removed in favour of upstream's rules plus the two narrow additions
above.

This narrows what the earlier local version covered in one case: a recovery
performed in another session or another process (including `/swarm recover`
from the CLI) while this session's view is `blocked`. Upstream keeps a `blocked`
view unrepaired on the consumer side by design, so this session's next Stage B
verdict for that task is skipped. Remedy: re-run the recovery in this session,
or continue in a fresh session.

## Known caveat

`applySessionWorkflowView` clears the task's council generation in the
refreshed session, so council verdicts collected before a `recover_rework_task`
must be re-collected after it (`submit_council_verdicts` fails closed with
`TASK_COUNCIL_GENERATION_REQUIRED`, and the next council dispatch re-binds the
generation). This matches upstream's other recovery legs.

## Migration

None.
