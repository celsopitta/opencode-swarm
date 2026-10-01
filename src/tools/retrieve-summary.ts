import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadFullOutput, sanitizeSummaryId } from '../summaries/manager';
import { MAX_RETRIEVABLE_SUMMARY_BYTES } from '../summaries/summarizer';
import { createSwarmTool } from './create-tool';

const RETRIEVE_MAX_BYTES = MAX_RETRIEVABLE_SUMMARY_BYTES;

export const retrieve_summary: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Retrieve the stored content behind a [SUMMARY Sx] stub by its ID (e.g. S1, S2). A stub means the tool output was stored, not truncated or lost: call this with the ID from the stub header and page with offset/limit (max 500 lines per call) until the range header shows the last line. If the stub header is marked "partial", the host cut the output before it could be stored and only that part is retrievable here.',
		args: {
			id: z
				.string()
				.describe(
					'The summary ID to retrieve (e.g. S1, S2, S99). Must match pattern S followed by digits.',
				),
			offset: z
				.number()
				.min(0)
				.default(0)
				.describe('Line offset to start from (default: 0).'),
			limit: z
				.number()
				.min(1)
				.max(500)
				.default(100)
				.describe('Number of lines to return (default: 100, max: 500).'),
		},
		async execute(
			args: unknown,
			directory: string,
			_ctx?: ToolContext,
		): Promise<string> {
			const typedArgs = args as { id: string; offset?: number; limit?: number };
			const offset = typedArgs.offset ?? 0;
			const limit = Math.min(typedArgs.limit ?? 100, 500);

			// Validate ID format and security constraints
			let sanitizedId: string;
			try {
				sanitizedId = sanitizeSummaryId(typedArgs.id);
			} catch {
				return 'Error: invalid summary ID format. Expected format: S followed by digits (e.g. S1, S2, S99).';
			}

			// Retrieve the full output
			let fullOutput: string | null;
			try {
				fullOutput = await loadFullOutput(directory, sanitizedId);
			} catch {
				return 'Error: failed to retrieve summary.';
			}

			if (fullOutput === null) {
				return `Summary \`${sanitizedId}\` not found. Use a valid summary ID (e.g. S1, S2).`;
			}

			// Enforce size limit
			if (fullOutput.length > RETRIEVE_MAX_BYTES) {
				return `Error: summary content exceeds maximum size limit (10 MB).`;
			}

			// Handle empty content before splitting
			if (fullOutput.length === 0) {
				return `--- No content (0 lines) ---\n\n(Summary is empty)`;
			}

			// Paginate by lines - clamp negative offset to 0
			const lines = fullOutput.split('\n');
			const totalLines = lines.length;
			const clampedOffset = Math.max(0, offset);

			// Handle exhausted offset case - offset beyond available content
			if (clampedOffset >= totalLines) {
				const response = `--- Offset beyond range ---\n\n(Range exhausted. Valid offset range: 0-${totalLines - 1})\n(Content has ${totalLines} line${totalLines === 1 ? '' : 's'})`;
				return response;
			}

			// Normal pagination - get actual slice
			const startLine = Math.min(clampedOffset, totalLines);
			const endLine = Math.min(startLine + limit, totalLines);
			const paginatedLines = lines.slice(startLine, endLine);
			const paginatedContent = paginatedLines.join('\n');

			// Standard range header for valid slices
			const headerStart = startLine + 1;
			const headerEnd = endLine;
			const rangeHeader = `--- Lines ${headerStart}-${headerEnd} of ${totalLines} ---`;
			let response = `${rangeHeader}\n${paginatedContent}`;

			// Add continuation hint if there are more lines
			if (endLine < totalLines) {
				const remaining = totalLines - endLine;
				response += `\n\n... ${remaining} more line${remaining === 1 ? '' : 's'}. Use offset=${endLine} to retrieve more.`;
			}

			return response;
		},
	});
