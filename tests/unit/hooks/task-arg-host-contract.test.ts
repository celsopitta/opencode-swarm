/**
 * Host contract for the Task tool's `task_id` argument
 * (src/hooks/task-arg-host-contract.ts).
 *
 * The host reads `task_id` as a sub-agent session handle and throws
 * `Expected a string starting with "ses"` on anything else, after the plugin's
 * before-chain already admitted the call. These tests pin the pure helper that
 * removes such values before the host sees them.
 */
import { describe, expect, test } from 'bun:test';
import {
	isHostSessionHandle,
	stripNonSessionTaskIdArg,
} from '../../../src/hooks/task-arg-host-contract';

describe('isHostSessionHandle', () => {
	test('accepts the host session-id shape only', () => {
		expect(isHostSessionHandle('ses_f018af554ffeIc2ihVOdY7CspB')).toBe(true);
		expect(isHostSessionHandle('ses')).toBe(true);
		expect(isHostSessionHandle('1.1')).toBe(false);
		expect(isHostSessionHandle('SES_UPPER')).toBe(false);
		expect(isHostSessionHandle(' ses_padded')).toBe(false);
		expect(isHostSessionHandle('')).toBe(false);
		expect(isHostSessionHandle(11)).toBe(false);
		expect(isHostSessionHandle(undefined)).toBe(false);
		expect(isHostSessionHandle(null)).toBe(false);
	});
});

describe('stripNonSessionTaskIdArg', () => {
	test('removes a plan-shaped task_id in place and hands it back', () => {
		const args: Record<string, unknown> = {
			subagent_type: 'coder',
			prompt: 'coder\nTASK: 1.1\nObjective',
			task_id: '1.1',
		};
		const result = stripNonSessionTaskIdArg(args);
		expect(result).toEqual({ stripped: true, planTaskId: '1.1' });
		expect('task_id' in args).toBe(false);
		expect(args.subagent_type).toBe('coder');
		expect(args.prompt).toBe('coder\nTASK: 1.1\nObjective');
	});

	test('trims the returned plan id but never rewrites other fields', () => {
		const args: Record<string, unknown> = { task_id: '  2.3.1 ', prompt: 'p' };
		expect(stripNonSessionTaskIdArg(args)).toEqual({
			stripped: true,
			planTaskId: '2.3.1',
		});
		expect(args).toEqual({ prompt: 'p' });
	});

	test('leaves a session handle untouched (the host resume contract)', () => {
		const args: Record<string, unknown> = {
			task_id: 'ses_child_0123456789',
			subagent_type: 'coder',
		};
		expect(stripNonSessionTaskIdArg(args)).toEqual({ stripped: false });
		expect(args.task_id).toBe('ses_child_0123456789');
	});

	test('a blank string is removed with no plan id to preserve', () => {
		const args: Record<string, unknown> = { task_id: '   ' };
		expect(stripNonSessionTaskIdArg(args)).toEqual({ stripped: true });
		expect('task_id' in args).toBe(false);
	});

	test('a non-string value is removed with no plan id to preserve', () => {
		const args: Record<string, unknown> = { task_id: 11 };
		expect(stripNonSessionTaskIdArg(args)).toEqual({ stripped: true });
		expect('task_id' in args).toBe(false);
	});

	test('no task_id means no change', () => {
		const args: Record<string, unknown> = { subagent_type: 'reviewer' };
		expect(stripNonSessionTaskIdArg(args)).toEqual({ stripped: false });
		expect(args).toEqual({ subagent_type: 'reviewer' });
	});

	test('undefined args are tolerated', () => {
		expect(stripNonSessionTaskIdArg(undefined)).toEqual({ stripped: false });
	});

	test('other plan-id spellings are not the host field and stay in place', () => {
		const args: Record<string, unknown> = {
			plan_task_id: '1.1',
			taskId: '1.1',
		};
		expect(stripNonSessionTaskIdArg(args)).toEqual({ stripped: false });
		expect(args).toEqual({ plan_task_id: '1.1', taskId: '1.1' });
	});
});
