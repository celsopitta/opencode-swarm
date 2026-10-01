/**
 * Tool Output Summarizer Hook
 *
 * Intercepts oversized tool outputs in tool.execute.after,
 * stores the full content to .swarm/summaries/, and replaces
 * the output with a compact summary containing a retrieval ID.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHostDataDir } from '../config/cache-paths';
import { SUMMARIZER_EXEMPT_TOOL_NAMES } from '../config/constants';
import type { SummaryConfig } from '../config/schema';
import {
	allocateSummaryId,
	SummaryIdCollisionError,
	storeSummary,
} from '../summaries/manager';
import {
	createSummary,
	HOST_NOTES_LABEL,
	MAX_RETRIEVABLE_SUMMARY_BYTES,
	type SummaryOptions,
	shouldSummarize,
} from '../summaries/summarizer';
import { log, warn } from '../utils';
import { getStoredInputArgs } from './guardrails/stored-input-args';

/**
 * Bounded allocation attempts (issue #2576): every collision forces a fresh
 * directory rescan before the next attempt, so surviving N attempts requires
 * N distinct foreign winners of the same slot. The bound limits wasted work;
 * exhaustion fails open with the original output preserved.
 */
const MAX_ALLOCATION_ATTEMPTS = 8;

// HOST-PINNED ASSUMPTIONS (truthful summary recovery) — verified against the
// opencode host (v1.18.33) and the real incident records on this machine, and
// pinned by tests/unit/hooks/tool-summarizer-recovery.test.ts. Re-verify
// against the host if its truncation behavior changes:
//   1. Structured signal — when the host truncates a tool result it returns
//      the cut output together with `metadata.truncated === true` and
//      `metadata.outputPath` (the absolute path of the full copy). That same
//      result object is what `tool.execute.after` receives.
//      This holds for plugin tools and host built-ins. MCP tool results reach
//      the hook BEFORE host truncation and carry no `output` string, so they
//      are never summarized or recovered here. The host binary also holds a
//      second bounding path (`ToolOutputStore`, structured `content` results
//      with `outputPaths`); it was not observed delivering results to this
//      hook, and a result without `metadata.truncated` is summarized as
//      received.
//   2. Leaf grammar — the artifact is a file named `tool_<id>` (underscore)
//      placed DIRECTLY under <XDG_DATA_HOME or ~/.local/share>/opencode/tool-output/.
//   3. The artifact is NOT always a superset of the returned text. The generic
//      truncation wrapper adds only its truncation notice, but `bash` saves the
//      raw stream and appends `<shell_metadata>` (command timed out / user
//      aborted) to the returned text alone. Recovery therefore carries over
//      whatever the host added after the stream tail (see extractHostNotes)
//      instead of assuming the artifact says everything, and refuses to
//      present the artifact as the whole result when the returned text does
//      not line up with it.
//
// The host also appends a human-readable "Full output saved to: <path>" notice
// to the output text. WHETHER to recover and WHICH file to read are decided
// from the structured metadata alone, never from that text: tool output is
// untrusted content, and an output that merely quotes an old notice (a grep
// over logs, a search hit on this file) must not be able to redirect recovery
// to an unrelated artifact or mislabel a complete output as partial. The text
// is consulted only afterwards, to find the host's own notes, and only by the
// position of the metadata-reported path and of the artifact's tail.
const HOST_ARTIFACT_LEAF_RE = /^tool_[A-Za-z0-9]+$/;

/**
 * Host truncation state read from the structured `metadata` of a tool result.
 * `outputPath` is null when the host reported truncation without a usable path.
 */
interface HostTruncation {
	truncated: boolean;
	outputPath: string | null;
}

/**
 * Reads the host's structured truncation signal from a tool result's metadata.
 * Anything other than an object carrying `truncated === true` is "not
 * truncated" — the absence of the signal never triggers recovery.
 */
function readHostTruncation(metadata: unknown): HostTruncation {
	if (typeof metadata !== 'object' || metadata === null) {
		return { truncated: false, outputPath: null };
	}
	const record = metadata as Record<string, unknown>;
	if (record.truncated !== true) {
		return { truncated: false, outputPath: null };
	}
	const outputPath =
		typeof record.outputPath === 'string' && record.outputPath.length > 0
			? record.outputPath
			: null;
	return { truncated: true, outputPath };
}

/**
 * Room kept below the `retrieve_summary` size limit for the host notes that
 * are appended to a recovered artifact before it is stored.
 */
const HOST_NOTES_RESERVE_BYTES = 64 * 1024;

/**
 * A tail preview shorter than this (and shorter than the text it sits in) is
 * not accepted as lining up with the artifact: a few coincidentally equal
 * characters must not pass for a tail preview.
 */
const MIN_TAIL_ALIGNMENT_CHARS = 256;

/**
 * Host notes are short status blocks. More lines than this after the stream
 * tail means the text did not really line up with the artifact.
 */
const MAX_HOST_NOTE_LINES = 64;

/**
 * Length of the longest prefix of `text` that is also a suffix of `artifact`
 * — i.e. how much of `text`, from its start, is a tail preview of the
 * artifact. Exact and linear (Knuth–Morris–Pratt): no probe, no retry bound.
 */
function alignedTailLength(text: string, artifact: string): number {
	if (text.length === 0 || artifact.length === 0) {
		return 0;
	}
	const failure = new Int32Array(text.length);
	for (let i = 1, k = 0; i < text.length; i += 1) {
		while (k > 0 && text.charCodeAt(i) !== text.charCodeAt(k)) {
			k = failure[k - 1];
		}
		if (text.charCodeAt(i) === text.charCodeAt(k)) {
			k += 1;
		}
		failure[i] = k;
	}
	// Only the last `text.length` characters of the artifact can matter, and
	// over a window no longer than `text` a full match can only complete on
	// the final character, so `matched` never indexes past the end of `text`.
	const tail = artifact.slice(-text.length);
	let matched = 0;
	for (let i = 0; i < tail.length; i += 1) {
		const code = tail.charCodeAt(i);
		while (matched > 0 && code !== text.charCodeAt(matched)) {
			matched = failure[matched - 1];
		}
		if (code === text.charCodeAt(matched)) {
			matched += 1;
		}
	}
	return matched;
}

/**
 * Finds the lines the host added to the returned text that the saved artifact
 * does not contain — e.g. bash's `<shell_metadata>` timeout/abort block — so a
 * recovered summary does not present a killed command as a complete result.
 * Returns null when the returned text cannot be reconciled with the artifact,
 * in which case the caller must not claim the artifact is the whole result.
 *
 * Only the text AFTER the paragraph carrying the host-reported artifact path
 * is examined: that paragraph is the truncation notice, which recovery
 * supersedes, and what precedes it is the cut preview and its
 * "... truncated ..." marker. The anchor is the structured `outputPath`
 * value, never notice wording; without it the whole text is examined.
 *
 * That text must BEGIN with a tail of the artifact (a tail preview, possibly
 * starting mid-line); whatever follows the tail is the host's notes. The
 * split is purely positional — line contents are never compared — so output
 * that merely prints the same text as a host note cannot make the real note
 * look like output. The artifact is compared exactly as saved: the host's
 * previews are verbatim tails, and a looser match (e.g. ignoring trailing
 * whitespace) could swallow a real host note that follows whitespace.
 */
function extractHostNotes(
	received: string,
	artifact: string,
	outputPath: string,
): string[] | null {
	const lines = received.split('\n');
	let start = 0;
	const anchor = lines.findIndex((line) => line.includes(outputPath));
	if (anchor >= 0) {
		start = anchor + 1;
		while (start < lines.length && lines[start].trim() !== '') {
			start += 1;
		}
		// Skip the one blank line that separates the notice from what follows.
		if (start < lines.length) {
			start += 1;
		}
	}
	const text = lines.slice(start).join('\n');
	// Nothing follows the notice (the generic head layout): no notes.
	if (text.trim() === '') {
		return [];
	}
	const aligned = alignedTailLength(text, artifact);
	if (aligned < Math.min(MIN_TAIL_ALIGNMENT_CHARS, text.length)) {
		return null;
	}
	const notes = text
		.slice(aligned)
		.split('\n')
		.filter((line) => line.trim() !== '');
	return notes.length > MAX_HOST_NOTE_LINES ? null : notes;
}

/**
 * Outcome of a truthful-summary recovery attempt.
 * - `none`: the host did not truncate this output; summarize as-is.
 * - `recovered`: the true full artifact was read back, together with any
 *   notes the host attached to the returned text that the artifact lacks.
 * - `partial`: the host truncated the output but recovery failed; summarize
 *   the truncated string truthfully in partial mode.
 */
export type ArtifactRecovery =
	| { kind: 'none' }
	| { kind: 'recovered'; content: string; hostNotes: string[] }
	| { kind: 'partial'; reason: string };

/**
 * Attempts to recover the true full artifact for a host-truncated tool output.
 *
 * The trigger is the host's structured `metadata.truncated` / `outputPath`
 * signal — never the output text. Guards (defense in depth): the containment
 * base is `path.join(getHostDataDir(), 'tool-output')` — XDG_DATA_HOME-aware
 * and host-verbatim, never a hardcoded ~/.local/share; BOTH the reported path
 * and the base are realpath-resolved so a symlinked base and a symlinked
 * artifact both resolve to their canonical form; the resolved path must be a
 * DIRECT child of the resolved base whose leaf matches the host artifact
 * grammar (`tool_<id>`) — rejecting sibling-prefix tricks like
 * `tool-output-evil/` and symlink escapes; the artifact must be a non-empty
 * regular file (a FIFO or device node would block on read); and it must not
 * exceed `config.max_stored_bytes` or what `retrieve_summary` can serve (stat
 * before read). Any failure — no path,
 * outside containment, grammar mismatch, not a regular file, empty,
 * missing/unreadable, oversized, or returned text that does not line up with
 * the artifact — yields `partial` so the caller never claims full content.
 *
 * @param metadata - The tool result's `metadata` as received by the hook
 * @param config - Summary configuration (max_stored_bytes is the size guard)
 * @param received - The (truncated) output text the host returned; host-added
 *   lines it carries beyond the artifact are returned as `hostNotes`
 * @returns The recovery outcome
 */
export function recoverTruncatedOutput(
	metadata: unknown,
	config: SummaryConfig,
	received = '',
): ArtifactRecovery {
	const host = readHostTruncation(metadata);
	if (!host.truncated) {
		return { kind: 'none' };
	}
	if (host.outputPath === null) {
		return { kind: 'partial', reason: 'host reported no artifact path' };
	}

	try {
		// Containment base: host-verbatim, XDG_DATA_HOME-aware via getHostDataDir.
		// Resolved inside the try so a failing home-directory lookup degrades to
		// partial instead of escaping the hook.
		const baseDir = path.join(getHostDataDir(), 'tool-output');

		// Realpath BOTH the base and the reported path: a symlinked base and a
		// symlinked artifact both resolve to their canonical targets, so the
		// containment comparison below is canonical-form-to-canonical-form.
		const resolvedBase = fs.realpathSync(baseDir);
		const resolvedPath = fs.realpathSync(host.outputPath);

		// Containment: the resolved artifact must be a DIRECT child of the
		// resolved base (rejects sibling-prefix tricks and symlink escapes).
		if (path.dirname(resolvedPath) !== resolvedBase) {
			return { kind: 'partial', reason: 'artifact outside containment base' };
		}
		// Grammar: the leaf must match the host artifact grammar tool_<id>.
		if (!HOST_ARTIFACT_LEAF_RE.test(path.basename(resolvedPath))) {
			return {
				kind: 'partial',
				reason: 'artifact leaf grammar mismatch',
			};
		}
		// Regular-file guard: a FIFO or device node named like an artifact
		// would block or misbehave on read; only a regular file is an artifact.
		const stat = fs.statSync(resolvedPath);
		if (!stat.isFile()) {
			return { kind: 'partial', reason: 'artifact is not a regular file' };
		}
		// An empty artifact cannot be the full copy of a truncated output.
		if (stat.size === 0) {
			return { kind: 'partial', reason: 'artifact is empty' };
		}
		// Size guards, checked before reading: the configured storage cap, and
		// what retrieve_summary can serve — a copy the tool would refuse must
		// not sit behind a "use retrieve_summary" footer.
		if (stat.size > config.max_stored_bytes) {
			return { kind: 'partial', reason: 'artifact exceeds max_stored_bytes' };
		}
		if (stat.size > MAX_RETRIEVABLE_SUMMARY_BYTES - HOST_NOTES_RESERVE_BYTES) {
			return {
				kind: 'partial',
				reason: 'artifact exceeds the retrieve_summary limit',
			};
		}
		// Success: read the true full artifact content, plus whatever the host
		// added to the returned text that the artifact lacks. If the returned
		// text cannot be reconciled with the artifact, the artifact cannot be
		// presented as the whole result.
		const artifact = fs.readFileSync(resolvedPath, 'utf-8');
		const hostNotes = extractHostNotes(received, artifact, host.outputPath);
		if (hostNotes === null) {
			return {
				kind: 'partial',
				reason: 'returned text does not line up with the saved copy',
			};
		}
		return { kind: 'recovered', content: artifact, hostNotes };
	} catch {
		// Any FS error (missing base, missing/unreadable artifact, realpath
		// failure) fails open: no recovery, caller falls back to partial mode.
		return { kind: 'partial', reason: 'artifact missing or unreadable' };
	}
}

/**
 * True when this tool call is itself a retrieval of a stored summary through
 * the `/swarm retrieve` command (delivered to agents via the `swarm_command`
 * tool). Its output IS the stored content, so summarizing it again would hand
 * the agent a new stub pointing at a copy of the same content — a retrieval
 * loop. `swarm_command` as a whole stays summarizable; only the retrieve
 * command is exempt.
 *
 * Args come from the hook input when the host supplies them, otherwise from
 * the callID snapshot taken in `tool.execute.before` (#1849).
 */
function isSummaryRetrievalCall(input: {
	tool: string;
	callID: string;
	args?: unknown;
}): boolean {
	if (input.tool !== 'swarm_command') {
		return false;
	}
	const args = input.args ?? _internals.getStoredInputArgs(input.callID);
	return (
		typeof args === 'object' &&
		args !== null &&
		(args as Record<string, unknown>).command === 'retrieve'
	);
}

/**
 * Pure helpers exposed for direct unit testing (repo `_test_exports`
 * convention): the alignment is checked against a brute-force reference.
 */
export const _test_exports = { alignedTailLength };

/**
 * Dependency seam for tests (repo `_internals` DI convention) so the
 * collision-retry path and the recovery path are unit-testable without
 * `mock.module`.
 */
export const _internals = {
	allocateSummaryId,
	storeSummary,
	recoverTruncatedOutput,
	getStoredInputArgs,
};

/**
 * Creates a tool.execute.after hook that summarizes oversized tool outputs.
 *
 * @param config - Summary configuration including enabled, thresholds, and limits
 * @param directory - Base directory for storing full outputs
 * @returns Async hook function for tool.execute.after
 */
export function createToolSummarizerHook(
	config: SummaryConfig,
	directory: string,
): (
	input: { tool: string; sessionID: string; callID: string; args?: unknown },
	output: { title: string; output: string; metadata: unknown },
) => Promise<void> {
	// If summaries disabled, return no-op
	if (config.enabled === false) {
		return async () => {};
	}

	return async (input, output) => {
		// Skip non-string or empty outputs
		if (typeof output.output !== 'string' || output.output.length === 0) {
			return;
		}

		// Skip exempt tools. SUMMARIZER_EXEMPT_TOOL_NAMES is a FLOOR that always
		// applies — retrieval tools (retrieve_summary, retrieve_lane_output, task,
		// read) create a retrieval loop if their own output is summarized,
		// ref-carrying lane tools (dispatch_lanes*, collect_lane_results,
		// parse_lane_candidates) carry output_ref/structured rows that the
		// PR-workflow gate requires — rewriting them to a summary destroys the
		// refs and the gate can never settle — and the host `skill` tool returns
		// instructions the agent must read in full. Operator-configured
		// `exempt_tools` is additive on top of the floor, never a replacement
		// for it.
		const exemptTools = config.exempt_tools ?? [];
		if (
			(SUMMARIZER_EXEMPT_TOOL_NAMES as readonly string[]).includes(
				input.tool,
			) ||
			exemptTools.includes(input.tool)
		) {
			return;
		}

		// Skip `/swarm retrieve` delivered through swarm_command: its output is
		// the stored content itself, and summarizing it would loop.
		if (isSummaryRetrievalCall(input)) {
			return;
		}

		// Check if output exceeds threshold (with hysteresis)
		if (!shouldSummarize(output.output, config.threshold_bytes)) {
			return;
		}

		// Truthful summary recovery: when the host reports (via structured
		// metadata) that it already truncated this output and saved the full
		// copy, recover the TRUE full artifact from the host's tool-output
		// directory under strict containment/grammar/size guards. On success,
		// createSummary + storeSummary operate on the true full content
		// (truthful [SUMMARY] header + originalBytes). On any recovery failure,
		// summarize the truncated string truthfully in partial mode so the
		// summary never claims full content. A recovery step that THROWS keeps
		// the hook's fail-open contract: the original output is preserved.
		let recovery: ArtifactRecovery;
		try {
			recovery = _internals.recoverTruncatedOutput(
				output.metadata,
				config,
				output.output,
			);
		} catch (error) {
			warn(
				`Tool output summarization failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (recovery.kind === 'partial') {
			log(
				`Host-truncated output of ${input.tool} summarized as partial: ${recovery.reason}`,
			);
		}
		// Durable identity + no-overwrite storage (issue #2576): each attempt
		// allocates the next free ID from the entries that exist on disk
		// (restart-safe), embeds it in a freshly created summary text, and
		// stores with exclusive-install semantics. A collision means another
		// process won the slot — retry with a fresh allocation. ANY failure
		// on an attempt — allocation, summary rendering, or storage — is
		// returned to the caller so the hook's fail-open contract holds end
		// to end (PRR-001): exhausted attempts or non-collision errors keep
		// the original output preserved.
		// `described` is what the summary header and preview are built from;
		// `stored` is what retrieve_summary returns. They differ only for a
		// recovered output with host notes, where the notes are stored after
		// the artifact but shown on their own reserved line — never mixed into
		// the preview, where they would displace the output's real last lines.
		const summarizeAndStore = async (
			described: string,
			stored: string,
			options: SummaryOptions,
		): Promise<unknown | null> => {
			for (let attempt = 1; ; attempt += 1) {
				try {
					const summaryId = _internals.allocateSummaryId(directory);
					const summaryText = createSummary(
						described,
						input.tool,
						summaryId,
						config.max_summary_chars,
						options,
					);
					await _internals.storeSummary(
						directory,
						summaryId,
						stored,
						summaryText,
						config.max_stored_bytes,
					);
					// Only replace output after successful storage
					output.output = summaryText;
					return null;
				} catch (error) {
					if (
						error instanceof SummaryIdCollisionError &&
						attempt < MAX_ALLOCATION_ATTEMPTS
					) {
						continue;
					}
					return error;
				}
			}
		};

		let failure: unknown | null;
		if (recovery.kind === 'recovered') {
			// The stored content is the full artifact followed by the host's
			// notes (labelled), so retrieve_summary returns both; the summary
			// describes the artifact and shows the notes on a reserved line.
			const { hostNotes } = recovery;
			const stored =
				hostNotes.length > 0
					? `${recovery.content}\n\n${HOST_NOTES_LABEL}\n${hostNotes.join('\n')}`
					: recovery.content;
			failure = await summarizeAndStore(recovery.content, stored, {
				hostNotes,
			});
			if (failure !== null && !(failure instanceof SummaryIdCollisionError)) {
				// The recovered copy could not be stored (e.g. its serialized
				// entry exceeds max_stored_bytes). Fall back to a truthful
				// partial summary of what the host returned rather than leaving
				// the output unsummarized; the host notes already found are
				// kept on its reserved line. Exhausted ID collisions are not a
				// reason to fall back: the copy was storable, and a retry would
				// collide the same way, so that case stays fail-open.
				log(
					`Recovered output of ${input.tool} could not be stored (${failure instanceof Error ? failure.message : String(failure)}); summarizing as partial`,
				);
				failure = await summarizeAndStore(output.output, output.output, {
					partial: true,
					hostNotes,
				});
			}
		} else {
			failure = await summarizeAndStore(output.output, output.output, {
				partial: recovery.kind === 'partial',
			});
		}
		if (failure !== null) {
			// Graceful degradation: log warning and keep original output
			// (output.output is only replaced after a successful store).
			warn(
				`Tool output summarization failed: ${failure instanceof Error ? failure.message : String(failure)}`,
			);
		}
	};
}
