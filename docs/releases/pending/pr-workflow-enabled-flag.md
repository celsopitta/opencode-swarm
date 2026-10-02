# `pr_workflow.enabled`: turn the PR workflows off

## What changed

New top-level config block:

```json
{ "pr_workflow": { "enabled": false } }
```

`enabled` defaults to `true`, which is exactly the previous behaviour: the
generated agent configs are byte-identical. Set to `false`, the architect's
PR workflows — `MODE: PR_REVIEW`, `MODE: PR_FEEDBACK` and `MODE: CI_MONITOR` —
are unavailable, and their PR-only tools and mode instructions are no longer
sent to a model:

- The ten PR-only tools (`PR_WORKFLOW_TOOL_NAMES` in
  `src/config/constants.ts`) and the lane-overlay tool
  `submit_pr_review_result` are stripped from every agent's allow-list in
  `getAgentConfigs` (`src/agents/index.ts`) and therefore host-denied, even
  when a `tool_filter` override names them. `resolveAgentCapabilityTools`
  (`src/full-auto/policy.ts`) mirrors the strip.
- `createArchitectAgent` (`src/agents/architect.ts`) leaves the three mode
  sections out of the prompt and omits the PR-only tools from the
  `YOUR TOOLS` and `Available Tools` lists.
- `/swarm pr-review`, `/swarm pr-feedback` and `/swarm ci-monitor` fail with an
  explanation instead of emitting a MODE signal.
- `activatePrWorkflow` (`src/hooks/pr-workflow-gate.ts`) refuses to create a PR
  workflow gate, so the other ways a workflow can start are closed too: a
  `swarm-pr-review:` or `swarm-pr-feedback:verification` lane dispatch is
  refused with the same explanation before any lane or state is created, and
  the autonomous feedback loop does not start.
- `pr_monitor.auto_pr_feedback` is ignored with a startup advisory (PR
  notifications are still delivered).
- The Stage-A delegation error no longer suggests
  `authorize_pr_review_reentry`.

The setting is read once, at plugin startup. `src/pr-review/enablement.ts`
defines its meaning and holds the startup value per project root; the
commands and the gate answer from that value, never from a re-read of the
file.

## Why

Every architect request carried the PR workflows' tool definitions and mode
instructions whether or not the deployment ever reviews a pull request. On the
default configuration, turning the flag off removes about 21,400 characters of
architect prompt (139,732 down to 118,357) and about 15,500 characters of tool
definitions per request — roughly 10,000 tokens. Small-context local models
feel that most.

Nothing outside the PR workflows calls the ten tools, so removing them changes
nothing for a session that is not in a PR workflow.

## Migration / compatibility

- No change unless you set `pr_workflow.enabled: false`.
- Restart OpenCode after changing the setting. Until then the running session
  keeps the value it started with, in both directions.
- Finish or abort any PR workflow before turning the setting off (see
  Caveats).
- `prepare_pr_workflow_checkout` is deliberately not removed: its `restore`
  operation returns the stashed working tree after a workflow has ended.
- General tools that PR workflows also use (`dispatch_lanes_async`,
  `collect_lane_results`, `parse_lane_candidates`, `gh_evidence`, …) are not
  affected.
- `/swarm abort-pr-workflow`, `/swarm pr-feedback-loop stop` and
  `/swarm pr subscribe` / `unsubscribe` / `status` are not affected.

## Caveats

- A PR workflow that is still active when the setting is turned off keeps
  blocking edits in its session, and its messages still name tools that are
  now denied. `/swarm abort-pr-workflow` clears it, subject to that command's
  own rules (lanes still in flight must settle first; an armed publication
  needs `PR_FEEDBACK --cancel-publication <reason>`), and
  `prepare_pr_workflow_checkout` with `operation: "restore"` returns the
  stashed working tree. A `PR_FEEDBACK` workflow that has already published can
  only be closed with `complete_pr_workflow`: re-enable the setting and
  restart to finish it.
- The `dispatch_lanes_async` tool definition still describes its PR-review
  parameters (about 4,000 characters); the tool is shared with other modes and
  its definition cannot be varied per configuration.
- A lane dispatch under a PR mode that does not start a workflow (for example
  `swarm-pr-feedback:stage-b-reviewer` with no active gate) behaves as before.
- With `tool_filter.enabled: false` the plugin emits no per-tool denies, so the
  PR-only tools remain visible to the model. Only `pr_workflow_status`, a
  read-only status report, still does anything.
- With `pr_monitor.enabled: true` the wake message for PR events still refers
  to "the swarm-pr-feedback discipline".
- A custom architect prompt must use `### MODE: PR_REVIEW`,
  `### MODE: PR_FEEDBACK` and `### MODE: CI_MONITOR` headers for the sections
  to be removed. A section runs to the next `### MODE:` or `## ` heading, or
  to the end of the custom prompt; a PR mode section under another heading
  level is left in place and reported in a startup advisory.
- One sentence of the architect's rule on read-only advisory lanes still
  mentions an "active PR_REVIEW" exception, and the list of example mode
  signals still names `PR_REVIEW` and `PR_FEEDBACK`. Both are inert when the
  workflows are disabled: the architect only enters a signalled mode that has
  a matching section.
- The standalone CLI (`bunx opencode-swarm run …`) does not start the plugin
  and so does not apply the setting.
- The startup value is held per started project root, for up to 64 roots.
  Swarm worktree lanes are recognised (`resolveLaneContext`) and not recorded;
  a lane inside its project reads the project's value. Past the bound the
  plugin forgets in the safe direction only: PR commands may be refused for a
  project until a restart, but a disabled project is never switched back on.
- The shared real-host test fixture (`tests/helpers/knowledge-real-host.ts`)
  now pins `pr_workflow.enabled: true`, so those suites do not depend on a
  developer's own user-level config.
- `src/observability/catalog.ts` cites three telemetry emits in `src/index.ts`
  by line number; they are repointed for the lines this change adds.
