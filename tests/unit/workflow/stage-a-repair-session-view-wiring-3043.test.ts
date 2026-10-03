/**
 * Issue #3043 feedback-round tests — wiring and no-downgrade coverage that the
 * primary suite (settlement-recovery-blocked-start-view-3043.test.ts) does not
 * pin (parallel swarm-pr-review findings F-1/F-2 + PRR-012a/PRR-016):
 *
 * - F-1: the /swarm recover registry wiring (COMMAND_REGISTRY recover handler
 *   passing ctx.sessionID) is the only production line carrying the refresh;
 *   exercising it through the handler proves the plumbing, and the
 *   sessionID-less invocation proves the refresh is carried by that wiring.
 * - F-2: shouldRefreshStageARecoveryView must gate ALL FOUR production call
 *   sites (skip-path re-read, repaired fresh-write, tool no-op branch, tool
 *   fresh-write). Each case here is a deterministic downgrade discriminator:
 *   with the guard removed at that site, the map would move backwards.
 * - PRR-012a: a skipped_not_wedged outcome whose scan state is outside the
 *   recovered band (rework_required) never refreshes, even with a session.
 * - PRR-016: tied-rank pairs are never refreshed (strict rank comparison).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { COMMAND_REGISTRY } from '../../../src/commands/registry';
import {
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import { shouldRefreshStageARecoveryView } from '../../../src/workflow/session-view';
import { recoverStageATaskSupervised } from '../../../src/workflow/settlement-recovery';
import { repairWedgedStageA } from '../../../src/workflow/stage-a-repair';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import {
	drainRehydrations,
	makeTempDir,
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

async function seedSettlementWedge(directory: string): Promise<void> {
	const { writePlan } = await import(
		'../hooks/_stage-b-settlement-2817-helpers.js'
	);
	writePlan(directory);
	await settleAt(directory, TASK_ID, 'blocked');
	writeCommittedWal(directory, TASK_ID, true);
	await writeGreenBundles(directory);
}

async function sessionAt(
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

describe('issue #3043 feedback — registry wiring and no-downgrade call sites', () => {
	it('F-1: the COMMAND_REGISTRY recover handler carries the refresh; without sessionID it must not', async () => {
		tempDir = makeTempDir('sr-3043-reg-');
		const { writePlan } = await import(
			'../hooks/_stage-b-settlement-2817-helpers.js'
		);
		writePlan(tempDir);
		await settleAt(tempDir, TASK_ID, 'blocked');
		writeCommittedWal(tempDir, TASK_ID, true);
		await writeGreenBundles(tempDir);
		const wired = await sessionAt(tempDir, 'sess-3043-reg-wired', 'blocked');
		const unwired = await sessionAt(tempDir, 'sess-3043-reg-bare', 'blocked');

		const report = await COMMAND_REGISTRY.recover.handler({
			directory: tempDir,
			args: [TASK_ID],
			sessionID: 'sess-3043-reg-wired',
		});
		expect(report).toContain('Stage A repaired');
		expect(wired.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');

		// The discriminator: the same command without the session context must
		// NOT refresh — the wiring is what carries the refresh to the session.
		await COMMAND_REGISTRY.recover.handler({
			directory: tempDir,
			args: [TASK_ID],
			sessionID: undefined,
		});
		expect(unwired.taskWorkflowStates.get(TASK_ID)).toBe('blocked');
	});

	it('F-2 skip path: a tests_run view survives a /swarm recover re-run for an already-recovered task', async () => {
		tempDir = makeTempDir('sr-3043-nd-skip-');
		await seedSettlementWedge(tempDir);
		const recoverer = await sessionAt(tempDir, 'sess-3043-nd-a', 'blocked');
		await recoverStageATaskSupervised(tempDir, 'sess-3043-nd-a', {
			taskId: TASK_ID,
			reason: 'test: first recovery',
		});
		expect(recoverer.taskWorkflowStates.get(TASK_ID)).toBe('pre_check_passed');

		// A second session holds a barrier-ahead tests_run view and re-runs
		// /swarm recover; the skip-path refresh must refuse to move it back.
		const holder = await sessionAt(tempDir, 'sess-3043-nd-b', 'tests_run');
		await handleRecover(tempDir, TASK_ID, 'sess-3043-nd-b');
		expect(holder.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
	});

	it('F-2 repaired branch: a tests_run view survives a fresh wedged repair', async () => {
		tempDir = makeTempDir('sr-3043-nd-fix-');
		await seedSettlementWedge(tempDir);
		const holder = await sessionAt(tempDir, 'sess-3043-nd-fix', 'tests_run');

		const { results } = await repairWedgedStageA(tempDir, {
			taskIds: [TASK_ID],
			sessionId: 'sess-3043-nd-fix',
		});
		expect(results[0]?.outcome).toBe('repaired');
		expect(holder.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
		expect((await readTaskEvidence(tempDir, TASK_ID))?.workflow?.state).toBe(
			'pre_check_passed',
		);
	});

	it('F-2 no-op branch: a tests_run view survives an alreadyRecovered re-run', async () => {
		tempDir = makeTempDir('sr-3043-nd-noop-');
		await seedSettlementWedge(tempDir);
		const session = await sessionAt(tempDir, 'sess-3043-nd-noop', 'blocked');
		await recoverStageATaskSupervised(tempDir, 'sess-3043-nd-noop', {
			taskId: TASK_ID,
			reason: 'test: first recovery',
		});
		session.taskWorkflowStates.set(TASK_ID, 'tests_run' as never);

		const summary = await recoverStageATaskSupervised(
			tempDir,
			'sess-3043-nd-noop',
			{
				taskId: TASK_ID,
				reason: 'test: no-op re-run',
			},
		);
		expect(summary.alreadyRecovered).toBe(true);
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
	});

	it('PRR-012a: a skipped_not_wedged outcome outside the recovered band never refreshes', async () => {
		tempDir = makeTempDir('sr-3043-oob-');
		const { writePlan } = await import(
			'../hooks/_stage-b-settlement-2817-helpers.js'
		);
		writePlan(tempDir);
		// Settlement-failed shape: durable rework_required (not in the band).
		await transitionTaskWorkflowEvidence(tempDir, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `seed-coder:${TASK_ID}`,
			context: { settlementFailed: true },
		});
		const holder = await sessionAt(tempDir, 'sess-3043-oob', 'blocked');

		const report = await handleRecover(tempDir, TASK_ID, 'sess-3043-oob');
		expect(report).toContain('rework_required');
		expect((await readTaskEvidence(tempDir, TASK_ID))?.workflow?.state).toBe(
			'rework_required',
		);
		expect(holder.taskWorkflowStates.get(TASK_ID)).toBe('blocked');
	});

	it('PRR-016: tied-rank pairs are never refreshed (strict rank comparison)', () => {
		expect(
			shouldRefreshStageARecoveryView('pre_check_passed', 'pre_check_passed'),
		).toBe(false);
		expect(
			shouldRefreshStageARecoveryView('reviewer_run', 'reviewer_run'),
		).toBe(false);
		expect(shouldRefreshStageARecoveryView('tests_run', 'tests_run')).toBe(
			false,
		);
	});
});

async function handleRecover(
	directory: string,
	taskId: string,
	sessionID: string,
): Promise<string> {
	return COMMAND_REGISTRY.recover.handler({
		directory,
		args: [taskId],
		sessionID,
	});
}
