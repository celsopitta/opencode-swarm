/**
 * Tool-summarizer host-signal regressions.
 *
 * Recovery of a host-truncated output keys ONLY on the host's structured
 * `metadata.truncated` / `metadata.outputPath` signal. Tool output text is
 * untrusted content: an output that merely quotes the host's
 * "Full output saved to: <path>" notice must never redirect recovery or change
 * how the summary is labelled. Also pins the two retrieval-path guarantees
 * that keep a `[SUMMARY Sx]` stub expandable: `/swarm retrieve` delivered
 * through `swarm_command` is not re-summarized, and the host `skill` tool is
 * exempt.
 *
 * Kept separate from tool-summarizer-recovery.test.ts to respect the FR-006
 * 500-line test-file cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUMMARIZER_EXEMPT_TOOL_NAMES } from '../../../src/config/constants';
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

function input(tool = 'bash', args?: unknown) {
	return { tool, sessionID: 'test-session', callID: 'call-1', args };
}

let tempDir: string; // .swarm storage root (the hook `directory` param)
let dataHome: string; // XDG_DATA_HOME (host artifact location)
let savedXdg: string | undefined;

function writeArtifact(leaf: string, content: string): string {
	const base = join(dataHome, 'opencode', 'tool-output');
	mkdirSync(base, { recursive: true });
	const p = join(base, leaf);
	writeFileSync(p, content);
	return p;
}

function readStored(id: string): string {
	const p = join(tempDir, '.swarm', 'summaries', `${id}.json`);
	return (JSON.parse(readFileSync(p, 'utf-8')) as { fullOutput: string })
		.fullOutput;
}

/** The host's human-readable truncation notice, as it appears in output text. */
function noticeFor(artifactPath: string): string {
	return `The tool call succeeded but the output was truncated. Full output saved to: ${artifactPath}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`;
}

beforeEach(() => {
	tempDir = canonicalMkdtemp('tool-summarizer-host-signal-swarm-');
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	// Redirect XDG_DATA_HOME so the containment base is an isolated temp dir,
	// never the real ~/.local/share.
	dataHome = canonicalMkdtemp('tool-summarizer-host-signal-xdg-');
	savedXdg = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dataHome;
});

afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = savedXdg;
	rmSync(tempDir, { recursive: true, force: true });
	rmSync(dataHome, { recursive: true, force: true });
});

describe('tool-summarizer — regression: quoted host notice must not hijack recovery (VR-1)', () => {
	it('a complete output quoting an old notice keeps its own content', async () => {
		// Previous code matched /Full output saved to:\s*(\S+)/ anywhere in the
		// output text and read that path back, so a complete bash output that
		// merely quoted an old notice was replaced by the unrelated artifact's
		// content and the real output was stored nowhere.
		const unrelated = writeArtifact('tool_unrelated1', 'UNRELATED-ARTIFACT');
		const realOutput = `REAL-OUTPUT-START\nlog: ${noticeFor(unrelated)}\n${'important result line\n'.repeat(200)}REAL-OUTPUT-END`;
		const output = { title: 't', output: realOutput, metadata: {} as unknown };

		await createToolSummarizerHook(defaultConfig(), tempDir)(input(), output);

		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).not.toContain('| partial');
		expect(readStored('S1')).toBe(realOutput);
		expect(readStored('S1')).not.toContain('UNRELATED-ARTIFACT');
	});
});

describe('tool-summarizer — regression: quoted notice must not mislabel a complete output as partial (VR-2)', () => {
	it('notice wording with a dead path and no host signal stays a full summary', async () => {
		// Previous code treated any "Full output saved to: <path>" text as a
		// host truncation; when the quoted path did not exist (e.g. a search hit
		// on source that documents the wording) the complete output was labelled
		// `| partial` / "full output was not recoverable".
		const complete = `${'x\n'.repeat(1500)}//   "Full output saved to: <absolute-artifact-path>".\n`;
		const output = { title: 't', output: complete, metadata: null as unknown };

		await createToolSummarizerHook(defaultConfig(), tempDir)(
			input('search'),
			output,
		);

		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).not.toContain('| partial');
		expect(output.output).toContain('Use retrieve_summary S1 for full output');
		expect(readStored('S1')).toBe(complete);
	});
});

describe('tool-summarizer — regression: host signal outranks quoted notices (VR-3)', () => {
	it('a truncated output whose head quotes an older notice recovers the host-reported artifact', async () => {
		// Previous code took the FIRST notice in the text, so a genuinely
		// truncated output whose head quoted an older notice recovered the older,
		// unrelated artifact instead of its own.
		const older = writeArtifact('tool_older1', 'OLDER-UNRELATED-ARTIFACT');
		const own = writeArtifact('tool_own1', 'OWN-FULL-CONTENT '.repeat(300));
		const output = {
			title: 't',
			output: `head quoting: ${noticeFor(older)}\n${'y'.repeat(3000)}\n\n${noticeFor(own)}`,
			metadata: { truncated: true, outputPath: own } as unknown,
		};

		await createToolSummarizerHook(defaultConfig(), tempDir)(input(), output);

		expect(output.output).not.toContain('| partial');
		expect(readStored('S1')).toBe('OWN-FULL-CONTENT '.repeat(300));
	});
});

describe('tool-summarizer host truncation signal', () => {
	it('truncated without an outputPath → partial, stored content is the received output', async () => {
		const received = `${'z'.repeat(3000)}\n...truncated...`;
		const output = {
			title: 't',
			output: received,
			metadata: { truncated: true } as unknown,
		};

		await createToolSummarizerHook(defaultConfig(), tempDir)(input(), output);

		expect(output.output).toContain('| partial');
		expect(output.output).toContain(
			'Partial output only; use retrieve_summary S1',
		);
		expect(readStored('S1')).toBe(received);
	});

	it('truncated: false with an outputPath is not treated as truncated', async () => {
		const artifact = writeArtifact('tool_ignored1', 'SHOULD-NOT-BE-READ');
		const received = 'w'.repeat(4000);
		const output = {
			title: 't',
			output: received,
			metadata: { truncated: false, outputPath: artifact } as unknown,
		};

		await createToolSummarizerHook(defaultConfig(), tempDir)(input(), output);

		expect(output.output).not.toContain('| partial');
		expect(readStored('S1')).toBe(received);
	});
});

describe('tool-summarizer — regression: /swarm retrieve must not be re-summarized (VR-4)', () => {
	const stored = 'stored summary content line\n'.repeat(300);

	it('swarm_command retrieve output passes through (args on hook input)', async () => {
		// Previous code summarized the output of `/swarm retrieve Sx` (delivered
		// through the swarm_command tool) like any other large output, handing
		// the agent a NEW stub for a copy of the same content — a retrieval loop.
		const output = { title: 't', output: stored, metadata: {} as unknown };

		await createToolSummarizerHook(defaultConfig(), tempDir)(
			input('swarm_command', { command: 'retrieve', args: ['S7'] }),
			output,
		);

		expect(output.output).toBe(stored);
	});

	it('swarm_command retrieve output passes through (args from the callID snapshot)', async () => {
		const realGet = _internals.getStoredInputArgs;
		_internals.getStoredInputArgs = (callID: string) =>
			callID === 'call-1' ? { command: 'retrieve', args: ['S7'] } : undefined;
		const output = { title: 't', output: stored, metadata: {} as unknown };
		try {
			await createToolSummarizerHook(defaultConfig(), tempDir)(
				input('swarm_command'),
				output,
			);
		} finally {
			_internals.getStoredInputArgs = realGet;
		}

		expect(output.output).toBe(stored);
	});

	it('swarm_command with no recorded arguments is summarized, not an error', async () => {
		// Neither the hook input nor the callID snapshot carries args.
		const realGet = _internals.getStoredInputArgs;
		_internals.getStoredInputArgs = () => undefined;
		const output = { title: 't', output: stored, metadata: {} as unknown };
		try {
			await createToolSummarizerHook(defaultConfig(), tempDir)(
				input('swarm_command'),
				output,
			);
		} finally {
			_internals.getStoredInputArgs = realGet;
		}

		expect(output.output).toContain('[SUMMARY S1]');
	});

	it('other swarm_command output is still summarized', async () => {
		const output = { title: 't', output: stored, metadata: {} as unknown };

		await createToolSummarizerHook(defaultConfig(), tempDir)(
			input('swarm_command', { command: 'status', args: [] }),
			output,
		);

		expect(output.output).toContain('[SUMMARY S1]');
	});

	it('a non-swarm_command tool whose args carry command: retrieve is still summarized', async () => {
		const output = { title: 't', output: stored, metadata: {} as unknown };

		await createToolSummarizerHook(defaultConfig(), tempDir)(
			input('bash', { command: 'retrieve' }),
			output,
		);

		expect(output.output).toContain('[SUMMARY S1]');
	});
});

describe('tool-summarizer — regression: host skill tool output must not be stubbed (VR-5)', () => {
	it('skill is on the exempt floor and passes through untouched', async () => {
		// Previous exempt floor omitted the host `skill` tool, so a skill body
		// over the threshold was replaced by a 5-line stub and agents proceeded
		// without the instructions.
		expect(SUMMARIZER_EXEMPT_TOOL_NAMES as readonly string[]).toContain(
			'skill',
		);
		const body = `<skill_content name="x">\n${'rule line\n'.repeat(500)}</skill_content>`;
		const output = { title: 't', output: body, metadata: {} as unknown };

		await createToolSummarizerHook(defaultConfig(), tempDir)(
			input('skill'),
			output,
		);

		expect(output.output).toBe(body);
	});
});

describe('recoverTruncatedOutput guards', () => {
	it('only a strict boolean true counts as the host truncation signal', () => {
		const artifact = writeArtifact('tool_strict1', 'FULL');
		for (const truncated of ['true', 1, {}, null, undefined, false]) {
			expect(
				recoverTruncatedOutput(
					{ truncated, outputPath: artifact },
					defaultConfig(),
				),
			).toEqual({ kind: 'none' });
		}
	});

	it('non-object metadata is never a truncation signal', () => {
		for (const metadata of [null, undefined, 'truncated', 42, true]) {
			expect(recoverTruncatedOutput(metadata, defaultConfig())).toEqual({
				kind: 'none',
			});
		}
	});

	it('a missing or non-string outputPath yields partial without touching the filesystem', () => {
		for (const outputPath of [undefined, '', 7, null]) {
			expect(
				recoverTruncatedOutput(
					{ truncated: true, outputPath },
					defaultConfig(),
				),
			).toEqual({ kind: 'partial', reason: 'host reported no artifact path' });
		}
	});

	it('a contained file whose leaf is not tool_<id> is rejected by the grammar guard', () => {
		// The grammar is anchored at both ends and allows only letters and
		// digits after the prefix.
		for (const leaf of [
			'notes.txt',
			'tool_abc.txt',
			'tool_ab-c',
			'xtool_abc',
		]) {
			const notArtifact = writeArtifact(leaf, 'NOT-AN-ARTIFACT');
			expect(
				recoverTruncatedOutput(
					{ truncated: true, outputPath: notArtifact },
					defaultConfig(),
				),
			).toEqual({ kind: 'partial', reason: 'artifact leaf grammar mismatch' });
		}
	});

	it('a contained, grammar-valid directory is rejected as not a regular file', () => {
		const dir = join(dataHome, 'opencode', 'tool-output', 'tool_dir1');
		mkdirSync(dir, { recursive: true });
		expect(
			recoverTruncatedOutput(
				{ truncated: true, outputPath: dir },
				defaultConfig(),
			),
		).toEqual({ kind: 'partial', reason: 'artifact is not a regular file' });
	});

	it('an empty artifact is not accepted as the full copy', () => {
		const empty = writeArtifact('tool_empty1', '');
		expect(
			recoverTruncatedOutput(
				{ truncated: true, outputPath: empty },
				defaultConfig(),
			),
		).toEqual({ kind: 'partial', reason: 'artifact is empty' });
	});

	it('a valid artifact is recovered', () => {
		const artifact = writeArtifact('tool_ok1', 'FULL-CONTENT');
		expect(
			recoverTruncatedOutput(
				{ truncated: true, outputPath: artifact },
				defaultConfig(),
			),
		).toEqual({ kind: 'recovered', content: 'FULL-CONTENT', hostNotes: [] });
	});
});

describe('tool-summarizer — regression: a throwing recovery step must stay fail-open (VR-6)', () => {
	it('preserves the original output when recovery throws', async () => {
		// Previous code called the recovery step outside the hook's try/catch,
		// so an exception while reading the host signal escaped the hook and
		// skipped the remaining tool.execute.after hooks.
		const realRecover = _internals.recoverTruncatedOutput;
		_internals.recoverTruncatedOutput = () => {
			throw new Error('simulated recovery failure');
		};
		const original = 'q'.repeat(4000);
		const output = { title: 't', output: original, metadata: {} as unknown };
		try {
			await createToolSummarizerHook(defaultConfig(), tempDir)(input(), output);
		} finally {
			_internals.recoverTruncatedOutput = realRecover;
		}

		expect(output.output).toBe(original);
	});
});
