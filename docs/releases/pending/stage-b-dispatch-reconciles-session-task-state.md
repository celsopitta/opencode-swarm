# A Stage B gate dispatch now reconciles the session with the durable task state

## What

**Dispatch admission (`src/hooks/delegation-gate.ts`).** When a `reviewer` or
`test_engineer` dispatch is admitted because a task's durable workflow is at
`pre_check_passed` or `reviewer_run`, the dispatching session's in-memory copy
of that task is first brought in line with the durable state. This applies to
every task the dispatch is admitted for, including plan tasks that are only
mentioned in the prompt.

**Recovery tools.** `recover_stage_a_task`
(`src/workflow/settlement-recovery.ts`) and `recover_rework_task`
(`src/workflow/rework-recovery.ts`) reconcile the calling session right after
their durable `stage_a_passed` write. `recover_stage_a_task` also reconciles
when the task is already past Stage A (the "already recovered" answer).

All of them use one helper, `reconcileSessionWorkflowWithEvidence` in
`src/workflow/session-workflow-sync.ts`:

- evidence that is missing or not authoritative is never copied into the
  session;
- a session that already agrees on state and generation is not touched;
- a Stage B completion marker in the session is removed when the evidence no
  longer holds the gate it stands for; markers whose gate is still recorded
  are kept, and none is added;
- council state for the task is never touched: a council generation bound at
  an older durable generation stays as it is, so the council evidence writer
  keeps rejecting verdicts collected before the generation changed.

## Why

Dispatch admission and task completion read the evidence file. The Stage B
settlement path reads `session.taskWorkflowStates` and skips any task that is
not `pre_check_passed` or `reviewer_run` there, with no message. Nothing kept
the two in step when the durable workflow was rewritten outside the session's
own transitions. After a successful `recover_stage_a_task` the tool answered
"Reviewer/test_engineer dispatch is permitted again", the dispatch was
admitted, and every verdict that came back was skipped because the session
still held `idle` or `blocked`. The same happened with a session that held
`rework_required` against a durable `reviewer_run`. The task could not be
completed in that process.

Reconciling at admission covers every writer, including ones that never touch
the session: `/swarm recover` run from another process, a recovery performed by
another session, or a restored evidence file.

## Behavior change

- A session whose copy of a task was ahead of or behind the durable state is
  corrected to the durable state when a reviewer or test_engineer dispatch for
  that task is admitted, so the verdict of that dispatch is settled against
  the state the admission used.
- A task state that exists only in the session and disagrees with the durable
  one does not survive the next admitted Stage B dispatch for that task,
  because the durable state is the authority. A durable `rework_required` is
  not affected: such a task is not admitted.
- A verdict from a reviewer or test_engineer dispatch that was launched before
  the task was rejected is recorded if the task has since been brought back to
  a Stage B state at the same generation (for example by `recover_rework_task`)
  and a new Stage B dispatch for it has been admitted. The generation fence on
  gate recording is unchanged.

## Migration

None.

## Known caveats

- "Mentioned in the prompt" is textual: any plan task id that appears in the
  dispatch text is a candidate, including an incidental number such as a
  version (`bun 1.2`). That is how the gate already selected tasks; such a task
  is now also reconciled when its durable state admits Stage B.
- Reconciliation happens at Stage B dispatch and in the two recovery tools.
  Other readers of the session copy (status text, guidance) can still show the
  older state until the next Stage B dispatch for the task.
- `/swarm recover` itself does not update any session; a session picks the
  repair up at its next reviewer or test_engineer dispatch for the task.
- A verdict for a task whose state changes between the dispatch and the reply
  (for example a parallel REJECTED verdict that moves it to `rework_required`)
  is still skipped without a message.

## Tests

- `tests/unit/workflow/recovery-session-sync.test.ts`
- `tests/unit/hooks/delegation-gate-recovery-then-stage-b.test.ts`
