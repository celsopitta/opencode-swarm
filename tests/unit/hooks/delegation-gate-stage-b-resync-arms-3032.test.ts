/**
 * Issue #3032 regression tests — isRepairableStageBView / A2 boundary arms
 * (swarm-pr-review PRR-004 coverage closure for PR #3038).
 *
 * The journey file (delegation-gate-stage-b-inmemory-resync-3032.test.ts)
 * pins both resync layers on the rework_required wedge shape. This file pins
 * the remaining predicate and settlement-side boundary arms:
 * - A1 with an ABSENT in-memory view (undefined arm),
 * - A1 with a rank-below view (coder_delegated arm of the rank comparator),
 * - A2 with a non-authoritative durable snapshot (skip, fail-closed),
 * - A2 with a durable state that is genuinely ineligible (skip, fail-closed).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
async function seedDurablePreCheckPassed(directory: string): Promise<void> {
	const { writePlan } = await import('./_stage-b-settlement-2817-helpers.js');
	writePlan(directory);
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `seed-coder:${TASK_ID}`,
	});
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `seed-stage-a:${TASK_ID}`,
	});
}

const APPROVED_OUTPUT = `[REVIEWED] | task-${TASK_ID} | APPROVED | all good`;

describe('issue #3032 — resync predicate and A2 boundary arms (PRR-004)', () => {
	it('A1 undefined arm: a session whose map never observed the task is repaired from durable at dispatch', async () => {
		const sessionID = 'sess-3032-arm-undef';
		tempDir = makeTempDir('dg-3032-arm-undef-');
		await seedDurablePreCheckPassed(tempDir);
		// Fresh architect session: the map has no entry for the task at all
		// (existingView === undefined arm of isRepairableStageBView).
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		const session = ensureAgentSession(sessionID);
		expect(session.taskWorkflowStates.has(TASK_ID)).toBe(false);
		session.currentTaskId = TASK_ID;
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-3032-arm-undef';

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

	it('A1 rank-below arm: a coder_delegated in-memory view is repaired by the rank comparator', async () => {
		const sessionID = 'sess-3032-arm-below';
		tempDir = makeTempDir('dg-3032-arm-below-');
		await seedDurablePreCheckPassed(tempDir);
		const session = await setupSession(tempDir, sessionID, 'coder_delegated');
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-3032-arm-below';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(`Review task-${TASK_ID} and return a structured approval.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		// compareTaskWorkflowStateRank('pre_check_passed', 'coder_delegated') > 0.
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

	it('A2 non-authoritative arm: a durable snapshot that is unreadable/non-authoritative is not resynced (fail-closed skip)', async () => {
		const sessionID = 'sess-3032-arm-nonauth';
		tempDir = makeTempDir('dg-3032-arm-nonauth-');
		await seedDurablePreCheckPassed(tempDir);
		const session = await setupSession(tempDir, sessionID, 'pre_check_passed');
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-3032-arm-nonauth';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(`Review task-${TASK_ID} and return a structured approval.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		// Divergence after dispatch: stale in-memory view...
		session.taskWorkflowStates.set(TASK_ID, 'rework_required');
		// ...and a durable snapshot that can no longer authorize a resync.
		fs.rmSync(path.join(tempDir, '.swarm', 'evidence', `${TASK_ID}.json`), {
			force: true,
		});

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
		// Non-authoritative durable read: no resync, silent fail-closed skip —
		// the same shape as base (no gate write, no crash, no advisory change).
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('rework_required');
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeUndefined();
	});

	it('A2 durable-ineligible arm: a durable state that is genuinely ineligible is not resynced (no admission widening)', async () => {
		const sessionID = 'sess-3032-arm-inelig';
		tempDir = makeTempDir('dg-3032-arm-inelig-');
		await seedDurablePreCheckPassed(tempDir);
		const session = await setupSession(tempDir, sessionID, 'pre_check_passed');
		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-3032-arm-inelig';

		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{
				args: reviewerArgs(`Review task-${TASK_ID} and return a structured approval.
ACCEPTANCE: return a structured approval for task-${TASK_ID}.`),
			},
		);
		// Divergence after dispatch: an at-or-above in-memory view (the barrier
		// over-advance shape, map tests_run) AND the durable state rewound to
		// genuinely ineligible (settlement-failed recovery shape). The views are
		// deliberately DIVERGENT so the arm's effect is observable: with the
		// arm intact the map stays tests_run; with the arm removed the resync
		// would downgrade the map to rework_required (rank 5 > 4).
		session.taskWorkflowStates.set(TASK_ID, 'tests_run');
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 1,
			transitionId: `seed-rewind:${TASK_ID}`,
			context: { settlementFailed: true },
		});

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
		// Durable rework_required is not Stage B eligible: no resync (the
		// map-ahead view is never downgraded), no gate.
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
		const evidence = await readTaskEvidence(tempDir, TASK_ID);
		expect(evidence?.gates?.reviewer).toBeUndefined();
	});
});

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
