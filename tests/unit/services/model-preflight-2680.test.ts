/**
 * Final enabled-role model-selection preflight — issue #2680.
 *
 * The preflight must validate the FINAL effective selection of every ENABLED
 * legacy and prefixed multi-swarm role (reusing the exact-name helpers), with
 * distinct bounded outcome classes: missing provider (unresolved),
 * missing-selection (catalog-independent), host-controlled primaries, and
 * explicit-and-recorded fallbacks. Disabled and feature-gated roles are never
 * collected; ok/unknown/host-controlled entries produce no warning noise.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { createAgents } from '../../../src/agents';
import type { PluginConfig } from '../../../src/config';
import {
	collectEnabledAgentModels,
	enumerateEnabledAgentRoles,
	formatModelPreflightWarning,
	invalidateProviderCatalogCache,
	PROVIDER_LIST_TIMEOUT_MS,
	resolveAgainstCatalog,
	runModelPreflight,
	sanitizePreflightText,
} from '../../../src/services/model-preflight';

interface FakeProvider {
	id: string;
	models: Record<string, { id: string }>;
}

function fakeClient(providers: FakeProvider[]): OpencodeClient {
	return {
		provider: {
			list: async () => ({
				data: {
					all: providers.map((provider) => ({
						id: provider.id,
						name: provider.id,
						models: provider.models,
					})),
				},
			}),
		},
	} as unknown as OpencodeClient;
}

const CATALOG: FakeProvider[] = [
	{
		id: 'opencode',
		models: {
			// #3022: current DEFAULT_MODELS ids + the retired ids kept as
			// user-override fixtures.
			'big-pickle': { id: 'big-pickle' },
			'nemotron-3-ultra-free': { id: 'nemotron-3-ultra-free' },
			'mimo-v2.6-flash-free': { id: 'mimo-v2.6-flash-free' },
			'minimax-m2.5-free': { id: 'minimax-m2.5-free' },
			'gpt-5-nano': { id: 'gpt-5-nano' },
		},
	},
	{ id: 'anthropic', models: { 'claude-x': { id: 'claude-x' } } },
];

const MULTI_SWARM_CONFIG = {
	swarms: {
		local: {
			agents: {
				coder: {
					model: 'ghost/broken-model',
					fallback_models: ['opencode/big-pickle'],
				},
				reviewer: { disabled: true },
			},
		},
		mega: {
			agents: {
				explorer: { model: 'opencode/big-pickle' },
				reviewer: { disabled: true },
			},
		},
	},
} as unknown as PluginConfig;

describe('issue #2680 — final enabled-role model preflight', () => {
	beforeEach(() => {
		invalidateProviderCatalogCache();
	});

	afterEach(() => {
		invalidateProviderCatalogCache();
	});

	// ── Invariant-11 drift guard: the config-only enumeration must match what
	// createAgents actually generates across corner configurations. ──────────
	test('parity: enumerateEnabledAgentRoles matches createAgents across corner configs', () => {
		const cases: { name: string; config: PluginConfig }[] = [
			{
				name: 'legacy top-level only',
				config: {
					agents: { critic: { model: 'opencode/big-pickle' } },
				} as unknown as PluginConfig,
			},
			{
				name: 'multi-swarm named',
				config: MULTI_SWARM_CONFIG,
			},
			{
				name: 'mixed default + named swarms',
				config: {
					swarms: {
						default: { agents: { coder: { disabled: true } } },
						paid: { agents: { critic: { model: 'opencode/big-pickle' } } },
					},
				} as unknown as PluginConfig,
			},
			{
				name: 'feature gates on with one gated role also disabled',
				config: {
					council: { general: { enabled: true } },
					design_docs: { enabled: true },
					ui_review: { enabled: true },
					agents: { designer: { disabled: true } },
				} as unknown as PluginConfig,
			},
			{
				name: 'multi-underscore swarm id',
				config: {
					swarms: {
						my_swarm: {
							agents: { coder: { model: 'opencode/big-pickle' } },
						},
					},
				} as unknown as PluginConfig,
			},
			{
				name: 'gates off + always-on roles disabled',
				config: {
					agents: {
						coder: { disabled: true },
						critic_oversight: { disabled: true },
					},
				} as unknown as PluginConfig,
			},
		];
		for (const { name, config } of cases) {
			const generated = createAgents(config).map((agent) => agent.name);
			const enumerated = enumerateEnabledAgentRoles(config);
			expect(new Set(enumerated), `parity failure for case: ${name}`).toEqual(
				new Set(generated),
			);
		}
	});

	test('[AC2] missing provider yields the distinct unresolved class with actionable detail', async () => {
		const result = await runModelPreflight(
			MULTI_SWARM_CONFIG,
			fakeClient(CATALOG),
		);
		expect(result.catalogAvailable).toBe(true);
		const ghost = result.resolutions.find(
			(resolution) => resolution.model === 'ghost/broken-model',
		);
		expect(ghost).toBeDefined();
		expect(ghost?.agent).toBe('local_coder');
		expect(ghost?.status).toBe('unresolved');
		expect(ghost?.detail).toContain(
			'provider "ghost" is not present in the provider catalog',
		);
	});

	test('[AC3] disabled and feature-gated roles are excluded; uninvoked ok roles and primaries stay silent; enabled unresolved is reported', async () => {
		const collected = collectEnabledAgentModels(MULTI_SWARM_CONFIG);
		// (a) no non-ok noise sources are even collected
		expect(collected.some((entry) => entry.agent === 'reviewer')).toBe(false);
		expect(
			collected.some((entry) => entry.agent.startsWith('docs_design')),
		).toBe(false);

		const result = await runModelPreflight(
			MULTI_SWARM_CONFIG,
			fakeClient(CATALOG),
		);
		// Disabled reviewer (any swarm) and flag-off optional roles never appear.
		expect(
			result.resolutions.filter(
				(resolution) =>
					resolution.agent === 'reviewer' ||
					resolution.agent === 'mega_reviewer' ||
					resolution.agent.startsWith('docs_design'),
			),
		).toHaveLength(0);

		// (b) a healthy catalog on an all-valid config yields NO warning —
		// uninvoked roles (enabled, never dispatched) with ok selections and
		// host-controlled primaries produce no consumer-default noise.
		const healthy = await runModelPreflight(
			{
				swarms: {
					default: {},
					local: { agents: { explorer: { model: 'opencode/big-pickle' } } },
				},
			} as unknown as PluginConfig,
			fakeClient(CATALOG),
		);
		expect(formatModelPreflightWarning(healthy)).toBeNull();

		// (c) the enabled unresolved role IS surfaced by the same surfaces.
		const warning = formatModelPreflightWarning(result);
		expect(warning).not.toBeNull();
		expect(warning).toContain('local_coder');
		expect(warning).toContain('ghost/broken-model');
		// Primary (host-controlled) entries never appear in the warning.
		expect(warning).not.toContain('architect');
	});

	test('[AC5] catalog fetch stays bounded and fail-open; valid selections are never rejected on catalog outage', async () => {
		// Timeout bound unchanged (invariant 1 contract).
		expect(PROVIDER_LIST_TIMEOUT_MS).toBe(2_000);
		// Null client: everything except catalog-independent classes is unknown.
		const result = await runModelPreflight(MULTI_SWARM_CONFIG, null);
		expect(result.catalogAvailable).toBe(false);
		expect(
			result.resolutions.every(
				(resolution) =>
					resolution.status === 'unknown' ||
					resolution.status === 'missing-selection',
			),
		).toBe(true);
		// A throwing catalog client also fails open.
		const throwingClient = {
			provider: {
				list: async () => {
					throw new Error('catalog unreachable');
				},
			},
		} as unknown as OpencodeClient;
		const failed = await runModelPreflight(MULTI_SWARM_CONFIG, throwingClient);
		expect(failed.catalogAvailable).toBe(false);
		expect(
			failed.resolutions.every((resolution) => resolution.status === 'unknown'),
		).toBe(true);
	});

	test('[AC6] an enabled role with no valid final selection gets the distinct missing-selection class', async () => {
		// Blank explicit override: never silently treated as a default.
		const blankOverride = {
			swarms: {
				local: { agents: { coder: { model: '   ' } } },
			},
		} as unknown as PluginConfig;
		const blank = await runModelPreflight(blankOverride, fakeClient(CATALOG));
		const blankEntry = blank.resolutions.find(
			(resolution) => resolution.agent === 'local_coder',
		);
		expect(blankEntry?.status).toBe('missing-selection');
		expect(blankEntry?.detail).toContain('no final model selection');

		// Stale registry name (swarm absent from config): the precedence chain
		// yields nothing through the live-registry path.
		const stale = collectEnabledAgentModels(
			{
				swarms: { local: {} },
			} as unknown as PluginConfig,
			{ generatedAgentNames: ['local_coder', 'ghostswarm_coder'] },
		);
		const staleEntry = stale.find(
			(entry) => entry.agent === 'ghostswarm_coder',
		);
		expect(staleEntry?.model).toBe('');
		// And it classifies missing-selection even while the catalog is DOWN
		// (catalog-independent class).
		const staleDown = await runModelPreflight(
			{
				swarms: { local: {} },
			} as unknown as PluginConfig,
			null,
			{ generatedAgentNames: ['ghostswarm_coder'] },
		);
		expect(staleDown.resolutions[0]?.status).toBe('missing-selection');
	});

	test('[AC7] explicit fallbacks are their own recorded class; none are synthesized', () => {
		const collected = collectEnabledAgentModels(MULTI_SWARM_CONFIG);
		const fallbacks = collected.filter((entry) => entry.source === 'fallback');
		// Only the explicitly configured local coder fallback appears.
		expect(fallbacks).toHaveLength(1);
		expect(fallbacks[0]).toEqual({
			agent: 'local_coder',
			model: 'opencode/big-pickle',
			source: 'fallback',
			mode: 'subagent',
		});
		// Roles without explicit fallback_models (e.g. curator_init, explorer)
		// get zero fallback entries — the curator runtime inheritance from
		// explorer is documented, not duplicated here.
		expect(
			collected.filter(
				(entry) =>
					entry.source === 'fallback' &&
					(entry.agent.includes('curator') || entry.agent.includes('explorer')),
			),
		).toHaveLength(0);
	});

	// PRR-004 disposition pin (PR review): a blank-model PRIMARY is classified
	// missing-selection (a real config error worth surfacing) — dispatched
	// primaries stay exempt regardless; this pins the classification ORDER.
	test('[AC6] ordering pin: a blank-model primary classifies missing-selection, not host-controlled', async () => {
		const blankPrimary = {
			swarms: {
				default: { agents: { architect: { model: '   ' } } },
			},
		} as unknown as PluginConfig;
		const result = await runModelPreflight(blankPrimary, fakeClient(CATALOG));
		const entry = result.resolutions.find((r) => r.agent === 'architect');
		expect(entry?.mode).toBe('primary');
		expect(entry?.status).toBe('missing-selection');
	});

	// PRR-001 (PR review): hostile config values must not structure the
	// warning text — newlines/ANSI from the model string are neutralized.
	test('[AC2] warning text neutralizes control characters from hostile model values', () => {
		const esc = String.fromCharCode(27);
		const hostile = [
			{
				agent: 'local_coder',
				model: `ghost/x\nFAKE WARNING${esc}[31mRED`,
				source: 'override' as const,
			},
		];
		const catalog = new Map(
			CATALOG.map((provider) => [
				provider.id,
				new Set(Object.keys(provider.models)),
			]),
		);
		const result = resolveAgainstCatalog(hostile, catalog);
		const warning = formatModelPreflightWarning(result);
		expect(warning).not.toBeNull();
		// Only the template's own structural newlines remain (3 lines:
		// header, one entry row, footer).
		expect(warning?.split('\n').length).toBe(3);
		expect(warning).not.toContain('FAKE WARNING\n');
		expect(warning).not.toContain(esc);
		// ESC is stripped; the orphaned printable sequence remains (control
		// chars are the injection vector, not printable text).
		expect(sanitizePreflightText(`a\nb${esc}[31mc`)).toBe('a b [31mc');
	});
});
