/**
 * Issue #3043 regression tests — blocked-start settlement-wedge recovery
 * refreshes the recovering session's in-memory workflow view (writer-side).
 *
 * The two blocked-start durable writers (recover_stage_a_task via
 * recoverStageATaskSupervised, and /swarm recover via repairWedgedStageA)
 * advanced durable evidence without touching any session's
 * taskWorkflowStates map, so a session whose map legitimately held `blocked`
 * wedged every later Stage B verdict. Pins the writer-side refresh, its
 * no-downgrade boundary, the /swarm recover skip-outcome extension, and the
 * cross-session residual. Wiring and per-call-site no-downgrade coverage
 * lives in stage-a-repair-session-view-wiring-3043.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleRecoverCommand } from '../../../src/commands/recover';
import {
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { executeRecoverStageATask } from '../../../src/tools/recover-stage-a-task';
import {
	type StageARecoveredState,
	shouldRefreshStageARecoveryView,
} from '../../../src/workflow/session-view';
import { recoverStageATaskSupervised } from '../../../src/workflow/settlement-recovery';
import { repairWedgedStageA } from '../../../src/workflow/stage-a-repair';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import {
	drainRehydrations,
	fullConfig,
	makeTempDir,
	reviewerArgs,
	TASK_ID,
} from '../hooks/_stage-b-settlement-2817-helpers.js';
import {
	settleAt,
	writeCommittedWal,
	writeGreenBundles,
} from './_settlement-recovery-2828-helpers.js';

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

/** The #2828 settlement wedge: durable blocked + COMMITTED accepted WAL + green bundles. */
async function seedSettlementWedge(directory: string): Promise<void> {
	const { writePlan } = await import(
		'../hooks/_stage-b-settlement-2817-helpers.js'
	);
	writePlan(directory);
	await settleAt(directory, TASK_ID, 'blocked');
	writeCommittedWal(directory, TASK_ID, true);
	await writeGreenBundles(directory);
}

async function architectSession(
	directory: string,
	sessionID: string,
	mapState?: string,
) {
	startAgentSession(sessionID, 'architect', directory);
	await drainRehydrations();
	const session = ensureAgentSession(sessionID);
	if (mapState) {
		session.taskWorkflowStates.set(TASK_ID, mapState as never);
	}
	session.currentTaskId = TASK_ID;
	return session;
}

const APPROVED_OUTPUT = `[REVIEWED] | task-${TASK_ID} | APPROVED | all good`;

describe('issue #3043 — blocked-start recovery refreshes the session view', () => {
	it('recover_stage_a_task (tool surface) refreshes map, clears Stage B bookkeeping, and syncs the cache', async () => {
		tempDir = makeTempDir('sr-3043-tool-');
		await seedSettlementWedge(tempDir);
		const sessionID = 'sess-3043-tool';
		const session = await architectSession(tempDir, sessionID, 'blocked');
		if (!session.stageBCompletion) {
			session.stageBCompletion = new Map();
		}
		session.stageBCompletion.set(TASK_ID, new Set(['reviewer']));
		// Seed the council maps so the clear assertions below discriminate.
		session.taskCouncilApproved?.set(TASK_ID, {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
		session.taskCouncilWorkflowGeneration?.set(TASK_ID, 1);

		const raw = await executeRecoverStageATask(
			{ task_id: TASK_ID, reason: 'test: blocked-start settlement wedge' },
			tempDir,
			{ sessionID },
		);
		expect(JSON.parse(raw).success).toBe(true);
		expect(JSON.parse(raw).state).toBe('pre_check_passed');

		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');
		expect(session.stageBCompletion.has(TASK_ID)).toBe(false);
		expect(session.taskCouncilApproved?.has(TASK_ID) ?? false).toBe(false);
		expect(session.taskCouncilWorkflowGeneration?.has(TASK_ID) ?? false).toBe(
			false,
		);
		const cache = session.taskWorkflowCache?.get(TASK_ID);
		const snapshotWorkflow = (await readTaskEvidence(tempDir, TASK_ID))
			?.workflow;
		expect(cache?.generation).toBe(snapshotWorkflow?.generation);
		expect(cache?.lastTransitionId).toBe(snapshotWorkflow?.lastTransitionId);
	});

	it('idempotent no-op path refreshes the map without touching evidence bytes', async () => {
		tempDir = makeTempDir('sr-3043-noop-');
		await seedSettlementWedge(tempDir);
		const sessionID = 'sess-3043-noop';
		const session = await architectSession(tempDir, sessionID, 'blocked');

		const first = await recoverStageATaskSupervised(tempDir, sessionID, {
			taskId: TASK_ID,
			reason: 'test: first recovery',
		});
		expect(first.alreadyRecovered).toBe(false);

		// The no-op call must self-heal: durable recovered, map re-diverged.
		session.taskWorkflowStates.set(TASK_ID, 'blocked' as never);
		const evidencePath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			`${TASK_ID}.json`,
		);
		const hashBefore = createHash('sha256')
			.update(fs.readFileSync(evidencePath))
			.digest('hex');

		const second = await recoverStageATaskSupervised(tempDir, sessionID, {
			taskId: TASK_ID,
			reason: 'test: no-op re-run',
		});
		expect(second.alreadyRecovered).toBe(true);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');

		const hashAfter = createHash('sha256')
			.update(fs.readFileSync(evidencePath))
			.digest('hex');
		expect(hashAfter).toBe(hashBefore);
	});

	it('repairWedgedStageA with sessionId refreshes the invoking session (direct and via /swarm recover)', async () => {
		tempDir = makeTempDir('sr-3043-cmd-');
		await seedSettlementWedge(tempDir);
		const sessionID = 'sess-3043-cmd';
		const session = await architectSession(tempDir, sessionID, 'blocked');

		const { results } = await repairWedgedStageA(tempDir, {
			taskIds: [TASK_ID],
			sessionId: sessionID,
		});
		expect(results[0]?.outcome).toBe('repaired');
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');

		// The command pass-through: a second task wedged the same way, repaired
		// through handleRecoverCommand with the invoking session id.
		const { writePlan } = await import(
			'../hooks/_stage-b-settlement-2817-helpers.js'
		);
		writePlan(tempDir, [TASK_ID, '1.2']);
		await settleAt(tempDir, '1.2', 'blocked');
		writeCommittedWal(tempDir, '1.2', true);
		session.taskWorkflowStates.set(TASK_ID, 'blocked' as never);
		session.taskWorkflowStates.set('1.2', 'blocked' as never);

		const report = await handleRecoverCommand(tempDir, ['1.2'], sessionID);
		expect(report).toContain('Stage A repaired');
		expect(session.taskWorkflowStates.get('1.2')).toBe('pre_check_passed');
		// Not in scope: 1.1 was not requested, its re-diverged view stays.
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('blocked');
	});

	it('pre-recorded repair id: the refresh follows the transition-result snapshot of the applied write', async () => {
		tempDir = makeTempDir('sr-3043-dup-');
		const { writePlan } = await import(
			'../hooks/_stage-b-settlement-2817-helpers.js'
		);
		writePlan(tempDir);
		// Seed a stage_a_passed carrying the repair's OWN deterministic
		// transition id in its history, then re-block. The repair's write is
		// NOT a duplicate (task_blocked overwrote lastTransitionId, which
		// isDuplicateTransition compares against), pinning that the refresh
		// follows the applied write's snapshot. A true concurrent duplicate
		// (duplicated=true over recovered evidence) needs a scan-to-write
		// race and is not deterministically constructible here.
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `coder:dup-${TASK_ID}`,
		});
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'stage_a_passed',
			settlementRecovery: true,
			expectedGeneration: 1,
			transitionId: `stage-a-repair:${TASK_ID}:1`,
		});
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'task_blocked',
			expectedGeneration: 1,
			transitionId: `terminal:dup-${TASK_ID}`,
		});
		writeCommittedWal(tempDir, TASK_ID, true);
		await writeGreenBundles(tempDir);

		const sessionID = 'sess-3043-dup';
		const session = await architectSession(tempDir, sessionID, 'blocked');
		await repairWedgedStageA(tempDir, {
			taskIds: [TASK_ID],
			sessionId: sessionID,
		});

		expect((await readTaskEvidence(tempDir, TASK_ID))?.workflow?.state).toBe(
			'pre_check_passed',
		);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');
	});

	it('skip-outcome extension: /swarm recover re-run un-wedges an already-recovered task', async () => {
		tempDir = makeTempDir('sr-3043-skip-');
		await seedSettlementWedge(tempDir);
		const sessionID = 'sess-3043-skip';
		const session = await architectSession(tempDir, sessionID, 'blocked');
		await recoverStageATaskSupervised(tempDir, sessionID, {
			taskId: TASK_ID,
			reason: 'test: earlier recovery (maybe another session)',
		});
		// Re-diverge: durable pre_check_passed, map blocked, and the repair
		// scan now classifies the task skipped_not_wedged.
		session.taskWorkflowStates.set(TASK_ID, 'blocked' as never);

		const report = await handleRecoverCommand(tempDir, [TASK_ID], sessionID);
		expect(report).toContain('nothing to repair');
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');
	});

	it('end-to-end: blocked map -> recovery -> reviewer dispatch + APPROVED verdict records gates.reviewer', async () => {
		tempDir = makeTempDir('sr-3043-e2e-');
		await seedSettlementWedge(tempDir);
		const sessionID = 'sess-3043-e2e';
		const session = await architectSession(tempDir, sessionID, 'blocked');

		const summary = await recoverStageATaskSupervised(tempDir, sessionID, {
			taskId: TASK_ID,
			reason: 'test: blocked-start journey',
		});
		expect(summary.alreadyRecovered).toBe(false);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');

		const hook = createDelegationGateHook(fullConfig(), tempDir);
		const callID = 'call-3043-e2e';
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
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
	});

	it('no-downgrade: barrier-ahead and terminal views survive the refresh untouched', async () => {
		tempDir = makeTempDir('sr-3043-ahead-');
		const { writePlan } = await import(
			'../hooks/_stage-b-settlement-2817-helpers.js'
		);
		writePlan(tempDir, [TASK_ID, '1.2']);
		await settleAt(tempDir, TASK_ID, 'blocked');
		await settleAt(tempDir, '1.2', 'blocked');
		writeCommittedWal(tempDir, TASK_ID, true);
		writeCommittedWal(tempDir, '1.2', true);
		await writeGreenBundles(tempDir);

		// Barrier-ahead shape: map tests_run while durable recovers to
		// pre_check_passed (required gates beyond the Stage B pair advance the
		// map past durable) — the refresh must not downgrade it.
		const aheadSessionID = 'sess-3043-ahead';
		const aheadSession = await architectSession(tempDir, aheadSessionID);
		aheadSession.taskWorkflowStates.set(TASK_ID, 'tests_run' as never);
		await recoverStageATaskSupervised(tempDir, aheadSessionID, {
			taskId: TASK_ID,
			reason: 'test: map-ahead must survive',
		});
		expect(aheadSession.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');

		// Terminal shape: a closed view is never un-completed in memory.
		const closedSessionID = 'sess-3043-closed';
		const closedSession = await architectSession(tempDir, closedSessionID);
		closedSession.taskWorkflowStates.set('1.2', 'closed' as never);
		await recoverStageATaskSupervised(tempDir, closedSessionID, {
			taskId: '1.2',
			reason: 'test: terminal must survive',
		});
		expect(closedSession.taskWorkflowStates.get('1.2')).toBe('closed');
		expect((await readTaskEvidence(tempDir, '1.2'))?.workflow?.state).toBe(
			'pre_check_passed',
		);
	});

	it('no-op corner: a reviewer_run map over durable tests_run refreshes FORWARD', async () => {
		tempDir = makeTempDir('sr-3043-corner-');
		const { writePlan } = await import(
			'../hooks/_stage-b-settlement-2817-helpers.js'
		);
		writePlan(tempDir);
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `seed-coder:${TASK_ID}`,
		});
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: `seed-stage-a:${TASK_ID}`,
		});
		const gen = (await readTaskEvidence(tempDir, TASK_ID))!.workflow!
			.generation;
		await recordGateEvidence(
			tempDir,
			TASK_ID,
			'reviewer',
			'seed-reviewer',
			undefined,
			{ expectedGeneration: gen },
		);
		const gen2 = (await readTaskEvidence(tempDir, TASK_ID))!.workflow!
			.generation;
		await recordGateEvidence(
			tempDir,
			TASK_ID,
			'test_engineer',
			'seed-tested',
			undefined,
			{ expectedGeneration: gen2 },
		);
		expect((await readTaskEvidence(tempDir, TASK_ID))?.workflow?.state).toBe(
			'tests_run',
		);

		const sessionID = 'sess-3043-corner';
		const session = await architectSession(tempDir, sessionID, 'reviewer_run');
		const summary = await recoverStageATaskSupervised(tempDir, sessionID, {
			taskId: TASK_ID,
			reason: 'test: forward sync on the no-op path',
		});
		expect(summary.alreadyRecovered).toBe(true);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
	});

	it('cross-session residual: a foreign session keeps its blocked view (consumer-side guard stays closed)', async () => {
		tempDir = makeTempDir('sr-3043-foreign-');
		await seedSettlementWedge(tempDir);
		const recoveringID = 'sess-3043-rec';
		const foreignID = 'sess-3043-foreign';
		const recovering = await architectSession(tempDir, recoveringID, 'blocked');
		startAgentSession(foreignID, 'architect', tempDir);
		await drainRehydrations();
		const foreign = ensureAgentSession(foreignID);
		foreign.taskWorkflowStates.set(TASK_ID, 'blocked' as never);
		foreign.currentTaskId = TASK_ID;

		await recoverStageATaskSupervised(tempDir, recoveringID, {
			taskId: TASK_ID,
			reason: 'test: recovery repairs only the recovering session',
		});
		expect(recovering.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');
		expect(foreign.taskWorkflowStates.get(TASK_ID)).toBe('blocked');
	});

	it('unknown sessionId never materializes a session (getAgentSession no-create)', async () => {
		tempDir = makeTempDir('sr-3043-unknown-');
		await seedSettlementWedge(tempDir);
		const sessionID = 'sess-3043-known';
		await architectSession(tempDir, sessionID, 'blocked');

		const { results } = await repairWedgedStageA(tempDir, {
			taskIds: [TASK_ID],
			sessionId: 'never-seen-3043',
		});
		expect(results[0]?.outcome).toBe('repaired');
		expect(swarmState.agentSessions.has('never-seen-3043')).toBe(false);
		// The durable repair still succeeded without any session refresh.
		expect((await readTaskEvidence(tempDir, TASK_ID))?.workflow?.state).toBe(
			'pre_check_passed',
		);
	});

	it('refresh predicate boundary: blocked/lagging refresh, ahead/terminal never (incl. out-of-band hardening)', () => {
		expect(shouldRefreshStageARecoveryView(undefined, 'pre_check_passed')).toBe(
			true,
		);
		expect(
			shouldRefreshStageARecoveryView('rework_required', 'pre_check_passed'),
		).toBe(true);
		expect(shouldRefreshStageARecoveryView('blocked', 'pre_check_passed')).toBe(
			true,
		);
		expect(shouldRefreshStageARecoveryView('idle', 'pre_check_passed')).toBe(
			true,
		);
		expect(
			shouldRefreshStageARecoveryView('coder_delegated', 'pre_check_passed'),
		).toBe(true);
		expect(
			shouldRefreshStageARecoveryView('pre_check_passed', 'reviewer_run'),
		).toBe(true);
		expect(shouldRefreshStageARecoveryView('reviewer_run', 'tests_run')).toBe(
			true,
		);
		// Never a downgrade in-band (map at/above durable):
		expect(shouldRefreshStageARecoveryView('tests_run', 'reviewer_run')).toBe(
			false,
		);
		expect(
			shouldRefreshStageARecoveryView('reviewer_run', 'pre_check_passed'),
		).toBe(false);
		expect(shouldRefreshStageARecoveryView('closed', 'tests_run')).toBe(false);
		expect(shouldRefreshStageARecoveryView('complete', 'tests_run')).toBe(
			false,
		);
		// Out-of-band hardening: production callers only pass the recovered
		// band, but the exclusion set also holds for recovered states outside
		// it, so a future band widening cannot silently downgrade these.
		expect(
			shouldRefreshStageARecoveryView(
				'tests_run',
				'blocked' as StageARecoveredState,
			),
		).toBe(false);
		expect(
			shouldRefreshStageARecoveryView(
				'closed',
				'complete' as StageARecoveredState,
			),
		).toBe(false);
		expect(
			shouldRefreshStageARecoveryView(
				'complete',
				'closed' as StageARecoveredState,
			),
		).toBe(false);
	});
});
