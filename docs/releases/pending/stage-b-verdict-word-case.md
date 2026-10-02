# Stage B verdict rows: case-insensitive verdict word, whole-field match, an unreadable row voids that task's verdict

Builds on "A missing Stage B verdict row is now reported and retryable"
(`stage-b-missing-verdict-visible-retryable.md`) and must not ship without it:
this change makes more replies count as "no parseable verdict row", and that
change is what makes such a reply visible and retryable instead of a silent
wedge.

## What

**Case.** The verdict word in a `[REVIEWED]` / `[TESTED]` row is compared
without regard to case in both parsers:

- `parsePerTaskVerdicts` in `src/hooks/delegation-gate.ts` (foreground Task
  dispatches) returns the word in upper case.
- `structuredStageBVerdict` in `src/background/stage-b-gates.ts` (background
  Stage B gates) compares the upper-cased word.

**Whole field (foreground parser).** The verdict word must be followed by `|`
or by the end of the line. The background parser already required the
following `|`. The foreground patterns are also applied without the multiline
flag, since they run on one line at a time.

**Unreadable row (foreground parser and gate).** A line that is a verdict row
for a task (marker, task id, `|`) but whose verdict field is not one of the
accepted words is reported as `STAGE_B_VERDICT_UNREADABLE` (debug log), and
that task gets no verdict from the reply, even if another row for it is
readable. The gate reports every awaited task with such a row to the architect
through the `verdict_missing` advisory, with a detail saying the row was there
but its verdict field could not be read. This includes tasks other than the
dispatch's own task, up to ten per reply (the last advisory says how many more
there were). When the dispatch has no task of its own and the reply has no
readable row at all, the single dispatch-wide advisory covers it instead.

**Prompts.** The reviewer and test_engineer prompts state that the verdict
field is exactly one of the listed words followed by ` | `.

**Skill.** `.opencode/skills/gate-attribution/SKILL.md` states the exact-word
rule and that an unreadable row voids the task's verdict for that reply.

## Why

Both parsers match the row with the `i` flag, so `[tested] | task-1.1 | pass |
…` was accepted as a verdict row. The captured word was then compared with
`=== 'PASS'`, `=== 'APPROVED'` and `=== 'SKIPPED'`. A lower-case or mixed-case
positive verdict matched none of them and took the failure branch: a durable
`stage_b_failed` that moved the task to `rework_required`. A lower-case
`skipped` lost its retryable handling the same way.

Accepting lower case without a boundary would have made ordinary sentences
such as `passed 3 of 20, 17 failing` authoritative, because the foreground
parser accepted any word that starts with a verdict word. With the boundary
alone, an unreadable negative row (`FAILED | first run`) would have been
ignored and a later `PASS | rerun` for the same task would have settled the
gate; hence the contradictory-reply rule.

## Behavior change

- `pass`, `Approved`, `skipped` and other case variants of the six verdict
  words now mean what they say, in both parsers.
- The same verdict written twice for one task, in the same or in different
  case, is one verdict. Two different verdicts for one task are still a
  `STAGE_B_VERDICT_CONFLICT` (debug log) and the first row is kept.
- Foreground rows that used to be read and are now rows with no parseable
  verdict:
  - a longer word or a phrase that starts with a verdict word: `PASSED`,
    `FAILED`, `PASSED 3 of 20, 17 failing`, `APPROVED WITH CONCERNS` (read
    before as `PASS`, `FAIL`, `PASS`, `APPROVED`);
  - a complete verdict word followed by punctuation or text instead of `|`:
    `APPROVED.`, `PASS - 10/10 tests passed`, `PASS: 10/10`.
- A foreground reply that has an unreadable row and a readable row for the
  same task settles nothing for that task.
- A row that follows a lone carriage return, U+2028 or U+2029 inside a line is
  no longer read (the patterns no longer treat those as line ends). For
  example `Running 20 tests... 100%\r[TESTED] | task-1.1 | PASS | 20/20` on
  one line was read before.

## Migration

None.

## Known caveats

- What happens to a foreground reply with no parseable row is defined by the
  change this one builds on: nothing is recorded, the task state is unchanged
  and the architect is told to re-dispatch. In particular a sloppy negative row
  (`FAILED`, `REJECTED.`) no longer records a durable `stage_b_failed`; it is
  reported as an unreadable reply instead.
- The cost of the unreadable-row rule is that a reply which contains a
  malformed row for a task before a correct one (a template echoed with a real
  task id, a per-file breakdown such as `[TESTED] | task-1.1 | src/a.test.ts |
  PASS`, a self-corrected row) settles nothing for that task and has to be
  re-dispatched.
- Two readable rows that disagree are not covered by that rule: the first one
  is kept (`STAGE_B_VERDICT_CONFLICT`, see Behavior change).
- The background parser is unchanged apart from case. It still takes the first
  row that matches for its task and has no conflict or contradiction check, and
  it still records a durable `stage_b_failed` when its task has no readable
  row.
- A row that echoes the format, such as `PASS|FAIL|SKIPPED` in the verdict
  position, is still read as `PASS` by both parsers.

## Tests

- `tests/unit/hooks/delegation-gate-stage-b-verdict-case.test.ts`
- `tests/unit/background/stage-b-gates-skipped-verdict.test.ts`
- `tests/unit/agents/stage-b-verdict-row-instructions.test.ts`
