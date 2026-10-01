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
import { createSummary, shouldSummarize } from '../summaries/summarizer';
import { warn } from '../utils';

/**
 * Bounded allocation attempts (issue #2576): every collision forces a fresh
 * directory rescan before the next attempt, so surviving N attempts requires
 * N distinct foreign winners of the same slot. The bound limits wasted work;
 * exhaustion fails open with the original output preserved.
 */
const MAX_ALLOCATION_ATTEMPTS = 8;

// HOST-PINNED ASSUMPTIONS (truthful summary recovery) — both verified against
// the real opencode host incident artifact on this machine (69,555-byte host
// artifact at ~/.local/share/opencode/tool-output/tool_0ef804c130015O0Ic34t7uabqz)
// and pinned by tests/unit/hooks/tool-summarizer-recovery.test.ts. Re-verify
// against the host if its truncation behavior changes:
//   1. Notice wording — the truncated tool output carries the literal text
//      "Full output saved to: <absolute-artifact-path>".
//   2. Leaf grammar — the artifact is a file named `tool_<id>` (underscore)
//      placed DIRECTLY under <XDG_DATA_HOME or ~/.local/share>/opencode/tool-output/.
const HOST_TRUNCATION_NOTICE_RE = /Full output saved to:\s*(\S+)/;
const HOST_ARTIFACT_LEAF_RE = /^tool_[A-Za-z0-9]+$/;

/**
 * Extracts the host artifact path from a truncation notice, if present.
 * @param output - The (possibly host-truncated) tool output string
 * @returns The absolute artifact path, or null when no host notice is present
 */
export function extractArtifactPath(output: string): string | null {
	const match = HOST_TRUNCATION_NOTICE_RE.exec(output);
	return match ? match[1] : null;
}

/**
 * Outcome of a truthful-summary recovery attempt.
 * - `none`: the output carried no host truncation notice; summarize as-is.
 * - `recovered`: the true full artifact was read back; summarize that content.
 * - `partial`: a notice was present but recovery failed; summarize the
 *   truncated string truthfully in partial mode.
 */
export type ArtifactRecovery =
	| { kind: 'none' }
	| { kind: 'recovered'; content: string }
	| { kind: 'partial'; reason: string };

/**
 * Attempts to recover the true full artifact for a host-truncated tool output.
 *
 * Guards (defense in depth): the containment base is
 * `path.join(getHostDataDir(), 'tool-output')` — XDG_DATA_HOME-aware and
 * host-verbatim, never a hardcoded ~/.local/share; BOTH the captured path and
 * the base are realpath-resolved so a symlinked base and a symlinked artifact
 * both resolve to their canonical form; the resolved path must be a DIRECT
 * child of the resolved base whose leaf matches the host artifact grammar
 * (`tool_<id>`) — rejecting sibling-prefix tricks like `tool-output-evil/` and
 * symlink escapes; and the artifact must not exceed `config.max_stored_bytes`
 * (stat before read). Any failure — no notice, outside containment, grammar
 * mismatch, missing/unreadable, oversized — yields `partial` so the caller
 * never claims full content.
 *
 * @param output - The (possibly host-truncated) tool output string
 * @param config - Summary configuration (max_stored_bytes is the size guard)
 * @returns The recovery outcome
 */
export function recoverTruncatedOutput(
	output: string,
	config: SummaryConfig,
): ArtifactRecovery {
	const artifactPath = extractArtifactPath(output);
	if (artifactPath === null) {
		return { kind: 'none' };
	}

	// Containment base: host-verbatim, XDG_DATA_HOME-aware via getHostDataDir.
	const baseDir = path.join(getHostDataDir(), 'tool-output');

	try {
		// Realpath BOTH the base and the captured path: a symlinked base and a
		// symlinked artifact both resolve to their canonical targets, so the
		// containment comparison below is canonical-form-to-canonical-form.
		const resolvedBase = fs.realpathSync(baseDir);
		const resolvedPath = fs.realpathSync(artifactPath);

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
		// Size guard: stat before reading; reject oversized artifacts.
		if (fs.statSync(resolvedPath).size > config.max_stored_bytes) {
			return { kind: 'partial', reason: 'artifact exceeds max_stored_bytes' };
		}
		// Success: read the true full artifact content.
		return {
			kind: 'recovered',
			content: fs.readFileSync(resolvedPath, 'utf-8'),
		};
	} catch {
		// Any FS error (missing base, missing/unreadable artifact, realpath
		// failure) fails open: no recovery, caller falls back to partial mode.
		return { kind: 'partial', reason: 'artifact missing or unreadable' };
	}
}

/**
 * Dependency seam for tests (repo `_internals` DI convention) so the
 * collision-retry path and the recovery path are unit-testable without
 * `mock.module`.
 */
export const _internals = {
	allocateSummaryId,
	storeSummary,
	extractArtifactPath,
	recoverTruncatedOutput,
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
	input: { tool: string; sessionID: string; callID: string },
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
		// read) create a retrieval loop if their own output is summarized, and
		// ref-carrying lane tools (dispatch_lanes*, collect_lane_results,
		// parse_lane_candidates) carry output_ref/structured rows that the
		// PR-workflow gate requires — rewriting them to a summary destroys the
		// refs and the gate can never settle. Operator-configured `exempt_tools`
		// is additive on top of the floor, never a replacement for it.
		const exemptTools = config.exempt_tools ?? [];
		if (
			(SUMMARIZER_EXEMPT_TOOL_NAMES as readonly string[]).includes(
				input.tool,
			) ||
			exemptTools.includes(input.tool)
		) {
			return;
		}

		// Check if output exceeds threshold (with hysteresis)
		if (!shouldSummarize(output.output, config.threshold_bytes)) {
			return;
		}

		// Truthful summary recovery: if the received output carries a
		// host-truncation notice ("Full output saved to: <path>"), attempt to
		// recover the TRUE full artifact from the host's tool-output directory
		// under strict containment/grammar/size guards. On success, createSummary
		// + storeSummary operate on the true full content (truthful [SUMMARY]
		// header + originalBytes). On any recovery failure, summarize the
		// truncated string truthfully in partial mode so the header never
		// claims full content.
		const recovery = _internals.recoverTruncatedOutput(output.output, config);
		const content =
			recovery.kind === 'recovered' ? recovery.content : output.output;
		const isPartial = recovery.kind === 'partial';

		// Durable identity + no-overwrite storage (issue #2576): each attempt
		// allocates the next free ID from the entries that exist on disk
		// (restart-safe), embeds it in a freshly created summary text, and
		// stores with exclusive-install semantics. A collision means another
		// process won the slot — retry with a fresh allocation. ANY failure
		// on an attempt — allocation, summary rendering, or storage — is
		// caught below so the hook's fail-open contract holds end to end
		// (PRR-001): exhausted attempts or non-collision errors keep the
		// original output preserved.
		for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
			try {
				const summaryId = _internals.allocateSummaryId(directory);
				const summaryText = createSummary(
					content,
					input.tool,
					summaryId,
					config.max_summary_chars,
					{ partial: isPartial },
				);
				await _internals.storeSummary(
					directory,
					summaryId,
					content,
					summaryText,
					config.max_stored_bytes,
				);
				// Only replace output after successful storage
				output.output = summaryText;
				return;
			} catch (error) {
				if (
					error instanceof SummaryIdCollisionError &&
					attempt < MAX_ALLOCATION_ATTEMPTS
				) {
					continue;
				}
				// Graceful degradation: log warning and keep original output
				warn(
					`Tool output summarization failed: ${error instanceof Error ? error.message : String(error)}`,
				);
				// Do NOT modify output.output — original is preserved
				return;
			}
		}
	};
}
