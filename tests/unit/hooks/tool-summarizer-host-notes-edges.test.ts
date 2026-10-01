/**
 * Tool-summarizer host notes — alignment bounds and store-flow edges.
 *
 * Companion to tool-summarizer-host-notes.test.ts (kept separate for the
 * FR-006 500-line cap). Pins the edges of the positional tail alignment that
 * only unusual streams reach, and how host notes travel through the store
 * fallback.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SummaryConfig } from '../../../src/config/schema';
import {
	_internals,
	_test_exports,
	createToolSummarizerHook,
	recoverTruncatedOutput,
} from '../../../src/hooks/tool-summarizer';
import { SummaryIdCollisionError } from '../../../src/summaries/manager';
import { HOST_NOTES_LABEL } from '../../../src/summaries/summarizer';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function defaultConfig(overrides?: Partial<SummaryConfig>): SummaryConfig {
	return {
		enabled: true,
		threshold_bytes: 1024,
		max_summary_chars: 1000,
		max_stored_bytes: 10485760,
		retention_days: 7,
		exempt_tools: [],
		...overrides,
	};
}

const BASH = { tool: 'bash', sessionID: 'test-session', callID: 'call-1' };
const TIMEOUT_NOTE =
	'shell tool terminated command after exceeding timeout 120000 ms.';
const SHELL_METADATA = `<shell_metadata>\n${TIMEOUT_NOTE}\n</shell_metadata>`;
const NOTES = ['<shell_metadata>', TIMEOUT_NOTE, '</shell_metadata>'];

let tempDir: string;
let dataHome: string;
let savedXdg: string | undefined;

function writeArtifact(leaf: string, content: string): string {
	const base = join(dataHome, 'opencode', 'tool-output');
	mkdirSync(base, { recursive: true });
	const p = join(base, leaf);
	writeFileSync(p, content);
	return p;
}

/** Host-shaped bash result: notice, then `afterNotice` verbatim. */
function bashResult(artifactPath: string, afterNotice: string) {
	return {
		title: 'bun test',
		output: `...output truncated...\n\nFull output saved to: ${artifactPath}\n\n${afterNotice}`,
		metadata: { truncated: true, outputPath: artifactPath } as unknown,
	};
}

function recover(artifactPath: string, received: string) {
	return recoverTruncatedOutput(
		{ truncated: true, outputPath: artifactPath },
		defaultConfig(),
		received,
	);
}

const stream = Array.from(
	{ length: 400 },
	(_, i) => `test output line ${i} ${'.'.repeat(30)}`,
).join('\n');
const streamTail = stream.split('\n').slice(-60).join('\n');

beforeEach(() => {
	tempDir = canonicalMkdtemp('tool-summarizer-notes-edges-swarm-');
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	dataHome = canonicalMkdtemp('tool-summarizer-notes-edges-xdg-');
	savedXdg = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dataHome;
});

afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = savedXdg;
	rmSync(tempDir, { recursive: true, force: true });
	rmSync(dataHome, { recursive: true, force: true });
});

describe('alignedTailLength', () => {
	const { alignedTailLength } = _test_exports;

	/** Longest k with text.slice(0, k) === artifact.slice(-k), by brute force. */
	function reference(text: string, artifact: string): number {
		for (let k = Math.min(text.length, artifact.length); k > 0; k -= 1) {
			if (text.slice(0, k) === artifact.slice(-k)) {
				return k;
			}
		}
		return 0;
	}

	it('agrees with a brute-force reference on repetitive strings', () => {
		// A two-letter alphabet makes prefixes recur constantly, which is what
		// exercises the failure links in both phases of the matcher. The
		// generator is a fixed-seed LCG, so the cases are identical every run
		// (32-bit arithmetic via Math.imul and the high bits: a plain `*` loses
		// the low bits past 2^53 and would produce the same letter forever).
		let seed = 12345;
		const next = (bound: number) => {
			seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
			return (seed >>> 16) % bound;
		};
		const word = (maxLength: number) =>
			Array.from({ length: next(maxLength + 1) }, () =>
				next(2) === 0 ? 'a' : 'b',
			).join('');
		const seen = new Set<string>();
		for (let i = 0; i < 4000; i += 1) {
			const text = word(12);
			const artifact = word(16);
			seen.add(text);
			expect(alignedTailLength(text, artifact)).toBe(reference(text, artifact));
		}
		// Guard against a degenerate generator: the cases must really vary.
		expect(seen.size).toBeGreaterThan(1000);
	});

	it('handles the empty and the fully-contained cases', () => {
		expect(alignedTailLength('', 'abc')).toBe(0);
		expect(alignedTailLength('abc', '')).toBe(0);
		expect(alignedTailLength('abc', 'xxabc')).toBe(3);
		expect(alignedTailLength('abcdef', 'abc')).toBe(3);
		expect(alignedTailLength('aabaab', 'baabaa')).toBe(5);
	});
});

describe('tail alignment bounds', () => {
	it('a short tail with nothing after it is accepted in full', () => {
		// The minimum applies to a tail that is followed by other text; a short
		// returned text that is entirely a tail of the artifact lines up.
		const artifact = writeArtifact('tool_shortfull', stream);
		const received = bashResult(artifact, stream.slice(-100));

		expect(recover(artifact, received.output)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: [],
		});
	});

	it('a tail of exactly the minimum length before notes lines up; one character less does not', () => {
		const artifact = writeArtifact('tool_minimum', stream);
		const withTail = (chars: number) =>
			bashResult(artifact, `${stream.slice(-chars)}\n\n${SHELL_METADATA}`)
				.output;

		expect(recover(artifact, withTail(256))).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: NOTES,
		});
		expect(recover(artifact, withTail(255)).kind).toBe('partial');
	});

	it('the first line carrying the artifact path is the notice', () => {
		// A host note may itself mention the path; the notice is still the
		// first paragraph that carries it.
		const artifact = writeArtifact('tool_pathtwice', stream);
		const note = `full output is at ${artifact}`;
		const received = bashResult(artifact, `${streamTail}\n\n${note}`);

		expect(recover(artifact, received.output)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: [note],
		});
	});

	it('a notice paragraph of several lines is skipped as a whole', () => {
		// The notice is the paragraph around the artifact path, however many
		// hint lines the host puts after it; the tail preview follows the next
		// blank line.
		const artifact = writeArtifact('tool_longnotice', stream);
		const received = `...350 lines truncated...\n\nFull output saved to: ${artifact}\nfirst hint line\nsecond hint line\n\n${streamTail}`;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: [],
		});
	});

	it('a whitespace-only stream still lines up and keeps the note', () => {
		const blank = Array.from({ length: 3000 }, () => '   ').join('\n');
		const artifact = writeArtifact('tool_blank', blank);
		const tail = blank.split('\n').slice(-200).join('\n');
		const received = bashResult(artifact, `${tail}\n\n${SHELL_METADATA}`);

		expect(recover(artifact, received.output)).toEqual({
			kind: 'recovered',
			content: blank,
			hostNotes: NOTES,
		});
	});

	it('text after the tail that repeats the stream ending is all kept as notes', () => {
		// The text after the tail repeats the stream's ending five times, so the
		// artifact's ending occurs six times; only the first one ends the tail.
		const ending = stream.slice(-256);
		const repeats = Array.from({ length: 5 }, () => ending);
		const artifact = writeArtifact('tool_repeat', stream);
		const received = bashResult(
			artifact,
			`${streamTail}\n${repeats.join('\n')}`,
		);

		expect(recover(artifact, received.output)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: repeats.flatMap((copy) => copy.split('\n')),
		});
	});

	it('an implausibly long run of lines after the tail is reported partial', () => {
		// Host notes are short status blocks. Forty copies of the stream's
		// ending, each followed by junk, leave far more lines after the aligned
		// tail than any host note has, so the text is not treated as lining up.
		const ending = stream.slice(-256);
		const junk = Array.from({ length: 40 }, () => `${ending} trailing-junk`);
		const artifact = writeArtifact('tool_bound', stream);
		const received = bashResult(
			artifact,
			`${junk.join('\n')}\n\ngenuine host note`,
		);

		expect(recover(artifact, received.output)).toEqual({
			kind: 'partial',
			reason: 'returned text does not line up with the saved copy',
		});
	});

	it('up to the note-line limit is kept; one line more is reported partial', () => {
		const artifact = writeArtifact('tool_limit', stream);
		const lines = (count: number) =>
			Array.from({ length: count }, (_, i) => `note ${i}`);

		expect(
			recover(
				artifact,
				bashResult(artifact, `${streamTail}\n\n${lines(64).join('\n')}`).output,
			),
		).toEqual({ kind: 'recovered', content: stream, hostNotes: lines(64) });
		expect(
			recover(
				artifact,
				bashResult(artifact, `${streamTail}\n\n${lines(65).join('\n')}`).output,
			).kind,
		).toBe('partial');
	});
});

describe('tool-summarizer — regression: the store fallback must keep host notes (CR-5)', () => {
	it('a recovered copy too large to store falls back to partial WITH the timeout note', async () => {
		// Previous code dropped the notes it had already extracted when the
		// recovered copy could not be stored, so the partial stub of a killed
		// command showed no timeout indication.
		const escapeHeavy = '"\\\n'.repeat(4000); // ~12 KB raw, ~24 KB serialized
		const artifact = writeArtifact('tool_escapes2', escapeHeavy);
		const tail = escapeHeavy.split('\n').slice(-600).join('\n');
		const output = bashResult(artifact, `${tail}\n\n${SHELL_METADATA}`);
		const received = output.output;

		await createToolSummarizerHook(
			defaultConfig({ max_stored_bytes: 16000 }),
			tempDir,
		)(BASH, output);

		expect(output.output).toContain('| partial');
		expect(output.output).toContain(`${HOST_NOTES_LABEL} ${TIMEOUT_NOTE}`);
		// The partial stub describes the text the host returned, not the copy
		// that could not be stored.
		expect(output.output.split('\n')[0]).toContain(
			`| ${received.split('\n').length} lines | partial`,
		);
		const stored = JSON.parse(
			readFileSync(join(tempDir, '.swarm', 'summaries', 'S1.json'), 'utf-8'),
		) as { fullOutput: string };
		expect(stored.fullOutput.endsWith(SHELL_METADATA)).toBe(true);
	});
});

describe('tool-summarizer — regression: exhausted ID collisions must not downgrade to partial (CR-6)', () => {
	it('keeps the original output when every store attempt collides', async () => {
		// Previous code treated ANY failure to store the recovered copy as a
		// reason to store a partial summary instead. Exhausted collisions say
		// nothing about the copy being unstorable, and a partial stub would
		// misreport a recoverable output.
		const artifact = writeArtifact('tool_collide', stream);
		const output = bashResult(artifact, `${streamTail}\n\n${SHELL_METADATA}`);
		const original = output.output;
		const realStore = _internals.storeSummary;
		let calls = 0;
		_internals.storeSummary = async (_dir, id) => {
			calls += 1;
			throw new SummaryIdCollisionError(id);
		};
		try {
			await createToolSummarizerHook(defaultConfig(), tempDir)(BASH, output);
		} finally {
			_internals.storeSummary = realStore;
		}

		expect(output.output).toBe(original);
		// One bounded round of attempts, not a second round for a fallback.
		expect(calls).toBe(8);
	});
});
