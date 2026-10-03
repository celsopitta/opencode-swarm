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
import { applySessionWorkflowView } from '../../../src/workflow/session-view';
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
		applySessionWorkflowView(
			session,
			'7.3',
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '7.3')),
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
