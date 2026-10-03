/**
 * A session's in-memory workflow view that belongs to an OLDER durable
 * generation (the task was reworked elsewhere) must not wedge Stage B.
 *
 * Upstream's #3032 admission repair never overwrites a view that ranks at or
 * above the durable state. That is right for a view that is legitimately ahead,
 * but a view left over from an older generation is not: the next verdict could
 * advance it to tests_run on a stale completion marker and the missing gate's
 * verdict would then be skipped forever. Admission therefore drops completion
 * markers with no durable gate and repairs an at-or-above, non-terminal view
 * when it is provably from an older generation (a marker was dropped, or the
 * cached generation differs from durable).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
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
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import {
	drainRehydrations,
	fullConfig,
	makeTempDir,
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

async function architect(sessionID: string) {
	startAgentSession(sessionID, 'architect', undefined, tempDir);
	await drainRehydrations();
	return ensureAgentSession(sessionID);
}

function gateHook() {
	const cfg = fullConfig();
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

describe('a session view from an older durable generation does not wedge Stage B', () => {
	/** Durable generation 2 at pre_check_passed with no Stage B gates. */
	async function seedRotatedPreCheck(taskId: string): Promise<void> {
		for (let g = 0; g < 2; g++) {
			await transitionTaskWorkflowEvidence(tempDir, taskId, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: g,
				transitionId: `mut-${taskId}-${g}`,
			});
		}
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: 2,
			transitionId: `stage-a-${taskId}-2`,
		});
	}

	it('a stale reviewer marker and reviewer_run view are repaired, so both verdicts record', async () => {
		// The session believes it ran the reviewer in an older generation; the
		// durable workflow was rotated elsewhere and has no reviewer gate.
		// Before the repair, the test_engineer verdict advanced the view to
		// tests_run on the stale marker and the reviewer verdict was then
		// skipped forever (the #3032 resync never downgrades tests_run).
		const sessionID = 'sess-stale-generation';
		tempDir = makeTempDir('dg-stale-generation-');
		writePlan(tempDir, [TASK]);
		const session = await architect(sessionID);
		await seedRotatedPreCheck(TASK);
		session.taskWorkflowStates.set(TASK, 'reviewer_run');
		session.stageBCompletion = new Map([[TASK, new Set(['reviewer'])]]);
		session.currentTaskId = TASK;

		await dispatch(
			gateHook(),
			sessionID,
			'call-stale-te',
			testEngineerArgsFor(TASK),
			`[TESTED] | task-${TASK} | PASS | 5/5 tests passed`,
		);
		expect(session.taskWorkflowStates.get(TASK)).not.toBe('tests_run');
		expect(session.stageBCompletion?.get(TASK)?.has('reviewer') ?? false).toBe(
			false,
		);

		await dispatch(
			gateHook(),
			sessionID,
			'call-stale-rv',
			reviewerArgsFor(TASK),
			`[REVIEWED] | task-${TASK} | APPROVED | fine`,
		);
		const evidence = await readTaskEvidence(tempDir, TASK);
		expect(Object.keys(evidence?.gates ?? {}).sort()).toEqual([
			'pre_check',
			'reviewer',
			'test_engineer',
		]);
		expect(evidence?.workflow?.state).toBe('tests_run');
	});

	it('a terminal view is never overwritten, even with a stale marker', async () => {
		const sessionID = 'sess-stale-terminal';
		tempDir = makeTempDir('dg-stale-terminal-');
		writePlan(tempDir, [TASK]);
		const session = await architect(sessionID);
		await seedRotatedPreCheck(TASK);
		session.taskWorkflowStates.set(TASK, 'blocked');
		session.stageBCompletion = new Map([[TASK, new Set(['reviewer'])]]);
		session.currentTaskId = TASK;

		await gateHook().toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-stale-terminal' },
			{ args: reviewerArgsFor(TASK) },
		);
		expect(session.taskWorkflowStates.get(TASK)).toBe('blocked');
		// The stale marker is still dropped: that only makes the session stricter.
		expect(session.stageBCompletion?.get(TASK)).toBeUndefined();
	});
});

describe('the cached-generation leg of the stale-view repair', () => {
	async function seedPreCheckAt(generation: number): Promise<void> {
		for (let g = 0; g < generation; g++) {
			await transitionTaskWorkflowEvidence(tempDir, TASK, {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: g,
				transitionId: `mut-${TASK}-${g}`,
			});
		}
		await transitionTaskWorkflowEvidence(tempDir, TASK, {
			type: 'stage_a_passed',
			expectedGeneration: generation,
			transitionId: `stage-a-${TASK}-${generation}`,
		});
	}

	function cacheAt(generation: number) {
		return {
			generation,
			retryCount: 0,
			lastOutcome: 'none' as const,
			lastTransitionId: null,
			updatedAt: '',
		};
	}

	it('repairs a tests_run view with no markers when its cached generation is older than durable', async () => {
		const sessionID = 'sess-cache-generation-older';
		tempDir = makeTempDir('dg-cache-gen-older-');
		writePlan(tempDir, [TASK]);
		const session = await architect(sessionID);
		await seedPreCheckAt(2);
		session.taskWorkflowStates.set(TASK, 'tests_run');
		session.taskWorkflowCache?.set(TASK, cacheAt(1));
		session.currentTaskId = TASK;

		await gateHook().toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-cache-older' },
			{ args: reviewerArgsFor(TASK) },
		);

		expect(session.taskWorkflowStates.get(TASK)).toBe('pre_check_passed');
		expect(session.taskWorkflowCache?.get(TASK)?.generation).toBe(2);
	});

	it('keeps a tests_run view with no markers when its cached generation equals durable (upstream rule)', async () => {
		const sessionID = 'sess-cache-generation-equal';
		tempDir = makeTempDir('dg-cache-gen-equal-');
		writePlan(tempDir, [TASK]);
		const session = await architect(sessionID);
		await seedPreCheckAt(2);
		session.taskWorkflowStates.set(TASK, 'tests_run');
		session.taskWorkflowCache?.set(TASK, cacheAt(2));
		session.currentTaskId = TASK;

		await gateHook().toolBefore(
			{ tool: 'Task', sessionID, callID: 'call-cache-equal' },
			{ args: reviewerArgsFor(TASK) },
		);

		expect(session.taskWorkflowStates.get(TASK)).toBe('tests_run');
	});
});
