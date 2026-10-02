/**
 * End to end: when a task's durable workflow says a Stage B gate may run, the
 * verdict that the gate returns must be recorded, whatever the session's own
 * copy of the task state said before the dispatch.
 *
 * Observed live: a recovery wrote pre_check_passed on disk and the reviewer
 * dispatch was admitted, but the session still held the wedge state, so the
 * clean `[REVIEWED] | task-1.1 | APPROVED` row was skipped. This repeated for
 * twelve reviewer runs and one test run. Earlier in the same run the session
 * held rework_required (set in memory only) against a durable reviewer_run,
 * with the same result for the test gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { setGatesForIdentity } from '../../../src/db/qa-gate-profile';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { executeRecoverStageATask } from '../../../src/tools/recover-stage-a-task';
import { recoverStageATaskSupervised } from '../../../src/workflow/settlement-recovery';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import {
	settleAt,
	writeCommittedWal,
	writeGreenBundles,
} from '../workflow/_settlement-recovery-2828-helpers';
import {
	drainRehydrations,
	fullConfig,
	makeTempDir,
	PLAN_TITLE,
	seedReviewerApproved,
	TASK_ID,
	testEngineerArgs,
	writePlan,
} from './_stage-b-settlement-2817-helpers.js';

const TASK = '7.1';
let tempDir = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
	closeAllProjectDbs();
	try {
		if (tempDir) safeRmRecursive(tempDir);
	} catch {
		// best-effort cleanup (temp dir only)
	}
	tempDir = '';
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

/** An architect session bound to the project directory, rehydration settled. */
async function architect(sessionID: string) {
	startAgentSession(sessionID, 'architect', undefined, tempDir);
	await drainRehydrations();
	return ensureAgentSession(sessionID);
}

function gateHook() {
	const cfg = fullConfig();
	// Route-receipt enforcement is a separate fence with its own suites; it is
	// off here so the state-eligibility path is the one under test.
	cfg.review_routing = { enforce_receipts: false };
	return createDelegationGateHook(cfg, tempDir);
}

async function dispatch(
	hook: ReturnType<typeof createDelegationGateHook>,
	sessionID: string,
	callID: string,
	args: Record<string, unknown>,
	output: string,
): Promise<void> {
	await hook.toolBefore({ tool: 'Task', sessionID, callID }, { args });
	await hook.toolAfter({ tool: 'Task', sessionID, callID, args }, { output });
}

function reviewerArgsFor(taskId: string) {
	return {
		subagent_type: 'reviewer',
		task_id: taskId,
		prompt: `TASK: ${taskId}\nACCEPTANCE: reviewer must report a structured verdict for the task`,
	};
}

function testEngineerArgsFor(taskId: string) {
	return {
		subagent_type: 'test_engineer',
		task_id: taskId,
		prompt: `TASK: ${taskId}\nACCEPTANCE: test_engineer must report a structured verdict for the task`,
	};
}

async function seedSettlementWedge(wedge: 'idle' | 'blocked'): Promise<void> {
	writePlan(tempDir, [TASK]);
	await settleAt(tempDir, TASK, wedge);
	writeCommittedWal(tempDir, TASK);
	await writeGreenBundles(tempDir);
}

describe('Stage B after the durable workflow was repaired — regression: verdicts were skipped because the session kept an older state (live run 2026-10-02)', () => {
	// Previous code admitted the dispatch from the durable state and then
	// decided settlement eligibility from session.taskWorkflowStates, which
	// nothing had updated. The verdict was dropped with a bare `continue`.

	for (const wedge of ['idle', 'blocked'] as const) {
		it(`recover_stage_a_task from ${wedge}, then reviewer and test_engineer verdicts are both recorded`, async () => {
			const sessionID = `sess-recover-then-gates-${wedge}`;
			tempDir = makeTempDir('dg-recover-gates-');
			const session = await architect(sessionID);
			await seedSettlementWedge(wedge);
			session.taskWorkflowStates.set(TASK, wedge);
			session.currentTaskId = TASK;

			const recovery = JSON.parse(
				await executeRecoverStageATask(
					{ task_id: TASK, reason: 'settlement-backed recovery' },
					tempDir,
					{ sessionID },
				),
			);
			expect(recovery.success).toBe(true);

			const hook = gateHook();
			await dispatch(
				hook,
				sessionID,
				`call-review-${wedge}`,
				reviewerArgsFor(TASK),
				`[REVIEWED] | task-${TASK} | APPROVED | No issues found`,
			);
			await dispatch(
				hook,
				sessionID,
				`call-test-${wedge}`,
				testEngineerArgsFor(TASK),
				`[TESTED] | task-${TASK} | PASS | 12/12 tests passed`,
			);

			const evidence = await readTaskEvidence(tempDir, TASK);
			expect(evidence?.gates?.reviewer).toBeDefined();
			expect(evidence?.gates?.test_engineer).toBeDefined();
			expect(evidence?.workflow?.state).toBe('tests_run');
			expect(session.taskWorkflowStates.get(TASK)).toBe('tests_run');
		});
	}

	it('a repair written outside this session is picked up when the gate is dispatched', async () => {
		// Stands in for `/swarm recover` run from another process and for a
		// recovery performed by another session: this session never sees the
		// write, only the durable result.
		const sessionID = 'sess-foreign-repair';
		tempDir = makeTempDir('dg-foreign-repair-');
		const session = await architect(sessionID);
		await seedSettlementWedge('idle');
		session.taskWorkflowStates.set(TASK, 'idle');
		session.currentTaskId = TASK;
		await architect('sess-other-architect');
		await recoverStageATaskSupervised(tempDir, 'sess-other-architect', {
			taskId: TASK,
			reason: 'performed elsewhere',
		});
		expect(session.taskWorkflowStates.get(TASK)).toBe('idle');

		await dispatch(
			gateHook(),
			sessionID,
			'call-foreign-repair',
			reviewerArgsFor(TASK),
			`[REVIEWED] | task-${TASK} | APPROVED | No issues found`,
		);

		const evidence = await readTaskEvidence(tempDir, TASK);
		expect(evidence?.gates?.reviewer).toBeDefined();
		expect(session.taskWorkflowStates.get(TASK)).toBe('reviewer_run');
	});

	it('a session that holds rework_required against a durable reviewer_run still settles the test gate', async () => {
		// The exact shape that started the live wedge: the session map said
		// rework_required, the evidence file said reviewer_run.
		const sessionID = 'sess-memory-only-rework';
		tempDir = makeTempDir('dg-memory-rework-');
		const session = await architect(sessionID);
		await seedReviewerApproved(tempDir, 'mr');
		session.taskWorkflowStates.set(TASK_ID, 'rework_required');
		session.currentTaskId = TASK_ID;

		await dispatch(
			gateHook(),
			sessionID,
			'call-memory-rework',
			testEngineerArgs(),
			`[TESTED] | task-${TASK_ID} | PASS | 41/41 tests passed`,
		);

		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeDefined();
		expect(evidence?.workflow?.state).toBe('tests_run');
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
	});

	it('a dispatch that the durable state does not admit leaves the session untouched', async () => {
		// Reconciliation rides on admission: when the durable workflow is not
		// Stage B eligible the dispatch is refused and nothing is copied.
		const sessionID = 'sess-not-admitted';
		tempDir = makeTempDir('dg-not-admitted-');
		const session = await architect(sessionID);
		await seedSettlementWedge('idle');
		session.taskWorkflowStates.set(TASK, 'reviewer_run');
		session.currentTaskId = TASK;
		const hook = gateHook();

		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID, callID: 'call-not-admitted' },
				{ args: reviewerArgsFor(TASK) },
			),
		).rejects.toThrow(/TASK_WORKFLOW_STAGE_A_REQUIRED/);

		expect(session.taskWorkflowStates.get(TASK)).toBe('reviewer_run');
	});
});

describe('admission reconciliation is limited to what it must change', () => {
	/** Durable pre_check_passed for a task at the given generation (1 or 2). */
	async function seedPreCheckPassedAt(
		taskId: string,
		generation: 1 | 2,
	): Promise<void> {
		for (let g = 0; g < generation; g++) {
			await transitionTaskWorkflowEvidence(tempDir, taskId, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: g,
				transitionId: `mut-${taskId}-${g}`,
			});
		}
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: generation,
			transitionId: `stage-a-${taskId}-${generation}`,
		});
	}

	it('a council generation recorded for a task that is only mentioned in a reviewer prompt survives', async () => {
		// Council mode: a critic dispatch for 1.2 records the council generation
		// (2). A reviewer dispatch for 1.1 that mentions task-1.2 reconciles 1.2
		// as well; the session's cached generation for 1.2 is stale (1), but the
		// council generation is current and must not be cleared, or the later
		// submit_council_verdicts for 1.2 fails with
		// TASK_COUNCIL_GENERATION_REQUIRED.
		const sessionID = 'sess-council-mentioned';
		tempDir = makeTempDir('dg-council-mentioned-');
		writePlan(tempDir, ['1.1', '1.2']);
		setGatesForIdentity(
			tempDir,
			{ swarm: 'test', title: PLAN_TITLE },
			{ council_mode: true },
		);
		const session = await architect(sessionID);
		await seedPreCheckPassedAt('1.1', 1);
		await seedPreCheckPassedAt('1.2', 2);
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');
		session.taskWorkflowStates.set('1.2', 'pre_check_passed');
		session.taskWorkflowCache?.set('1.2', {
			generation: 1,
			retryCount: 0,
			lastOutcome: 'none',
			lastTransitionId: null,
			updatedAt: '',
		});
		session.currentTaskId = '1.1';
		const cfg = fullConfig();
		cfg.review_routing = { enforce_receipts: false };
		cfg.council = { enabled: true } as typeof cfg.council;
		const hook = createDelegationGateHook(cfg, tempDir);

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-council-critic' },
			{
				args: {
					subagent_type: 'critic',
					task_id: '1.2',
					prompt: 'TASK: 1.2\nCouncil review of the task.',
				},
			},
		);
		expect(session.taskCouncilWorkflowGeneration?.get('1.2')).toBe(2);

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-council-reviewer' },
			{
				args: {
					subagent_type: 'reviewer',
					task_id: '1.1',
					prompt:
						'TASK: 1.1\nDo not review the files of task-1.2.\nACCEPTANCE: reviewer must report a structured verdict for the task',
				},
			},
		);

		expect(session.taskWorkflowCache?.get('1.2')?.generation).toBe(2);
		expect(session.taskCouncilWorkflowGeneration?.get('1.2')).toBe(2);
	});

	it('a council generation bound before the durable generation changed stays stale for the dispatched task', async () => {
		// Council mode: a critic dispatch binds council generation 1. The task
		// is then reworked elsewhere (durable generation 2). A reviewer dispatch
		// for the same task reconciles the workflow state, but must not drop the
		// council generation: the council block would re-bind it at 2 and the
		// council evidence writer would then accept verdicts collected at 1.
		const sessionID = 'sess-council-own-task';
		tempDir = makeTempDir('dg-council-own-task-');
		writePlan(tempDir, ['1.1']);
		setGatesForIdentity(
			tempDir,
			{ swarm: 'test', title: PLAN_TITLE },
			{ council_mode: true },
		);
		const session = await architect(sessionID);
		await seedPreCheckPassedAt('1.1', 1);
		session.taskWorkflowStates.set('1.1', 'pre_check_passed');
		session.currentTaskId = '1.1';
		const cfg = fullConfig();
		cfg.review_routing = { enforce_receipts: false };
		cfg.council = { enabled: true } as typeof cfg.council;
		const hook = createDelegationGateHook(cfg, tempDir);
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-own-critic' },
			{
				args: {
					subagent_type: 'critic',
					task_id: '1.1',
					prompt: 'TASK: 1.1\nCouncil review of the task.',
				},
			},
		);
		expect(session.taskCouncilWorkflowGeneration?.get('1.1')).toBe(1);
		// Reworked elsewhere: a new accepted mutation and Stage A pass.
		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 1,
			transitionId: 'mut-1.1-foreign',
		});
		await transitionTaskWorkflowEvidence(tempDir, '1.1', {
			type: 'stage_a_passed',
			expectedGeneration: 2,
			transitionId: 'stage-a-1.1-foreign',
		});

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-own-reviewer' },
			{
				args: {
					subagent_type: 'reviewer',
					task_id: '1.1',
					prompt:
						'TASK: 1.1\nACCEPTANCE: reviewer must report a structured verdict for the task',
				},
			},
		);

		expect(session.taskWorkflowCache?.get('1.1')?.generation).toBe(2);
		expect(session.taskCouncilWorkflowGeneration?.get('1.1')).toBe(1);
	});

	it('a critic dispatch does not rewrite the session state of its task', async () => {
		// Only the two Stage B agents settle through the session state, so only
		// their dispatches reconcile it.
		const sessionID = 'sess-critic-no-reconcile';
		tempDir = makeTempDir('dg-critic-no-reconcile-');
		writePlan(tempDir, [TASK]);
		const session = await architect(sessionID);
		await seedPreCheckPassedAt(TASK, 1);
		session.taskWorkflowStates.set(TASK, 'idle');
		session.currentTaskId = TASK;

		await gateHook().toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-critic-no-reconcile' },
			{
				args: {
					subagent_type: 'critic',
					task_id: TASK,
					prompt: `TASK: ${TASK}\nReview the approach.`,
				},
			},
		);

		expect(session.taskWorkflowStates.get(TASK)).toBe('idle');
	});
});
