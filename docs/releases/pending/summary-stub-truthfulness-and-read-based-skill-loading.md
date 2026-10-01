# Skills load through `read`, and `[SUMMARY Sx]` stubs are truthful and expandable

## What changed

### Skill loading uses the host `read` tool instead of `search`

The skill-loading protocol in the architect prompt (`SKILL LOADING`) and in the
coder, reviewer, test_engineer, sme, docs (both roles) and designer prompts
(`SKILLS HANDLING`) now loads `file:` skill references with the host `read`
tool, following `Use offset=N to continue` until the end of the file. It
previously loaded them through the plugin `search` tool with `query: .*`.

`search` returns one pretty-printed JSON object per matched line, which
inflates a whole-file load roughly 2–4× (1.8–4.0× measured across this
repository's skills). For the 41 skills in this
repository that meant only 17 arrived intact; 16 were replaced by a summary
stub and 8 (including `swarm-plan`, `execute`, `swarm-pr-review`,
`writing-tests` and `engineering-conventions`) were first cut by OpenCode's
~50 KB tool-output limit and then stubbed. Through `read`, 39 load in a single
call and the remaining 2 need follow-up calls with `offset`.

The old `total === 0` / `truncated === true` checks are gone: they described
only `search`'s own result cap and could not see either layer that actually
cut the content. `SKILL_LOAD_FAILED` is now reported when `read` fails or
returns nothing.

The host `read` tool cuts any single line longer than 2,000 characters and
marks it `(line truncated to 2000 chars)`. Two safeguards cover that:

- The one shipped skill line over the cap (a 2,581-character paragraph line in
  `swarm-pr-review`) is split into two lines and an adjacent hard-wrapped pair
  is joined, so the file keeps its 2,024-line count. The reflow is
  whitespace-only (spaces and newlines swapped, content and byte count
  unchanged; the skill's `swarm-contract-digest` stamp is refreshed because
  the stamp covers whitespace). A new test
  (`tests/unit/skills/skill-line-length-host-read-cap.test.ts`) fails if any
  markdown file in the native skill trees exceeds the cap.
- For skills this repository does not control, the prompts tell the agent to
  fetch a marked line in full with a single targeted `search` call
  (`mode: literal`, `max_lines: 10000`).

### Host-truncated outputs are recovered from the host's structured signal

When OpenCode truncates a tool result it returns `metadata.truncated: true` and
`metadata.outputPath` alongside the cut text. The tool-output summarizer now
keys recovery on that signal: it stores the full copy OpenCode saved (under
containment, leaf-grammar and `max_stored_bytes` guards) so the summary
describes and retrieves the true output. If the copy cannot be used (missing,
outside the host's tool-output directory, not a regular file, empty, over
`max_stored_bytes` raw or once serialized for storage, or larger than
`retrieve_summary` can serve), the stub header is marked `| partial` and the
footer says only the partial output is stored. Host notes already found are kept on the
partial stub. A failure inside the recovery step itself, every summary ID
colliding, or the partial summary also failing to store, leaves the original
output untouched and unsummarized.

The saved copy is not always everything the host returned: for `bash` it is
the raw output stream, while the "command timed out" / "user aborted" block
(`<shell_metadata>`) exists only in the returned text. Recovery therefore
carries over whatever the host added after the end of the output stream:

- in the stored content, appended after the full output under a
  `[host notes on this result]` label, so `retrieve_summary` returns it;
- in the stub, on a reserved line directly above the footer that the preview
  budget cannot squeeze out, e.g.
  `[host notes on this result] shell tool terminated command after exceeding
  timeout 120000 ms. …`.

A recovered result of a killed command is therefore not presented as a
complete one. The stub's header and preview describe the command's own output
(its real last lines stay visible, and its size and line count exclude the
appended notes); the notes appear once, on their reserved line.

The notes are found by position, not by comparing line contents: the text
after the host's notice must begin with a tail of the saved copy, and whatever
follows that tail is the notes. Output that merely prints the same text as a
host note therefore does not hide the real one. If the returned text does not
line up with the saved copy (an unrecognised layout, a tail that is not a
verbatim ending of the copy, fewer than 256 matching characters before other
text, or more than 64 lines left over), the saved copy
is not presented as the whole result: the summary is marked `| partial` and
stores what the host returned.

Limits of this, stated plainly:

- If the output's own visible tail is that same block repeated with the same
  spacing, the host's copy is indistinguishable from the output's and no notes
  line is added.
- The exact label `[host notes on this result]` is rewritten to
  `[output text: host notes on this result]` wherever tool output shown in the
  preview contains it. Look-alike text (different case, extra characters) is
  not detected, and output that ends with the label can imitate the labelled
  section inside the stored content returned by `retrieve_summary`.

Whether to recover, and which file to read, are decided from the structured
signal alone, never from OpenCode's "Full output saved to: …" text. Tool
output is untrusted content, and an output that merely quotes that notice can
no longer redirect recovery to an unrelated file or cause a complete output to
be labelled partial. The text is consulted only afterwards, to find the host's
notes.

### The stub footer names the `retrieve_summary` tool

- Footer: `→ Use retrieve_summary S7 for full output`
  (was `→ Use /swarm retrieve S7 for full content`).
- Partial footer: `→ Partial output only; use retrieve_summary S7`.
- The `retrieve_summary` tool description, the `[SWARM HINT]` system hint and
  the skill-loading prompt blocks now state that a stub means the output was
  stored, not truncated or lost, and that a stub marked partial holds only the
  part the host returned.
- `/swarm retrieve <id>` delivered through the `swarm_command` tool is no
  longer re-summarized into a new stub (previously a retrieval loop).
- The compaction block's `STORED OUTPUTS` fact now names the `retrieve_summary`
  tool alongside `/swarm retrieve <id>`.
- Line-truncated tool output (`tool_output.max_lines`) no longer ends with
  `Use /swarm retrieve <id> to get the full content`. That truncation stores
  nothing and has no id, so the footer now reads `Omitted lines have no
  summary id; re-run with a narrower scope to see them`.
- `retrieve_summary` is now also granted to `explorer`, `researcher`,
  `skill_improver` and `critic_oversight`, which hold `search` and therefore
  receive stubs.

### `skill` joins the summarizer exempt floor

The host `skill` tool is added to `SUMMARIZER_EXEMPT_TOOL_NAMES` (and so to the
default `summaries.exempt_tools`). A skill body is instructions the agent must
read in full, so a stub saved nothing. That list is shared: `skill` output is
now also exempt from context-budget tool-output masking and from line
truncation (`tool_output`), as `read` already was. The default list is now
`retrieve_summary`, `retrieve_lane_output`, `task`, `read`, `dispatch_lanes`,
`dispatch_lanes_async`, `collect_lane_results`, `parse_lane_candidates`,
`skill`.

## Why

An architect loaded `swarm-plan/SKILL.md` through `search`. The 29.9 KB file
became 69.6 KB of JSON, OpenCode truncated it, and the summarizer then stored
the already-truncated copy behind a stub that claimed "full content". The
architect concluded the skill was truncated and proceeded without it. Two
independent large-output mechanisms were stacking, and the loading path made
most skills large enough to hit both.

## Migration / compatibility

- No configuration change is required.
- Anything that matches the old footer text `Use /swarm retrieve <id> for full
  content` must match the new footer instead. The normal footer is no longer
  than the old one, so ordinary summaries do not grow; the partial footer is
  five bytes longer. `/swarm retrieve <id>` itself still works for users.
- Operators who set `summaries.exempt_tools` explicitly do not need to add
  `skill`: the exempt floor always applies on top of the configured list.
- README's Summarization Settings now documents the real default threshold
  (16384 bytes; summarization triggers at 1.25× that, about 20 KB). The
  previous text still showed the pre-#1323 value.

## Caveats

- Recovery depends on OpenCode supplying `metadata.truncated` /
  `metadata.outputPath` to `tool.execute.after` (verified on OpenCode
  1.18.33 for plugin tools and built-ins). On a host that omits them, a
  truncated output is summarized as received, as before this change. MCP tool
  results reach the hook before the host truncates them and carry no output
  text, so they are neither summarized nor recovered.
- A tool that reports its own truncation without a saved copy (the built-in
  `grep` and `glob`) now gets a `| partial` stub when its output is over the
  threshold. That is accurate, but the cut was the tool's own, not the 50 KB
  host limit.
- Storage and cost: a recovered output stores the host's full copy (up to
  `summaries.max_stored_bytes`, default 10 MB, and never more than
  `retrieve_summary` serves) under `.swarm/summaries/`, where it previously
  stored about 50 KB of truncated text. The copy is read and summarized
  synchronously in the after-hook; the declaration scan that feeds the
  preview is now linear and capped, and a 9 MB code-heavy copy summarizes in
  well under a second. Retention is unchanged (`summaries.retention_days`,
  default 7).
- A summary that carries host notes is larger than one without: the reserved
  notes line adds up to about 430 bytes and, like the header and footer, is
  never cut, so such a summary can exceed a small `max_summary_chars`.
- Host notes get the reserved line only when the host's saved copy was
  recovered (or was recovered but could not be stored). A `bash` result the
  host did not truncate, or one summarized as `| partial` because the saved
  copy could not be read or lined up, keeps its timeout/abort block in the stored content and in the
  text being summarized, but the existing preview byte cap can still cut it
  from the stub when the output is long or declaration-heavy. That preview
  behaviour is unchanged by this release.
- Agents that cannot expand a stub: `curator_*` and `council_*` do not hold
  `retrieve_summary`, and ephemeral read-only evaluation sessions deny every
  plugin tool, so any stub they receive is final for them.
- OpenCode's binary also contains a second output-bounding path
  (`ToolOutputStore`, structured results reporting `outputPaths`). It was not
  observed delivering results to this hook; a result without
  `metadata.truncated` is summarized as received.
- The architect execution-stall guard can deny `read` (it never denied
  `search`). A skill load attempted after that guard has tripped is refused,
  and the architect reports `SKILL_LOAD_FAILED` and asks the user.
- In PR-review modes the read-only argument classifier can reject the
  over-long-line fallback `search` when the chosen phrase contains a
  write-like word. No shipped skill line needs the fallback.
- `search` remains available to agents for searching; it is only no longer the
  way to read a whole skill file.
- Behaviour inside a live OpenCode session, and on Windows or macOS, has not
  been exercised; verification was by unit tests and by replaying recorded
  tool results through the hook on Linux.
