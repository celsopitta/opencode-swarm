/**
 * Single source of truth for the Full-Auto oversight evidence filename
 * grammar (issue #3011).
 *
 * `.swarm/evidence/{phase}/full-auto-{seq}.json` is BOTH written by
 * `writeFullAutoOversightEvidence` (`src/full-auto/oversight.ts`) and scanned
 * by `nextFullAutoOversightSequence` (`src/full-auto/state.ts`) when the
 * durable counter catches up to persisted evidence. Defining the grammar once
 * here — instead of an inline template in the writer and a separate regex in
 * the scanner — makes writer/scanner drift impossible.
 *
 * Leaf module: imports nothing at all (pure string/regex builders), so both
 * `oversight.ts` and `state.ts` can share it without an import cycle.
 */

/**
 * Filename for one oversight evidence record: `full-auto-{seq}.json`.
 */
export function fullAutoOversightEvidenceFileName(sequence: number): string {
	return `full-auto-${sequence}.json`;
}

/**
 * Matches (and captures the sequence digits of) an oversight evidence
 * filename. Anchored to the full basename so `full-auto-1.json.bak`-style
 * neighbors and unrelated files are ignored.
 */
export const FULL_AUTO_OVERSIGHT_EVIDENCE_FILE_RE = /^full-auto-(\d+)\.json$/;
