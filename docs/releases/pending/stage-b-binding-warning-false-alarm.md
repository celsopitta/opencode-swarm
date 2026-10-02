# Stage B durable binding warning no longer fires when there is nothing to write

## What

A dispatch that carries no task binding no longer raises the warning below.
That covers a gate agent that resolves to no task (a plan critic, a
`critic_sounding_board` consultation) and a PR-review re-entry dispatch that
is remembered before any generation is collected:

```
CRITICAL-WARN: [delegation-gate] Stage B durable binding write FAILED for call <id> — restart recovery for this dispatch is unavailable until re-dispatch (non-fatal; in-memory fencing remains active)
```

`rememberStageBDispatchGenerations` in `src/hooks/delegation-gate.ts` now skips
the durable store when the dispatch carries no task binding.

## Why

`recordStageBDispatchBindings` returns `false` when a write fails and also
when the binding list is empty. The caller treated every `false` as a failed
write and reported it on the always-emitted channel (stderr), so every
task-free critic dispatch raised a critical warning although nothing had failed
and there was nothing to recover after a restart.

## Behavior

- Dispatches with a task binding are unchanged: the durable record is written,
  and the warning is still raised, with the dispatch still proceeding, whenever
  the binding is not persisted (a failed write, a non-recordable session or call
  id, or a binding list in which every entry is malformed).
- Dispatches without a task binding do not touch
  `.swarm/stage-b-dispatch-bindings/` and raise no warning. Before this change
  they wrote nothing either; only the warning is gone.

## Migration

None.

## Tests

`tests/unit/hooks/delegation-gate-stage-b-binding-warn.test.ts`
