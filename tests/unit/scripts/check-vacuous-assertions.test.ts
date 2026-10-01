/**
 * Unit tests for scripts/check-vacuous-assertions.ts (issue #2903).
 *
 * Fixture discipline (plan §G): every source line below that would itself
 * match a rule carries an inline `// vacuous-ok: detector fixture` marker, so
 * this file scans to ZERO unmarked findings (pinned by the self-scan test at
 * the bottom). Positive-firing fixtures are MATERIALIZED with the marker
 * stripped (`stripMarker`), so the detector sees them unmarked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	evaluateRatchet,
	literalsEqual,
	normalizeLiteral,
	parseBaseline,
	resolveEnforce,
	scanContent,
} from '../../../scripts/check-vacuous-assertions.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const MARKER_SUFFIX = / \/\/ vacuous-ok: detector fixture.*$/;

/** Strip the dogfood marker so a materialized fixture line reaches the detector unmarked. */
function stripMarker(line: string): string {
	return line.replace(MARKER_SUFFIX, '');
}

/** Materialize fixture lines into a temp .test.ts file and return its absolute path. */
function materialize(lines: string[]): string {
	const dir = canonicalMkdtemp('vacuous-detector-');
	const file = path.join(dir, 'fixture.test.ts');
	fs.writeFileSync(file, `${lines.map(stripMarker).join('\n')}\n`, 'utf8');
	return file;
}

/** Scan a fixture directly from its source lines. */
function scanLines(lines: string[]): ReturnType<typeof scanContent> {
	return scanContent(`${lines.map(stripMarker).join('\n')}\n`);
}

let tempRoots: string[] = [];
function trackRoot(p: string): void {
	tempRoots.push(path.dirname(p));
}

afterAll(() => {
	for (const dir of tempRoots) {
		try {
			fs.rmSync(dir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		} catch {
			// best-effort cleanup
		}
	}
	tempRoots = [];
});

describe('rule detection (positives fire at exact lines)', () => {
	it('flags len-ge-0 and size-ge-0', () => {
		const sites = scanLines([
			'const ok = 1;', // line 1 (preamble keeps line numbers honest)
			'expect(items.length).toBeGreaterThanOrEqual(0); // vacuous-ok: detector fixture',
			'expect(map.size).toBeGreaterThanOrEqual(0); // vacuous-ok: detector fixture',
		]);
		expect(sites).toEqual([
			{ line: 2, rule: 'len-ge-0' },
			{ line: 3, rule: 'size-ge-0' },
		]);
	});

	it('flags the true-to-true shape as true-to-be-true (precedence over literal-same-to-be)', () => {
		const sites = scanLines([
			'expect(true).toBe(true); // vacuous-ok: detector fixture',
		]);
		expect(sites).toEqual([{ line: 1, rule: 'true-to-be-true' }]);
	});

	it('flags the false-to-be-false shape as literal-same-to-be', () => {
		const sites = scanLines([
			'expect(false).toBe(false); // vacuous-ok: detector fixture',
		]);
		expect(sites).toEqual([{ line: 1, rule: 'literal-same-to-be' }]);
	});

	it('flags same-literal toBe across mixed quotes and mixed whitespace (normalization)', () => {
		const sites = scanLines([
			'expect(\'same\').toBe("same"); // vacuous-ok: detector fixture',
			'expect(7).toBe( 7 ); // vacuous-ok: detector fixture',
		]);
		expect(sites).toEqual([
			{ line: 1, rule: 'literal-same-to-be' },
			{ line: 2, rule: 'literal-same-to-be' },
		]);
	});

	it('flags literal toBeDefined', () => {
		const sites = scanLines([
			'expect(7).toBeDefined(); // vacuous-ok: detector fixture',
		]);
		expect(sites).toEqual([{ line: 1, rule: 'literal-to-be-defined' }]);
	});

	it('reports at most one finding per line (first match wins)', () => {
		const sites = scanLines([
			'if (x) expect(items.length).toBeGreaterThanOrEqual(0); // vacuous-ok: detector fixture',
		]);
		expect(sites.length).toBe(1);
	});
});

describe('rule detection (negatives never fire)', () => {
	it('does not flag indexOf / findIndex / search results or counters', () => {
		const sites = scanLines([
			"expect(items.indexOf('a')).toBeGreaterThanOrEqual(0);",
			"expect(items.findIndex((i) => i === 'a')).toBeGreaterThanOrEqual(0);",
			'expect(haystack.search(/a/)).toBeGreaterThanOrEqual(0);',
			'expect(processedCount).toBeGreaterThanOrEqual(0);',
		]);
		expect(sites).toEqual([]);
	});

	it('does not flag other matchers or a concrete count', () => {
		const sites = scanLines([
			'expect(items.length).toBeGreaterThan(0);',
			'expect(items.length).toBe(2);',
			'expect(items.length).toBeGreaterThanOrEqual(1);',
		]);
		expect(sites).toEqual([]);
	});

	it('does not flag kind-mismatched literals (string vs number)', () => {
		expect(literalsEqual("'7'", '7')).toBe(false);
		const sites = scanLines(["expect('7').toBe(7);"]);
		expect(sites).toEqual([]);
	});

	it('does not flag different literals', () => {
		const sites = scanLines(["expect('a').toBe('b');", 'expect(1).toBe(2);']);
		expect(sites).toEqual([]);
	});
});

describe('marker suppression', () => {
	it('suppresses a site marked on the same line', () => {
		const sites = scanLines([
			'expect(true).toBe(true); // vacuous-ok: deliberate skip indicator',
		]);
		expect(sites).toEqual([]);
	});

	it('suppresses a site marked on the preceding line', () => {
		const sites = scanLines([
			'// vacuous-ok: deliberate probe, table-exists',
			'expect(rows.length).toBeGreaterThanOrEqual(0); // vacuous-ok: detector fixture',
		]);
		expect(sites).toEqual([]);
	});

	it('does not suppress when the marker is two lines above', () => {
		const sites = scanLines([
			'// vacuous-ok: deliberate probe',
			'const preamble = 0;',
			'expect(rows.length).toBeGreaterThanOrEqual(0); // vacuous-ok: detector fixture',
		]);
		expect(sites).toEqual([{ line: 3, rule: 'len-ge-0' }]);
	});
});

describe('literal normalization helpers', () => {
	it('kind-tags strings, numbers, and keywords', () => {
		expect(normalizeLiteral("  'a' ")).toEqual({ kind: 'string', value: 'a' });
		expect(normalizeLiteral(' 7 ')).toEqual({ kind: 'number', value: '7' });
		expect(normalizeLiteral('null')).toEqual({
			kind: 'keyword',
			value: 'null',
		});
		expect(normalizeLiteral('')).toBeNull();
	});
	it('treats single- and double-quoted content as equal', () => {
		expect(literalsEqual("'a'", '"a"')).toBe(true);
	});
});

describe('resolveEnforce truth table', () => {
	it('defaults to enforce when unset or unrecognized', () => {
		expect(resolveEnforce(undefined)).toBe(true);
		expect(resolveEnforce('1')).toBe(true);
		expect(resolveEnforce('yes')).toBe(true);
	});
	it('soft-warns on 0/false/no/off (case-insensitive)', () => {
		expect(resolveEnforce('0')).toBe(false);
		expect(resolveEnforce('FALSE')).toBe(false);
		expect(resolveEnforce('no')).toBe(false);
		expect(resolveEnforce('Off')).toBe(false);
	});
});

describe('parseBaseline (flat map)', () => {
	it('reads numeric entries and ignores non-numeric metadata keys', () => {
		const parsed = parseBaseline(
			'{"$comment":"meta","a.test.ts":2,"b.test.ts":0,"ignored":"text"}',
		);
		expect(parsed).toEqual({ 'a.test.ts': 2, 'b.test.ts': 0 });
	});
});

describe('evaluateRatchet decision table', () => {
	const counts = (map: Record<string, number>) => (file: string) =>
		map[file] ?? null;

	it('violates a changed file with sites and no baseline entry', () => {
		const r = evaluateRatchet({
			changedFiles: ['a.test.ts'],
			currentCount: counts({ 'a.test.ts': 1 }),
			baseline: {},
			baselineAtBase: null,
			enforce: true,
		});
		expect(r.newFileViolations).toBe(1);
		expect(r.exitCode).toBe(1);
		expect(
			r.messages.some((m) => m.startsWith('ERROR') && m.includes('a.test.ts')),
		).toBe(true);
	});

	it('passes a changed file within its baseline count', () => {
		const r = evaluateRatchet({
			changedFiles: ['b.test.ts'],
			currentCount: counts({ 'b.test.ts': 1 }),
			baseline: { 'b.test.ts': 1 },
			baselineAtBase: null,
			enforce: true,
		});
		expect(r.violations).toBe(0);
		expect(r.exitCode).toBe(0);
	});

	it('violates growth beyond the baseline (ratchet arm)', () => {
		const r = evaluateRatchet({
			changedFiles: ['b.test.ts'],
			currentCount: counts({ 'b.test.ts': 3 }),
			baseline: { 'b.test.ts': 2 },
			baselineAtBase: null,
			enforce: true,
		});
		expect(r.ratchetViolations).toBe(1);
		expect(r.exitCode).toBe(1);
	});

	it('allows shrinking and skips deleted or non-test files', () => {
		const r = evaluateRatchet({
			changedFiles: ['b.test.ts', 'gone.test.ts', 'src/x.ts'],
			currentCount: counts({ 'b.test.ts': 0 }),
			baseline: { 'b.test.ts': 2 },
			baselineAtBase: null,
			enforce: true,
		});
		expect(r.violations).toBe(0);
	});

	it('soft-warns instead of failing when enforce is off', () => {
		const r = evaluateRatchet({
			changedFiles: ['a.test.ts'],
			currentCount: counts({ 'a.test.ts': 2 }),
			baseline: {},
			baselineAtBase: null,
			enforce: false,
		});
		expect(r.violations).toBe(1);
		expect(r.exitCode).toBe(0);
		expect(r.messages.some((m) => m.includes('soft-warn'))).toBe(true);
	});

	it('violates baseline growth vs the base branch (new entry or higher count)', () => {
		const grown = evaluateRatchet({
			changedFiles: [],
			currentCount: counts({}),
			baseline: { 'b.test.ts': 3 },
			baselineAtBase: { 'b.test.ts': 2 },
			enforce: true,
		});
		expect(grown.baselineGrowthViolations).toBe(1);
		expect(grown.exitCode).toBe(1);

		const added = evaluateRatchet({
			changedFiles: [],
			currentCount: counts({}),
			baseline: { 'c.test.ts': 1 },
			baselineAtBase: { 'b.test.ts': 2 },
			enforce: true,
		});
		expect(added.baselineGrowthViolations).toBe(1);
	});

	it('reports the introduction arm when the baseline is absent at base', () => {
		const r = evaluateRatchet({
			changedFiles: [],
			currentCount: counts({}),
			baseline: { 'b.test.ts': 2 },
			baselineAtBase: null,
			enforce: true,
		});
		expect(r.violations).toBe(0);
		expect(r.messages.some((m) => m.includes('Baseline introduction'))).toBe(
			true,
		);
	});
});

describe('materialized-fixture integrity', () => {
	it('materialized positive fixtures carry no marker', () => {
		const lines = [
			'expect(true).toBe(true); // vacuous-ok: detector fixture',
			'expect(items.length).toBeGreaterThanOrEqual(0); // vacuous-ok: detector fixture',
		];
		const file = materialize(lines);
		trackRoot(file);
		const written = fs.readFileSync(file, 'utf8').split('\n');
		for (const line of written) {
			expect(line.includes('vacuous-ok')).toBe(false);
		}
	});

	it('materialized positive fixtures are detected by scanContent', () => {
		const file = materialize([
			'expect(true).toBe(true); // vacuous-ok: detector fixture',
			'expect(items.length).toBeGreaterThanOrEqual(0); // vacuous-ok: detector fixture',
			'expect(map.size).toBeGreaterThanOrEqual(0); // vacuous-ok: detector fixture',
		]);
		trackRoot(file);
		const sites = scanContent(fs.readFileSync(file, 'utf8'));
		expect(sites.map((s) => s.rule)).toEqual([
			'true-to-be-true',
			'len-ge-0',
			'size-ge-0',
		]);
	});
});

describe('feedback coverage (PRR-006/007/008/010)', () => {
	const counts = (map: Record<string, number>) => (file: string) =>
		map[file] ?? null;

	it('strips CR before matching (CRLF files scan identically to LF)', () => {
		const vacuous = 'expect(items.' + 'length).toBeGreaterThanOrEqual(0);'; // vacuous-ok: detector fixture
		const content = ['const preamble = 0;', vacuous].join('\r\n') + '\r\n';
		expect(scanContent(content)).toEqual([{ line: 2, rule: 'len-ge-0' }]);
	});

	it('passes the baseline-growth arm when the baseline is unchanged vs base', () => {
		const r = evaluateRatchet({
			changedFiles: [],
			currentCount: counts({}),
			baseline: { 'b.test.ts': 2 },
			baselineAtBase: { 'b.test.ts': 2 },
			enforce: true,
		});
		expect(r.violations).toBe(0);
		expect(r.exitCode).toBe(0);
	});

	it('parseBaseline drops negative, fractional, and null values; throws on arrays and malformed JSON', () => {
		expect(parseBaseline('{"a.test.ts": -1, "b.test.ts": 1.5}')).toEqual({});
		expect(parseBaseline('{"c.test.ts": null}')).toEqual({});
		expect(() => parseBaseline('[]')).toThrow();
		expect(() => parseBaseline('{oops')).toThrow();
	});

	it('flags the null literal in toBeDefined; the undefined literal stays unflagged (unsatisfiable, not vacuous)', () => {
		const nullSites = scanLines([
			'expect(null).toBeDefined(); // vacuous-ok: detector fixture',
		]);
		expect(nullSites).toEqual([{ line: 1, rule: 'literal-to-be-defined' }]);
		const undefinedSites = scanLines(['expect(undefined).toBeDefined();']);
		expect(undefinedSites).toEqual([]);
	});
});

describe('self-scan (dogfood)', () => {
	it('this test file itself scans to zero unmarked findings', () => {
		const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
		expect(scanContent(self)).toEqual([]);
	});
});
