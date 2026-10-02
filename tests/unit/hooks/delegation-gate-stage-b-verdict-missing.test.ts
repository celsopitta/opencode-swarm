/**
 * A reviewer or test_engineer reply that carries no parseable verdict row for
 * a dispatched task must fail closed without wedging the task: no gate is
 * recorded, the task state is left exactly as it was, and the architect is
 * told, so the next dispatch of the same gate can settle.
 *
 * Observed live: a worker wrapped its row in markdown on one line
 * (`**VERDICT: PASS [20/20]** — \`[TESTED] | task-1.1 | PASS | …\``). The row
 * was not parsed, the task was moved to rework_required in memory only with no
 * message, and every later clean verdict was dropped silently.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
	readTaskEvidence,
	recordAgentDispatch,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import * as logger from '../../../src/utils/logger';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import {
	drainRehydrations,
	fullConfig,
	MARKER,
	makeTempDir,
	REDISPATCH_RE,
	seedReviewerApproved,
	settlementDropAdvisories,
	TASK_ID,
	testEngineerArgs,
	writePlan,
} from './_stage-b-settlement-2817-helpers.js';

const DECORATED_REPLY = [
	'Task 1.1 verification is complete: 20 tests, all passing.',
	'',
	`**VERDICT: PASS [20/20]** — \`[TESTED] | task-${TASK_ID} | PASS | 20/20 tests passed via node --test tests/shell.test.js\``,
].join('\n');

let tempDir = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
let criticalWarnSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	criticalWarnSpy = spyOn(logger, 'criticalWarn').mockImplementation(() => {});
});

afterEach(() => {
	criticalWarnSpy?.mockRestore();
	criticalWarnSpy = undefined;
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

function testConfig(): ReturnType<typeof fullConfig> {
	const cfg = fullConfig();
	cfg.review_routing = { enforce_receipts: false };
	return cfg;
}

function hostWarnings(): string[] {
	return (criticalWarnSpy?.mock.calls ?? []).map((call) => String(call[0]));
}

/** Stage A passed for every listed task; session mirrors pre_check_passed. */
async function seedStageA(sessionID: string, taskIds: string[]): Promise<void> {
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

describe('Stage B missing verdict row — regression: an unparsed row wedged the task silently (live run 2026-10-02)', () => {
	// Previous code set the task to rework_required in the session map only
	// (no durable transition, no advisory) when a reply had no parseable row.
	// The durable evidence stayed at reviewer_run, so completion reported a
	// missing gate, every recovery tool refused, and each later clean verdict
	// was skipped because the in-memory state was no longer Stage-B eligible.

	it('a markdown-wrapped [TESTED] row records nothing, leaves the task state unchanged, and tells the architect', async () => {
		const sessionID = 'sess-verdict-missing-decorated';
		tempDir = makeTempDir('dg-verdict-missing-a-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'vm-a');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-a',
			testEngineerArgs(),
			DECORATED_REPLY,
		);

		// Fail-closed: no gate evidence, durable workflow not advanced.
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeUndefined();
		expect(evidence?.workflow?.state).toBe('reviewer_run');
		// The session state still matches the durable state.
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain(MARKER);
		expect(advisories[0]).toContain(`test_engineer task ${TASK_ID}`);
		expect(advisories[0]).toMatch(REDISPATCH_RE);
		// The row format is quoted with the verdict left open: the advisory
		// must never suggest an outcome.
		expect(advisories[0]).toContain(
			`[TESTED] | task-${TASK_ID} | <PASS, FAIL or SKIPPED> | <brief summary>`,
		);
		expect(advisories[0]).not.toMatch(/\| (PASS|FAIL|SKIPPED) \|/);
		expect(advisories[0]).toContain(
			'If this advisory repeats for the same agent and task after a re-dispatch, stop re-dispatching and report the unreadable reply to the user.',
		);
		// No Stage B completion is credited for an unread reply.
		expect(
			session.stageBCompletion?.get(TASK_ID)?.has('test_engineer') ?? false,
		).toBe(false);
		expect(
			hostWarnings().filter((line) =>
				line.includes('no parseable verdict row'),
			),
		).toHaveLength(1);
	});

	it('the next test_engineer dispatch with a plain row settles the gate', async () => {
		const sessionID = 'sess-verdict-missing-retry';
		tempDir = makeTempDir('dg-verdict-missing-b-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'vm-b');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-b1',
			testEngineerArgs(),
			DECORATED_REPLY,
		);
		await dispatch(
			hook,
			sessionID,
			'call-vm-b2',
			testEngineerArgs(),
			`All 20 tests pass.\n[TESTED] | task-${TASK_ID} | PASS | 20/20 tests passed`,
		);

		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeDefined();
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
	});

	it('a reviewer reply with only a VERDICT line leaves pre_check_passed in place and names the [REVIEWED] row', async () => {
		const sessionID = 'sess-verdict-missing-reviewer';
		tempDir = makeTempDir('dg-verdict-missing-c-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedStageA(sessionID, [TASK_ID]);
		const session = ensureAgentSession(sessionID);

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-c',
			{
				subagent_type: 'reviewer',
				task_id: TASK_ID,
				prompt: `TASK: ${TASK_ID}\nACCEPTANCE: reviewer must report a structured verdict for the task`,
			},
			'VERDICT: APPROVED\nReviewed the code. No issues found.',
		);

		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeUndefined();
		expect(evidence?.workflow?.state).toBe('pre_check_passed');
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');
		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain(`reviewer task ${TASK_ID}`);
		expect(advisories[0]).toContain(
			`[REVIEWED] | task-${TASK_ID} | <APPROVED, REJECTED or CONCERNS> | <brief summary>`,
		);
		expect(advisories[0]).not.toMatch(/\| (APPROVED|REJECTED|CONCERNS) \|/);
		expect(
			session.stageBCompletion?.get(TASK_ID)?.has('reviewer') ?? false,
		).toBe(false);
	});

	it('reviewer and test_engineer both unreadable for one task in the same turn: each gets its own advisory', async () => {
		const sessionID = 'sess-verdict-missing-pair';
		tempDir = makeTempDir('dg-verdict-missing-p-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedStageA(sessionID, [TASK_ID]);

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-p1',
			{
				subagent_type: 'reviewer',
				task_id: TASK_ID,
				prompt: `TASK: ${TASK_ID}\nACCEPTANCE: reviewer must report a structured verdict for the task`,
			},
			`**VERDICT: APPROVED** — \`[REVIEWED] | task-${TASK_ID} | APPROVED | fine\``,
		);
		await dispatch(
			hook,
			sessionID,
			'call-vm-p2',
			testEngineerArgs(),
			DECORATED_REPLY,
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(2);
		expect(advisories.some((m) => m.includes(`reviewer task ${TASK_ID}`))).toBe(
			true,
		);
		expect(
			advisories.some((m) => m.includes(`test_engineer task ${TASK_ID}`)),
		).toBe(true);
	});

	it('a reply with a row for another listed task but none for the dispatched task reports the dispatched task only', async () => {
		const sessionID = 'sess-verdict-missing-primary';
		tempDir = makeTempDir('dg-verdict-missing-d-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedStageA(sessionID, ['2.1', '2.2']);
		const session = ensureAgentSession(sessionID);

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-d',
			{
				subagent_type: 'reviewer',
				task_id: '2.1',
				prompt:
					'TASK: 2.1\nTASKS: 2.1, 2.2\nACCEPTANCE: reviewer must report a structured verdict for every listed task',
			},
			'[REVIEWED] | task-2.2 | APPROVED | No issues found',
		);

		expect(session.taskWorkflowStates.get('2.1')).toBe('pre_check_passed');
		expect(session.taskWorkflowStates.get('2.2')).toBe('reviewer_run');
		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('reviewer task 2.1');
		// 2.2 did get its row, so it must not be listed as still awaited.
		expect(advisories[0]).not.toContain('also awaited');
	});

	it('a task number that only appears in the prompt text is not reported when the dispatched task has its row', async () => {
		const sessionID = 'sess-verdict-missing-prose';
		tempDir = makeTempDir('dg-verdict-missing-f-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedStageA(sessionID, ['2.1', '2.2']);
		const session = ensureAgentSession(sessionID);

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-f',
			{
				subagent_type: 'reviewer',
				task_id: '2.1',
				prompt:
					'TASK: 2.1\nDo not review the files of task 2.2.\nACCEPTANCE: reviewer must report a structured verdict for the task',
			},
			'[REVIEWED] | task-2.1 | APPROVED | No issues found',
		);

		expect(session.taskWorkflowStates.get('2.1')).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get('2.2')).toBe('pre_check_passed');
		expect(settlementDropAdvisories(sessionID)).toEqual([]);
		expect(hostWarnings()).toEqual([]);
	});

	it('a dispatch with no task of its own and no row at all gets one advisory listing the awaited tasks', async () => {
		const sessionID = 'sess-verdict-missing-set';
		tempDir = makeTempDir('dg-verdict-missing-g-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedStageA(sessionID, ['2.1', '2.2']);
		const session = ensureAgentSession(sessionID);

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-g',
			{
				subagent_type: 'reviewer',
				prompt:
					'TASKS: 2.1, 2.2\nACCEPTANCE: reviewer must report a structured verdict for every listed task',
			},
			'Both tasks look fine.',
		);

		expect(session.taskWorkflowStates.get('2.1')).toBe('pre_check_passed');
		expect(session.taskWorkflowStates.get('2.2')).toBe('pre_check_passed');
		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		// It speaks about the dispatch, not about one task, and asks for a row
		// per task.
		expect(advisories[0]).toContain('reviewer dispatch from call call-vm-g');
		expect(advisories[0]).toContain('rows were awaited for: 2.1, 2.2');
		expect(advisories[0]).toContain('require one verdict row per task');
		expect(advisories[0]).toContain(
			'If this advisory repeats for the same agent after a re-dispatch, stop re-dispatching and report the unreadable reply to the user.',
		);
		expect(advisories[0]).toContain(
			'[REVIEWED] | task-<taskId> | <APPROVED, REJECTED or CONCERNS> | <brief summary>',
		);
	});

	it('a per-task advisory and a dispatch-wide advisory for the same agent and first task are both kept', async () => {
		const sessionID = 'sess-verdict-missing-both-shapes';
		tempDir = makeTempDir('dg-verdict-missing-j-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedStageA(sessionID, ['2.1', '2.2']);

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-j1',
			{
				subagent_type: 'reviewer',
				task_id: '2.1',
				prompt:
					'TASK: 2.1\nACCEPTANCE: reviewer must report a structured verdict for the task',
			},
			'Looks fine.',
		);
		await dispatch(
			hook,
			sessionID,
			'call-vm-j2',
			{
				subagent_type: 'reviewer',
				prompt:
					'TASKS: 2.1, 2.2\nACCEPTANCE: reviewer must report a structured verdict for every listed task',
			},
			'Both tasks look fine.',
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(2);
		expect(advisories.some((m) => m.includes('reviewer task 2.1'))).toBe(true);
		expect(
			advisories.some((m) =>
				m.includes('reviewer dispatch from call call-vm-j2'),
			),
		).toBe(true);
	});

	it('a dispatch with no task of its own that returns some rows is not reported', async () => {
		const sessionID = 'sess-verdict-missing-set-partial';
		tempDir = makeTempDir('dg-verdict-missing-h-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedStageA(sessionID, ['2.1', '2.2']);
		const session = ensureAgentSession(sessionID);

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-h',
			{
				subagent_type: 'reviewer',
				prompt:
					'TASKS: 2.1, 2.2\nACCEPTANCE: reviewer must report a structured verdict for every listed task',
			},
			'[REVIEWED] | task-2.1 | APPROVED | No issues found',
		);

		expect(session.taskWorkflowStates.get('2.1')).toBe('reviewer_run');
		expect(session.taskWorkflowStates.get('2.2')).toBe('pre_check_passed');
		expect(settlementDropAdvisories(sessionID)).toEqual([]);
	});

	it('an unreadable reply for a dispatched task also lists the other tasks the dispatch awaited', async () => {
		const sessionID = 'sess-verdict-missing-also';
		tempDir = makeTempDir('dg-verdict-missing-i-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedStageA(sessionID, ['2.1', '2.2']);

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-i',
			{
				subagent_type: 'reviewer',
				task_id: '2.1',
				prompt:
					'TASK: 2.1\nTASKS: 2.1, 2.2\nACCEPTANCE: reviewer must report a structured verdict for every listed task',
			},
			'Both tasks look fine.',
		);

		const advisories = settlementDropAdvisories(sessionID);
		expect(advisories).toHaveLength(1);
		expect(advisories[0]).toContain('reviewer task 2.1');
		expect(advisories[0]).toContain('(rows were also awaited for: 2.2)');
	});

	it('a reply with a row for every dispatched task raises no missing-verdict advisory', async () => {
		const sessionID = 'sess-verdict-missing-clean';
		tempDir = makeTempDir('dg-verdict-missing-e-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'vm-e');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;

		const hook = createDelegationGateHook(testConfig(), tempDir);
		await dispatch(
			hook,
			sessionID,
			'call-vm-e',
			testEngineerArgs(),
			`[TESTED] | task-${TASK_ID} | PASS | 20/20 tests passed`,
		);

		expect(settlementDropAdvisories(sessionID)).toEqual([]);
		expect(hostWarnings()).toEqual([]);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
	});
});
