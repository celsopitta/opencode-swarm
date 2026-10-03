import { describe, expect, test } from 'bun:test';
import {
	collectModelRosterWarnings,
	VERIFIED_KEYLESS_MODEL_ROSTER,
} from '../../../src/services/model-preflight';

/**
 * Issue #3022 (AC4) — clientless roster preflight.
 *
 * `collectModelRosterWarnings` is the pure surface the v2 startup preflight
 * uses (v2 hosts carry no OpencodeClient, so the catalog-backed
 * `runModelPreflight` degrades to all-`unknown`). It must warn for every
 * off-roster id — deduped — and stay silent when everything resolves.
 */
const ROSTER = [
	'opencode/big-pickle',
	'opencode/nemotron-3-ultra-free',
	'opencode/mimo-v2.6-flash-free',
];

describe('#3022 collectModelRosterWarnings', () => {
	test('string[] input: warns per off-roster id, deduped', () => {
		const warnings = collectModelRosterWarnings(
			[
				'opencode/minimax-m2.5-free',
				'opencode/gpt-5-nano',
				'opencode/minimax-m2.5-free',
				'opencode/big-pickle',
			],
			ROSTER,
		);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain('opencode/minimax-m2.5-free');
		expect(warnings[1]).toContain('opencode/gpt-5-nano');
	});

	test('DEFAULT_AGENT_CONFIGS-shaped record input: models and fallbacks checked', () => {
		const bad = collectModelRosterWarnings(
			{
				coder: {
					model: 'opencode/minimax-m2.5-free',
					fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
				},
			},
			ROSTER,
		);
		expect(bad).toHaveLength(2);

		const good = collectModelRosterWarnings(
			{
				coder: {
					model: 'opencode/nemotron-3-ultra-free',
					fallback_models: ['opencode/big-pickle'],
				},
			},
			ROSTER,
		);
		expect(good).toEqual([]);
	});

	test('all-resolving input produces no warnings', () => {
		expect(collectModelRosterWarnings(ROSTER, ROSTER)).toEqual([]);
	});

	test('degenerate inputs produce no warnings', () => {
		expect(collectModelRosterWarnings([], ROSTER)).toEqual([]);
		expect(collectModelRosterWarnings({}, ROSTER)).toEqual([]);
		expect(collectModelRosterWarnings({ coder: {} }, ROSTER)).toEqual([]);
	});

	test('non-zen providers are out of scope (#3022 review round 1: no false failures)', () => {
		const warnings = collectModelRosterWarnings(
			['anthropic/claude-sonnet-5', 'xai/grok-4.7', 'openai/gpt-5.5'],
			ROSTER,
		);
		expect(warnings).toEqual([]);
	});

	test('mixed config: only off-roster opencode/ ids warn', () => {
		const warnings = collectModelRosterWarnings(
			[
				'anthropic/claude-x',
				'opencode/minimax-m2.5-free',
				'opencode/big-pickle',
			],
			ROSTER,
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('opencode/minimax-m2.5-free');
	});

	test('the shipped roster const is non-empty and opencode-prefixed', () => {
		expect(VERIFIED_KEYLESS_MODEL_ROSTER.length).toBeGreaterThan(0);
		for (const id of VERIFIED_KEYLESS_MODEL_ROSTER) {
			expect(id.startsWith('opencode/')).toBe(true);
		}
		expect(new Set(VERIFIED_KEYLESS_MODEL_ROSTER).size).toBe(
			VERIFIED_KEYLESS_MODEL_ROSTER.length,
		);
	});
});
