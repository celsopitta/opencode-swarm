/**
 * Summarization engine for tool outputs.
 * Provides content type detection, summarization decision logic, and structured summary creation.
 */

/**
 * Hysteresis factor to prevent churn for outputs near the threshold.
 * An output must be 25% larger than the threshold to be summarized.
 */
export const HYSTERESIS_FACTOR = 1.25;

/**
 * Content type classification for tool outputs.
 */
type ContentType = 'json' | 'code' | 'text' | 'binary';

/**
 * Heuristic-based content type detection.
 * @param output - The tool output string to analyze
 * @param toolName - The name of the tool that produced the output
 * @returns The detected content type: 'json', 'code', 'text', or 'binary'
 */
export function detectContentType(
	output: string,
	toolName: string,
): ContentType {
	// Check for JSON first
	const trimmed = output.trim();
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			JSON.parse(trimmed);
			return 'json';
		} catch {
			// Not valid JSON, continue to other checks
		}
	}

	// Check if tool suggests code (read, cat, grep, bash)
	const codeToolNames = ['read', 'cat', 'grep', 'bash'];
	const lowerToolName = toolName.toLowerCase();
	const toolSegments = lowerToolName.split(/[.\-_/]/);
	if (codeToolNames.some((name) => toolSegments.includes(name))) {
		return 'code';
	}

	// Check for common code patterns
	const codePatterns = [
		'function ',
		'const ',
		'import ',
		'export ',
		'class ',
		'def ',
		'return ',
		'=>',
	];
	const startsWithShebang = trimmed.startsWith('#!');

	if (
		codePatterns.some((pattern) => output.includes(pattern)) ||
		startsWithShebang
	) {
		return 'code';
	}

	// Check for binary content (high ratio of non-printable characters)
	const sampleSize = Math.min(1000, output.length);
	let nonPrintableCount = 0;
	for (let i = 0; i < sampleSize; i++) {
		const charCode = output.charCodeAt(i);
		// Count chars with code < 32, excluding \n (10), \r (13), \t (9)
		if (charCode < 32 && charCode !== 9 && charCode !== 10 && charCode !== 13) {
			nonPrintableCount++;
		}
	}

	if (sampleSize > 0 && nonPrintableCount / sampleSize > 0.1) {
		return 'binary';
	}

	// Default to text
	return 'text';
}

/**
 * Determines whether output should be summarized based on size and hysteresis.
 * Uses hysteresis to prevent repeated summarization decisions for outputs near the threshold.
 * @param output - The tool output string to check
 * @param thresholdBytes - The threshold in bytes
 * @returns true if the output should be summarized
 */
export function shouldSummarize(
	output: string,
	thresholdBytes: number,
): boolean {
	const byteLength = Buffer.byteLength(output, 'utf8');
	return byteLength >= thresholdBytes * HYSTERESIS_FACTOR;
}

/**
 * Formats bytes into a human-readable string.
 * @param bytes - Number of bytes
 * @returns Formatted string (e.g., "20.5 KB", "1.2 MB")
 */
function formatBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB'];
	let unitIndex = 0;
	let size = bytes;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	// Format to 1 decimal place if not whole number
	const formatted = unitIndex === 0 ? size.toString() : size.toFixed(1);
	return `${formatted} ${units[unitIndex]}`;
}

/**
 * Infer a compact type signature for a JSON value.
 */
function jsonTypeSignature(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) {
		const len = value.length;
		if (len === 0) return 'array<>';
		const first = value[0];
		return `array<${len}, ${jsonTypeSignature(first)}>`;
	}
	switch (typeof value) {
		case 'string':
			return 'string';
		case 'number':
			return Number.isInteger(value) ? 'number' : 'number(float)';
		case 'boolean':
			return 'boolean';
		case 'object':
			return 'object';
		default:
			return typeof value;
	}
}

/**
 * Build a structure-aware preview for a JSON object.
 * Shows ALL top-level keys with their type signatures (AC-008 / SC-012).
 */
function summarizeJsonObject(parsed: Record<string, unknown>): string {
	const keys = Object.keys(parsed);
	const parts = keys.map((key) => `${key}: ${jsonTypeSignature(parsed[key])}`);
	return `{ ${parts.join(', ')} }`;
}

/**
 * Build a structure-aware preview for a JSON array.
 */
function summarizeJsonArray(parsed: unknown[]): string {
	const len = parsed.length;
	if (len === 0) return '[ 0 items ]';
	const firstSig = jsonTypeSignature(parsed[0]);
	return `[ ${len} items, first: ${firstSig} ]`;
}

/**
 * Regex-based extractor for declaration signatures in code output.
 */
const DECLARATION_PATTERN =
	/(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+(\w+)/g;

/**
 * Bound on distinct declaration names collected. The names only feed a
 * preview line that is byte-capped at `max_summary_chars` (≤ 5000), which
 * this many names always overflow, so the cap never changes which names are
 * shown — it bounds the scan when a multi-megabyte recovered artifact is
 * summarized.
 */
const MAX_CODE_SIGNATURES = 2000;

/**
 * Extract declaration names from code text (distinct, in first-seen order,
 * at most {@link MAX_CODE_SIGNATURES}). Linear in the text scanned and stops
 * at the cap.
 */
function extractCodeSignatures(code: string): string[] {
	const seen = new Set<string>();
	for (const match of code.matchAll(DECLARATION_PATTERN)) {
		const name = match[1];
		if (name && !seen.has(name)) {
			seen.add(name);
			if (seen.size >= MAX_CODE_SIGNATURES) {
				break;
			}
		}
	}
	return [...seen];
}

/**
 * Per-line character cap (#2107 §5): a single oversized line (e.g. a 1 MiB
 * minified blob on one line) must be bounded on its own, with a truthful
 * omission suffix — never materialized in full and silently cut later.
 */
const MAX_SUMMARY_LINE_CHARS = 400;

/**
 * Codepoint-safe truncation to a UTF-8 byte budget (#2107 §5).
 *
 * Iterates code points (never UTF-16 units) so a multibyte CJK/emoji run can
 * never be split mid-codepoint, and the result is deterministic across Bun and
 * Node (which disagree on `Buffer.byteLength` for unpaired surrogates — per
 * code point, both agree). Returns the kept text and the exact number of bytes
 * omitted.
 */
export function truncateToBytes(
	text: string,
	maxBytes: number,
): { text: string; omittedBytes: number } {
	const totalBytes = Buffer.byteLength(text, 'utf8');
	if (maxBytes <= 0) {
		return { text: '', omittedBytes: totalBytes };
	}
	let used = 0;
	let kept = '';
	for (const codePoint of text) {
		const cpBytes = Buffer.byteLength(codePoint, 'utf8');
		if (used + cpBytes > maxBytes) {
			return { text: kept, omittedBytes: totalBytes - used };
		}
		kept += codePoint;
		used += cpBytes;
	}
	return { text, omittedBytes: 0 };
}

function capLine(line: string): string {
	if (line.length <= MAX_SUMMARY_LINE_CHARS) {
		return line;
	}
	const omitted = line.length - MAX_SUMMARY_LINE_CHARS;
	return `${line.slice(0, MAX_SUMMARY_LINE_CHARS)} [... ${omitted} chars omitted on this line ...]`;
}

/**
 * Deterministic bounded head/tail preview (#2107 §5).
 *
 * Head: the leading non-blank identity lines (ceil half of the line budget).
 * Tail: the trailing RAW outcome lines (floor half) — compiler, test, lint,
 * and security verdicts live at the END of tool output, so the old head-only
 * preview discarded exactly the decision-relevant evidence. Lines are never
 * reordered within either segment, no outcome is invented, and every dropped
 * region is disclosed with an accurate omitted-line count. When everything
 * fits, the original text is returned unchanged (modulo per-line caps).
 */
function headTailPreview(output: string, maxLines: number): string {
	const rawLines = output.split('\n');
	if (maxLines <= 0) {
		return '';
	}
	// Everything fits: return the original text unchanged (modulo per-line
	// caps). No omission marker, no reordering, no blank-line rewriting.
	if (rawLines.length <= maxLines) {
		return rawLines.map(capLine).join('\n');
	}
	const headCount = Math.max(1, Math.ceil(maxLines / 2));
	const tailCount = Math.max(0, maxLines - headCount);

	// Head: leading non-blank identity lines, never reaching into the tail
	// region (a line must not appear in both segments).
	const headLimitIndex =
		tailCount > 0 ? rawLines.length - tailCount : rawLines.length;
	const headLines: string[] = [];
	for (let i = 0; i < headLimitIndex && headLines.length < headCount; i++) {
		const line = rawLines[i];
		if (line.trim().length === 0) continue;
		headLines.push(line);
	}
	const tailLines: string[] = tailCount > 0 ? rawLines.slice(-tailCount) : [];
	// Trailing blank lines carry no evidence; trim them from the tail segment.
	while (
		tailLines.length > 0 &&
		tailLines[tailLines.length - 1].trim() === ''
	) {
		tailLines.pop();
	}

	const omittedCount = rawLines.length - headLines.length - tailLines.length;
	const segments: string[] = [];
	if (headLines.length > 0) {
		segments.push(headLines.map(capLine).join('\n'));
	}
	if (omittedCount > 0) {
		segments.push(`[... ${omittedCount} lines omitted ...]`);
	}
	if (tailLines.length > 0) {
		segments.push(tailLines.map(capLine).join('\n'));
	}
	return segments.join('\n');
}

/**
 * Build a preview for code output that includes declaration signatures plus
 * the bounded head/tail policy (failure output at the end of a code blob is
 * preserved).
 */
function summarizeCode(output: string): string {
	const signatures = extractCodeSignatures(output);
	const preview = headTailPreview(output, 5);

	if (signatures.length === 0) {
		return preview;
	}

	const sigLine = `// declarations: ${signatures.join(', ')}`;
	return [sigLine, preview].join('\n');
}

/**
 * Build a preview for plain text output using the bounded head/tail policy
 * (see headTailPreview). Previously head-only: the first `maxLines` non-blank
 * lines, which silently discarded trailing failure/exit evidence.
 */
function summarizeText(output: string, maxLines: number): string {
	return headTailPreview(output, maxLines);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for {@link createSummary}.
 */
export interface SummaryOptions {
	/**
	 * Mark the summary as partial: the stored content is known-truncated
	 * and the full output was not recoverable. The header keeps the
	 * `[SUMMARY <id>]` marker and gains an explicit ` | partial` mark; the
	 * footer says only the partial output is stored and never claims the
	 * full output is retrievable.
	 */
	partial?: boolean;
	/**
	 * Lines the host attached to the result that the tool output itself does
	 * not contain (e.g. bash's "command timed out" block). They get a reserved
	 * line directly above the footer, outside the preview budget, so a long
	 * or declaration-heavy output can never push them out of the summary.
	 */
	hostNotes?: readonly string[];
}

/**
 * Largest stored output the `retrieve_summary` tool will serve. The summarizer
 * must not store, behind a "use retrieve_summary" footer, content that tool
 * would refuse — so recovery of a host artifact is bounded by this as well as
 * by `summaries.max_stored_bytes`. Defined here (not in the storage manager)
 * so the tests that module-mock the manager keep a complete export set.
 */
export const MAX_RETRIEVABLE_SUMMARY_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Label that introduces host-added notes, both on the reserved summary line
 * and in the stored content.
 */
export const HOST_NOTES_LABEL = '[host notes on this result]';

/**
 * What the label is rewritten to when it occurs inside tool output shown in a
 * preview, so output carrying the exact label is not mistaken for the reserved
 * host-notes line (look-alike text is not detected).
 */
const QUOTED_HOST_NOTES_LABEL = '[output text: host notes on this result]';

/**
 * Byte cap for the reserved host-notes line (label excluded). Host notes are
 * short status messages; the cap only bounds a pathological case.
 */
const MAX_HOST_NOTES_LINE_BYTES = 400;

/**
 * Renders host notes as one summary line, or null when there are none. Tag-only
 * lines carry no information on a single line, so `<x>` / `</x>` wrappers are
 * dropped here (the stored content keeps them verbatim).
 */
function renderHostNotesLine(
	hostNotes: readonly string[] | undefined,
): string | null {
	if (!hostNotes || hostNotes.length === 0) {
		return null;
	}
	const informative = hostNotes
		.map((note) => note.trim())
		.filter((note) => note.length > 0 && !/^<\/?[A-Za-z_][\w-]*>$/.test(note));
	const joined = (informative.length > 0 ? informative : hostNotes).join(' | ');
	const { text, omittedBytes } = truncateToBytes(
		joined,
		MAX_HOST_NOTES_LINE_BYTES,
	);
	return `${HOST_NOTES_LABEL} ${text}${omittedBytes > 0 ? '…' : ''}`;
}

/**
 * Creates a structured summary string from tool output.
 * @param output - The full tool output string (in partial mode, the stored
 * known-truncated content, which the size/lines/type fields then describe)
 * @param toolName - The name of the tool that produced the output
 * @param summaryId - Unique identifier for this summary
 * @param maxSummaryChars - Maximum bytes allowed for the preview
 * @param options - Optional behavior switches (e.g. `partial` mode)
 * @returns Formatted summary string
 */
export function createSummary(
	output: string,
	toolName: string,
	summaryId: string,
	maxSummaryChars: number,
	options?: SummaryOptions,
): string {
	const contentType = detectContentType(output, toolName);
	const lineCount = output.split('\n').length;
	const byteSize = Buffer.byteLength(output, 'utf8');
	const formattedSize = formatBytes(byteSize);

	// Calculate overhead for header and footer lines (in BYTES — the footer's
	// "→" is 3 UTF-8 bytes, so a character count would under-reserve and let
	// the total slip past the cap).
	const partial = options?.partial === true;
	// The footer is the retrieval contract every agent sees on every summary,
	// so it names the `retrieve_summary` TOOL (the paged, summarizer-exempt
	// retrieval path) rather than the `/swarm retrieve` slash command. Partial
	// mode: the header keeps the `[SUMMARY <id>]` marker and is explicitly
	// marked partial, and the footer must never claim the full output is
	// retrievable — only the stored partial output is.
	const headerLine = partial
		? `[SUMMARY ${summaryId}] ${formattedSize} | ${contentType} | ${lineCount} lines | partial`
		: `[SUMMARY ${summaryId}] ${formattedSize} | ${contentType} | ${lineCount} lines`;
	// The normal footer is kept no longer than the legacy `/swarm retrieve`
	// footer so the change does not push a summary past a small
	// `max_summary_chars`; the partial footer is a few bytes longer.
	const footerLine = partial
		? `→ Partial output only; use retrieve_summary ${summaryId}`
		: `→ Use retrieve_summary ${summaryId} for full output`;
	// Host notes are part of the fixed frame, like the header and footer: they
	// are never cut by the preview budget.
	const hostNotesLine = renderHostNotesLine(options?.hostNotes);
	const overhead =
		Buffer.byteLength(headerLine, 'utf8') +
		1 +
		(hostNotesLine === null
			? 0
			: Buffer.byteLength(hostNotesLine, 'utf8') + 1) +
		Buffer.byteLength(footerLine, 'utf8') +
		1;

	const maxPreviewChars = maxSummaryChars - overhead;

	let preview: string;

	switch (contentType) {
		case 'json': {
			try {
				const parsed = JSON.parse(output.trim());
				if (Array.isArray(parsed)) {
					preview = summarizeJsonArray(parsed);
				} else if (typeof parsed === 'object' && parsed !== null) {
					preview = summarizeJsonObject(parsed as Record<string, unknown>);
				} else {
					preview = summarizeText(output, 3);
				}
			} catch {
				preview = summarizeText(output, 3);
			}
			break;
		}
		case 'code': {
			preview = summarizeCode(output);
			break;
		}
		case 'text': {
			preview = summarizeText(output, 5);
			break;
		}
		case 'binary': {
			preview = `[Binary content - ${formattedSize}]`;
			break;
		}
		default: {
			preview = summarizeText(output, 5);
		}
	}

	// The preview is untrusted tool output: it must not be able to imitate the
	// reserved host-notes line, so the label is defanged wherever the output
	// itself contains it.
	preview = preview.replaceAll(HOST_NOTES_LABEL, QUOTED_HOST_NOTES_LABEL);

	// Byte-safe preview cap (#2107 §5). The cap is enforced on UTF-8 bytes with
	// codepoint-safe truncation — multibyte content can no longer slip past the
	// implied budget the way the old character-based substring allowed — and
	// the omission is disclosed truthfully. When even the marker would not fit
	// the remaining budget, a minimal `...` marker is used so the TOTAL stays
	// within maxSummaryChars whenever the fixed frame (header, host-notes line,
	// footer) leaves room for it. The frame is never cut: at a cap close to the
	// schema minimum it can exceed the cap by itself.
	const previewBytes = Buffer.byteLength(preview, 'utf8');
	if (previewBytes > maxPreviewChars) {
		let marker = `[... ${previewBytes} bytes total, truncated ...]`;
		if (Buffer.byteLength(marker, 'utf8') > maxPreviewChars) {
			marker = '...';
		}
		const { text: kept } = truncateToBytes(
			preview,
			Math.max(0, maxPreviewChars - Buffer.byteLength(marker, 'utf8')),
		);
		preview = `${kept}${marker}`;
	}

	return hostNotesLine === null
		? `${headerLine}\n${preview}\n${footerLine}`
		: `${headerLine}\n${preview}\n${hostNotesLine}\n${footerLine}`;
}

/**
 * Internal helpers exposed for testability.
 */
export const _internals = {
	truncateToBytes,
	headTailPreview,
	jsonTypeSignature,
	summarizeJsonObject,
	summarizeJsonArray,
	extractCodeSignatures,
	summarizeCode,
	summarizeText,
};
