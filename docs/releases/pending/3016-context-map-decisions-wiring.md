---
issue: 3016
---

# Context map: decisions pipeline wired end-to-end

## What changed

The context map's decisions pipeline — durable since #2720/#3015 but never exercised at runtime — now records and surfaces architectural decisions:

- **Producer** (`src/context-map/post-agent-update.ts`): new `extractContextDecisionsFromContextMd` reads the architect-maintained `.swarm/context.md` `## Decisions` section (shared #2493 extractor grammar, `- decision: rationale` bullets split on the first `: `), bounded to the most recent 50 entries, and gated so only architect-orchestrated task completions sync. The Task-tool post-hook in `src/index.ts` now passes these decisions to `updateContextMapAfterAgent`, which sanitizes them through the shared context sanitizer and persists them as durable `A<n>`-identified `DecisionEntry` rows (the persisted log keeps the most recent 200 entries). Appends are idempotent (trimmed-text dedup, first-write-wins) so re-syncing never duplicates.
- **Consumer** (`src/context-map/capsule-builder.ts`): critic capsules gain a `## Decisions` section (task-scoped entries first, then most recent others, capped at 10; pruned last under token pressure), making `docs/context-map.md`'s Critic capsule claim true. Other roles are unchanged (new `RoleProfile.include_decisions` flag, critic only).
- **Hardening** (`src/context-map/persistence.ts`): `loadContextMap` fails closed on structurally invalid maps — `decisions` must be an array, `files`/`task_history` non-null non-array objects; absent keys fail the same way (every in-repo writer materializes all three). Previously a non-array `decisions` loaded fine and then dropped or corrupted the whole update via the outer catch.
- **Docs**: `docs/context-map.md` documents the recording source, the append-only/first-write-wins semantics, the bounded sync window, and the corrupt-map policy; the context-map-capsules release fragment names the recording source.

## Why

Issue #3016 (filed from two swarm-pr-review rounds of #3015): the only runtime caller of `updateContextMapAfterAgent` passed no `decisions`, nothing read `ContextMap.decisions`, and two docs overclaimed — the feature's storage layer shipped but its recording and surfacing halves were dead code.

## Migration steps

Nothing to do. The feature remains opt-in (`context_map.enabled: true`); decisions flow automatically once `.swarm/context.md` records them.
