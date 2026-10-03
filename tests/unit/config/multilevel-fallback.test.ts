import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
	DEFAULT_AGENT_CONFIGS,
	DEFAULT_MODELS,
} from '../../../src/config/constants';
import rosterJson from '../../fixtures/opencode-zen-keyless-roster.json' with {
	type: 'json',
};

/**
 * Multi-level fallback configuration tests (v6.85+; rewritten for #3022).
 *
 * Before #3022 this suite pinned a LOCAL COPY of the default agents table —
 * a fiction that had already drifted (council_member/council_moderator entries
 * production never had) and silently rotted with the roster. It now imports the
 * REAL constants and asserts the structural invariants against the checked-in
 * verified keyless roster (fixture membership; refresh procedure in the fixture
 * _meta and tests/unit/config/default-models-roster-guard.test.ts).
 *
 * Invariants:
 * 1. Primary agents have 2-level fallback chains (depth 3); lightweight agents
 *    have 1-level (depth 2).
 * 2. Fallback chains only use models from the verified keyless roster.
 * 3. The first fallback of a big-pickle primary is the cheap tier (ordering
 *    pin — membership alone would accept reordered chains).
 * 4. Schema max-3 fallbacks respected.
 */

const AgentOverrideConfigSchema = z.object({
	model: z.string().optional(),
	temperature: z.number().min(0).max(2).optional(),
	disabled: z.boolean().optional(),
	fallback_models: z.array(z.string()).max(3).optional(),
});

type AgentOverrideConfig = z.infer<typeof AgentOverrideConfigSchema>;

const ROSTER = new Set<string>((rosterJson as { models: string[] }).models);
const CHEAP_TIER = 'opencode/mimo-v2.6-flash-free';
const STRONG_DEFAULT = 'opencode/big-pickle';

const DEFAULT_AGENTS: Record<string, AgentOverrideConfig> =
	DEFAULT_AGENT_CONFIGS;

describe('Multi-Level Fallback Configuration', () => {
	test('All default agents have valid schema-compliant configurations', () => {
		for (const [agent, config] of Object.entries(DEFAULT_AGENTS)) {
			const result = AgentOverrideConfigSchema.safeParse(config);
			expect(result.success).toBe(true);
			if (!result.success) {
				console.error(
					`Agent ${agent} failed validation:`,
					result.error.message,
				);
			}
		}
	});

	test('Agents with primary big-pickle have 2-level fallback', () => {
		const bigPickleAgents = [
			'reviewer',
			'explorer',
			'sme',
			'critic',
			'docs',
			'designer',
		];

		for (const agent of bigPickleAgents) {
			const config = DEFAULT_AGENTS[agent];
			expect(config.model).toBe(STRONG_DEFAULT);
			expect(config.fallback_models).toBeDefined();
			expect(config.fallback_models?.length).toBe(2);
			expect(config.fallback_models?.[0]).toBe(CHEAP_TIER);
			expect(config.fallback_models?.[1]).toBe(STRONG_DEFAULT);
		}
	});

	test('Coder has 2-level fallback (nemotron → cheap tier → big-pickle)', () => {
		const config = DEFAULT_AGENTS.coder;
		expect(config.model).toBe('opencode/nemotron-3-ultra-free');
		expect(config.fallback_models).toEqual([CHEAP_TIER, STRONG_DEFAULT]);
	});

	test('Lightweight agents have 1-level fallback', () => {
		const lightweightAgents = [
			'test_engineer',
			'critic_sounding_board',
			'critic_drift_verifier',
			'critic_hallucination_verifier',
			'critic_oversight',
			'curator_init',
			'curator_phase',
			'curator_postmortem',
			'curator_consolidation',
		];

		for (const agent of lightweightAgents) {
			const config = DEFAULT_AGENTS[agent];
			expect(config.model).toBe(CHEAP_TIER);
			expect(config.fallback_models).toBeDefined();
			expect(config.fallback_models?.length).toBe(1);
			expect(config.fallback_models?.[0]).toBe(STRONG_DEFAULT);
		}
	});

	test('All default and fallback models are from the verified keyless roster (#3022)', () => {
		for (const [agent, config] of Object.entries(DEFAULT_AGENTS)) {
			if (config.model && !ROSTER.has(config.model)) {
				throw new Error(
					`Agent ${agent} has off-roster primary model: ${config.model}`,
				);
			}
			for (const fallback of config.fallback_models || []) {
				if (!ROSTER.has(fallback)) {
					throw new Error(
						`Agent ${agent} has off-roster fallback model: ${fallback}`,
					);
				}
			}
		}
		for (const [role, model] of Object.entries(DEFAULT_MODELS)) {
			if (!ROSTER.has(model)) {
				throw new Error(`DEFAULT_MODELS.${role} is off-roster: ${model}`);
			}
		}
	});

	test('Schema respects max 3 fallbacks limit', () => {
		for (const [, config] of Object.entries(DEFAULT_AGENTS)) {
			const fallbackCount = config.fallback_models?.length || 0;
			expect(fallbackCount).toBeLessThanOrEqual(3);
		}
	});

	test('Fallback chains provide meaningful recovery', () => {
		// Scenario 1: Coder primary unavailable
		const coderChain = [
			DEFAULT_AGENTS.coder.model,
			...(DEFAULT_AGENTS.coder.fallback_models || []),
		];
		const coderAvailableFallback = coderChain.find(
			(m) => m !== DEFAULT_AGENTS.coder.model,
		);
		expect(coderAvailableFallback).toBeDefined();

		// Scenario 2: Critic exhaustion path — fallback to third level
		const criticChain = [
			DEFAULT_AGENTS.critic.model,
			...(DEFAULT_AGENTS.critic.fallback_models || []),
		];
		expect(criticChain).toHaveLength(3);
		expect(criticChain[0]).toBe(STRONG_DEFAULT);
		expect(criticChain[1]).toBe(CHEAP_TIER);
		expect(criticChain[2]).toBe(STRONG_DEFAULT);

		// Scenario 3: Only big-pickle available ensures no complete failure
		const testEngineerChain = [
			DEFAULT_AGENTS.test_engineer.model,
			...(DEFAULT_AGENTS.test_engineer.fallback_models || []),
		];
		expect(testEngineerChain).toEqual([CHEAP_TIER, STRONG_DEFAULT]);
	});

	test('Each agent has a model assignment (explicit or inherited)', () => {
		const agentsWithoutModel = Object.entries(DEFAULT_AGENTS).filter(
			([, config]) => !config.model,
		);
		expect(agentsWithoutModel).toHaveLength(0);
	});

	test('Fallback models exclude removed/inconsistent models', () => {
		const disallowedModels = [
			'opencode/trinity-large-preview-free', // v6.84.6 removed
			'opencode/minimax-m2.5-free', // #3022: dropped from the zen keyless roster
			'opencode/gpt-5-nano', // #3022: dropped from the zen keyless roster
		];

		for (const [, config] of Object.entries(DEFAULT_AGENTS)) {
			for (const fallback of config.fallback_models || []) {
				for (const disallowed of disallowedModels) {
					expect(fallback).not.toBe(disallowed);
				}
			}
		}
	});

	test('Resilience summary: agents have recovery depth', () => {
		const resilienceCounts: Record<string, number> = {};

		for (const [agent, config] of Object.entries(DEFAULT_AGENTS)) {
			const depth = (config.fallback_models?.length || 0) + 1; // +1 for primary
			resilienceCounts[agent] = depth;
		}

		// Primary agents should have depth 3 (primary + 2 fallbacks)
		[
			'coder',
			'reviewer',
			'explorer',
			'sme',
			'critic',
			'docs',
			'designer',
		].forEach((agent) => {
			expect(resilienceCounts[agent]).toBe(3);
		});

		// Lightweight agents should have depth 2 (primary + 1 fallback)
		['test_engineer', 'critic_sounding_board', 'curator_init'].forEach(
			(agent) => {
				expect(resilienceCounts[agent]).toBe(2);
			},
		);
	});
});
