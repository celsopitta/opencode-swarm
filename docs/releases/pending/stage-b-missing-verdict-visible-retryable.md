# A missing Stage B verdict row is now reported and retryable, and the row instructions are explicit

## What

**Missing verdict row (`src/hooks/delegation-gate.ts`, foreground Task
dispatches).** When a `reviewer` or `test_engineer` reply carries no parseable
`[REVIEWED]` / `[TESTED]` row for the task it was dispatched for:

- nothing is recorded for that task and its workflow state is left unchanged,
  in the session and on disk;
- the architect receives one `STAGE B SETTLEMENT DROPPED` advisory (new reason
  class `verdict_missing`) that names the agent, the task and the row format
  with the verdict left open, with the remedy "re-dispatch the gate" and the
  instruction to stop and report to the user if the advisory repeats;
- one aggregated host-log line is emitted, as for the other drop classes.

The advisory is keyed by agent and task, so an unreadable reviewer reply and an
unreadable test_engineer reply for the same task are both reported. It names
the task the gate attributes the dispatch to (`task_id`, an unambiguous prompt
id, or the session's current task), and only when the dispatch awaited a Stage
B verdict for that task. A PR-review re-entry dispatch binds no task for
settlement and is never reported. Task numbers that only appear in the prompt
text are not reported one by one for being absent from the reply; when the
reply has no row at all they are listed inside the one advisory. (An awaited
task for which the reply carries an unreadable row is reported; see
`stage-b-verdict-word-case.md`.) A dispatch with no task of its own gets a
single dispatch-wide advisory asking for one row per awaited task, and only
when the reply had no row at all.

**Row instructions (`src/agents/test-engineer.ts`, `src/agents/reviewer.ts`).**
The "STRUCTURED VERDICT LINE" section now states how the row must be written:
on a line of its own starting at the first character, as plain text, with
nothing else on the line, and separate from the `VERDICT:` line. The row format
and the rest of the output format are unchanged.

**Architect delegation examples (`src/agents/architect.ts`).** The two
test_engineer `OUTPUT:` example lines now also ask for the `[TESTED]` row. The
reviewer examples are unchanged; the architect prompt has a character budget
and the reviewer prompt states the row rule itself.

**Gate-attribution skill (`.opencode/skills/gate-attribution/SKILL.md`).** The
skill told the architect things the gate does not do: that with no parseable
row "attribution falls back to the single-task rule", that every parseable row
"creates gate evidence (regardless of verdict value)", and that
`dispatch_lanes_async` lanes attribute gates. It now says that a gate is
recorded only from a parseable row in the reply to a Task dispatch, what each
verdict does, how the row must be written, what happens when the row is
missing and that the remedy is a re-dispatch of the same gate, and that lane
replies record no plan-task gate (the PR-feedback workflow's lane gates are a
separate mechanism, and the skill says so). The trivial-gate template asks for the row.

## Why

`parsePerTaskVerdicts` only reads a row that starts its line. A worker model
that wrapped the row in markdown on the same line as its `VERDICT:` line
produced a reply with no readable row. The gate then set the task to
`rework_required` in the session map only: no durable transition, and a warning
that is debug-gated. The durable evidence stayed at `reviewer_run`, so
completion reported a missing gate, `recover_rework_task` did not apply
(durable state was not `rework_required`), `repair_gate_evidence` refused
(evidence was valid), and every later clean verdict for the task was skipped
because the in-memory state was no longer Stage B eligible. The architect had
no signal about any of it.

## Behavior change

For a foreground Task dispatch, a reply with no parseable row no longer moves
the task to `rework_required` in the session. It still fails closed: no gate
evidence is written, no Stage B completion is credited, and the workflow does
not advance. The next dispatch of the same gate settles normally. A parseable
`REJECTED` or `FAIL` row is unchanged and still moves the task to
`rework_required` durably.

## Migration

None.

## Known caveats

- In a multi-task dispatch, a reply that has rows for some tasks but omits
  another listed task (not the dispatch's own task) is not reported. Listed
  task ids cannot be told apart from task numbers that merely appear in the
  prompt, and reporting them produced false alarms.
- A reviewer or test_engineer dispatch that carries no task id is attributed
  to the session's current task. If that dispatch was not meant as the gate
  (a general question, say) and the task is awaiting its Stage B gate, an
  unreadable reply is reported as a missing verdict for that task.
- The "stop re-dispatching if this repeats" instruction is guidance in the
  advisory text. Nothing counts re-dispatches.
- Background Stage B gates (`src/background/stage-b-gates.ts`) are not changed.
  They still record a durable `stage_b_failed` when a reply has no valid
  structured verdict.
- An unreadable reply does not undo a verdict already recorded for the same
  gate. If a first reviewer run was recorded as APPROVED and a second reviewer
  reply is unreadable, the earlier approval stands; the advisory is the only
  signal for the second reply.
- The advisory needs the dispatch context kept in the plugin process. If the
  plugin is reloaded between a dispatch and its reply, an unreadable reply is
  not reported; the task state is still left unchanged.
- A verdict that arrives for a task whose in-memory state is not Stage B
  eligible is still skipped without an advisory. That path is not changed here.
- The prompt wording lowers the chance of an unreadable row; it cannot
  guarantee it. The advisory is what makes the failure recoverable.

## Tests

- `tests/unit/hooks/delegation-gate-stage-b-verdict-missing.test.ts`
- `tests/unit/hooks/delegation-gate.set-dispatch.test.ts` (SC-023.1, SC-023.2, SC-023.4)
- `tests/unit/hooks/delegation-gate-reentry-bypass.test.ts`
- `tests/unit/agents/stage-b-verdict-row-instructions.test.ts`
