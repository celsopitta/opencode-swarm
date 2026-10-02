/**
 * The session's in-memory copy of a task's workflow must be brought in line
 * with authoritative durable evidence without inventing state, without
 * touching a session that already agrees, and without discarding progress
 * that belongs to the current generation.
 *
 * Observed live: recover_stage_a_task moved the evidence to pre_check_passed
 * and reported "dispatch is permitted again" while the session still said
 * blocked (later idle); twelve reviewer approvals and a test pass were then
 * skipped without any message.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { saveEvidence } from '../../../src/evidence/manager';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	type AgentSessionState,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { executeRecoverStageATask } from '../../../src/tools/recover-stage-a-task';
import { forceRecoverReworkTask } from '../../../src/workflow/rework-recovery';
import { reconcileSessionWorkflowWithEvidence } from '../../../src/workflow/session-workflow-sync';
import { recoverStageATaskSupervised } from '../../../src/workflow/settlement-recovery';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import {
	settleAt,
	writeCommittedWal,
	writeGreenBundles,
} from './_settlement-recovery-2828-helpers';

const REASON = 'recovery must leave the session in agreement with the evidence';

let directory = '';
let cleanup = (): void => {};

beforeEach(() => {
	resetSwarmState();
	({ dir: directory, cleanup } = createSafeTestDir('recovery-sync-'));
});

afterEach(() => {
	resetSwarmState();
	cleanup();
});

/** An architect session bound to the project, with its rehydration settled. */
async function architect(id: string): Promise<AgentSessionState> {
	const session = ensureAgentSession(id, 'architect', directory);
	await Promise.allSettled([...swarmState.pendingRehydrations]);
	return session;
}

/** Durable pre_check_passed at generation 1. */
async function seedPreCheckPassed(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `mut-${taskId}`,
	});
	await transitionTaskWorkflowEvidence(directory, taskId, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `stage-a-${taskId}`,
	});
}

function writePlan(taskId: string): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'recovery-session-sync',
			swarm: 'local',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: taskId,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: `task ${taskId}`,
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		}),
	);
}

async function writeGreenPair(timestamp: string): Promise<void> {
	await saveEvidence(directory, 'secretscan', {
		task_id: 'secretscan',
		type: 'secretscan',
		timestamp,
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no secrets found',
		findings_count: 0,
		files_scanned: 3,
		skipped_files: 0,
		incomplete_files: 0,
		incomplete_paths: [],
	});
	await saveEvidence(directory, 'sast_scan', {
		task_id: 'sast_scan',
		type: 'sast',
		timestamp,
		agent: 'pre_check_batch',
		verdict: 'pass',
		summary: 'no findings',
		findings: [],
		engine: 'tier_a',
		files_scanned: 3,
		findings_count: 0,
		findings_by_severity: { critical: 0, high: 0, medium: 0, low: 0 },
	});
}

function markCurrentWaveProgress(session: AgentSessionState, taskId: string) {
	session.stageBCompletion = new Map([[taskId, new Set(['reviewer'])]]);
	session.taskCouncilApproved = new Map([
		[taskId, { verdict: 'APPROVE', roundNumber: 1 }],
	]) as AgentSessionState['taskCouncilApproved'];
	session.taskCouncilWorkflowGeneration = new Map([[taskId, 1]]);
}

describe('reconcileSessionWorkflowWithEvidence', () => {
	test('missing or non-authoritative evidence is never written into the session', async () => {
		const session = await architect('arch-null');
		session.taskWorkflowStates.set('1.1', 'reviewer_run');

		expect(reconcileSessionWorkflowWithEvidence(session, '1.1', null)).toBe(
			false,
		);
		expect(
			reconcileSessionWorkflowWithEvidence(session, '1.1', undefined),
		).toBe(false);
		// An evidence file without authoritative workflow metadata.
		expect(
			reconcileSessionWorkflowWithEvidence(session, '1.1', {
				taskId: '1.1',
				required_gates: ['reviewer', 'test_engineer'],
				gates: {},
			} as unknown as Parameters<
				typeof reconcileSessionWorkflowWithEvidence
			>[2]),
		).toBe(false);

		expect(session.taskWorkflowStates.get('1.1')).toBe('reviewer_run');
	});

	test('a session that already agrees on state and generation is left untouched', async () => {
		await seedPreCheckPassed('1.1');
		const evidence = await readTaskEvidence(directory, '1.1');
		const session = await architect('arch-agree');
		reconcileSessionWorkflowWithEvidence(session, '1.1', evidence);
		markCurrentWaveProgress(session, '1.1');

		expect(reconcileSessionWorkflowWithEvidence(session, '1.1', evidence)).toBe(
			false,
		);

		expect(session.stageBCompletion?.get('1.1')?.has('reviewer')).toBe(true);
		expect(session.taskCouncilApproved?.has('1.1')).toBe(true);
		expect(session.taskCouncilWorkflowGeneration?.get('1.1')).toBe(1);
	});

	test('the state and the cached generation are set from the evidence', async () => {
		await seedPreCheckPassed('1.1');
		const evidence = await readTaskEvidence(directory, '1.1');
		const session = await architect('arch-state');
		session.taskWorkflowCache?.delete('1.1');
		session.taskWorkflowStates.set('1.1', 'rework_required');

		expect(reconcileSessionWorkflowWithEvidence(session, '1.1', evidence)).toBe(
			true,
		);

		expect(session.taskWorkflowStates.get('1.1')).toBe('pre_check_passed');
		expect(session.taskWorkflowCache?.get('1.1')?.generation).toBe(1);
	});

	test('a completion marker is kept while its durable gate exists and removed when it does not', async () => {
		// Durable: reviewer gate recorded, no test_engineer gate. The session
		// holds both markers; the test_engineer one has no gate behind it (the
		// gate was cleared elsewhere, for example by a rejection).
		await seedPreCheckPassed('1.1');
		await recordGateEvidence(directory, '1.1', 'reviewer', 'seed', undefined, {
			expectedGeneration: 1,
			transitionId: 'seed-reviewer:1.1',
		});
		const evidence = await readTaskEvidence(directory, '1.1');
		const session = await architect('arch-markers');
		session.taskWorkflowStates.set('1.1', 'idle');
		session.stageBCompletion = new Map([
			['1.1', new Set(['reviewer', 'test_engineer'])],
		]);

		reconcileSessionWorkflowWithEvidence(session, '1.1', evidence);

		expect([...(session.stageBCompletion?.get('1.1') ?? [])]).toEqual([
			'reviewer',
		]);
	});

	test('no completion marker is added for a durable gate the session did not settle', async () => {
		await seedPreCheckPassed('1.1');
		await recordGateEvidence(directory, '1.1', 'reviewer', 'seed', undefined, {
			expectedGeneration: 1,
			transitionId: 'seed-reviewer:1.1',
		});
		const evidence = await readTaskEvidence(directory, '1.1');
		const session = await architect('arch-no-add');
		session.taskWorkflowStates.set('1.1', 'idle');
		session.stageBCompletion?.delete('1.1');

		reconcileSessionWorkflowWithEvidence(session, '1.1', evidence);

		expect(session.stageBCompletion?.has('1.1')).toBe(false);
	});

	test('a task with no durable Stage B gate ends with no completion marker', async () => {
		await seedPreCheckPassed('1.1');
		const evidence = await readTaskEvidence(directory, '1.1');
		const session = await architect('arch-no-gates');
		session.taskWorkflowStates.set('1.1', 'reviewer_run');
		session.stageBCompletion = new Map([['1.1', new Set(['reviewer'])]]);

		reconcileSessionWorkflowWithEvidence(session, '1.1', evidence);

		expect(session.stageBCompletion?.has('1.1')).toBe(false);
	});

	test('council state for the task is never touched, even when its generation is older than the durable one', async () => {
		// A council generation bound before the durable generation changed must
		// stay stale: the council evidence writer then rejects verdicts that
		// were collected for the old generation. Dropping it here would let the
		// next dispatch re-bind it at the new generation.
		await settleAt(directory, '7.1', 'idle');
		writeCommittedWal(directory, '7.1');
		await writeGreenBundles(directory);
		const session = await architect('arch-council');
		session.taskWorkflowStates.set('7.1', 'reviewer_run');
		markCurrentWaveProgress(session, '7.1');
		// Another architect session performs the recovery (generation 2).
		await architect('arch-other');
		await recoverStageATaskSupervised(directory, 'arch-other', {
			taskId: '7.1',
			reason: REASON,
		});
		const evidence = await readTaskEvidence(directory, '7.1');
		expect(getTaskWorkflowSnapshot(evidence).generation).toBe(2);

		expect(reconcileSessionWorkflowWithEvidence(session, '7.1', evidence)).toBe(
			true,
		);

		expect(session.taskWorkflowStates.get('7.1')).toBe('pre_check_passed');
		expect(session.taskWorkflowCache?.get('7.1')?.generation).toBe(2);
		expect(session.stageBCompletion?.has('7.1')).toBe(false);
		expect(session.taskCouncilWorkflowGeneration?.get('7.1')).toBe(1);
		expect(session.taskCouncilApproved?.has('7.1')).toBe(true);
	});
});

describe('recovery tools leave the calling session in agreement — regression: a recovered task kept a stale session state (live run 2026-10-02)', () => {
	// Previous code wrote the durable stage_a_passed transition and returned.
	// The caller's session.taskWorkflowStates entry kept the pre-recovery
	// value, so the Stage B settlement loop treated the task as ineligible.

	for (const wedge of ['idle', 'blocked'] as const) {
		test(`recover_stage_a_task from ${wedge}: the session reads the durable state and generation`, async () => {
			await settleAt(directory, '7.1', wedge);
			writeCommittedWal(directory, '7.1');
			await writeGreenBundles(directory);
			const session = await architect('arch-sync');
			session.taskWorkflowStates.set('7.1', wedge);

			const result = JSON.parse(
				await executeRecoverStageATask(
					{ task_id: '7.1', reason: REASON },
					directory,
					{ sessionID: 'arch-sync' },
				),
			);

			expect(result.success).toBe(true);
			const durable = getTaskWorkflowSnapshot(
				await readTaskEvidence(directory, '7.1'),
			);
			expect(durable.state).toBe('pre_check_passed');
			expect(session.taskWorkflowStates.get('7.1')).toBe(durable.state);
			expect(session.taskWorkflowCache?.get('7.1')?.generation).toBe(
				durable.generation,
			);
		});
	}

	test('recover_stage_a_task on an already recovered task corrects a stale session', async () => {
		await seedPreCheckPassed('7.2');
		const stale = await architect('arch-stale');
		stale.taskWorkflowStates.set('7.2', 'idle');

		const summary = await recoverStageATaskSupervised(directory, 'arch-stale', {
			taskId: '7.2',
			reason: REASON,
		});

		expect(summary.alreadyRecovered).toBe(true);
		expect(stale.taskWorkflowStates.get('7.2')).toBe('pre_check_passed');
	});

	test('a repeated recover_stage_a_task does not discard progress of the current wave', async () => {
		// A session that already agrees with the evidence must not be touched:
		// clearing its markers on a harmless repeat between the two Stage B
		// gates would leave it one step behind the durable state.
		await seedPreCheckPassed('7.3');
		const session = await architect('arch-repeat');
		reconcileSessionWorkflowWithEvidence(
			session,
			'7.3',
			await readTaskEvidence(directory, '7.3'),
		);
		markCurrentWaveProgress(session, '7.3');

		const summary = await recoverStageATaskSupervised(
			directory,
			'arch-repeat',
			{
				taskId: '7.3',
				reason: REASON,
			},
		);

		expect(summary.alreadyRecovered).toBe(true);
		expect(session.stageBCompletion?.get('7.3')?.has('reviewer')).toBe(true);
		expect(session.taskCouncilWorkflowGeneration?.get('7.3')).toBe(1);
	});

	test('recover_rework_task: the session leaves rework_required with the durable state', async () => {
		writePlan('1.1');
		await seedPreCheckPassed('1.1');
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'stage_b_failed',
			gate: 'test_engineer',
			expectedGeneration: 1,
			transitionId: 'stage-b-fail-1.1',
		});
		const anchor = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		).updatedAt;
		await writeGreenPair(new Date(Date.parse(anchor) + 60_000).toISOString());
		const session = await architect('arch-rework');
		session.taskWorkflowStates.set('1.1', 'rework_required');

		const summary = await forceRecoverReworkTask(directory, 'arch-rework', {
			taskId: '1.1',
			reason: REASON,
		});

		expect(summary.state).toBe('pre_check_passed');
		expect(session.taskWorkflowStates.get('1.1')).toBe('pre_check_passed');
		expect(session.taskWorkflowCache?.get('1.1')?.generation).toBe(
			summary.generation,
		);
	});
});
