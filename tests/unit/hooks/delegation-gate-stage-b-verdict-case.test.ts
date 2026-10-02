/**
 * The verdict row is matched case-insensitively, so the verdict word must be
 * compared case-insensitively too. A worker that writes `approved` or `pass`
 * in lower case has given a positive verdict.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	readTaskEvidence,
	recordAgentDispatch,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	createDelegationGateHook,
	parsePerTaskVerdicts,
} from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import {
	drainRehydrations,
	fullConfig,
	makeTempDir,
	seedReviewerApproved,
	settlementDropAdvisories,
	TASK_ID,
	testEngineerArgs,
	writePlan,
} from './_stage-b-settlement-2817-helpers.js';

let tempDir = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
	try {
		if (tempDir) safeRmRecursive(tempDir);
	} catch {
		// best-effort cleanup (temp dir only)
	}
	tempDir = '';
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

/** An architect session with every listed task durably at pre_check_passed. */
async function preCheckPassedSession(sessionID: string, taskIds: string[]) {
	startAgentSession(sessionID, 'architect', undefined, tempDir);
	await drainRehydrations();
	writePlan(tempDir, taskIds);
	const session = ensureAgentSession(sessionID);
	for (const taskId of taskIds) {
		await recordAgentDispatch(tempDir, taskId, 'coder');
		const generation = (await readTaskEvidence(tempDir, taskId))!.workflow!
			.generation;
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: generation,
		});
		session.taskWorkflowStates.set(taskId, 'pre_check_passed');
	}
	session.currentTaskId = taskIds[0]!;
	const cfg = fullConfig();
	cfg.review_routing = { enforce_receipts: false };
	return { session, hook: createDelegationGateHook(cfg, tempDir) };
}

async function reviewerReply(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
	callID: string,
	args: Record<string, unknown>,
	output: string,
): Promise<void> {
	await hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
	await hook.toolAfter({ tool: 'Task', sessionID, callID, args }, { output });
}

describe('Stage B verdict word case — regression: a lower-case positive verdict was recorded as a failure (review of the missing-verdict change, 2026-10-02)', () => {
	// Previous code matched the row with the `i` flag and stored the captured
	// word as written, then compared it with `=== 'PASS'` / `=== 'APPROVED'`.
	// `pass` and `approved` therefore fell through to the stage_b_failed
	// branch and moved the task to rework_required durably.

	it('parsePerTaskVerdicts returns the verdict word in canonical upper case', () => {
		const result = parsePerTaskVerdicts(
			[
				'[tested] | task-1.1 | pass | all green',
				'[Reviewed] | Task-2.1 | Approved | fine',
				'[REVIEWED] | 2.2 | concerns | see notes',
				'[TESTED] | task-3.1 | Skipped | not run',
			].join('\n'),
		);
		expect(result.errors).toEqual([]);
		expect(result.verdicts.get('1.1')).toEqual({
			verdict: 'PASS',
			kind: 'TESTED',
		});
		expect(result.verdicts.get('2.1')).toEqual({
			verdict: 'APPROVED',
			kind: 'REVIEWED',
		});
		expect(result.verdicts.get('2.2')).toEqual({
			verdict: 'CONCERNS',
			kind: 'REVIEWED',
		});
		expect(result.verdicts.get('3.1')).toEqual({
			verdict: 'SKIPPED',
			kind: 'TESTED',
		});
	});

	it('the same verdict written in two cases is one verdict, not a conflict', () => {
		const result = parsePerTaskVerdicts(
			'[TESTED] | task-1.1 | PASS | first\n[tested] | task-1.1 | pass | again',
		);
		expect(result.errors).toEqual([]);
		expect(result.verdicts.get('1.1')?.verdict).toBe('PASS');
	});

	it('opposite verdicts in different cases still raise the conflict error (the first row is the one kept)', () => {
		const result = parsePerTaskVerdicts(
			'[TESTED] | task-1.1 | PASS | first\n[tested] | task-1.1 | fail | again',
		);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain('STAGE_B_VERDICT_CONFLICT');
		expect(result.verdicts.get('1.1')?.verdict).toBe('PASS');
	});

	it('a lower-case test_engineer pass settles the gate instead of failing the task', async () => {
		// Before the fix this reply wrote a durable stage_b_failed and moved the
		// task to rework_required.
		const sessionID = 'sess-verdict-case-pass';
		tempDir = makeTempDir('dg-verdict-case-');
		startAgentSession(sessionID, 'architect', undefined, tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'vc');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const cfg = fullConfig();
		cfg.review_routing = { enforce_receipts: false };
		const hook = createDelegationGateHook(cfg, tempDir);
		const callID = 'call-verdict-case';
		const args = testEngineerArgs();

		await hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
		await hook.toolAfter(
			{ tool: 'Task', sessionID, callID, args },
			{ output: `[tested] | task-${TASK_ID} | pass | 20/20 tests passed` },
		);

		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeDefined();
		expect(evidence?.workflow?.lastOutcome).not.toBe('stage_b_failed');
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
	});
});

describe('Stage B verdict field boundary — regression: a word that only starts with a verdict word counted as the verdict (critic pass on the case fix, 2026-10-02)', () => {
	// A prefix used to count as the verdict: "PASSED 3 of 20, 17 failing" was
	// read as PASS and "APPROVED WITH CONCERNS" as APPROVED. Accepting lower
	// case without a boundary would have extended that to ordinary sentences.
	for (const row of [
		'[tested] | task-1.1 | passed 3 of 20, 17 failing',
		'[TESTED] | task-1.1 | PASSED | all green',
		'[tested] | task-1.1 | passing: 0, failing: 20',
		'[reviewed] | 1.1 | approved? no - rejected, see notes',
		'[REVIEWED] | task-1.1 | APPROVED WITH CONCERNS | see notes',
		'[TESTED] | task-1.1 | FAILED | 3 failures',
		'[TESTED] | task-1.1 | PASS - 10/10 tests passed',
		'[REVIEWED] | task-1.1 | APPROVED.',
	]) {
		it(`is not a verdict: ${row}`, () => {
			expect(parsePerTaskVerdicts(row).verdicts.size).toBe(0);
		});
	}

	for (const [row, verdict] of [
		['[REVIEWED] | 2.1 | APPROVED', 'APPROVED'],
		['[REVIEWED] | 2.1 | approved   ', 'APPROVED'],
		['[TESTED] | task-2.1 | PASS |', 'PASS'],
		['[TESTED] | task-2.1 | pass|20/20', 'PASS'],
		['[TESTED] | task-2.1 | FAIL | 2 of 10 failed', 'FAIL'],
		['[TESTED] | task-2.1 | PASS | reran after 1 FAIL', 'PASS'],
	] as const) {
		it(`is the verdict ${verdict}: ${row}`, () => {
			expect(parsePerTaskVerdicts(row).verdicts.get('2.1')?.verdict).toBe(
				verdict,
			);
		});
	}

	it('a lone carriage return inside a line does not end the verdict field', () => {
		// The patterns used the multiline flag, so a lone CR counted as a line
		// end: "PASS\rED 3 of 20" was read as PASS.
		for (const row of [
			'[TESTED] | task-1.1 | PASS\rED 3 of 20, 17 failing',
			'[TESTED] | task-1.1 | FAILED\r[TESTED] | task-1.1 | PASS | rerun',
		]) {
			expect(parsePerTaskVerdicts(row).verdicts.size).toBe(0);
		}
	});
});

describe('Stage B contradictory reply — regression: an unreadable negative row was ignored and a later positive row settled the gate (critic pass on the case fix, 2026-10-02)', () => {
	// With the boundary alone, "FAILED | first run" became invisible and a
	// following "PASS | rerun" for the same task recorded the gate, where
	// base kept the first row (read as FAIL).

	for (const reply of [
		'[TESTED] | task-1.1 | FAILED | first run\n[TESTED] | task-1.1 | PASS | rerun',
		'[tested] | task-1.1 | failed | first run\n[TESTED] | task-1.1 | PASS | rerun',
		'[TESTED] | 1.1 | FAILED | first run\n[TESTED] | task-1.1 | PASS | rerun',
		'[TESTED] | task-1.1 | PASS | rerun\n[TESTED] | task-1.1 | FAIL: 3 failures',
		'[REVIEWED] | task-1.1 | REJECTED.\n[REVIEWED] | task-1.1 | APPROVED | fine',
	]) {
		it(`gives the task no verdict: ${JSON.stringify(reply)}`, () => {
			const result = parsePerTaskVerdicts(reply);
			expect(result.verdicts.has('1.1')).toBe(false);
			expect([...result.unreadable]).toEqual(['1.1']);
			expect(
				result.errors.some(
					(e) =>
						e.includes('STAGE_B_VERDICT_UNREADABLE') &&
						e.includes('task 1.1') &&
						e.includes('discarded'),
				),
			).toBe(true);
		});
	}

	it('an unreadable row for one task does not affect another task', () => {
		const result = parsePerTaskVerdicts(
			'[REVIEWED] | task-2.1 | APPROVED | fine\n[REVIEWED] | task-2.2 | REJECTED. needs work',
		);
		expect(result.verdicts.get('2.1')?.verdict).toBe('APPROVED');
		expect(result.verdicts.has('2.2')).toBe(false);
		expect([...result.unreadable]).toEqual(['2.2']);
	});

	it('a reply with only readable rows lists no unreadable task', () => {
		expect(
			parsePerTaskVerdicts('[TESTED] | task-1.1 | PASS | ok').unreadable.size,
		).toBe(0);
	});

	it('a failed-then-pass reply records no test gate', async () => {
		const sessionID = 'sess-verdict-contradiction';
		tempDir = makeTempDir('dg-verdict-contradiction-');
		startAgentSession(sessionID, 'architect', undefined, tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'vx');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		const cfg = fullConfig();
		cfg.review_routing = { enforce_receipts: false };
		const hook = createDelegationGateHook(cfg, tempDir);
		const callID = 'call-verdict-contradiction';
		const args = testEngineerArgs();

		await hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
		await hook.toolAfter(
			{ tool: 'Task', sessionID, callID, args },
			{
				output: `[TESTED] | task-${TASK_ID} | FAILED | first run\n[TESTED] | task-${TASK_ID} | PASS | rerun`,
			},
		);

		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeUndefined();
		// Handled as a reply with no readable verdict: nothing recorded, state
		// unchanged, and the architect is told to re-dispatch.
		expect(evidence?.workflow?.state).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain(`test_engineer task ${TASK_ID}`);
		// The architect can see a PASS row in the reply, so the advisory says
		// why it did not count.
		expect(advisories[0]).toContain(
			'whose verdict field is not one of the accepted words',
		);
	});

	it('an unreadable row for another awaited task is reported while the dispatched task settles', async () => {
		// The reply addresses task 2.2 with a row that cannot be read. Before
		// this, 2.2 stayed where it was with no message at all.
		const sessionID = 'sess-verdict-unreadable-other';
		tempDir = makeTempDir('dg-verdict-unreadable-other-');
		const { session, hook } = await preCheckPassedSession(sessionID, [
			'2.1',
			'2.2',
		]);
		const callID = 'call-verdict-unreadable-other';
		const args = {
			subagent_type: 'reviewer',
			task_id: '2.1',
			prompt:
				'TASK: 2.1\nTASKS: 2.1, 2.2\nACCEPTANCE: reviewer must report a structured verdict for every listed task',
		};

		await hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
		await hook.toolAfter(
			{ tool: 'Task', sessionID, callID, args },
			{
				output:
					'[REVIEWED] | task-2.1 | APPROVED | fine\n[REVIEWED] | task-2.2 | REJECTED: missing null check',
			},
		);

		expect(session.taskWorkflowStates.get('2.1')).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get('2.2')).toBe('pre_check_passed');
		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('reviewer task 2.2');
		expect(advisories[0]).toContain(
			'whose verdict field is not one of the accepted words',
		);
	});

	it('a row for a task the dispatch did not await raises nothing', async () => {
		const sessionID = 'sess-verdict-not-awaited';
		tempDir = makeTempDir('dg-verdict-not-awaited-');
		const { session, hook } = await preCheckPassedSession(sessionID, [
			'2.1',
			'2.2',
		]);

		await reviewerReply(
			hook,
			sessionID,
			'call-verdict-not-awaited',
			{
				subagent_type: 'reviewer',
				task_id: '2.1',
				prompt: 'TASK: 2.1\nACCEPTANCE: one row',
			},
			'[REVIEWED] | task-2.1 | APPROVED | fine\n[REVIEWED] | task-2.2 | REJECTED: not asked',
		);

		expect(session.taskWorkflowStates.get('2.1')).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get('2.2')).toBe('pre_check_passed');
		expect(settlementDropAdvisories(sessionID)).toEqual([]);
	});

	it('a reply with no row at all keeps the plain missing-row wording', async () => {
		const sessionID = 'sess-verdict-plain-missing';
		tempDir = makeTempDir('dg-verdict-plain-missing-');
		const { hook } = await preCheckPassedSession(sessionID, ['2.1', '2.2']);

		await reviewerReply(
			hook,
			sessionID,
			'call-verdict-plain-missing',
			{
				subagent_type: 'reviewer',
				task_id: '2.1',
				prompt: 'TASK: 2.1\nACCEPTANCE: one row',
			},
			'Looks fine to me.',
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain(
			'the reply had no parseable [REVIEWED] verdict row for this task',
		);
		expect(advisories[0]).not.toContain('whose verdict field');
	});

	it('at most ten other tasks are reported, and the last advisory says how many more there were', async () => {
		const sessionID = 'sess-verdict-cap';
		tempDir = makeTempDir('dg-verdict-cap-');
		const taskIds = Array.from({ length: 13 }, (_, i) => `3.${i + 1}`);
		const { hook } = await preCheckPassedSession(sessionID, taskIds);

		await reviewerReply(
			hook,
			sessionID,
			'call-verdict-cap',
			{
				subagent_type: 'reviewer',
				task_id: '3.1',
				prompt: `TASK: 3.1\nTASKS: ${taskIds.join(', ')}\nACCEPTANCE: reviewer must report a structured verdict for every listed task`,
			},
			[
				'[REVIEWED] | task-3.1 | APPROVED | fine',
				...taskIds
					.slice(1)
					.map((id) => `[REVIEWED] | task-${id} | REJECTED: x`),
			].join('\n'),
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(10);
		expect(
			advisories.filter((m) =>
				m.includes(
					'2 more awaited task(s) in this reply also had an unreadable row',
				),
			),
		).toHaveLength(1);
	});

	it('a dispatch with no task of its own and only unreadable rows gets the dispatch-wide advisory alone', async () => {
		const sessionID = 'sess-verdict-dispatch-wide';
		tempDir = makeTempDir('dg-verdict-dispatch-wide-');
		const { hook } = await preCheckPassedSession(sessionID, ['2.1', '2.2']);

		await reviewerReply(
			hook,
			sessionID,
			'call-verdict-dispatch-wide',
			{
				subagent_type: 'reviewer',
				prompt:
					'TASKS: 2.1, 2.2\nACCEPTANCE: reviewer must report a structured verdict for every listed task',
			},
			'[REVIEWED] | task-2.1 | APPROVED. | fine\n[REVIEWED] | task-2.2 | REJECTED: null check',
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('reviewer dispatch from call');
	});

	it('a dispatch with no task of its own that returns one readable and one unreadable row reports the unreadable task', async () => {
		// The dispatch-wide advisory does not fire here (the reply has a
		// readable row), so the per-task report must.
		const sessionID = 'sess-verdict-no-primary-mixed';
		tempDir = makeTempDir('dg-verdict-no-primary-mixed-');
		const { session, hook } = await preCheckPassedSession(sessionID, [
			'2.1',
			'2.2',
		]);

		await reviewerReply(
			hook,
			sessionID,
			'call-verdict-no-primary-mixed',
			{
				subagent_type: 'reviewer',
				prompt:
					'TASKS: 2.1, 2.2\nACCEPTANCE: reviewer must report a structured verdict for every listed task',
			},
			'[REVIEWED] | task-2.1 | APPROVED | fine\n[REVIEWED] | task-2.2 | REJECTED: null check',
		);

		expect(session.taskWorkflowStates.get('2.1')).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get('2.2')).toBe('pre_check_passed');
		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('reviewer task 2.2');
		expect(advisories[0]).toContain(
			'whose verdict field is not one of the accepted words',
		);
		expect(advisories[0]).not.toContain('more awaited task');
	});
});
