/**
 * Registered-host model-preflight qualification — issue #2680.
 *
 * Boots the REAL plugin (server()) via bootSwarmPluginHost with a multi-swarm
 * config and an injected catalog client, then proves through REGISTERED
 * surfaces only:
 * - [AC1] valid legacy unprefixed AND multi-swarm prefixed enabled roles
 *   resolve final models and their Task dispatches proceed.
 * - [AC4] when the catalog client THROWS, provider.list was actually invoked,
 *   the preflight stays fail-open, and the dispatch still proceeds — a
 *   catalog warning alone is not dispatch-failure evidence.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type { OpencodeClient } from '@opencode-ai/sdk';
import type { PluginConfig } from '../../src/config';
import {
	invalidateProviderCatalogCache,
	runModelPreflight,
} from '../../src/services/model-preflight';
import { resetSwarmState, swarmState } from '../../src/state';
import {
	bootSwarmPluginHost,
	createPluginHostProject,
} from '../helpers/plugin-host';

const MULTI_SWARM: Record<string, unknown> = {
	swarms: {
		default: { name: 'Default' },
		local: {
			name: 'Local',
			agents: {
				explorer: { model: 'opencode/big-pickle' },
				coder: {
					model: 'ghost/broken-model',
					fallback_models: ['opencode/big-pickle'],
				},
			},
		},
	},
};

function catalogClient(fail = false): {
	client: OpencodeClient;
	listCalls: () => number;
} {
	let calls = 0;
	const client = {
		provider: {
			list: async () => {
				calls++;
				if (fail) throw new Error('catalog unreachable');
				return {
					data: {
						all: [
							{
								id: 'opencode',
								name: 'opencode',
								models: {
									'big-pickle': { id: 'big-pickle' },
									'nemotron-3-ultra-free': {
										id: 'nemotron-3-ultra-free',
									},
									'mimo-v2.6-flash-free': { id: 'mimo-v2.6-flash-free' },
									'minimax-m2.5-free': { id: 'minimax-m2.5-free' },
									'gpt-5-nano': { id: 'gpt-5-nano' },
								},
							},
						],
					},
				};
			},
		},
	} as unknown as OpencodeClient;
	return { client, listCalls: () => calls };
}

/** Fire the registered chat.message hook (agent-turn surface) like the host. */
async function activateSession(
	host: Awaited<ReturnType<typeof bootSwarmPluginHost>>,
	sessionID: string,
	agent: string,
): Promise<void> {
	const chat = host.hooks['chat.message'];
	if (typeof chat !== 'function')
		throw new Error('chat.message hook not registered');
	await chat({ sessionID, agent }, { message: { role: 'user' }, parts: [] });
}

async function dispatchTask(
	host: Awaited<ReturnType<typeof bootSwarmPluginHost>>,
	sessionID: string,
	callID: string,
	subagentType: string,
	prompt = 'map the repo',
): Promise<void> {
	await host.hooks['tool.execute.before'](
		{ tool: 'Task', sessionID, callID },
		{ args: { subagent_type: subagentType, prompt } },
	);
}

describe('issue #2680 — model preflight on a registered host', () => {
	let directory: string;

	beforeEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		directory = createPluginHostProject('model-preflight-2680-');
	});

	afterEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('[AC1] valid legacy and prefixed enabled roles resolve final models and dispatch on the registered host', async () => {
		const { client } = catalogClient();
		const host = await bootSwarmPluginHost(directory, MULTI_SWARM, client);
		const sessionID = 'preflight-ac1';

		// Registry proof: the booted host registered BOTH naming forms.
		const registered = [...swarmState.generatedAgentNames];
		expect(registered.includes('explorer')).toBe(true);
		expect(registered.includes('local_explorer')).toBe(true);

		// Preflight selection through the registered inputs (the same call
		// shape the post-resolution task uses).
		const result = await runModelPreflight(
			MULTI_SWARM as unknown as PluginConfig,
			swarmState.opencodeClient,
			{ generatedAgentNames: swarmState.generatedAgentNames },
		);
		expect(result.catalogAvailable).toBe(true);
		const byAgent = new Map(result.resolutions.map((r) => [r.agent, r]));
		expect(byAgent.get('explorer')?.status).toBe('ok');
		expect(byAgent.get('local_explorer')?.status).toBe('ok');
		// Architect-role primaries are host-controlled, never failures.
		expect(byAgent.get('architect')?.status).toBe('host-controlled');
		expect(byAgent.get('local_architect')?.status).toBe('host-controlled');
		// The broken multi-swarm override IS now visible to the preflight.
		// (The role also carries a fallback entry that resolves ok — select
		// the PRIMARY selection explicitly.)
		const localCoderPrimary = result.resolutions.find(
			(r) => r.agent === 'local_coder' && r.source !== 'fallback',
		);
		expect(localCoderPrimary?.status).toBe('unresolved');

		// Dispatch decisions: both valid roles proceed past the REGISTERED
		// tool.execute.before chain (guardrails + delegation gate).
		await activateSession(host, sessionID, 'architect');
		await expect(
			dispatchTask(host, sessionID, 'call-legacy-explorer', 'explorer'),
		).resolves.toBeUndefined();
		await expect(
			dispatchTask(host, sessionID, 'call-local-explorer', 'local_explorer'),
		).resolves.toBeUndefined();
	});

	test('[AC4] a throwing catalog is queried but never turns into a dispatch failure', async () => {
		// The ghost model rides a READ-ONLY prefixed role so the fail-open
		// property is proven through the registered chain without unrelated
		// coder plan/scope gates.
		const ghostReadOnlyConfig = {
			swarms: {
				default: { name: 'Default' },
				local: {
					name: 'Local',
					agents: { explorer: { model: 'ghost/broken-model' } },
				},
			},
		};
		const { client, listCalls } = catalogClient(true);
		const host = await bootSwarmPluginHost(
			directory,
			ghostReadOnlyConfig,
			client,
		);
		const sessionID = 'preflight-ac4';

		// The preflight itself stays fail-open: no positive classes when the
		// catalog is unreachable, and the broken local_explorer override
		// cannot be confirmed against a down catalog.
		const result = await runModelPreflight(
			ghostReadOnlyConfig as unknown as PluginConfig,
			swarmState.opencodeClient,
			{ generatedAgentNames: swarmState.generatedAgentNames },
		);
		expect(result.catalogAvailable).toBe(false);
		expect(
			result.resolutions.every(
				(resolution) =>
					resolution.status === 'unknown' ||
					resolution.status === 'missing-selection',
			),
		).toBe(true);

		// Dispatch decisions: both roles — including the one whose model sits
		// on the unreachable ghost provider — proceed. A catalog warning alone
		// is not dispatch-failure evidence.
		await activateSession(host, sessionID, 'architect');
		await expect(
			dispatchTask(host, sessionID, 'call-explorer-down', 'explorer'),
		).resolves.toBeUndefined();
		await expect(
			dispatchTask(
				host,
				sessionID,
				'call-ghost-explorer-down',
				'local_explorer',
			),
		).resolves.toBeUndefined();
		// The catalog WAS actually consulted through the booted host's client.
		// (PRR-013 note: the count is intentionally not pinned to an exact
		// number — the preflight call plus each dispatch's admission lookup
		// re-consult a failing catalog because failures are never cached.)
		expect(listCalls()).toBeGreaterThan(0);
	});
});
