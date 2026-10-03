/**
 * Issue #3011/#3024 — direct unit coverage for the durable oversight-sequence
 * allocator (`nextFullAutoOversightSequence`) and its evidence catch-up scan
 * (`maxPersistedOversightEvidenceSequence`), complementing the end-to-end
 * fresh-process coverage in
 * tests/unit/hooks/full-auto-intercept-sequence-durability.test.ts.
 *
 * Pins the PR #3024 feedback-round contracts (parallel review F3/F4 + F2):
 *  - multi-phase-dir max selection (a scan that ignores a phase dir fails)
 *  - non-numeric evidence subdirectories are skipped (task-id dirs,
 *    gate-audit/, sbom/ — the locked walk stays bounded by phase count)
 *  - both fail-closed throw branches surface as a stable typed error with
 *    the persisted counter left untouched
 *  - unsafe integers are ignored on BOTH inputs: a hand-planted
 *    `full-auto-<huge>.json` filename cannot pin the allocation, and a
 *    corrupt persisted counter re-derives from disk instead of sticking
 *  - the safe-integer ceiling fails closed
 *
 * All cases run synchronously through the `_internals` DI seam (no
 * `mock.module`, per AGENTS.md invariant 7); seams are restored in
 * `afterEach`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	nextFullAutoOversightSequence,
} from '../../../src/full-auto/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalScan = _internals.scanOversightEvidenceSequence;
const originalReadPersisted = _internals.readPersisted;

afterEach(() => {
	_internals.scanOversightEvidenceSequence = originalScan;
	_internals.readPersisted = originalReadPersisted;
});

function seedEvidenceFile(
	dir: string,
	phaseName: string,
	sequence: number | string,
): void {
	const phaseDir = path.join(dir, '.swarm', 'evidence', phaseName);
	fs.mkdirSync(phaseDir, { recursive: true });
	fs.writeFileSync(
		path.join(phaseDir, `full-auto-${sequence}.json`),
		'{}\n',
		'utf-8',
	);
}

function seedState(dir: string, oversightSequence: number): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'full-auto-state.json'),
		`${JSON.stringify(
			{
				version: 2,
				updatedAt: '2026-10-01T00:00:00.000Z',
				oversightSequence,
				sessions: {},
			},
			null,
			2,
		)}\n`,
		'utf-8',
	);
}

function readPersistedCounter(dir: string): number {
	const raw = JSON.parse(
		fs.readFileSync(path.join(dir, '.swarm', 'full-auto-state.json'), 'utf-8'),
	) as { oversightSequence?: number };
	return raw.oversightSequence ?? 0;
}

describe('oversight evidence-sequence catch-up scan (direct)', () => {
	test('selects the max across multiple numeric phase dirs', () => {
		const dir = canonicalMkdtemp('p3011-alloc-');
		seedEvidenceFile(dir, '1', 10);
		seedEvidenceFile(dir, '2', 9);
		expect(_internals.scanOversightEvidenceSequence(dir)).toBe(10);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('skips non-numeric evidence subdirectories (task ids, gate-audit, sbom)', () => {
		const dir = canonicalMkdtemp('p3011-alloc-');
		seedEvidenceFile(dir, '1', 4);
		// A planted high sequence in a non-writer directory must not count.
		seedEvidenceFile(dir, 'sess-task-abc', 99);
		seedEvidenceFile(dir, 'gate-audit', 50);
		seedEvidenceFile(dir, 'sbom', 60);
		expect(_internals.scanOversightEvidenceSequence(dir)).toBe(4);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('missing evidence root and non-directory root both scan as 0', () => {
		const dir = canonicalMkdtemp('p3011-alloc-');
		expect(_internals.scanOversightEvidenceSequence(dir)).toBe(0);
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'evidence'),
			'not a dir',
			'utf-8',
		);
		expect(_internals.scanOversightEvidenceSequence(dir)).toBe(0);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('unsafe (non-safe-integer) filename values are skipped, safe ones still count', () => {
		const dir = canonicalMkdtemp('p3011-alloc-');
		seedEvidenceFile(dir, '1', 9007199254740992);
		seedEvidenceFile(dir, '1', 3);
		expect(_internals.scanOversightEvidenceSequence(dir)).toBe(3);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe('nextFullAutoOversightSequence (direct, via DI seams)', () => {
	test('catches the counter up past multi-phase evidence and persists it', () => {
		const dir = canonicalMkdtemp('p3011-alloc-');
		seedState(dir, 0);
		seedEvidenceFile(dir, '1', 10);
		seedEvidenceFile(dir, '2', 9);
		expect(nextFullAutoOversightSequence(dir)).toBe(11);
		expect(readPersistedCounter(dir)).toBe(11);
		// A second allocation is strictly monotonic.
		expect(nextFullAutoOversightSequence(dir)).toBe(12);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('a corrupt (unsafe) persisted counter is ignored and re-derived from disk', () => {
		const dir = canonicalMkdtemp('p3011-alloc-');
		seedState(dir, 9007199254740992);
		seedEvidenceFile(dir, '1', 5);
		// 9007199254740992 + 1 === 9007199254740992 would stick forever; the
		// allocator must ignore the unsafe counter and take fileMax + 1.
		expect(nextFullAutoOversightSequence(dir)).toBe(6);
		expect(readPersistedCounter(dir)).toBe(6);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('scan failure propagates a stable typed error and burns nothing', () => {
		const dir = canonicalMkdtemp('p3011-alloc-');
		seedState(dir, 7);
		_internals.scanOversightEvidenceSequence = () => {
			throw new Error(
				'Full-Auto oversight evidence scan failed for sequence allocation',
			);
		};
		expect(() => nextFullAutoOversightSequence(dir)).toThrow(
			'Full-Auto oversight evidence scan failed for sequence allocation',
		);
		_internals.scanOversightEvidenceSequence = originalScan;
		expect(readPersistedCounter(dir)).toBe(7);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('safe-integer ceiling fails closed', () => {
		const dir = canonicalMkdtemp('p3011-alloc-');
		seedState(dir, 0);
		_internals.scanOversightEvidenceSequence = () => Number.MAX_SAFE_INTEGER;
		expect(() => nextFullAutoOversightSequence(dir)).toThrow(
			'safe-integer ceiling',
		);
		_internals.scanOversightEvidenceSequence = originalScan;
		expect(readPersistedCounter(dir)).toBe(0);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
