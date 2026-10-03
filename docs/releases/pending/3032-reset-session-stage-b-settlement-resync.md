---
issue: 3032
title: Stage B settlements no longer wedge when the session's workflow view lags durable evidence
---

## What changed

After a `/swarm reset-session` whose settlement recovery left a task at `rework_required`, a subsequent `recover_rework_task` (or `recover_stage_a_task` / force-repair) writes the durable `stage_a_passed` — but until now nothing updated the session's in-memory workflow view. Reviewer/test_engineer dispatches were admitted from the durable evidence while the settlement loop filtered on the stale in-memory view, so every later APPROVED/PASS verdict was silently skipped before any #2817 drop site: no `gates.reviewer`/`gates.test_engineer` entries, no `[stageb-settlement-drop]` advisory, and no completion path short of a fresh session (issue #3032).

Two resync layers close the wedge (both use one shared `isRepairableStageBView` predicate):

- **Dispatch-side** (`src/hooks/delegation-gate.ts`): when a reviewer/test_engineer dispatch binds a task's launch generation from the durable workflow, it also repairs the session's in-memory view when that view is absent, `rework_required`, or ranks below the durable eligible state.
- **Settlement-side**: a verdict-carrying task in this call's dispatch context whose in-memory view is stale gets one bounded durable re-read and the same repair before the eligibility skip.

`WORKFLOW_STATE_RANK` is a plan-vs-evidence precedence order, not a workflow progress order — `rework_required` ranks above the Stage B eligible states even though `rework_required → pre_check_passed` is forward progress — so `rework_required` is explicitly repairable. An at-or-above view (`tests_run`/`blocked`/`closed`/`complete`) is never overwritten: completion permissively admits only `tests_run`/`complete` (`blocked`/`closed` are terminal), and that shape needs its missing non-Stage B gate, not a reviewer/test_engineer re-run.

Fail-closed semantics are unchanged: tasks whose durable state is genuinely ineligible still do not settle (dispatch still throws `TASK_WORKFLOW_STAGE_A_REQUIRED` for the resolved task id), generation fencing at the durable write still rejects stale generations with the existing `evidence_rejected` advisory, and the #2817 drop legs are untouched. Two adjacent behavior notes: the `STAGE_B_ATTRIBUTION_MISSING` fail-closed marker is written to the session's in-memory view only, and the next dispatch's resync now heals it (at base it silently wedged later verdicts instead); and a negative Stage B verdict on a repaired task now persists `stage_b_failed` (durable `rework_required`) where base skipped it — intended and generation-fenced.

Intentionally out of scope (unchanged behavior): verdict-carrying tasks whose durable state is genuinely ineligible still skip silently (including PR-review re-entry dispatches, which are PR-review-scoped, not task-gate-scoped); post-restart settlements with no dispatch context still rely on session rehydration; a `tests_run`-ahead map view is never corrected backward; and recovery from a BLOCKED in-memory view (`recover_stage_a_task` / stage-a-repair accept `blocked` starts) was left to a fresh session by this fix — subsequently covered writer-side by issue #3043 (both recovery surfaces now refresh the recovering session's in-memory view), while the at-or-above guard still refuses blocked views in sessions that did not run the recovery. The sibling `knowledge_receipt` `wrong_session` rejection from the same report is a separate mechanism — tracked in issue #3036.
