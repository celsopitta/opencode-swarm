/**
 * Issue #3032 regression tests — the Stage B in-memory/durable view split-brain.
 *
 * The settlement loop admits tasks by the session's in-memory
 * `taskWorkflowStates` while the dispatch side reads the durable evidence.
 * Covered durable-only writers: recover_rework_task (rework_required views)
 * and the idle-start recoveries (recover_stage_a_task / stage-a-repair from
 * idle, or a mechanical write landing on another session's map). Recovery
 * from a BLOCKED in-memory view is covered WRITER-SIDE by issue #3043 (both
 * settlement-wedge writers refresh the recovering session's view in the
 * same call — see tests/unit/workflow/settlement-recovery-blocked-start-view-3043.test.ts);
 * this consumer-side guard still refuses at-or-above views, so a blocked view
 * in a session that did NOT run the recovery stays unrepaired — the pinned
 * cross-session residual: in such a diverged view every later
 * reviewer/test_engineer verdict is silently skipped before any
 * #2817 drop site — no gate write, no advisory, no recovery short of a
 * fresh session (the frozen checks in
 * .agents/issue-traces/3032-reset-session-stage-b-gate-persistence/repro/
 * pin the full reset-session journey; this file pins the two resync layers
 * and their boundaries on the plain seeding surface).
 *
 * Layer A1 (dispatch-side): binding a Stage B generation from durable
 * evidence also repairs a lagging in-memory view. Layer A2 (settlement-side):
 * a verdict-carrying task in this call's dispatch context gets one bounded
 * durable re-read when the in-memory view is stale. Both layers share
 * isRepairableStageBView: absent / rework_required / rank-below only — an
 * at-or-above view (tests_run/blocked/closed/complete) is never overwritten.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
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
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import {
	drainRehydrations,
	fullConfig,
	makeTempDir,
	reviewerArgs,
	TASK_ID,
	testEngineerArgs,
} from './_stage-b-settlement-2817-helpers.js';

let tempDir: string;
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
});

afterEach(() => {
	resetSwarmState();
	try {
		if (tempDir) {
			fs.rmSync(tempDir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		}
	} catch {
		// best-effort cleanup (temp dir only)
	}
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

/** Durable: accepted coder mutation @gen1 -> stage_a_passed (pre_check_passed). */
async function seedDurablePreCheckPassed(
	directory: string,
	options?: { agentType?: string; settlementFailed?: boolean },
): Promise<void> {
	const { writePlan } = await import('./_stage-b-settlement-2817-helpers.js');
	writePlan(directory);
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'accepted_mutation',
		agentType: options?.agentType ?? 'coder',
		expectedGeneration: 0,
		transitionId: `seed-coder:${TASK_ID}`,
		...(options?.settlementFailed
			? { context: { settlementFailed: true } }
			: {}),
	});
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `seed-stage-a:${TASK_ID}`,
	});
}

async function setupSession(
	directory: string,
	sessionID: string,
	inMemoryState: string,
): Promise<ReturnType<typeof ensureAgentSession>> {
	startAgentSession(sessionID, 'architect', directory);
	await drainRehydrations();
	const session = ensureAgentSession(sessionID);
	session.taskWorkflowStates.set(TASK_ID, inMemoryState as never);
	session.currentTaskId = TASK_ID;
	return session;
}

const APPROVED_OUTPUT = `[REVIEWED] | task-${TASK_ID} | APPROVED | all good`;
const PASS_OUTPUT = `[TESTED] | task-${TASK_ID} | PASS | all green`;

describe('issue #3032 — Stage B in-memory/durable view resync', () => {
	it('A1: reviewer dispatch repairs a lagging in-memory view from durable evidence, then the settlement records gates.reviewer', async () => {
		const sessionID = 'sess-3032-a1';
		tempDir = makeTempDir('dg-3032-a1-');
		await seedDurablePreCheckPassed(tempDir);
		// The #3032 wedge: durable pre_check_passed (written by a durable-only
		// recovery tool), in-memory still rework_required.
		const session = await setupSession(tempDir, sessionID, 'rework_required');
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-3032-a1';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(`Review task-${TASK_ID} and return a structured approval.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: reviewerArgs(
					`ACCEPTANCE: return a structured approval for task-${TASK_ID}.`,
				),
			},
			{ output: APPROVED_OUTPUT },
		);
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeDefined();
	});

	it('A2: a divergence created between dispatch and settlement (durable-only writer mid-flight) is repaired at settlement', async () => {
		const sessionID = 'sess-3032-a2';
		tempDir = makeTempDir('dg-3032-a2-');
		await seedDurablePreCheckPassed(tempDir);
		const session = await setupSession(tempDir, sessionID, 'pre_check_passed');
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-3032-a2';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(`Review task-${TASK_ID} and return a structured approval.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		// Divergence AFTER dispatch: a recovery tool advances durable but not
		// this session's map (modeled directly — the durable state is already
		// pre_check_passed, so the stale map below is the divergence).
		session.taskWorkflowStates.set(TASK_ID, 'rework_required');

		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: reviewerArgs(
					`ACCEPTANCE: return a structured approval for task-${TASK_ID}.`,
				),
			},
			{ output: APPROVED_OUTPUT },
		);
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeDefined();
		// The settlement resynced the view (A2) and then advanced it normally.
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
	});

	it('A1: test_engineer settles from the stale view one durable step after the reviewer (barrier order kept)', async () => {
		const sessionID = 'sess-3032-te';
		tempDir = makeTempDir('dg-3032-te-');
		await seedDurablePreCheckPassed(tempDir);
		// The #3032 wedge across BOTH Stage B gates: reviewer settles from the
		// repaired view, then a durable-only writer re-stales the map before the
		// test_engineer dispatch (durable is now reviewer_run).
		const session = await setupSession(tempDir, sessionID, 'rework_required');
		const hook = createDelegationGateHook(fullConfig(), tempDir);

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-3032-te-r' },
			{
				args: reviewerArgs(`Review task-${TASK_ID} and return a structured approval.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-3032-te-r',
				args: reviewerArgs(
					`ACCEPTANCE: return a structured approval for task-${TASK_ID}.`,
				),
			},
			{ output: APPROVED_OUTPUT },
		);
		expect(
			(await readTaskEvidence(tempDir, TASK_ID))?.gates?.reviewer,
		).toBeDefined();

		session.taskWorkflowStates.set(TASK_ID, 'rework_required');
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-3032-te-t' },
			{ args: testEngineerArgs() },
		);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-3032-te-t',
				args: testEngineerArgs(),
			},
			{ output: PASS_OUTPUT },
		);
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.test_engineer).toBeDefined();
		expect(evidence?.gates?.reviewer).toBeDefined();
	});

	it("context mismatch: a verdict for a task NOT in this call's dispatch context is not resynced and not settled", async () => {
		const sessionID = 'sess-3032-ctx';
		tempDir = makeTempDir('dg-3032-ctx-');
		const { writePlan } = await import('./_stage-b-settlement-2817-helpers.js');
		writePlan(tempDir, [TASK_ID, '1.2']);
		// Durable: 1.1 and 1.2 both pre_check_passed; the dispatch binds only 1.1.
		for (const taskId of [TASK_ID, '1.2']) {
			await transitionTaskWorkflowEvidence(tempDir, taskId, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: `seed-coder:${taskId}`,
			});
			await transitionTaskWorkflowEvidence(tempDir, taskId, {
				type: 'stage_a_passed',
				expectedGeneration: 1,
				transitionId: `seed-stage-a:${taskId}`,
			});
		}
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'rework_required');
		session.taskWorkflowStates.set('1.2', 'rework_required');
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-3032-ctx';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(`Review task-${TASK_ID} and return a structured approval.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		// A1 repaired 1.1 (in context); 1.2 was never part of this dispatch.
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');
		expect(session.taskWorkflowStates.get('1.2')).toBe('rework_required');

		// The verdict names 1.2 — not in this call's dispatch context: no A2
		// resync, silent skip preserved (the fail-closed no-toolBefore shapes of
		// #2817 depend on exactly this).
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: reviewerArgs(
					`ACCEPTANCE: return a structured approval for task-${TASK_ID}.`,
				),
			},
			{ output: `[REVIEWED] | task-1.2 | APPROVED | all good` },
		);
		expect(session.taskWorkflowStates.get('1.2')).toBe('rework_required');
		const evidence12 = await readTaskEvidence(tempDir, '1.2');
		expect(evidence12?.gates?.reviewer).toBeUndefined();
	});

	it('reverse divergence: an eligible in-memory view cannot admit a task whose durable state is genuinely ineligible', async () => {
		const sessionID = 'sess-3032-rev';
		tempDir = makeTempDir('dg-3032-rev-');
		// Durable: settlement-failed recovery shape -> rework_required @gen1.
		const { writePlan } = await import('./_stage-b-settlement-2817-helpers.js');
		writePlan(tempDir);
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `seed-coder:${TASK_ID}`,
			context: { settlementFailed: true },
		});
		await setupSession(tempDir, sessionID, 'pre_check_passed');
		const hook = createDelegationGateHook(fullConfig(), tempDir);

		// Dispatch admission reads DURABLE (rework_required) for the resolved
		// task id and must still throw Stage A required — no widening.
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID, callID: 'call-3032-rev' },
				{
					args: reviewerArgs(`Review task-${TASK_ID}.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
				},
			),
		).rejects.toThrow('TASK_WORKFLOW_STAGE_A_REQUIRED');
	});

	it('map-ahead view (real barrier writer, required gates beyond the Stage B pair) is never downgraded by A1 or A2', async () => {
		const sessionID = 'sess-3032-ahead';
		tempDir = makeTempDir('dg-3032-ahead-');
		// required_gates [designer, reviewer, test_engineer] via the real
		// deriveRequiredGates('designer') expansion — the settlement barrier
		// advances the map to tests_run on both Stage B completions while the
		// durable reducer stays at reviewer_run (designer gate missing).
		await seedDurablePreCheckPassed(tempDir, { agentType: 'designer' });
		const session = await setupSession(tempDir, sessionID, 'pre_check_passed');
		const hook = createDelegationGateHook(fullConfig(), tempDir);

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-3032-ahead-r' },
			{
				args: reviewerArgs(`Review task-${TASK_ID}.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-3032-ahead-r',
				args: reviewerArgs(
					`ACCEPTANCE: return a structured approval for task-${TASK_ID}.`,
				),
			},
			{ output: APPROVED_OUTPUT },
		);
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-3032-ahead-t' },
			{ args: testEngineerArgs() },
		);
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-3032-ahead-t',
				args: testEngineerArgs(),
			},
			{ output: PASS_OUTPUT },
		);
		// Barrier over-advance: map tests_run, durable reviewer_run.
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');

		// A re-dispatch must not downgrade the map-ahead view (A1), and the
		// settlement must skip without resync (A2) — no crash, no downgrade.
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-3032-ahead-r2' },
			{
				args: reviewerArgs(`Review task-${TASK_ID}.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID: 'call-3032-ahead-r2',
				args: reviewerArgs(
					`ACCEPTANCE: return a structured approval for task-${TASK_ID}.`,
				),
			},
			{ output: APPROVED_OUTPUT },
		);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeDefined();
		expect(evidence?.gates?.test_engineer).toBeDefined();
		// PRR-011 pin: the second reviewer verdict must not rewrite the durable
		// gate record — lastTransitionId stays at the test_engineer write.
		expect(evidence?.workflow?.lastTransitionId).toBe(
			'gate:call-3032-ahead-t:1.1',
		);
	});

	it('control: an in-sync journey settles exactly as before', async () => {
		const sessionID = 'sess-3032-ctl';
		tempDir = makeTempDir('dg-3032-ctl-');
		await seedDurablePreCheckPassed(tempDir);
		const session = await setupSession(tempDir, sessionID, 'pre_check_passed');
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-3032-ctl';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(`Review task-${TASK_ID}.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');
		await hook.toolAfter(
			{
				tool: 'Task',
				sessionID,
				callID,
				args: reviewerArgs(
					`ACCEPTANCE: return a structured approval for task-${TASK_ID}.`,
				),
			},
			{ output: APPROVED_OUTPUT },
		);
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeDefined();
	});
});
