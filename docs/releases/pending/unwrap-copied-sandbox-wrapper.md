# A copied sandbox wrapper is unwrapped instead of refused

## What changed

The guardrails before-hook (`src/hooks/guardrails/tool-before.ts`) now peels a
bash command that is an exact copy of the plugin's own Bubblewrap wrapper back
to its inner command, before any other check reads the command. The parser,
`unwrapGeneratedBubblewrapCommand` in
`src/sandbox/linux/bubblewrap-executor.ts`, is the exact inverse of
`BubblewrapSandboxExecutor.wrapCommand`: the bwrap binary (`/usr/bin/bwrap` or
`bwrap`), only the options `wrapCommand` emits with their exact arity, then
`-- bash -c '<inner>'` and nothing after it. Wrappers copied more than once are
peeled repeatedly, up to eight levels. A deeper stack is peeled eight levels
and what remains is still a bwrap wrapper: it is refused when Bubblewrap is
about to wrap the call, and otherwise runs as that single remaining layer.
Only the exact tool names `bash` and `shell` are unwrapped, the same names the
destructive-command and write-scope checks and the sandbox wrap act on.

The inner command then goes through the circuit, audit, destructive-command
and write-scope checks, and is sandboxed once with the
plugin's own scope when the sandbox applies to the call; for a call the
sandbox does not wrap (no declared scope, an unsandboxed role, no executor)
it runs plain, exactly as if the agent had sent it. Every option in the copy,
including any bind the agent invented, is discarded. The unwrap runs only
while guardrails policy is enforced; with guardrails disabled the plugin
rewrites nothing.

This also closes a check gap: a write or a destructive command inside a copied
wrapper used to be invisible to the write-scope and destructive-command
checks, which saw only the bwrap invocation.

A bwrap command of any other shape is unchanged and is still refused when
Bubblewrap is about to wrap it.

## Why

opencode stores the wrapped command as the agent's own tool input and replays
it to the model on later turns. Agents then imitate it: in one coder session
14 of 17 commands the model itself sent started with `/usr/bin/bwrap`, even
though every session's first command was plain and no prompt mentions bwrap.
The nested-bwrap refusal kept those calls from running, but each one cost the
agent a turn. Restoring the original command in the after-hook does not help:
an isolated opencode run confirmed the host keeps the rewritten input.

## Migration

None. Stale knowledge-base lessons that quote a full bwrap command line can be
removed by hand; they are no longer needed for agents to recover.
