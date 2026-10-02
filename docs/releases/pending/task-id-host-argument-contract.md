# Task `task_id` is the host's session handle, never a plan task id

## What changed

- The architect prompt no longer asks for the numeric plan task id as the Task
  tool's `task_id` argument. Task attribution stays on the standalone `TASK:` line
  (for example `TASK: 1.1`), and the prompt now says to leave `task_id` unset,
  because the host reads it as a sub-agent session handle for resuming. The one
  stated exception is a PR-feedback coder dispatch with a prepared feedback
  scope, whose controller still reads the numeric feedback task id from that
  argument; the boundary below consumes it before the host sees it, so that
  flow now works on hosts that validate the field.
- The plugin enforces that contract at the host boundary. As the last step of
  the Task `tool.execute.before` chain, after every plugin-side reader of the
  plan id has run (including the gate-denial streak reset, which must key on the
  same arguments the denial side saw), a `task_id` that is not a session handle
  (`ses…`) is removed from the arguments the host executes. The plan-shaped value it carried is kept for the
  `tool.execute.after` readers on the stored argument snapshot as
  `plan_task_id`, a field the task-id resolver already honours. Session handles
  are left untouched, including the child session id the worktree path writes.
- When the host marks a Task tool part as failed (`state.status === 'error'`)
  and the part carries no child session id, the plugin now rolls back what the
  before-chain began for that call: a DISPATCHED coder settlement is aborted,
  and the Stage B route slot, dispatch context and dispatch bindings reserved
  for the call are released. The host publishes `state.metadata.sessionId`
  before the sub-agent runs and keeps it on a user abort and on a child
  failure, so a part without it is a call the host rejected before any
  sub-agent existed; a part with it may stand for real work and is left
  DISPATCHED for the recovery path, as before. The rollback reuses the
  denied-dispatch entry point, which is idempotent and settlement-state aware,
  so a part that errors after `tool.execute.after` has settled the call is a
  no-op. The aborted record names the real cause ("Task tool failed in the host
  before the sub-agent ran"), not a gate denial.

## Why

OpenCode's Task tool has carried `task_id` = "resume a previous task" since
November 2025. Since the session-id branding work (host 1.18.x, the pinned
range) the value is validated before the tolerant lookup runs, and anything
else makes the tool throw `Expected a string starting with "ses"`. The throw
lands after the plugin's before-chain admitted the call, and the host fires no
`tool.execute.after` for a thrown tool.

The plugin's prompt (shipped 2026-09-14) told the architect to pass the plan id
in that field. On parallel plans the worktree path overwrote it with a real
child session id, so nothing failed. On serial plans the numeric value reached
the host and was rejected. Observed live on 2026-10-01 and 2026-10-02: the
first coder dispatch of a run failed with that message, and on the second
occasion the coder settlement begun for it stayed DISPATCHED, so every retry
was refused with `CODER_DISPATCH_IN_PROGRESS` until a human ran
`/swarm recover <task> --force`.

## Migration

None for plan-task delegations: those that attribute through the `TASK:` line
are unchanged, and one that still passes a numeric `task_id` now reaches the
host without it and is attributed from `plan_task_id` plus the `TASK:` line.
PR-feedback coder dispatches keep passing their numeric feedback task id in
`task_id` (the controller reads it before the strip); on validating hosts they
were rejected before this change and now run.

## Caveats

- Critic-family dispatches that carried only a numeric `task_id` and no
  standalone `TASK:` line are still attributed, through the stored
  `plan_task_id`; the architect prompt requires the `TASK:` line regardless.
- The failed-part rollback applies to the v1 host event stream. The v2 host
  adapter maps tool failures to `tool.execute.after` with an error state, where
  the existing settlement path already runs.
- The rollback releases the coder settlement and the Stage B reservations. A
  pre-launch background-coder reservation is not released by this entry point
  (the same holds for the existing gate-denial path); the stale reaper clears
  it.
- The host-side rejection of other invalid Task arguments (anything the host
  schema refuses) still produces no `tool.execute.after`; only `task_id` is
  normalised here, because it is the only field the plugin's own contract
  overloaded.
