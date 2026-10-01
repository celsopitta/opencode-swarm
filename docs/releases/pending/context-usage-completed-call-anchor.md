# Context usage is read from the latest completed model call

## What changed

`computeContextUsage` (`src/hooks/context-usage.ts`) — the measurement behind
the `context_status` tool, the context-budget hook and final context
accounting — now anchors on the most recent **completed** model call and takes
the host's own measurement of it:

```
providerTokens = input + output + reasoning + cache.read + cache.write
```

of the most recently created assistant message that has output tokens. This is
the same rule and the same formula the OpenCode UI uses for the context figure
it displays. "Most recently created" is decided as the host decides it, by
creation time and then message id, not by position in the message list (see
"Why").

Only content the provider has not counted yet is estimated: tool results
attached to that message after its call returned, and every message that
follows it in the list (including a message still being generated). The
reading is

```
tokensUsed = providerTokens + pendingEstimateTokens
```

`context_status` now returns both parts as well as the total:

- `providerTokens` — the host-measured size of the latest completed call (equal
  to the OpenCode UI's figure); `null` before the first call completes.
- `pendingEstimateTokens` — the estimated content added since.

## Why

The OpenCode host creates every assistant message with all token fields at
zero and fills them in when the model call finishes. The previous code
anchored on the last assistant message whose token fields were numeric, so:

- `context_status`, which a model can only call from inside a message that is
  still being generated, read that message's zero placeholders as a provider
  report and returned `tokensUsed: 1` (the estimate of its own empty
  arguments) with `usageSource: "provider"` — observed in a session whose
  completed calls measured about 180,000 tokens.
- An aborted assistant message (token fields never left zero) reset the reading
  the same way for the hooks that run before the next request.
- After a compaction that retains a tail, the host hands the message hooks the
  list as `[compaction request, summary, ...retained tail, ...later]`. The
  retained tail was created before the summary but sits after it, so "the last
  assistant message in the list" was a pre-compaction call. The context-budget
  hook then read the size of the conversation as it was before compaction
  (87% of the window in a recorded session whose next request really used
  42%) and injected a context warning into a freshly compacted context.

It also counted only `input + cache` from the provider and estimated the
anchor message's visible content, which ignores reasoning tokens. In recorded
sessions those carry into the next request (144,650 input + 1,055 output +
13,611 reasoning was followed by a 159,285-token input), so the old reading
ran below both the host UI and the real context for reasoning models.

## Migration / compatibility

- No configuration change is required.
- `context_status` output gains two fields; existing fields keep their names.
  `tokensUsed` is now `providerTokens + pendingEstimateTokens`. The anchor
  call's output and reasoning are now taken from the provider's count instead
  of an estimate of its visible text and tool arguments, so the reading is
  usually a little higher than before and clearly higher for reasoning models.
- Warning and pruning thresholds (`context_budget.warn_threshold`,
  `critical_threshold`) are unchanged but are now reached slightly earlier for
  models that emit reasoning tokens, because those tokens are counted.
- A message whose provider reports no output tokens is not treated as a
  completed call. A session with no completed call is estimated, as before.
- Right after a compaction the hooks no longer report the pre-compaction size.

## Caveats

- `pendingEstimateTokens` is an estimate by design: the host has no token
  count for content added after the last completed call until the next call
  runs.
- Before the first model call of a session completes, the host has no
  measurement at all. The reading is then an estimate of the messages only: it
  cannot see the system prompt or the tool definitions, so it is far below the
  real size of the first request (in recorded sessions a `context_status` call
  made in the first assistant message read 28 tokens against a real request of
  about 60,000 to 80,000). It is reported as `usageSource: "estimated"` with
  `providerTokens: null`; treat it as "not measured yet".
- Immediately after a host compaction the anchor is the compaction call
  itself, exactly as in the OpenCode UI. The compaction call is a different
  request from the one that follows it (it carries the content being
  summarised, not the agent's system prompt and tools), so until the next
  model call completes the reading is approximate in either direction. The
  hooks add an estimate of the retained tail and anything newer: across the
  five recorded compactions in sessions with a 259,000-token window, the hook
  reading was between 21 points of the window below and 11 points above the
  next request's real size. `context_status` receives the unfiltered history,
  where the retained tail sits before the compaction call, so in that window
  it adds only what is newer than the call and reads lower than the hooks.
  From the next completed call onward both are measured again.
- The model limit (denominator) is unchanged by this release. When the host
  reports no context limit for a model, the plugin still falls back to its
  static tables and, last, a flat 128,000 — `context_status` reports this as
  `fallbackActive: true`.
