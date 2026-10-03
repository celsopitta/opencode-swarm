/**
 * Roster guard for the default swarm models (issue #3022, AC1).
 *
 * The opencode zen keyless roster rotates without notice (minimax-m2.5-free and
 * gpt-5-nano were both live-verified UNAVAILABLE on 2026-10-02 — fresh installs
 * failed at first delegation with "Model unavailable"). This guard pins every
 * default model and fallback against a checked-in snapshot of ids that were
 * LIVE-VERIFIED keyless so the class cannot silently recur.
 *
 * REFRESH PROCEDURE (see tests/fixtures/opencode-zen-keyless-roster.json
 * `_meta.refreshProcedure` for the full text): on a clean OpenCode 2 host with
 * no API key, run `opencode run -m opencode/<id> -- "Reply with exactly: OK"`
 * for each current id plus new zen -free candidates (failures print
 * "Error: Model unavailable: <id>" while still exiting 0 — match text, not exit
 * codes). Update the fixture's `models`/`rejected`, then rotate
 * src/config/constants.ts onto the new roster. This test failing after a
 * fixture refresh is the guard working: the constants must follow the roster.
 */
import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_AGENT_CONFIGS,
	DEFAULT_MODELS,
} from '../../../src/config/constants';
import { VERIFIED_KEYLESS_MODEL_ROSTER } from '../../../src/services/model-preflight';
import fixtureJson from '../../../tests/fixtures/opencode-zen-keyless-roster.json' with {
	type: 'json',
};

const rosterFixture = fixtureJson as {
	_meta: { capturedAt: string; refreshProcedure: string };
	models: string[];
	rejected: { id: string; reason: string }[];
};

// The verified keyless roster, pinned as literals: a roster edit that does not
// intentionally come from a refresh run should be visible in this diff.
const VERIFIED_KEYLESS_ROSTER = [
	'opencode/big-pickle',
	'opencode/longcat-2.5-preview-free',
	'opencode/nemotron-3-ultra-free',
	'opencode/space-bunny-free',
	'opencode/mimo-v2.6-flash-free',
	'opencode/fledge-alpha-free',
	'opencode/nemotron-3.5-lightning-free',
	'opencode/muse-spark-1.3-contributor-free',
] as const;

const roster = new Set<string>(VERIFIED_KEYLESS_ROSTER);

describe('opencode zen keyless roster snapshot (issue #3022)', () => {
	test('fixture matches the pinned verified roster', () => {
		expect(rosterFixture.models).toEqual([...VERIFIED_KEYLESS_ROSTER]);
	});

	test('the runtime roster const (v2 startup preflight) matches the fixture', () => {
		// Single roster source of truth: src/services/model-preflight.ts embeds
		// the list for clientless v2 startup checks; this pin keeps the const
		// and the fixture from drifting apart.
		expect([...VERIFIED_KEYLESS_MODEL_ROSTER]).toEqual(rosterFixture.models);
	});

	test('fixture is well-formed', () => {
		expect(rosterFixture._meta.capturedAt.length).toBeGreaterThan(0);
		expect(rosterFixture._meta.refreshProcedure.length).toBeGreaterThan(0);
		expect(rosterFixture.models.length).toBe(VERIFIED_KEYLESS_ROSTER.length);
		for (const id of rosterFixture.models) {
			expect(id.startsWith('opencode/')).toBe(true);
		}
		expect(new Set(rosterFixture.models).size).toBe(
			rosterFixture.models.length,
		);
	});

	test('the #3022 broken defaults are recorded as rejected', () => {
		const rejectedIds = new Set(rosterFixture.rejected.map((r) => r.id));
		expect(rejectedIds.has('opencode/minimax-m2.5-free')).toBe(true);
		expect(rejectedIds.has('opencode/gpt-5-nano')).toBe(true);
	});
});

describe('default models resolve against the verified roster (issue #3022 AC1)', () => {
	test('every DEFAULT_MODELS value is in the roster', () => {
		const offenders: string[] = [];
		for (const [role, model] of Object.entries(DEFAULT_MODELS)) {
			if (!roster.has(model)) offenders.push(`DEFAULT_MODELS.${role}=${model}`);
		}
		expect(offenders).toEqual([]);
	});

	test('every DEFAULT_AGENT_CONFIGS model and fallback is in the roster', () => {
		const offenders: string[] = [];
		for (const [role, cfg] of Object.entries(DEFAULT_AGENT_CONFIGS)) {
			if (!roster.has(cfg.model)) {
				offenders.push(`DEFAULT_AGENT_CONFIGS.${role}.model=${cfg.model}`);
			}
			for (const fb of cfg.fallback_models) {
				if (!roster.has(fb)) {
					offenders.push(`DEFAULT_AGENT_CONFIGS.${role}.fallback=${fb}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('no default or fallback references the retired #3022 ids', () => {
		const retired = new Set([
			'opencode/minimax-m2.5-free',
			'opencode/gpt-5-nano',
		]);
		for (const model of Object.values(DEFAULT_MODELS)) {
			expect(retired.has(model)).toBe(false);
		}
		for (const cfg of Object.values(DEFAULT_AGENT_CONFIGS)) {
			expect(retired.has(cfg.model)).toBe(false);
			for (const fb of cfg.fallback_models) {
				expect(retired.has(fb)).toBe(false);
			}
		}
	});
});
