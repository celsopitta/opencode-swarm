/**
 * Tool-summarizer host notes.
 *
 * The artifact the host saves is not always everything it returned. For the
 * built-in `bash` tool (opencode 1.18.33) the artifact is the raw stream, and
 * the returned text is
 *   `...output truncated...\n\nFull output saved to: <path>\n\n<tail>`
 * followed, only when the command timed out or was aborted, by
 *   `\n\n<shell_metadata>\n<message>\n</shell_metadata>`.
 * Recovery must carry that block over: in the stored content, and on a
 * reserved line of the summary that the preview budget cannot squeeze out.
 * Notes are located by POSITION (what follows the stream tail), never by
 * comparing line contents, so output that quotes a note cannot hide it. When
 * the returned text does not line up with the saved copy, recovery reports
 * partial instead of presenting the copy as the whole result.
 *
 * Also covers the two size cases where a recovered copy cannot be served and
 * the summary must fall back to a truthful partial one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SummaryConfig } from '../../../src/config/schema';
import {
	createToolSummarizerHook,
	recoverTruncatedOutput,
} from '../../../src/hooks/tool-summarizer';
import {
	HOST_NOTES_LABEL,
	MAX_RETRIEVABLE_SUMMARY_BYTES,
} from '../../../src/summaries/summarizer';
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
	'shell tool terminated command after exceeding timeout 120000 ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.';
const SHELL_METADATA = `<shell_metadata>\n${TIMEOUT_NOTE}\n</shell_metadata>`;

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

function lastLines(stream: string, count: number): string {
	return stream.split('\n').slice(-count).join('\n');
}

/** A host-shaped truncated bash result for `stream` saved at `artifactPath`. */
function bashResult(artifactPath: string, tail: string, withMetadata = true) {
	return {
		title: 'bun test',
		output: `...output truncated...\n\nFull output saved to: ${artifactPath}\n\n${tail}${withMetadata ? `\n\n${SHELL_METADATA}` : ''}`,
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

const shortStream = Array.from(
	{ length: 400 },
	(_, i) => `test output line ${i} ${'.'.repeat(30)}`,
).join('\n');

beforeEach(() => {
	tempDir = canonicalMkdtemp('tool-summarizer-host-notes-swarm-');
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	// Redirect XDG_DATA_HOME so the containment base is an isolated temp dir,
	// never the real ~/.local/share.
	dataHome = canonicalMkdtemp('tool-summarizer-host-notes-xdg-');
	savedXdg = process.env.XDG_DATA_HOME;
	process.env.XDG_DATA_HOME = dataHome;
});

afterEach(() => {
	if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = savedXdg;
	rmSync(tempDir, { recursive: true, force: true });
	rmSync(dataHome, { recursive: true, force: true });
});

describe('tool-summarizer — regression: recovery must keep host-added notes the artifact lacks (CR-1)', () => {
	it('a timed-out bash command keeps its timeout notice in the stub and the stored content', async () => {
		// Previous code replaced the returned text with the artifact wholesale.
		// For bash the artifact is the raw stream, so the <shell_metadata>
		// timeout block vanished and a killed run looked like a complete result.
		const artifact = writeArtifact('tool_bash1', shortStream);
		const output = bashResult(artifact, lastLines(shortStream, 60));

		await createToolSummarizerHook(defaultConfig(), tempDir)(BASH, output);

		expect(output.output).not.toContain('| partial');
		const lines = output.output.split('\n');
		expect(lines[lines.length - 2]).toBe(`${HOST_NOTES_LABEL} ${TIMEOUT_NOTE}`);
		expect(lines[lines.length - 1]).toBe(
			'→ Use retrieve_summary S1 for full output',
		);
		expect(readStored('S1')).toBe(
			`${shortStream}\n\n${HOST_NOTES_LABEL}\n${SHELL_METADATA}`,
		);
		// The preview describes the command's own output: its real last line is
		// shown, and the note appears once (on the reserved line), not again in
		// the preview tail where it would displace that line.
		expect(output.output).toContain('test output line 399');
		expect(output.output.split(TIMEOUT_NOTE).length - 1).toBe(1);
		expect(output.output).not.toContain('</shell_metadata>');
	});
});

describe('tool-summarizer — regression: host notes must survive the preview budget (CR-2)', () => {
	it('a long, declaration-heavy bash output still shows the timeout notice in the stub', async () => {
		// Previous code only appended the notes to the END of the content. A
		// bash preview starts with an unbounded `// declarations:` line and is
		// cut from the tail, so on realistic output the notice never reached
		// the stub and a killed run was still presented as a complete result.
		const stream = Array.from(
			{ length: 2500 },
			(_, i) =>
				`src/file${i}.ts:${i}: export const value${i} = compute${i}(); type Shape${i} = ${'x'.repeat(120)}`,
		).join('\n');
		const artifact = writeArtifact('tool_bashlong', stream);
		const output = bashResult(artifact, lastLines(stream, 200));

		await createToolSummarizerHook(defaultConfig(), tempDir)(BASH, output);

		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).toContain('// declarations:');
		expect(output.output).toContain(`${HOST_NOTES_LABEL} ${TIMEOUT_NOTE}`);
		expect(readStored('S1').endsWith(SHELL_METADATA)).toBe(true);
	});
});

describe('tool-summarizer — regression: output quoting a host note must not hide the real one (CR-3)', () => {
	it('keeps the real timeout block when the stream itself printed an identical block', () => {
		// Previous code classified each returned line by CONTENT (present in the
		// artifact ⇒ output), so a stream that had printed the same
		// <shell_metadata> text made the host's real block look like output and
		// it was dropped.
		const stream = `${shortStream}\nlog: ${TIMEOUT_NOTE}\n${SHELL_METADATA}\n${shortStream}`;
		const artifact = writeArtifact('tool_bashquote', stream);
		const received = bashResult(artifact, lastLines(stream, 80)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: ['<shell_metadata>', TIMEOUT_NOTE, '</shell_metadata>'],
		});
	});

	it('keeps the real block even when the stream ENDS with an identical block', () => {
		const stream = `${shortStream}\n${SHELL_METADATA}`;
		const artifact = writeArtifact('tool_bashquoteend', stream);
		const received = bashResult(artifact, lastLines(stream, 80)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: ['<shell_metadata>', TIMEOUT_NOTE, '</shell_metadata>'],
		});
	});
});

describe('host notes extraction', () => {
	it('a bash result with no host-added lines yields no notes', () => {
		const artifact = writeArtifact('tool_bash2', shortStream);
		const received = bashResult(artifact, lastLines(shortStream, 60), false);

		expect(recover(artifact, received.output)).toEqual({
			kind: 'recovered',
			content: shortStream,
			hostNotes: [],
		});
	});

	it('a tail far longer than any scan bound yields no notes', () => {
		const stream = Array.from(
			{ length: 3000 },
			(_, i) => `row ${i} ${i % 7}`,
		).join('\n');
		const artifact = writeArtifact('tool_bashtail', stream);
		const received = bashResult(artifact, lastLines(stream, 1900), false);

		expect(recover(artifact, received.output)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: [],
		});
	});

	it('a tail that starts mid-line is not mistaken for a host note', () => {
		const artifact = writeArtifact('tool_bash3', shortStream);
		// The first tail line is a suffix of a real stream line, not a whole one.
		const tail = `ne 340 ${'.'.repeat(30)}\n${lastLines(shortStream, 59)}`;

		expect(recover(artifact, bashResult(artifact, tail, false).output)).toEqual(
			{ kind: 'recovered', content: shortStream, hostNotes: [] },
		);
	});

	it('a stream ending in a newline lines up with its verbatim tail', () => {
		// The host returns the end of the stream verbatim, trailing newline
		// included.
		const stream = `${shortStream}\n`;
		const artifact = writeArtifact('tool_bashnl', stream);
		const received = bashResult(artifact, stream.slice(-3000)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: ['<shell_metadata>', TIMEOUT_NOTE, '</shell_metadata>'],
		});
	});

	it('the generic host wrapper layouts (head and tail direction) yield no notes', () => {
		const artifact = writeArtifact('tool_generic1', shortStream);
		const notice = `The tool call succeeded but the output was truncated. Full output saved to: ${artifact}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`;
		const head = `${shortStream.split('\n').slice(0, 50).join('\n')}\n\n...9000 bytes truncated...\n\n${notice}`;
		const tail = `...350 lines truncated...\n\n${notice}\n\n${lastLines(shortStream, 50)}`;

		for (const received of [head, tail]) {
			expect(recover(artifact, received)).toEqual({
				kind: 'recovered',
				content: shortStream,
				hostNotes: [],
			});
		}
	});

	it('returned text that does not line up with the artifact is reported partial', () => {
		// No artifact path and no tail of the stream: there is no way to tell
		// what the host added, so the copy must not be presented as the whole
		// result (the partial summary stores what the host returned).
		const artifact = writeArtifact('tool_bash4', shortStream);
		const received = `${shortStream.split('\n').slice(0, 20).join('\n')}\nhost-added line without a pointer`;

		expect(recover(artifact, received)).toEqual({
			kind: 'partial',
			reason: 'returned text does not line up with the saved copy',
		});
	});
});

describe('tool-summarizer — regression: an unservable recovered copy must fall back to partial (CR-4)', () => {
	it('an artifact whose stored entry would exceed max_stored_bytes becomes a partial summary', async () => {
		// Previous code compared the RAW artifact size to max_stored_bytes, but
		// storage checks the JSON-serialized entry. An artifact under the cap
		// whose serialization exceeded it failed to store, leaving no summary
		// at all and the host-truncated text in context.
		const artifactContent = '"\\\n'.repeat(4000); // 12,000 bytes raw, ~24,000 serialized
		const artifact = writeArtifact('tool_escapes', artifactContent);
		const received = `${'q'.repeat(3000)}\n\n...9000 bytes truncated...\n\nFull output saved to: ${artifact}`;
		const output = {
			title: 't',
			output: received,
			metadata: { truncated: true, outputPath: artifact } as unknown,
		};

		await createToolSummarizerHook(
			defaultConfig({ max_stored_bytes: 16000 }),
			tempDir,
		)({ tool: 'search', sessionID: 's', callID: 'c' }, output);

		expect(output.output).toContain('[SUMMARY S1]');
		expect(output.output).toContain('| partial');
		expect(readStored('S1')).toBe(received);
	});

	it('an artifact larger than retrieve_summary can serve is not recovered', () => {
		// Previous code stored any artifact up to max_stored_bytes behind a
		// "use retrieve_summary" footer, although the tool refuses content
		// over its own limit when max_stored_bytes is configured above it.
		const artifact = writeArtifact(
			'tool_huge',
			'z'.repeat(MAX_RETRIEVABLE_SUMMARY_BYTES),
		);

		expect(
			recoverTruncatedOutput(
				{ truncated: true, outputPath: artifact },
				defaultConfig({ max_stored_bytes: 52428800 }),
			),
		).toEqual({
			kind: 'partial',
			reason: 'artifact exceeds the retrieve_summary limit',
		});
	});
});

describe('host notes extraction — positional alignment edge cases', () => {
	const NOTES = ['<shell_metadata>', TIMEOUT_NOTE, '</shell_metadata>'];

	it('a stream ending in two identical blocks keeps exactly the host block', () => {
		// The artifact's ending also occurs one block later in the returned
		// text; only the true end of the tail lines up with the artifact.
		const stream = `${shortStream}\n${SHELL_METADATA}\n\n${SHELL_METADATA}`;
		const artifact = writeArtifact('tool_twoblocks', stream);
		const received = bashResult(artifact, lastLines(stream, 80)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: NOTES,
		});
	});

	it('a repetitive stream does not leak into the notes', () => {
		// The artifact's ending occurs at every period of a repetitive stream.
		// Aligning on the FIRST occurrence would report the rest of the tail as
		// host notes; the last aligned occurrence is the real end of the tail.
		const stream = Array.from({ length: 3000 }, () => 'ab').join('\n');
		const artifact = writeArtifact('tool_periodic', stream);
		const received = bashResult(artifact, lastLines(stream, 500)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: NOTES,
		});
	});

	it('an artifact ending in whitespace lines up with its verbatim tail', () => {
		const stream = `${shortStream}\n${SHELL_METADATA}\nlast real line  \n\n\n`;
		const artifact = writeArtifact('tool_trailingws', stream);
		const received = bashResult(artifact, stream.slice(-3000)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: NOTES,
		});
	});

	it('a tail that is not a verbatim ending of the artifact is reported partial', () => {
		// The host never trims its preview. A tail with the stream's trailing
		// whitespace dropped is not a tail of the saved copy, and matching it
		// loosely is exactly what would let a real note be swallowed.
		const body = `${shortStream}\nlast real line`;
		const artifact = writeArtifact('tool_trimmedtail', `${body}  \n\n\n`);
		const received = bashResult(artifact, lastLines(body, 80)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'partial',
			reason: 'returned text does not line up with the saved copy',
		});
	});

	it('a tail cut mid-line still aligns when the stream quotes the block', () => {
		// The returned tail starts in the middle of a line. A content-based
		// fallback would drop the real note here because the stream quotes it.
		const stream = `${shortStream}\n${SHELL_METADATA}\n${shortStream}`;
		const artifact = writeArtifact('tool_midline', stream);
		const tail = `ne 340 ${'.'.repeat(30)}\n${lastLines(shortStream, 59)}`;
		const received = bashResult(artifact, tail).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: NOTES,
		});
	});

	it('a tail preview too short to trust is reported partial', () => {
		// A few coincidentally equal characters must not pass for a tail
		// preview: here only the final 40 characters of the stream precede the
		// host block.
		const artifact = writeArtifact('tool_shorttail', shortStream);
		const received = bashResult(artifact, shortStream.slice(-40)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'partial',
			reason: 'returned text does not line up with the saved copy',
		});
	});

	it('a stream that printed the block once and ends in blank lines keeps the host block', () => {
		// The visible tail is whitespace only, and the block text also occurs
		// earlier in the stream. Comparing line contents would treat the
		// host's block as output; position does not.
		const stream = `${shortStream}\n${SHELL_METADATA}\n${Array.from({ length: 2500 }, () => '    ').join('\n')}`;
		const artifact = writeArtifact('tool_blanktail', stream);
		const received = bashResult(artifact, lastLines(stream, 1500)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: NOTES,
		});
	});
});

describe('tool-summarizer — regression: whitespace around a printed block must not swallow the host block (CR-8)', () => {
	it('keeps the host block when the stream printed the block between two runs of blank lines', () => {
		// Previous code also tried the artifact with trailing whitespace
		// trimmed. For a stream of output + blank lines + its own printed block
		// + blank lines, that trimmed ending matched the WHOLE returned text —
		// the host's real block included — so no notes were reported and a
		// killed command looked complete.
		const blanks = Array.from({ length: 2500 }, () => ' '.repeat(40)).join(
			'\n',
		);
		const stream = `${shortStream}\n${blanks}\n\n${SHELL_METADATA}\n${blanks}`;
		const artifact = writeArtifact('tool_wsblock', stream);
		const received = bashResult(artifact, stream.slice(-51000)).output;

		expect(recover(artifact, received)).toEqual({
			kind: 'recovered',
			content: stream,
			hostNotes: ['<shell_metadata>', TIMEOUT_NOTE, '</shell_metadata>'],
		});
	});
});
