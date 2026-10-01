# ADR-0003: OpenCode 2 plugin API support via a dual-shape entrypoint

- **Issue:** [#3004](https://github.com/ZaxbyHub/opencode-swarm/issues/3004) (implementation slot: [#2910](https://github.com/ZaxbyHub/opencode-swarm/issues/2910), discovery slot: [#2909](https://github.com/ZaxbyHub/opencode-swarm/issues/2909))
- **Supersedes:** the invariant-2 sentence "default export must remain the v1 plugin object shape `{ id, server }`" (AGENTS.md amended alongside this ADR)

## Status

Accepted (2026-09-30)

## Context

OpenCode 2 (npm `@opencode/cli` 2.x; plugin SDK `@opencode/plugin` 2.x) shipped with an intentionally breaking plugin API: the host decodes each plugin module's default export against `Schema.Struct({ default: Union([{id, effect: fn}, {id, setup: fn}]) })` (`sst/opencode` v2 line, `packages/core/src/plugin/module.ts`) and maps any decode failure to `Plugin must export a default definition with an id and an effect or setup function.` — the exact error in #3004. Our v1-only export `{ id, server }` matches neither union branch, so the plugin is dropped at startup on every 2.x host.

Verified facts driving the decision (all against primary sources, 2026-09-30):

- The v2 schema **ignores excess keys** on the default object: `{ id, server, setup }` passes on the `setup` branch (empirically confirmed with the exact schema and `effect@4.0.0-rc.112`, the dependency of `@opencode/plugin@2.0.20`).
- The v1 loader `readV1Plugin` (`anomalyco/opencode`, byte-identical at tags v1.18.3 and v1.18.33) only consults `id`/`server`/`tui` — an added `setup` key is inert across the entire v1 line. The official v2 migration guide sanctions the interim dual shape ("A package can temporarily expose both implementations from one default export. V1 calls `server()` and V2 calls `setup()`") and notes v1 object entrypoints are officially supported from OpenCode 1.18.29+ (our pinned SDK is 1.18.3; behavior verified identical at both ends of the line).
- v2 has **no returned-Hooks object**: all registration happens through setup-time domain transforms and hooks (`ctx.tool.transform/hook`, `ctx.agent.transform`, `ctx.command.transform`, `ctx.session.hook("context"|"prompt"|"compaction")`, `ctx.event.subscribe`, setup-returned `Cleanup`). The full v1→v2 mapping is `docs/host/v2-hook-inventory.md`.

## Decision

**Adopt the dual-shape default export `{ id, server, setup }` with a v2 adapter layer under `src/host/v2/`** (Candidate A). `server()` stays byte-stable for v1 hosts. The v2 `setup(ctx)` reuses the SAME initialization core (`runServerInit`, dependency-injected to avoid a module cycle) and the SAME v1 hook set — the adapter only translates registration surfaces. The v1 `config` hook doubles as the shared agent/command builder: the adapter invokes it against a synthetic `opencodeConfig` object and registers the resulting tables, so auto-select promotions and the command table are reused verbatim with zero extraction from `src/index.ts`.

Rejected alternatives: **(B)** separate entrypoints per host — the same migration guide says older v1 releases would then need separate package versions; doubles packaging surface for no benefit. **(C)** defer until v1 EOL — user-facing break with an impact-9 audit rating.

## Consequences

- **Invariants 2 and 10 (AGENTS.md)** now describe the dual shape and the v2 in-place `event.system`/`event.messages` contract respectively (amended in the same change).
- **Guidance transport differs by host by design:** v1 keeps the #2526 USER-role carriers (the v1 host drops `role:'system'` entries); v2 re-homes the carrier text into `event.system` (rendered natively). The provenance fence is preserved in both; content parity is asserted by fixture tests on both paths.
- **Deferred deltas** (each with an inventory row and release-note disclosure): the v1 text-completion gate is inert on v2 (no v2 equivalent — official table); `OpencodeClient`-dependent background consumers take client-absent paths on v2; v1 tool `title`/`attachments` have no v2 surface; v1 `chat.message`'s model-override write has no v2 prompt field yet.
- **Type strategy:** vendored structural types (`src/host/v2/types.ts`, provenance-headed against `@opencode/plugin@2.0.20` d.ts) instead of a devDependency — the v1 SDK packages are runtime dependencies whose factories production code imports, whereas the v2 types would be adapter-only and would pull `effect@4.0.0-rc.112` transitives into the lockfile for zero runtime value. Truth is guarded by the provenance pin above and by the live-host smoke; a `check-host-contract.ts` v2 digest leg ships with the #2910 follow-up PR (tracked there with the dual-host CI lane).
- **v1 minimum version:** dual-shape behavior verified against `readV1Plugin` at v1.18.3 (the repo pin) and v1.18.33 (npm-latest); the official support statement for object entrypoints is 1.18.29+. No lockfile change in this ADR.

## Go/no-go for #2910's follow-up PRs

**GO.** This change delivers the (a)+(b)+(c)-core scope: entrypoint + adapter seam, full tool/guidance/lifecycle/agents/commands port, contracts and docs. The dual-host CI lane (v2 smoke cell in `ci.yml`, drift-check dependency freshness for the `@opencode/*` 2.x line, weekly host-contract v2 leg wiring) is the follow-up PR; the live-host smoke script produced with this change is its seed. **Owner acceptance of the deferral:** recorded in the PR review of this change and tracked on #2910 (the follow-up must land before the next minor release cut so the v2 lane is CI-proven, not smoke-proven only).
