/**
 * Swarm-agent dispatch model preflight — issue #2680.
 *
 * Gate-level coverage (the service is covered in
 * tests/unit/services/model-preflight-2680.test.ts):
 * - The delegation gate denies a NON-critic registered agent dispatch whose
 *   final effective model does not resolve, with the distinct
 *   SWARM_AGENT_MODEL_UNRESOLVED class (critics keep PLAN_CRITIC_MODEL_UNRESOLVED).
 * - An enabled registered role with no final selection denies with
 *   SWARM_AGENT_MODEL_MISSING_SELECTION.
 * - Catalog unavailable → fail-open: the dispatch proceeds (a catalog warning
 *   alone is never dispatch-failure evidence).
 * - Primary agents are exempt (short-circuit BEFORE any catalog lookup) so a
 *   host whose catalog lacks the registered fallback model never sees a false
 *   denial while the UI-selected model is fine.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { getAgentConfigs } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { invalidateProviderCatalogCache } from '../../../src/services/model-preflight';
import { resetSwarmState, swarmState } from '../../../src/state';
import {
	addTelemetryListener,
	initTelemetry,
	removeTelemetryListener,
	resetTelemetryForTesting,
} from '../../../src/telemetry';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function catalogClient(
	providers: { id: string; models: string[] }[],
	fail = false,
): OpencodeClient {
	return {
		provider: {
			list: async () => {
				if (fail) throw new Error('catalog unreachable');
				return {
					data: {
						all: providers.map((provider) => ({
							id: provider.id,
							name: provider.id,
							models: Object.fromEntries(
								provider.models.map((model) => [model, { id: model }]),
							),
						})),
					},
				};
			},
		},
	} as unknown as OpencodeClient;
}

const OPENCODE_CATALOG = catalogClient([
	// #3022: current defaults + retired ids kept as user-override fixtures.
	{
		id: 'opencode',
		models: [
			'big-pickle',
			'nemotron-3-ultra-free',
			'mimo-v2.6-flash-free',
			'minimax-m2.5-free',
			'gpt-5-nano',
		],
	},
]);

const baseConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as unknown as PluginConfig;

const multiSwarmConfig = {
	...baseConfig,
	swarms: {
		local: {
			name: 'Local',
			agents: {
				coder: { model: 'ghost/broken-model' },
				explorer: { model: 'opencode/big-pickle' },
			},
		},
	},
} as unknown as PluginConfig;

describe('issue #2680 — registered-agent dispatch model preflight', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		tempDir = canonicalMkdtemp('agent-preflight-2680-');
	});

	afterEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('[AC2] non-critic registered agent with an unresolvable final model is denied with its distinct typed class', async () => {
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(multiSwarmConfig, tempDir);
		const hook = createDelegationGateHook(
			multiSwarmConfig,
			tempDir,
			registeredAgents,
		);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'coder-call-1' },
			{ args: { subagent_type: 'local_coder', prompt: 'map the repo' } },
		);
		await expect(outcome).rejects.toThrow('SWARM_AGENT_MODEL_UNRESOLVED');
		await expect(outcome).rejects.toThrow('local_coder');
		await expect(outcome).rejects.toThrow('ghost/broken-model');
		await expect(outcome).rejects.toThrow('swarm override wins');
	});

	test('[AC2] critic dispatches keep the PLAN_CRITIC_MODEL_UNRESOLVED identity', async () => {
		const criticConfig = {
			...multiSwarmConfig,
			swarms: {
				local: {
					name: 'Local',
					agents: { critic: { model: 'ghost/broken-critic' } },
				},
			},
		} as unknown as PluginConfig;
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(criticConfig, tempDir);
		const hook = createDelegationGateHook(
			criticConfig,
			tempDir,
			registeredAgents,
		);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'critic-call-1' },
			{ args: { subagent_type: 'local_critic', prompt: 'review the plan' } },
		);
		await expect(outcome).rejects.toThrow('PLAN_CRITIC_MODEL_UNRESOLVED');
		await expect(outcome).rejects.toThrow('ghost/broken-critic');
		// The critic message must NOT carry the non-critic class name.
		const error = (await outcome.catch(
			(caught: unknown) => caught,
		)) as unknown as Error;
		expect(error.message.startsWith('PLAN_CRITIC_MODEL_UNRESOLVED')).toBe(true);
	});

	test('[AC2] a valid prefixed role dispatch proceeds on a healthy catalog', async () => {
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(multiSwarmConfig, tempDir);
		const hook = createDelegationGateHook(
			multiSwarmConfig,
			tempDir,
			registeredAgents,
		);
		await expect(
			hook.toolBefore(
				{
					tool: 'Task',
					sessionID: 'architect-1',
					callID: 'explorer-call-1',
				},
				{
					args: { subagent_type: 'local_explorer', prompt: 'map the repo' },
				},
			),
		).resolves.toBeUndefined();
	});

	test('[AC5] non-critic dispatch fails open when the catalog is unreachable', async () => {
		// A read-only role whose model sits on the ghost provider: with the
		// catalog DOWN the preflight resolves 'unknown' and the dispatch
		// proceeds — an unreachable catalog is a warning surface, never
		// dispatch-failure evidence. ([AC2]'s healthy-catalog denial on the
		// same ghost provider is the symmetric control.)
		const ghostExplorerConfig = {
			...baseConfig,
			swarms: {
				local: {
					name: 'Local',
					agents: { explorer: { model: 'ghost/broken-model' } },
				},
			},
		} as unknown as PluginConfig;
		swarmState.opencodeClient = catalogClient([], true);
		const registeredAgents = getAgentConfigs(ghostExplorerConfig, tempDir);
		const hook = createDelegationGateHook(
			ghostExplorerConfig,
			tempDir,
			registeredAgents,
		);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'explorer-call-2' },
				{ args: { subagent_type: 'local_explorer', prompt: 'map the repo' } },
			),
		).resolves.toBeUndefined();
	});

	test('[AC6] a registered role with no final selection denies with the missing-selection class', async () => {
		swarmState.opencodeClient = OPENCODE_CATALOG;
		// Hand-built registry entry whose swarm is absent from the config: the
		// exact-name precedence chain yields nothing (stale swarm registry).
		const staleRegistry = {
			ghostswarm_coder: { model: '', mode: 'subagent' },
		} as unknown as ReturnType<typeof getAgentConfigs>;
		const configWithLocalSwarm = {
			...baseConfig,
			swarms: { local: {} },
		} as unknown as PluginConfig;
		const hook = createDelegationGateHook(
			configWithLocalSwarm,
			tempDir,
			staleRegistry,
		);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'stale-call-1' },
			{ args: { subagent_type: 'ghostswarm_coder', prompt: 'map the repo' } },
		);
		await expect(outcome).rejects.toThrow(
			'SWARM_AGENT_MODEL_MISSING_SELECTION',
		);
		await expect(outcome).rejects.toThrow('ghostswarm_coder');
	});

	// New-behavior pin (PRR-011 disclosure): the base tree had NO non-critic
	// model preflight at all, so this test cannot discriminate base vs head —
	// it pins the PR's new primary-exemption property against regressions.
	test('primary agents are exempt: a catalog lacking their registered model never denies a Task dispatch', async () => {
		// Catalog WITHOUT any opencode provider — the primary's registered
		// fallback model (DEFAULT_MODELS.default) is unresolvable here, but the
		// UI owns the primary's selection, so the dispatch must proceed.
		swarmState.opencodeClient = catalogClient([
			{ id: 'custom', models: ['unrelated-model'] },
		]);
		const config = {
			...baseConfig,
			swarms: { local: {} },
		} as unknown as PluginConfig;
		const registeredAgents = getAgentConfigs(config, tempDir);
		const hook = createDelegationGateHook(config, tempDir, registeredAgents);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'primary-call-1' },
				{ args: { subagent_type: 'local_architect', prompt: 'lead' } },
			),
		).resolves.toBeUndefined();
	});

	// PRR-003 (PR review): a registered role whose override is EXPLICITLY
	// blank must deny missing-selection here — before the fix the resolver
	// chain silently fell back to DEFAULT_MODELS and the dispatch proceeded
	// while init/doctor flagged the same role.
	test('[AC6] a blank model override on a registered role denies missing-selection', async () => {
		const blankConfig = {
			...baseConfig,
			swarms: {
				local: {
					name: 'Local',
					agents: { explorer: { model: '   ' } },
				},
			},
		} as unknown as PluginConfig;
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(blankConfig, tempDir);
		const hook = createDelegationGateHook(
			blankConfig,
			tempDir,
			registeredAgents,
		);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'blank-call-1' },
			{ args: { subagent_type: 'local_explorer', prompt: 'map the repo' } },
		);
		await expect(outcome).rejects.toThrow(
			'SWARM_AGENT_MODEL_MISSING_SELECTION',
		);
	});

	// PRR-009 (PR review): the denial emits model_unresolved telemetry with
	// the role, the effective model, and the fixed detail string.
	test('[AC2] denial emits model_unresolved telemetry with fixed-shape fields', async () => {
		initTelemetry(tempDir);
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const events: { event: string; data: Record<string, unknown> }[] = [];
		const listener = (event: unknown, data: Record<string, unknown>): void => {
			events.push({ event: String(event), data });
		};
		addTelemetryListener(listener);
		try {
			const registeredAgents = getAgentConfigs(multiSwarmConfig, tempDir);
			const hook = createDelegationGateHook(
				multiSwarmConfig,
				tempDir,
				registeredAgents,
			);
			await hook
				.toolBefore(
					{ tool: 'Task', sessionID: 'architect-1', callID: 'tel-call-1' },
					{ args: { subagent_type: 'local_coder', prompt: 'map the repo' } },
				)
				.catch(() => {});
		} finally {
			removeTelemetryListener(listener);
			resetTelemetryForTesting();
		}
		const emitted = events.find((e) => e.event === 'model_unresolved');
		expect(emitted).toBeDefined();
		expect(emitted?.data.agentName).toBe('coder');
		expect(emitted?.data.model).toBe('ghost/broken-model');
		expect(emitted?.data.detail).toBe('swarm-agent dispatch preflight');
	});

	// PRR-009 (PR review): a denial invalidates the catalog cache — a config
	// fix takes effect on the NEXT dispatch, not after the 30 s TTL. Call 1
	// omits the model (denial + invalidate); call 2 includes it (proceeds).
	test('[AC2] a fixed model config takes effect on the next dispatch after denial', async () => {
		let models: Record<string, { id: string }> = {};
		const mutatingClient = {
			provider: {
				list: async () => ({
					data: { all: [{ id: 'custom', name: 'custom', models }] },
				}),
			},
		} as unknown as OpencodeClient;
		swarmState.opencodeClient = mutatingClient;
		const fixedConfig = {
			...baseConfig,
			swarms: {
				local: {
					name: 'Local',
					agents: { explorer: { model: 'custom/explorer-model' } },
				},
			},
		} as unknown as PluginConfig;
		const registeredAgents = getAgentConfigs(fixedConfig, tempDir);
		const hook = createDelegationGateHook(
			fixedConfig,
			tempDir,
			registeredAgents,
		);
		// First dispatch: the catalog does not know the model -> denial.
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'fix-call-1' },
				{ args: { subagent_type: 'local_explorer', prompt: 'map' } },
			),
		).rejects.toThrow('SWARM_AGENT_MODEL_UNRESOLVED');
		// Simulate the operator fixing the provider catalog (not the cache TTL).
		models = { 'explorer-model': { id: 'explorer-model' } };
		// Second dispatch must refetch (cache was invalidated by the denial)
		// and proceed.
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'fix-call-2' },
				{ args: { subagent_type: 'local_explorer', prompt: 'map' } },
			),
		).resolves.toBeUndefined();
	});

	// PRR-001 (PR review): a hostile critic-prefixed subagent_type must not
	// inject newlines into the denial message. The catalog deliberately lacks
	// the `opencode` provider so the legacy default model is unresolved and
	// the denial fires.
	test('[AC2] denial message neutralizes control characters from hostile subagent_type', async () => {
		const esc = String.fromCharCode(27);
		const criticConfig = {
			...baseConfig,
			agents: { critic: { model: 'ghost/broken-critic' } },
		} as unknown as PluginConfig;
		swarmState.opencodeClient = catalogClient([
			{ id: 'custom', models: ['unrelated-model'] },
		]);
		const registeredAgents = getAgentConfigs(criticConfig, tempDir);
		const hook = createDelegationGateHook(
			criticConfig,
			tempDir,
			registeredAgents,
		);
		const error = (await hook
			.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'hostile-call-1' },
				{
					args: {
						subagent_type: `critic\n${esc}[31mFORGED`,
						prompt: 'review the plan',
					},
				},
			)
			.catch((caught: unknown) => caught)) as unknown as Error;
		expect(error.message.startsWith('PLAN_CRITIC_MODEL_UNRESOLVED')).toBe(true);
		expect(error.message.split('\n').length).toBe(1);
		expect(error.message).not.toContain(esc);
	});
});
