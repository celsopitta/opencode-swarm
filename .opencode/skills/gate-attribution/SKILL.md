---
name: gate-attribution
audience: swarm-plugin
description: Per-task gate attribution for reviewer/test_engineer dispatches. A Stage B gate is recorded only from a parseable per-task verdict row in the reply to a Task dispatch. Covers single-task and set-dispatch rows, how the row must be written, what each verdict does, and what to do when a row is missing.
---

# Gate Attribution

## The rule
This skill is about the Stage B gates of plan tasks (`execute` steps 5j-5l).
The gate tracker attributes reviewer/test_engineer dispatches PER TASK, and it
records a gate only from a parseable verdict row in the reply to a Task
dispatch. The task id in the dispatch (`task_id` / `taskId` / unambiguous
prompt task ID) tells the tracker which task the dispatch is for; it records
nothing by itself. This holds for a single-task dispatch and for a
set-dispatch alike:

```
[REVIEWED] | task-2.1 | APPROVED | ...
[TESTED] | 2.1 | PASS | ...
```

`[REVIEWED]` verdicts are `APPROVED | REJECTED | CONCERNS`; `[TESTED]` verdicts
are `PASS | FAIL | SKIPPED`. Rows with `task-X.Y` are normalized to `X.Y`;
unsafe or non-plan IDs are ignored.

A row that does not start its line is not read: inline backticks or bold around
it, a quote or list marker, or any text before it on the same line (for example
a `VERDICT:` prefix). Ask for each row on a line of its own, as plain text,
starting at the first character of the line and with a `|` after the verdict.
A foreground Task dispatch tolerates leading spaces and a row that ends right
after the verdict; a background Task gate does not.

What a parseable row does:
- `APPROVED` / `PASS` records the gate for that task.
- `REJECTED`, `CONCERNS` or `FAIL` records no gate and moves the task to
  `rework_required`.
- `SKIPPED` records nothing and leaves the task ready for a test-gate
  re-dispatch.

If the reply has no parseable row for the dispatched task, nothing is
attributed: there is no fallback to the task id. For a foreground Task dispatch
no gate is recorded, the task state does not change, and you normally receive a
`STAGE B SETTLEMENT DROPPED` advisory (`verdict_missing`). Re-dispatch the same
gate and require the row; do not send the task back to the coder for this, and
do not use a recovery tool. A background Task gate treats a missing verdict as
a failed gate instead and moves the task to `rework_required`.

## Protocol
1. **Run each gate as a Task dispatch with exactly ONE taskId** (reviewer and
   test_engineer separately). This is the default and the safest form.
2. **For a true set-dispatch** (one Task dispatch that covers several tasks):
   require one `[REVIEWED] | task-id | verdict | ...` (or `[TESTED] | ...`)
   row per task in the returned output. In a foreground Task dispatch each
   task is settled from its own row, and a task whose row is missing is not
   attributed. A background Task gate settles only its own task; rows for
   other tasks attribute nothing there.
3. **Lanes do not record plan-task gates.** For the per-task Stage B gates of
   a plan task, `dispatch_lanes` / `dispatch_lanes_async` replies are advisory
   input: a verdict row in a lane reply attributes nothing to any plan task.
   Use lanes for read-only exploration or review input, then run the gate
   itself as a Task dispatch (step 1 or 2). On hosts without the swarm
   controller's dispatch tools the lane tools are not available at all.
   This does not apply to the PR-feedback workflow: its Stage B gates are
   controller lanes with their own modes, and direct Task calls do not satisfy
   them. Follow the swarm-pr-feedback skill there.
4. **Do NOT rely on prose summaries:** a reply without parseable rows is
   ambiguous and does not count for any task.

Gate evidence is persisted independently as `.swarm/evidence/{taskId}.json` for
each task. A recorded gate is written to that task's file; a single multi-task
evidence file cannot satisfy any task.

## Optimization for trivial tasks
For pure ceremony gates (1-line doc fix), a Task dispatch to test_engineer:
```
TASK: Verify task X.Y. Run skill-mirrors.test.ts. PASS/FAIL.
taskId: X.Y
OUTPUT: end with the verdict row on its own line:
[TESTED] | task-X.Y | <PASS, FAIL or SKIPPED> | <summary>
```

## Why this exists
The gate tracker (the delegation-gate runtime) keys delegation chains by
`sessionID`. Ambiguous multi-task prompts still fail closed, but parseable
`[REVIEWED] | task-id | ...` rows provide explicit per-task attribution for
set-dispatches. Tracked in issue #1746 item 6.
