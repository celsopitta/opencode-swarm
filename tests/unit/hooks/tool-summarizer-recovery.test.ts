/**
 * Truthful summary recovery — security matrix and real-incident layout.
 *
 * Exercises the recovery guards in the tool-summarizer hook: when the host
 * reports truncation through structured metadata (`metadata.truncated` +
 * `metadata.outputPath`), the TRUE full artifact is recovered only when it is
 * contained under `getHostDataDir()/tool-output`, matches the host
 * `tool_<id>` leaf grammar, and is within `max_stored_bytes`. Every
 * unrecoverable case falls back to a partial-labeled summary that never
 * claims full content.
 *
 * The host-signal regressions (quoted notices, missing metadata) live in
 * tool-summarizer-host-signal.test.ts to respect the FR-006 500-line cap.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getHostDataDir } from '../../../src/config/cache-paths';
import type { SummaryConfig } from '../../../src/config/schema';
import {
	_internals,
	createToolSummarizerHook,
	recoverTruncatedOutput,
} from '../../../src/hooks/tool-summarizer';
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

function input(tool = 'bash') {
	return { tool, sessionID: 'test-session', callID: 'call-1' };
}

/**
 * Build a host-truncated tool result as the hook receives it: a head large
 * enough to trip the summary threshold (1024 * 1.25) followed by the host's
 * human-readable notice, plus the structured metadata recovery keys on.
 */
function hostTruncated(artifactPath: string, head = 'x'.repeat(3000)) {
	return {
		title: 't',
		output: `TRUNCATED-HEAD\n${head}\n\nThe tool call succeeded but the output was truncated. Full output saved to: ${artifactPath}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`,
		metadata: { truncated: true, outputPath: artifactPath } as unknown,
	};
}

function readStoredSummary(id: string): {
	fullOutput: string;
	originalBytes: number;
} {
	const p = join(tempDir, '.swarm', 'summaries', `${id}.json`);
	return JSON.parse(readFileSync(p, 'utf-8')) as {
		fullOutput: string;
		originalBytes: number;
	};
}

// Symlink creation needs elevation (or creates junctions) on Windows, so the
// two symlink cases are skipped there instead of silently passing.
const itSymlink = it.skipIf(process.platform === 'win32');

let tempDir: string; // .swarm storage root (the hook `directory` param)
let dataHome: string; // XDG_DATA_HOME (host artifact location)
let savedXdg: string | undefined;

function baseDir(): string {
	return join(dataHome, 'opencode', 'tool-output');
}

function makeBase(): string {
	const base = baseDir();
	mkdirSync(base, { recursive: true });
	return base;
}

function writeArtifact(leaf: string, content: string): string {
	const base = makeBase();
	const p = join(base, leaf);
	writeFileSync(p, content);
	return p;
}

describe('tool-summarizer recovery', () => {
	beforeEach(() => {
		tempDir = canonicalMkdtemp('tool-summarizer-recovery-swarm-');
		mkdirSync(join(tempDir, '.swarm'), { recursive: true });
		// Redirect XDG_DATA_HOME (curate.test.ts pattern) so getHostDataDir()
		// — and therefore the containment base — is derived from an isolated
		// temp dir, never the real ~/.local/share.
		dataHome = canonicalMkdtemp('tool-summarizer-recovery-xdg-');
		savedXdg = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = dataHome;
	});

	afterEach(() => {
		if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = savedXdg;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(dataHome, { recursive: true, force: true });
	});

	it('recovers the true full artifact: truthful originalBytes and header', async () => {
		const fullContent = Array.from(
			{ length: 250 },
			(_, i) => `artifact line ${i} ${'z'.repeat(40)}`,
		).join('\n');
		const expectedBytes = Buffer.byteLength(fullContent, 'utf8');
		const expectedLines = fullContent.split('\n').length;
		const artifact = writeArtifact('tool_abc123', fullContent);

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = hostTruncated(artifact);

		await hook(input(), output);

		// Non-partial summary whose header reflects the TRUE full content.
		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).not.toContain('| partial');
		expect(output.output).toContain('Use retrieve_summary S1 for full output');
		expect(output.output).toContain(`| ${expectedLines} lines`);

		// Stored summary carries the true full content + truthful originalBytes.
		const stored = readStoredSummary('S1');
		expect(stored.fullOutput).toBe(fullContent);
		expect(stored.originalBytes).toBe(expectedBytes);
	});

	it('sibling-prefix escape (tool-output-evil/) is not recovered → partial', async () => {
		makeBase(); // ensure the real base exists so realpath(base) succeeds
		const evilDir = join(dataHome, 'opencode', 'tool-output-evil');
		mkdirSync(evilDir, { recursive: true });
		const evilArtifact = join(evilDir, 'tool_evil001');
		writeFileSync(evilArtifact, 'SECRET-FULL-CONTENT');

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = hostTruncated(evilArtifact);
		const original = output.output;

		await hook(input(), output);

		// Not recovered: partial-labeled summary of the truncated string.
		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).toContain('| partial');
		expect(output.output).toContain(
			'Partial output only; use retrieve_summary S1',
		);
		expect(output.output).not.toContain('for full output');
		const stored = readStoredSummary('S1');
		expect(stored.fullOutput).toBe(original);
		expect(stored.fullOutput).not.toBe('SECRET-FULL-CONTENT');
	});

	itSymlink(
		'symlink inside base pointing outside is not recovered → partial',
		async () => {
			const base = makeBase();
			const outsideDir = join(dataHome, 'outside');
			mkdirSync(outsideDir, { recursive: true });
			const outsideFile = join(outsideDir, 'tool_outside1');
			writeFileSync(outsideFile, 'OUTSIDE-SECRET');
			// A symlink INSIDE the base, grammar-valid name, pointing outside.
			const link = join(base, 'tool_sym001');
			symlinkSync(outsideFile, link);

			const hook = createToolSummarizerHook(defaultConfig(), tempDir);
			const output = hostTruncated(link);
			const original = output.output;

			await hook(input(), output);

			expect(output.output).toContain('[SUMMARY S1]');
			expect(output.output).toContain('| partial');
			const stored = readStoredSummary('S1');
			expect(stored.fullOutput).toBe(original);
			expect(stored.fullOutput).not.toBe('OUTSIDE-SECRET');
		},
	);

	itSymlink('symlinked base dir resolves correctly → recovered', async () => {
		// Real artifact dir elsewhere; the canonical base is a symlink to it.
		const realBase = join(dataHome, 'real-data', 'tool-output');
		mkdirSync(realBase, { recursive: true });
		const fullContent = 'REAL-BASE-CONTENT'.repeat(200);
		writeFileSync(join(realBase, 'tool_base123'), fullContent);
		const expectedBytes = Buffer.byteLength(fullContent, 'utf8');

		const opencodeDir = join(dataHome, 'opencode');
		mkdirSync(opencodeDir, { recursive: true });
		const symlinkedBase = join(opencodeDir, 'tool-output');
		symlinkSync(realBase, symlinkedBase);

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		// The host-reported path goes through the SYMLINKED base.
		const output = hostTruncated(join(symlinkedBase, 'tool_base123'));

		await hook(input(), output);

		// Recovered through the symlinked base: true full content, non-partial.
		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).not.toContain('| partial');
		const stored = readStoredSummary('S1');
		expect(stored.fullOutput).toBe(fullContent);
		expect(stored.originalBytes).toBe(expectedBytes);
	});

	it('containment base is derived from XDG_DATA_HOME (host-verbatim)', async () => {
		// getHostDataDir() must respect the XDG_DATA_HOME override.
		expect(getHostDataDir()).toBe(join(dataHome, 'opencode'));
		// And recovery reads from that derived base, not ~/.local/share.
		const fullContent = 'XDG-BASE-CONTENT'.repeat(100);
		const artifact = writeArtifact('tool_xdg1', fullContent);

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = hostTruncated(artifact);

		await hook(input(), output);

		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).not.toContain('| partial');
		expect(readStoredSummary('S1').fullOutput).toBe(fullContent);
	});

	it('missing artifact → partial', async () => {
		makeBase(); // base exists, but the named artifact does not
		const missingArtifact = join(baseDir(), 'tool_missing1');

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = hostTruncated(missingArtifact);
		const original = output.output;

		await hook(input(), output);

		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).toContain('| partial');
		expect(readStoredSummary('S1').fullOutput).toBe(original);
	});

	it('oversized artifact (exceeds max_stored_bytes) → partial', async () => {
		const bigArtifact = 'B'.repeat(40000); // 40000 bytes
		const artifact = writeArtifact('tool_big1', bigArtifact);
		// max_stored_bytes small enough to trip the size guard (40000 > 10240).
		const hook = createToolSummarizerHook(
			defaultConfig({ max_stored_bytes: 10240 }),
			tempDir,
		);
		const output = hostTruncated(artifact);
		const original = output.output;

		await hook(input(), output);

		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).toContain('| partial');
		// Stored content is the truncated string (partial), not the 40KB artifact.
		const stored = readStoredSummary('S1');
		expect(stored.fullOutput).toBe(original);
		expect(stored.fullOutput.length).toBeLessThan(40000);
		// The raw-size guard itself rejects the artifact before it is read; the
		// store-size fallback must not be what produces the partial result.
		expect(
			recoverTruncatedOutput(
				{ truncated: true, outputPath: artifact },
				defaultConfig({ max_stored_bytes: 10240 }),
			),
		).toEqual({ kind: 'partial', reason: 'artifact exceeds max_stored_bytes' });
	});

	it('no host truncation signal → unchanged (full) behavior', async () => {
		const plainLarge = 'y'.repeat(4000); // host did not truncate
		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = {
			title: 't',
			output: plainLarge,
			metadata: null,
		};

		await hook(input(), output);

		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).not.toContain('| partial');
		expect(output.output).toContain('Use retrieve_summary S1 for full output');
		expect(readStoredSummary('S1').fullOutput).toBe(plainLarge);
	});

	it('fail-open preserved on storage error even after a successful recovery', async () => {
		const fullContent = 'RECOVERED-BUT-STORE-FAILS'.repeat(100);
		const artifact = writeArtifact('tool_storefail', fullContent);

		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = hostTruncated(artifact);
		const original = output.output;

		// Stub the storage seam to fail after recovery has already succeeded.
		const realStore = _internals.storeSummary;
		_internals.storeSummary = mock(async () => {
			throw new Error('simulated storage failure');
		});
		try {
			await hook(input(), output);
		} finally {
			_internals.storeSummary = realStore;
		}

		// Fail-open: the original (truncated) output is preserved untouched.
		expect(output.output).toBe(original);
	});

	it('recovers the real incident layout (metadata signal, tool_<id> leaf, ~69KB valid-JSON artifact)', async () => {
		const artifact = buildIncidentArtifact();
		const artifactBytes = Buffer.byteLength(artifact, 'utf8');
		// Comparable size to the real 69,555-byte incident artifact.
		expect(artifactBytes).toBeGreaterThan(55000);
		expect(artifactBytes).toBeLessThan(100000);
		// Valid JSON with the incident structure.
		const parsed = JSON.parse(artifact) as {
			matches: unknown[];
			truncated: boolean;
		};
		expect(Array.isArray(parsed.matches)).toBe(true);
		expect(parsed.truncated).toBe(false);
		const expectedLines = artifact.split('\n').length;

		// The real incident leaf name, host notice wording and metadata shape.
		const artifactPath = writeArtifact(
			'tool_0ef804c130015O0Ic34t7uabqz',
			artifact,
		);
		const hook = createToolSummarizerHook(defaultConfig(), tempDir);
		const output = hostTruncated(artifactPath);

		await hook(input(), output);

		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).not.toContain('| partial');
		expect(output.output).toContain('Use retrieve_summary S1 for full output');
		expect(output.output).toContain(`| ${expectedLines} lines`);
		const stored = readStoredSummary('S1');
		expect(stored.fullOutput).toBe(artifact);
		expect(stored.originalBytes).toBe(artifactBytes);
	});
});

/**
 * Build a full-output artifact replicating the REAL incident layout: the
 * grep-JSON shape (matches[] + trailing metadata), 2-space pretty-printed, at a
 * size comparable to the real 69,555-byte artifact.
 */
function buildIncidentArtifact(): string {
	const matches = Array.from({ length: 337 }, (_, i) => ({
		file: '.swarm/bundled-skills/swarm-plan/SKILL.md',
		lineNumber: i + 1,
		lineText:
			i === 0
				? '---'
				: `line ${i + 1}: Full execution protocol for MODE: PLAN -- plan creation, external plan ingestion`,
	}));
	return JSON.stringify(
		{
			matches,
			truncated: false,
			total: 337,
			query: '.*',
			mode: 'regex',
			maxResults: 10000,
			engine: 'fallback',
			warning:
				'Fallback search uses bounded filesystem traversal and does not fully emulate ripgrep gitignore behavior.',
		},
		null,
		2,
	);
}
