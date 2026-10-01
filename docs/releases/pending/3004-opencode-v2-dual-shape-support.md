---
issue: 3004
type: fix
---

OpenCode 2 support: dual-shape plugin entrypoint (`{ id, server, setup }`).

Installing opencode-swarm into OpenCode 2 hosts (2.0.x) failed at startup with
`Plugin must export a default definition with an id and an effect or setup
function.` — the v2 plugin loader validates the default export against
`{ id, effect | setup }` and the v1-only `{ id, server }` shape matched
neither branch (#3004).

The package now ships a dual-shape default export sanctioned by the official
v2 migration guide: OpenCode 1 hosts keep calling `server()` (byte-stable; the
v1 loader never consults `setup`, verified across the 1.18.x line), and
OpenCode 2 hosts call `setup(ctx)`, which registers the full plugin surface —
all tools (from the same manifest), agents (auto-select semantics included),
commands, guidance, tool guards, compaction, events, and cleanup — through
the v2 plugin API (`src/host/v2/`, ADR-0003). Guidance carrier text is
re-homed into the v2 native system surface with the provenance fence intact;
`.swarm/` containment is unchanged.

Known v2 deltas (full table in `docs/host/v2-hook-inventory.md`): the
PR-workflow response gate that relied on the v1 text-completion hook is inert
on v2 (no v2 equivalent); the v1 command-interception hook has no v2
counterpart (self-registered commands carry their own execute); worktree-lane
external-directory permission scoping is not yet ported to the v2 permission
surface; the compaction customizer's directive output has no v2 mapping (the turn-generation advance still runs); v1 TUI-side `$ARGUMENTS` expansion is replaced by direct substitution in the command bridge; v2 tool-after results surface a `state` discrimination field where v1 carried it implicitly; client-dependent background dispatch surfaces run
their client-absent paths; tool `title`/`attachments` have no v2 surface; the
in-session model override from the quota-fallback fix (#2989) applies to v1
hosts until an equivalent v2 prompt surface is confirmed. A dual-host CI lane
is tracked as the follow-up on #2910.
