# Final context accounting no longer double-counts injections on the provider-anchored path

## What changed

`src/hooks/final-context-accounting.ts` computes the "final prompt pressure"
behind the `[CONTEXT PRESSURE …]` advisories, the compaction-service tiers, the
one-time 50% advisory and the `/swarm status` "Prompt pressure (final)" line.

When `computeContextUsage` is anchored on a completed model call (the normal
case after a session's first call), the total is now:

```
host-measured tokens of the anchor call
+ max(0, estimated tail after the anchor − this request's messages-surface ledger emissions)
```

System-surface ledger emissions are no longer added on that path. The
pure-estimate path (no completed call yet) is unchanged: the estimate of the
messages array plus the ledger's system-surface emissions, because the system
prompt is invisible to that estimate.

## Why

The host's count for the anchor call already contains two things the ledger
also records:

- the system prompt the plugin composed for that call. For sessions whose
  `system.transform` enhancer runs (sub-agents), OpenCode's
  `messages.transform`-before-`system.transform` order means the ledger read at
  accounting time holds the previous request's system-surface emissions — the
  content the anchor counted. For a session-bound architect the system-surface
  enhancer begins no ledger; its guidance travels on a messages-surface
  carrier and is covered by the next point;
- the per-request messages-surface injections (guidance carriers, knowledge,
  memory recall, the advisory block). The host never persists them, so every
  request rebuilds them after the anchor and the estimated tail counted them a
  second time.

Measured live on 2026-10-02 against a 259K-window model: the architect's
advisory said 73% while the host showed 63% for the same call, about 25K
tokens, so every pressure-driven advisory fired roughly ten points early. The
double count predates the completed-call anchor change
(`context-usage-completed-call-anchor.md`); it dates from the introduction of
the system-surface addition.

## Migration

None. Thresholds and config keys are unchanged; they are now reached when the
host's own count reaches them.

## Caveats

- The previous request's injections stand in for this request's. They are
  rebuilt from the same inputs each turn, so the two differ only by what the
  turn itself changed (a new knowledge directive, a drained advisory). That
  difference is signed: an injection that first appears in a request is
  under-counted by its size for that one request, bounded by the producers'
  caps (knowledge `max_injection_tokens`, the advisory block limit, the memory
  recall budget, the system-enhancer budget — about 11K tokens in total with
  default settings), and it is inside the next completed call's host count.
  A drained injection over-counts the same way for one request.
- The subtraction needs a ledger. When none exists at accounting time (a
  native agent, a session without identity, the architect's compaction-pending
  turn), messages-surface emissions are dropped on record, nothing is
  subtracted, and the tail still counts that request's injections as before.
- `context_status` measures persisted messages only and was never affected.
  The context-budget pruning hook runs early in the chain and sees only the
  pipeline tracker's phase reminder placed before it. After this change the
  readings agree on the provider-anchored path up to the remaining over-count
  sources: the advisories' own tokens, the context-budget hook's warning and
  the pipeline tracker's phase reminder (neither is ledger-recorded), and the
  gap between a producer's recorded estimate and its fenced carrier text. All
  of them err towards reporting more; the one-request under-count above is the
  only source in the other direction.
- The debug log line now reports both `systemSurface=` and `messagesSurface=`.
