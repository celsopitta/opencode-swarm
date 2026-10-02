/**
 * Task.task_id host contract — real-host boundary through src/index.ts.
 *
 * The OpenCode host reads the Task tool's `task_id` as a sub-agent session
 * handle and throws `Expected a string starting with "ses"` on anything else.
 * That throw lands AFTER the plugin's tool.execute.before chain admitted the
 * call, and no tool.execute.after follows a thrown tool, so a coder settlement
 * begun for the call stayed DISPATCHED until a human ran `/swarm recover`
 * (observed live, 2026-10-02).
 *
 * These tests drive the EXPORTED hooks with SDK-shaped payloads and pin:
 *  1. a plan-shaped `task_id` is removed from output.args before the host runs
 *     the tool, and preserved for toolAfter readers as `plan_task_id` on the
 *     stored snapshot;
 *  2. a real session handle is left alone (the host resume contract);
 *  3. a tool part that the host marks failed rolls back what the before-chain
 *     began, so the next dispatch of the same task is admitted again.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { getStoredInputArgs } from '../../src/hooks/guardrails';
import { resetSwarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host';

const SESSION = 'ses_task_id_host_contract';
const PROMPT =
	'coder\nTASK: 1.1\nACCEPTANCE: the entry module exists\nObjective: implement the entry module';

function walState(dir: string): string | undefined {
	const file = path.join(dir, '.swarm', 'coder-settlements', '1.1.json');
	if (!existsSync(file)) return undefined;
	return (JSON.parse(readFileSync(file, 'utf8')) as { state?: string }).state;
}

describe('Task.task_id host contract through the exported hooks', () => {
	let dir: string;
	let plugin: Awaited<ReturnType<typeof bootKnowledgeHost>>;
	let cleanupIsolatedEnv: () => void;

	beforeEach(async () => {
		resetSwarmState();
		cleanupIsolatedEnv = createIsolatedTestEnv().cleanup;
		dir = createKnowledgeProject();
		plugin = await bootKnowledgeHost(dir, { knowledge: { enabled: false } });
		await plugin.hooks['chat.message'](
			{ sessionID: SESSION, agent: 'architect' },
			{ message: {}, parts: [] },
		);
	});
	afterEach(() => {
		resetSwarmState();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* tmpdir is reaped by the OS */
		}
		cleanupIsolatedEnv();
	});

	test('a plan-shaped task_id never reaches the host and survives as plan_task_id for toolAfter', async () => {
		const callID = 'call-strip-plan-task-id';
		const output = {
			args: {
				task_id: '1.1',
				prompt: PROMPT,
				subagent_type: 'coder',
			} as Record<string, unknown>,
		};
		await plugin.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: SESSION, callID },
			output,
		);
		try {
			// What the host executes: no task_id at all.
			expect('task_id' in output.args).toBe(false);
			expect(output.args.subagent_type).toBe('coder');
			// What toolAfter reads back: the plan id under the resolver's own field.
			const stored = getStoredInputArgs(callID) as Record<string, unknown>;
			expect(stored.plan_task_id).toBe('1.1');
			expect('task_id' in stored).toBe(false);
			expect(stored.subagent_type).toBe('coder');
		} finally {
			await plugin.hooks['tool.execute.after'](
				{ tool: 'Task', sessionID: SESSION, callID },
				{ title: 'done', output: 'ok', metadata: {} },
			);
		}
	});

	test('a session handle in task_id is the host resume contract and is left in place', async () => {
		const callID = 'call-keep-session-handle';
		const output = {
			args: {
				task_id: 'ses_resume_target_0001',
				prompt: 'explorer\nTASK: 1.1\nLook around',
				subagent_type: 'explorer',
			} as Record<string, unknown>,
		};
		await plugin.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: SESSION, callID },
			output,
		);
		try {
			expect(output.args.task_id).toBe('ses_resume_target_0001');
			const stored = getStoredInputArgs(callID) as Record<string, unknown>;
			expect(stored.task_id).toBe('ses_resume_target_0001');
			expect('plan_task_id' in stored).toBe(false);
		} finally {
			await plugin.hooks['tool.execute.after'](
				{ tool: 'Task', sessionID: SESSION, callID },
				{ title: 'done', output: 'ok', metadata: {} },
			);
		}
	});

	test('a host-failed Task part rolls back the coder settlement the before-chain began', async () => {
		const callID = 'chatcmpl-tool-host-rejected-0001';
		const output = {
			args: { prompt: PROMPT, subagent_type: 'coder' } as Record<
				string,
				unknown
			>,
		};
		await plugin.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: SESSION, callID },
			output,
		);
		// The chain admitted the call and began the durable settlement.
		expect(walState(dir)).toBe('DISPATCHED');

		// The host throws inside the tool (no toolAfter) and publishes the part
		// in its error state — the same SDK shape the plugin already consumes
		// for child-session binding.
		await plugin.hooks.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'prt_host_rejected_0001',
						sessionID: SESSION,
						messageID: 'msg_host_rejected_0001',
						type: 'tool',
						callID,
						tool: 'task',
						state: {
							status: 'error',
							input: output.args,
							error: 'Expected a string starting with "ses", got "1.1"',
							time: { start: 1, end: 2 },
						},
					},
				},
			},
		});
		expect(walState(dir)).toBe('ABORTED');
		// The audit trail names the real cause, not a plugin gate denial.
		const wal = JSON.parse(
			readFileSync(
				path.join(dir, '.swarm', 'coder-settlements', '1.1.json'),
				'utf8',
			),
		) as { abortReason?: string };
		expect(wal.abortReason).toContain('before the sub-agent ran');

		// The retry is admitted instead of CODER_DISPATCH_IN_PROGRESS.
		const retryCallID = 'chatcmpl-tool-retry-0002';
		const retry = {
			args: { prompt: PROMPT, subagent_type: 'coder' } as Record<
				string,
				unknown
			>,
		};
		await plugin.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: SESSION, callID: retryCallID },
			retry,
		);
		try {
			expect(walState(dir)).toBe('DISPATCHED');
		} finally {
			await plugin.hooks['tool.execute.after'](
				{ tool: 'Task', sessionID: SESSION, callID: retryCallID },
				{ title: 'done', output: 'ok', metadata: {} },
			);
		}
	});

	test('an errored Task part that carries a child session id is NOT rolled back (abort / child failure)', async () => {
		// The host publishes state.metadata.sessionId before the child runs and
		// keeps it on a user abort ("Tool execution aborted") and on a child
		// failure. Such a part may stand for real work: it stays DISPATCHED for
		// the recovery path instead of being aborted here.
		const callID = 'chatcmpl-tool-child-ran-0004';
		const output = {
			args: { prompt: PROMPT, subagent_type: 'coder' } as Record<
				string,
				unknown
			>,
		};
		await plugin.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: SESSION, callID },
			output,
		);
		expect(walState(dir)).toBe('DISPATCHED');
		await plugin.hooks.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'prt_child_ran_0004',
						sessionID: SESSION,
						messageID: 'msg_child_ran_0004',
						type: 'tool',
						callID,
						tool: 'task',
						state: {
							status: 'error',
							input: output.args,
							error: 'Tool execution aborted',
							metadata: { sessionId: 'ses_child_ran_0004', interrupted: true },
							time: { start: 1, end: 2 },
						},
					},
				},
			},
		});
		try {
			expect(walState(dir)).toBe('DISPATCHED');
		} finally {
			await plugin.hooks['tool.execute.after'](
				{ tool: 'Task', sessionID: SESSION, callID },
				{ title: 'done', output: 'ok', metadata: {} },
			);
		}
	});

	test('a completed or running Task part is not a rollback trigger', async () => {
		const callID = 'chatcmpl-tool-completed-0003';
		const output = {
			args: { prompt: PROMPT, subagent_type: 'coder' } as Record<
				string,
				unknown
			>,
		};
		await plugin.hooks['tool.execute.before'](
			{ tool: 'Task', sessionID: SESSION, callID },
			output,
		);
		expect(walState(dir)).toBe('DISPATCHED');
		await plugin.hooks.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'prt_completed_0003',
						sessionID: SESSION,
						messageID: 'msg_completed_0003',
						type: 'tool',
						callID,
						tool: 'task',
						state: { status: 'running', input: output.args },
					},
				},
			},
		});
		expect(walState(dir)).toBe('DISPATCHED');
		// A completed part (the sub-agent returned) must never abort a live
		// settlement either: toolAfter owns that call's settlement.
		await plugin.hooks.event({
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						id: 'prt_completed_0003',
						sessionID: SESSION,
						messageID: 'msg_completed_0003',
						type: 'tool',
						callID,
						tool: 'task',
						state: {
							status: 'completed',
							input: output.args,
							output: 'ok',
							title: 'done',
							metadata: {},
							time: { start: 1, end: 2 },
						},
					},
				},
			},
		});
		try {
			expect(walState(dir)).toBe('DISPATCHED');
		} finally {
			await plugin.hooks['tool.execute.after'](
				{ tool: 'Task', sessionID: SESSION, callID },
				{ title: 'done', output: 'ok', metadata: {} },
			);
		}
	});
});
