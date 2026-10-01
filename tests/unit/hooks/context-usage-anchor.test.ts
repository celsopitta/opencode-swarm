/**
 * context-usage — which assistant message anchors the reading.
 *
 * The OpenCode host creates every assistant message with all token fields at
 * zero and fills them in when the model call finishes. A message that is
 * still being generated (the one a tool call runs inside) and a message that
 * was aborted therefore carry zeros. Those are placeholders, not a provider
 * report: like the host UI, only a message with output tokens is a completed
 * call.
 *
 * "Latest" means most recently CREATED, as in the host: after a compaction
 * the hooks receive the retained tail AFTER the summary although it was
 * created before it, so list position is not creation order.
 *
 * Kept separate from context-usage.test.ts to respect the FR-006 500-line cap.
 */
import { describe, expect, test } from 'bun:test';
import { createContextBudgetHandler } from '../../../src/hooks/context-budget';
import { _test_exports } from '../../../src/hooks/context-usage';

const { computeContextUsage, estimateMessageTokens, estimateToolResultTokens } =
	_test_exports;

function makeMessage(overrides: {
	role: string;
	text?: string;
	tokens?: Record<string, unknown>;
	toolInput?: unknown;
	toolOutput?: string;
	/** A tool call the host is still executing: arguments, no result yet. */
	runningTool?: boolean;
	created?: unknown;
	id?: unknown;
}) {
	const parts: Array<Record<string, unknown>> = [];
	if (overrides.text !== undefined) {
		parts.push({ type: 'text', text: overrides.text });
	}
	if (overrides.toolOutput !== undefined) {
		parts.push({
			type: 'tool',
			tool: 'context_status',
			state: {
				status: 'completed',
				...(overrides.toolInput !== undefined
					? { input: overrides.toolInput }
					: {}),
				output: overrides.toolOutput,
			},
		});
	}
	if (overrides.runningTool) {
		parts.push({
			type: 'tool',
			tool: 'context_status',
			state: { status: 'running', input: {} },
		});
	}
	return {
		info: {
			role: overrides.role,
			...(overrides.id !== undefined ? { id: overrides.id } : {}),
			...(overrides.created !== undefined
				? { time: { created: overrides.created } }
				: {}),
			...(overrides.tokens ? { tokens: overrides.tokens } : {}),
		},
		parts,
	};
}

/** Token fields of a completed model call (the host fills these in at the end). */
function completed(
	input: number,
	output: number,
	extra: { reasoning?: number; read?: number; write?: number } = {},
) {
	return {
		input,
		output,
		...(extra.reasoning !== undefined ? { reasoning: extra.reasoning } : {}),
		cache: { read: extra.read ?? 0, write: extra.write ?? 0 },
	};
}

/** Token fields as the host creates them, before the model call finishes. */
const PLACEHOLDER_TOKENS = {
	input: 0,
	output: 0,
	reasoning: 0,
	cache: { read: 0, write: 0 },
};

describe('context-usage — regression: zero-token placeholders are not a provider report (CU-1)', () => {
	test('the message still being generated is skipped; the last completed call anchors the reading', () => {
		// Previous code anchored on the LAST assistant message with numeric token
		// fields. The host creates every assistant message with all token
		// fields at zero and fills them in when the call finishes, so a tool
		// called by the model (always inside a message still being generated)
		// read that placeholder as "0 tokens used" and reported 1 token for
		// sessions holding well over 100,000. The token fields below are a
		// completed call from one such recorded session.
		const messages = [
			makeMessage({
				role: 'assistant',
				text: 'previous reply',
				tokens: completed(172735, 152, { reasoning: 3553 }),
			}),
			makeMessage({ role: 'user', text: 'call context_status' }),
			makeMessage({
				role: 'assistant',
				runningTool: true,
				tokens: PLACEHOLDER_TOKENS,
			}),
		];

		const result = computeContextUsage(messages);
		expect(result.source).toBe('provider');
		expect(result.assistantAnchorIndex).toBe(0);
		// The figure the OpenCode TUI shows for that call.
		expect(result.providerTokens).toBe(176440);
		expect(result.pendingEstimateTokens).toBe(
			estimateMessageTokens(messages[1]) + estimateMessageTokens(messages[2]),
		);
		expect(result.tokensUsed).toBe(
			176440 + (result.pendingEstimateTokens ?? 0),
		);
	});

	test('an aborted assistant message (zero tokens) after a completed call is skipped too', () => {
		// An interrupted call leaves an assistant message whose token fields
		// never left zero. It must not reset the reading for the hooks that run
		// before the next request.
		const messages = [
			makeMessage({
				role: 'assistant',
				text: 'completed',
				tokens: completed(90000, 500),
			}),
			makeMessage({
				role: 'assistant',
				text: 'aborted',
				tokens: PLACEHOLDER_TOKENS,
			}),
			makeMessage({ role: 'user', text: 'continue' }),
		];

		const result = computeContextUsage(messages);
		expect(result.assistantAnchorIndex).toBe(0);
		expect(result.providerTokens).toBe(90500);
	});

	test('with only placeholder messages there is nothing measured: the reading is an estimate', () => {
		const messages = [
			makeMessage({ role: 'user', text: 'first message of the session' }),
			makeMessage({
				role: 'assistant',
				runningTool: true,
				tokens: PLACEHOLDER_TOKENS,
			}),
		];

		const result = computeContextUsage(messages);
		expect(result.source).toBe('estimated');
		expect(result.providerTokens).toBeNull();
		expect(result.assistantAnchorIndex).toBeNull();
		expect(result.pendingEstimateTokens).toBe(result.tokensUsed);
	});

	test('a non-assistant message carrying token fields is never the anchor', () => {
		const messages = [
			makeMessage({
				role: 'assistant',
				text: 'completed',
				tokens: completed(40000, 100),
			}),
			makeMessage({
				role: 'user',
				text: 'not a model call',
				tokens: completed(999999, 1),
			}),
		];

		const result = computeContextUsage(messages);
		expect(result.assistantAnchorIndex).toBe(0);
		expect(result.providerTokens).toBe(40100);
	});

	test.each([
		['undefined', undefined],
		['an empty list', []],
	])('%s reads as an empty estimate with no provider figure', (_label, input) => {
		expect(computeContextUsage(input)).toEqual({
			tokensUsed: 0,
			source: 'estimated',
			assistantAnchorIndex: null,
			providerTokens: null,
			pendingEstimateTokens: 0,
		});
	});
});

describe('context-usage — regression: the anchor is the most recently CREATED completed call (CU-2)', () => {
	/**
	 * The list the host hands the message hooks after a compaction that
	 * retained a tail: compaction request, summary, then the retained tail
	 * (created BEFORE the summary), then anything later.
	 */
	function afterCompaction() {
		return [
			makeMessage({
				role: 'user',
				text: 'compact',
				created: 5000,
				id: 'msg_05',
			}),
			makeMessage({
				role: 'assistant',
				text: 'summary of the earlier conversation',
				created: 5001,
				id: 'msg_06',
				tokens: completed(110000, 5410),
			}),
			makeMessage({
				role: 'user',
				text: 'retained question',
				created: 3000,
				id: 'msg_03',
			}),
			makeMessage({
				role: 'assistant',
				text: 'retained answer',
				created: 3001,
				id: 'msg_04',
				tokens: completed(228000, 1500, { reasoning: 2000 }),
			}),
			makeMessage({
				role: 'user',
				text: 'continue',
				created: 6000,
				id: 'msg_07',
			}),
		];
	}

	test('a retained tail positioned after the summary does not anchor the reading', () => {
		// Previous code took the LAST completed call by list position. In the
		// hook's list that is a retained pre-compaction call, so the reading was
		// the size of the conversation BEFORE it was compacted (87% of the
		// window in a recorded session whose real usage was 42%).
		const messages = afterCompaction();

		const result = computeContextUsage(messages);
		expect(result.assistantAnchorIndex).toBe(1);
		// The compaction call: what the OpenCode UI shows at this point.
		expect(result.providerTokens).toBe(115410);
		// The retained tail and the new message follow the anchor in the list
		// and were not part of the compaction call's own count.
		expect(result.pendingEstimateTokens).toBe(
			estimateMessageTokens(messages[2]) +
				estimateMessageTokens(messages[3]) +
				estimateMessageTokens(messages[4]),
		);
		expect(result.tokensUsed).toBe(115410 + result.pendingEstimateTokens);
	});

	test('once a call completes after the compaction it becomes the anchor', () => {
		const messages = [
			...afterCompaction(),
			makeMessage({
				role: 'assistant',
				text: 'first reply after compaction',
				created: 6001,
				id: 'msg_08',
				tokens: completed(108892, 300),
			}),
		];

		const result = computeContextUsage(messages);
		expect(result.assistantAnchorIndex).toBe(5);
		expect(result.providerTokens).toBe(109192);
		expect(result.pendingEstimateTokens).toBe(0);
	});

	test('equal creation times are ordered by message id, as in the host', () => {
		const earlierId = makeMessage({
			role: 'assistant',
			created: 7000,
			id: 'msg_10',
			tokens: completed(1000, 1),
		});
		const laterId = makeMessage({
			role: 'assistant',
			created: 7000,
			id: 'msg_11',
			tokens: completed(2000, 1),
		});

		expect(computeContextUsage([laterId, earlierId]).providerTokens).toBe(2001);
		expect(computeContextUsage([earlierId, laterId]).providerTokens).toBe(2001);
	});

	test.each([
		['no creation time on the earlier-positioned message', undefined, 9000],
		['no creation time on the later-positioned message', 9000, undefined],
		['a non-numeric creation time', '9000', 1000],
		['a non-finite creation time', Number.NaN, 1000],
	])('%s: messages cannot be ordered, the later list position wins', (_label, firstCreated, secondCreated) => {
		const result = computeContextUsage([
			makeMessage({
				role: 'assistant',
				created: firstCreated,
				id: 'msg_21',
				tokens: completed(1000, 1),
			}),
			makeMessage({
				role: 'assistant',
				created: secondCreated,
				id: 'msg_20',
				tokens: completed(2000, 1),
			}),
		]);

		expect(result.assistantAnchorIndex).toBe(1);
		expect(result.providerTokens).toBe(2001);
	});

	test.each([
		['no id on the earlier-positioned message', undefined, 'msg_30'],
		['no id on the later-positioned message', 'msg_31', undefined],
	])('equal creation times and %s: the later list position wins', (_label, firstId, secondId) => {
		const result = computeContextUsage([
			makeMessage({
				role: 'assistant',
				created: 7000,
				id: firstId,
				tokens: completed(1000, 1),
			}),
			makeMessage({
				role: 'assistant',
				created: 7000,
				id: secondId,
				tokens: completed(2000, 1),
			}),
		]);

		expect(result.assistantAnchorIndex).toBe(1);
		expect(result.providerTokens).toBe(2001);
	});
});

describe('context-budget hook — regression: no pre-compaction reading after a compaction (CU-2)', () => {
	test('a freshly compacted conversation gets no context warning from a retained tail call', async () => {
		// Shape of a recorded session: the compaction call measured 115,410
		// tokens, the next request really held 108,892 (42% of a 259,000
		// window), and the retained tail carried a pre-compaction call of about
		// 230,000. Previous code anchored on that tail call and injected a
		// "[CONTEXT WARNING" (at ~87% in the recorded session).
		const user = (text: string, created: number, id: string) => ({
			info: {
				role: 'user',
				agent: 'architect',
				sessionID: 'cu2-after-compaction',
				id,
				time: { created },
			},
			parts: [{ type: 'text', text }],
		});
		const assistant = (
			text: string,
			created: number,
			id: string,
			tokens: Record<string, unknown>,
		) => ({
			info: {
				role: 'assistant',
				sessionID: 'cu2-after-compaction',
				id,
				time: { created },
				tokens,
			},
			parts: [{ type: 'text', text }],
		});
		const output = {
			messages: [
				user('compact', 5000, 'msg_05'),
				assistant('summary', 5001, 'msg_06', completed(110000, 5410)),
				user('retained question', 3000, 'msg_03'),
				assistant(
					'retained answer',
					3001,
					'msg_04',
					completed(228000, 1500, { reasoning: 2000 }),
				),
				user('continue', 6000, 'msg_07'),
			],
		};
		const handler = createContextBudgetHandler({
			context_budget: {
				enabled: true,
				enforce: true,
				model_limits: { default: 259000 },
			},
			max_iterations: 5,
			qa_retry_limit: 3,
			inject_phase_reminders: true,
		} as never);

		await handler({}, output as never);

		expect(output.messages).toHaveLength(5);
		expect(output.messages.map((m) => m.parts[0].text)).toEqual([
			'compact',
			'summary',
			'retained question',
			'retained answer',
			'continue',
		]);
	});
});

describe('estimateToolResultTokens', () => {
	const toolPart = (state: Record<string, unknown>) => ({
		type: 'tool',
		state,
	});

	test('counts completed output and error text only', () => {
		const output = 'x'.repeat(4000);
		const error = 'y'.repeat(2000);
		const both = estimateToolResultTokens({
			info: { role: 'assistant' },
			parts: [
				toolPart({ status: 'completed', output }),
				toolPart({ status: 'error', error }),
			],
		});
		const outputOnly = estimateToolResultTokens({
			parts: [toolPart({ status: 'completed', output })],
		});
		const errorOnly = estimateToolResultTokens({
			parts: [toolPart({ status: 'error', error })],
		});

		expect(outputOnly).toBeGreaterThan(0);
		expect(errorOnly).toBeGreaterThan(0);
		expect(both).toBe(outputOnly + errorOnly);
	});

	test('ignores text a part carries in a state that is not its result', () => {
		// A running call has no result yet, and an errored call's result is its
		// error text: an `output` or `error` string on any other status is not
		// content the model will be sent as a tool result.
		expect(
			estimateToolResultTokens({
				parts: [
					toolPart({ status: 'running', output: 'x'.repeat(4000) }),
					toolPart({ status: 'pending', error: 'y'.repeat(4000) }),
					toolPart({ status: 'error', output: 'x'.repeat(4000) }),
					toolPart({ status: 'completed', error: 'y'.repeat(4000) }),
					toolPart({ status: 'completed', output: 42 }),
					toolPart({ status: 'error', error: { message: 'boom' } }),
					{ type: 'text', text: 'z'.repeat(4000) },
				] as never,
			}),
		).toBe(0);
	});

	test.each([
		['no parts', { info: { role: 'assistant' } }],
		['parts that are not a list', { parts: {} }],
		['an undefined message', undefined],
	])('%s yields zero', (_label, message) => {
		expect(estimateToolResultTokens(message as never)).toBe(0);
	});
});
