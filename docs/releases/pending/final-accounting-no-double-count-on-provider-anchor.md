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

- the system prompt the plugin composed for that call (system-surface
  emissions). OpenCode runs `messages.transform` before `system.transform`, so
  the ledger read at accounting time holds the previous request's system
  emissions — exactly what the anchor counted;
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
  turn itself changed (a new knowledge directive, a drained advisory).
- `context_status` and the context-budget pruning hook measure persisted
  messages only and were never affected; after this change the three readings
  agree on the provider-anchored path apart from the advisory's own tokens.
- The debug log line now reports both `systemSurface=` and `messagesSurface=`.
