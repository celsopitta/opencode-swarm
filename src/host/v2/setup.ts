/**
 * #3022 AC4 (deferred, per the C6 naming convention): clientless startup model
 * preflight for v2 hosts. The catalog-backed `runModelPreflight` requires an
 * OpencodeClient the v2 Context does not carry, so validate the effective
 * enabled-role models against the checked-in verified keyless roster instead
 * and surface a bounded operational warning per non-roster id. Fail-open on
 * every error; bounded local reads only (no network).
 */
async function deferredV2StartupModelPreflight(
	directory: string,
): Promise<void> {
	try {
		const loaded = await withTimeout(
			Promise.resolve(loadPluginConfigWithMeta(directory)),
			2_000,
			new Error(
				'[opencode-swarm] v2: startup preflight config read exceeded budget',
			),
		);
		const entries = collectEnabledAgentModels(loaded?.config);
		const models = entries
			.map((entry) => entry.model)
			.filter(
				(model): model is string =>
					typeof model === 'string' && model.length > 0,
			);
		const quiet = loaded?.config?.quiet === true;
		for (const warning of collectModelRosterWarnings(
			models,
			VERIFIED_KEYLESS_MODEL_ROSTER,
		)) {
			// Two surfaces, mirroring the v1 preflight (src/index.ts ~1625):
			// 1. addDeferredWarning — the in-process advisory buffer /swarm
			//    diagnose reads. Live hosts run plugins in the background
			//    service process whose console the CLI does not relay (D3/AC4
			//    live probe, 2026-10-02), so the buffer is the channel the
			//    operator can actually reach; warn() alone would be
			//    OPENCODE_SWARM_DEBUG-gated and invisible in production.
			// 2. console.warn on stderr for foreground/standalone service runs,
			//    quiet-gated exactly like the v1 preflight's console.warn.
			addDeferredWarning(warning);
			if (!quiet) {
				// biome-ignore lint/suspicious/noConsole: #3022 AC4 startup roster warning must be visible without OPENCODE_SWARM_DEBUG (same rationale as the index.ts version banner), gated on config.quiet like the v1 preflight
				console.warn(warning);
			}
		}
	} catch (err) {
		log('v2 startup model preflight failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * OpenCode 2 (v2 plugin API) setup entrypoint — issue #3004 / #2910.
 *
 * The v2 host validates the plugin's default export against
 * `{ id, setup | effect }` (sst/opencode v2 line, packages/core/src/plugin/
 * module.ts). The v1 `server()` path stays byte-stable for OpenCode 1 hosts;
 * this module is what `setup(ctx)` runs on OpenCode 2 hosts.
 *
 * Architecture (ADR-0003): the adapter reuses the SAME initialization core and
 * the SAME v1 hook set — it only TRANSLATES registration surfaces:
 *
 *   - tools: `hooks.tool` map → `ctx.tool.transform(editor.add)` (one source,
 *     `buildPluginToolObject`; no parallel name list — enforced by
 *     scripts/check-tool-registration.ts);
 *   - agents + commands: the v1 `config` hook is invoked against a synthetic
 *     `opencodeConfig` object, making the config hook itself the shared
 *     builder (auto-select promotions and the command table are reused
 *     verbatim — zero extraction from src/index.ts);
 *   - guidance: the v1 messages/system transform chains run against a
 *     translated session event; the #2526 USER-role guidance carriers the
 *     messages chain materializes are re-homed into `event.system` (v2 renders
 *     system natively — the user→system transport delta is recorded in
 *     docs/host/v2-hook-inventory.md);
 *   - lifecycle: tool execute.before/after, compaction, prompt hooks and the
 *     event subscription are wired with payload translation; `setup` returns
 *     a single Cleanup that disposes every Registration and runs the v1
 *     dispose teardown.
 *
 * Init boundedness (AGENTS.md invariant 1): every `await` in src/host/** is
 * either on the same physical line as a `withTimeout(` call or inside a
 * function named deferred-…/cleanup-… (the frozen C6 source-scan convention).
 * The shared initialization wrapper (`deps.runInit`) is injected by
 * src/index.ts so no module cycle is created and the FATAL-fail surface stays
 * with the v1 wrapper.
 */

import { z } from 'zod';
import { loadPluginConfigWithMeta } from '../../config/loader';
import {
	collectEnabledAgentModels,
	collectModelRosterWarnings,
	VERIFIED_KEYLESS_MODEL_ROSTER,
} from '../../services/model-preflight';
import { addDeferredWarning } from '../../services/warning-buffer';
import { ensureAgentSession, swarmState } from '../../state';
import { log } from '../../utils';
import { resolveProjectRootDecision } from '../../utils/project-boundary';
import { withTimeout } from '../../utils/timeout';
import { registerV2AgentsAndCommands } from './agents-commands';
import { startDeferredEventPump } from './events';
import { registerV2ContextHook } from './guidance';
import { registerV2SessionHooks, registerV2ToolHooks } from './hooks';
import {
	clearV2AgentTransformSurface,
	registerV2AgentTransformSurface,
} from './model-apply';
import { registerV2Tools } from './tools';
import type { V1HooksSubset, V2PluginContext, V2Registration } from './types';

/** Bounds setup() itself — the v1 repro-704 class of deadline for the v2 path. */
const V2_SETUP_TIMEOUT_MS = 60_000;

/** Dependencies injected from src/index.ts (avoids an index↔host cycle). */
export interface V2SetupDependencies {
	/** The shared server-initialization wrapper (begin-interval → init core → schedule deferred → end-interval). */
	runInit: (input: unknown) => Promise<V1HooksSubset>;
}

interface CollectedState {
	readonly registrations: V2Registration[];
	pumpStop?: () => void;
	disposeV1?: () => Promise<void>;
}

/** Normalize a v2 agent reference (Agent.Info object or bare string) to a name. */
export function normalizeV2AgentRef(agent: unknown): string | undefined {
	if (typeof agent === 'string') return agent;
	if (agent && typeof agent === 'object') {
		const rec = agent as { id?: unknown; name?: unknown };
		if (typeof rec.id === 'string' && rec.id.length > 0) return rec.id;
		if (typeof rec.name === 'string' && rec.name.length > 0) return rec.name;
	}
	return undefined;
}

/**
 * Register the plugin on an OpenCode 2 host. Throws propagate to the v2 host
 * (which skips the plugin) after a FATAL stderr line from the shared wrapper —
 * the same posture the v1 server() path has (issue #675).
 */
export async function openCodeSwarmV2Setup(
	ctx: V2PluginContext,
	deps: V2SetupDependencies,
): Promise<() => Promise<void>> {
	const rawDirectory = ctx?.location?.directory;
	if (typeof rawDirectory !== 'string' || rawDirectory.length === 0) {
		// Fail closed (AGENTS.md invariant 4): the v2 Context contract marks
		// location.directory required; a cwd fallback would silently root
		// .swarm/ at the host process cwd.
		throw new Error(
			'[opencode-swarm] v2 setup: host Context carried no location.directory; refusing to start (invariant 4).',
		);
	}
	// Route the raw directory through the same project-root decision the v1
	// init path applies (issue #2127): a subdirectory owned by a parent
	// project root redirects, so session-scoped state does not split-brain
	// between two .swarm trees. Fail-closed keeps the raw directory (matching
	// the v1 bootstrapRoot behavior) with state writes disabled upstream.
	const rootDecision = resolveProjectRootDecision(rawDirectory);
	const directory =
		rootDecision.kind === 'redirect'
			? rootDecision.owningRoot
			: rootDecision.kind === 'root'
				? rootDecision.directory
				: rawDirectory;
	const state: CollectedState = { registrations: [] };

	// v1 PluginInput view — the init core consumes only `directory` and
	// `client`; the v2 Context carries no OpencodeClient, so background
	// managers take their client-absent paths (per-consumer dispositions in
	// docs/host/v2-hook-inventory.md).
	const input = {
		client: undefined,
		directory,
		worktree: directory,
	} as unknown as Parameters<V2SetupDependencies['runInit']>[0];

	const hooks = await withTimeout(
		deps.runInit(input),
		V2_SETUP_TIMEOUT_MS,
		new Error('[opencode-swarm] v2 setup: initialization exceeded budget'),
	);

	// Agents + commands through the v1 config hook against a synthetic config —
	// the single-source builder (see module header).
	await withTimeout(
		registerV2AgentsAndCommands(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2 setup: agent/command registration exceeded budget',
		),
	).catch((err: unknown) => {
		log('v2 agent/command registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	// Tools from the same map the v1 host receives.
	await withTimeout(
		registerV2Tools(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error('[opencode-swarm] v2 setup: tool registration exceeded budget'),
	).catch((err: unknown) => {
		log('v2 tool registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	// Guidance (context hook), tool hooks, compaction, prompt.
	await withTimeout(
		registerV2ContextHook(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2 setup: guidance registration exceeded budget',
		),
	).catch((err: unknown) => {
		log('v2 context-hook registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});
	await withTimeout(
		registerV2ToolHooks(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2 setup: tool-hook registration exceeded budget',
		),
	).catch((err: unknown) => {
		log('v2 tool-hook registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});
	await withTimeout(
		registerV2SessionHooks(ctx, hooks, directory, state.registrations),
		V2_SETUP_TIMEOUT_MS,
		new Error(
			'[opencode-swarm] v2 setup: prompt-hook registration exceeded budget',
		),
	).catch((err: unknown) => {
		log('v2 prompt-hook registration failed (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	});

	// Deferred event pump (detached; named for the C6 convention).
	const stopPump = startDeferredEventPump(ctx, hooks);
	state.pumpStop = stopPump;

	// #3022 D2: remember the agent transform surface for runtime model
	// rewrites (fallback advance application — the v2-native equivalent of the
	// v1 output.message.model write).
	registerV2AgentTransformSurface(ctx);

	// #3022 AC4: clientless startup roster preflight — the catalog-backed
	// preflight is client-only, so on v2 validate the effective models against
	// the checked-in verified roster instead. Every failure mode is a
	// non-fatal warning. Run INLINE at the tail of setup: live 2.0.21 probing
	// showed the host's plugin realm does NOT execute post-setup timer
	// callbacks, so a setTimeout-deferred run never fired; this is a local
	// two-file JSON read (no network, ~17 ms warm), within invariant 1's
	// fast-init allowance. The withTimeout wrap satisfies the C6 scan's
	// same-line bound requirement for awaits inside openCodeSwarmV2Setup.
	await withTimeout(
		deferredV2StartupModelPreflight(directory),
		V2_SETUP_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: startup model preflight exceeded budget'),
	);

	state.disposeV1 =
		typeof hooks.dispose === 'function' ? hooks.dispose : undefined;

	log('[opencode-swarm] v2 setup complete', {
		directory,
		tools: Object.keys(hooks.tool ?? {}).length,
	});

	return async function cleanupV2Plugin(): Promise<void> {
		if (typeof state.pumpStop === 'function') state.pumpStop();
		clearV2AgentTransformSurface();
		for (const registration of state.registrations) {
			try {
				await withTimeout(
					registration.dispose(),
					V2_SETUP_TIMEOUT_MS,
					new Error(
						'[opencode-swarm] v2 cleanup: registration dispose exceeded budget',
					),
				);
			} catch (err) {
				log('v2 registration dispose failed (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		if (state.disposeV1) {
			await withTimeout(
				state.disposeV1(),
				V2_SETUP_TIMEOUT_MS,
				new Error('[opencode-swarm] v2 cleanup: v1 dispose exceeded budget'),
			).catch((err: unknown) => {
				log('v1 dispose during v2 cleanup failed (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}
	};
}

/**
 * Seed the v1 session state a translated hook event implies. Shared by the
 * guidance/prompt/tool-hook adapters so the v1 chain sees the same session
 * identity the v1 host would have seeded via chat.message.
 */
export function seedV1SessionState(
	sessionID: string | undefined,
	agentRef: unknown,
	directory: string,
): string | undefined {
	if (typeof sessionID !== 'string' || sessionID.length === 0) return undefined;
	const agentName = normalizeV2AgentRef(agentRef);
	if (agentName === undefined) return sessionID;
	try {
		ensureAgentSession(sessionID, agentName, directory);
	} catch {
		// ensureAgentSession is best-effort here; the v1 chain re-resolves.
	}
	// Always re-pair: ensureAgentSession may have rewritten
	// agentSessions[sessionID].agentName on a mid-session agent switch, and
	// the v1 contract keeps activeAgent in sync with it — a first-write-wins
	// guard here left the two maps diverged.
	swarmState.activeAgent.set(sessionID, agentName);
	return sessionID;
}

/**
 * Convert a v1 zod args shape into the JSON-schema-ish `input` value the v2
 * tool editor accepts. Cached per tool at registration time (transforms must
 * be synchronous and cheap).
 */
export function v2ToolInputSchema(args: unknown): unknown {
	try {
		if (args && typeof args === 'object') {
			return z.toJSONSchema(z.object(args as z.ZodRawShape));
		}
	} catch {
		// Fall through to the permissive schema.
	}
	return { type: 'object' as const };
}
