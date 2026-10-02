/**
 * Issue #2756 regression tests — background Stage B TESTED SKIPPED verdict.
 *
 * `ingestBackgroundStageBCompletion` must classify a `[TESTED] | task-N |
 * SKIPPED | ...` structured verdict as a not-run skip (issue #2756 defect 2,
 * background path): no stage_b_failed transition, no rework_required, reviewer
 * gate proof preserved, and the record consumed with `skipped: true`. The
 * observer-path test additionally proves the completion observer publishes the
 * dedicated skip advisory (not the generic "ingestion failed"). Genuine FAIL
 * verdicts keep the rejection semantics.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBackgroundCompletionObserver } from '../../../src/background/completion-observer';
import {
	type BackgroundWorkspaceSnapshot,
	findByCorrelationId,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import { ingestBackgroundStageBCompletion } from '../../../src/background/stage-b-gates.js';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot.js';
import {
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state.js';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const TASK_ID = '1.1';

let directory = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;

function git(...args: string[]): void {
	const result = spawnSync('git', args, {
		cwd: directory,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 5_000,
		maxBuffer: 64 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function stageBRecord(
	workspace: BackgroundWorkspaceSnapshot,
): import('../../../src/background/pending-delegations.js').BackgroundDelegationRecord {
	return {
		schemaVersion: 2,
		correlationId: 'call-2756-skip:correlation',
		jobId: 'call-2756-skip:job',
		subagentSessionId: 'child-2756-skip',
		parentSessionId: 'parent-2756-skip',
		callID: 'call-2756-skip',
		normalizedAgent: 'test_engineer',
		swarmPrefixedAgent: 'test_engineer',
		planTaskId: TASK_ID,
		evidenceTaskId: TASK_ID,
		status: 'completed',
		createdAt: 1,
		updatedAt: 2,
		completedAt: 2,
		workflowGeneration: 1,
		workspace,
	};
}

/** accepted_mutation (gen 0→1) → stage_a_passed → reviewer proof; state reviewer_run. */
async function prepareTask(): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `coder:${TASK_ID}`,
	});
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'stage_a_passed',
		expectedGeneration: 1,
		transitionId: `stage-a:${TASK_ID}`,
	});
	await recordGateEvidence(
		directory,
		TASK_ID,
		'reviewer',
		'seed-reviewer',
		undefined,
		{
			expectedGeneration: 1,
			transitionId: `seed-reviewer:${TASK_ID}`,
		},
	);
	const session = swarmState.agentSessions.get('parent-2756-skip')!;
	session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
}

async function ingest(text: string) {
	return ingestBackgroundStageBCompletion({
		directory,
		record: stageBRecord(captureWorkspaceSnapshot(directory)),
		result: {
			text,
			chars: text.length,
			truncated: false,
			digest: 'call-2756-skip:digest',
		},
	});
}

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	directory = canonicalMkdtemp('bg-stage-b-skipped-');
	fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	git('init');
	git('config', 'user.email', 'tests@example.com');
	git('config', 'user.name', 'Tests');
	fs.writeFileSync(path.join(directory, 'base.txt'), 'base\n');
	git('add', 'base.txt');
	git('commit', '-m', 'test: issue 2756 fixture');
	startAgentSession('parent-2756-skip', 'architect', directory);
});

afterEach(() => {
	resetSwarmState();
	try {
		fs.rmSync(directory, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	} catch {
		// best-effort cleanup
	}
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

describe('background Stage B TESTED SKIPPED verdict is retryable, not a failure (#2756)', () => {
	test('SKIPPED ingest: no rejection, no state mutation, reviewer proof preserved, skipped flag set', async () => {
		await prepareTask();

		const outcome = await ingest(
			`[TESTED] | task-${TASK_ID} | SKIPPED | PROHIBITED SCOPE: test_runner refuses scope "all" — tests not run`,
		);

		expect(outcome.skipped).toBe(true);
		expect(outcome.consumed).toBe(true);
		expect(outcome.ok).toBe(false);
		expect(outcome.reason ?? '').not.toMatch(/rejected task/);

		const session = swarmState.agentSessions.get('parent-2756-skip')!;
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');

		const evidence = await readTaskEvidence(directory, TASK_ID);
		expect(evidence?.workflow?.state).toBe('reviewer_run');
		expect(evidence?.workflow?.lastOutcome).not.toBe('stage_b_failed');
		expect(evidence?.gates?.reviewer).toBeDefined();
	});

	test('regression: a lower-case skipped verdict is still a skip, not a failure', async () => {
		// Previous code matched the row with the `i` flag but compared the
		// captured word with === 'SKIPPED' / 'PASS' / 'APPROVED', so a
		// lower-case word fell through to the failure branch.
		await prepareTask();

		const outcome = await ingest(
			`[tested] | task-${TASK_ID} | skipped | tests not run`,
		);

		expect(outcome.skipped).toBe(true);
		expect(outcome.consumed).toBe(true);
		const session = swarmState.agentSessions.get('parent-2756-skip')!;
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
		const evidence = await readTaskEvidence(directory, TASK_ID);
		expect(evidence?.workflow?.state).toBe('reviewer_run');
		expect(evidence?.workflow?.lastOutcome).not.toBe('stage_b_failed');
		expect(evidence?.gates?.reviewer).toBeDefined();
	});

	test('regression: a lower-case pass verdict settles the test gate instead of rejecting the task', async () => {
		// Previous code compared the captured word with === 'PASS', so `pass`
		// was read as a failure: stage_b_failed and rework_required.
		await prepareTask();

		const outcome = await ingest(`[tested] | task-${TASK_ID} | pass | 20/20`);

		expect(outcome.ok).toBe(true);
		expect(outcome.consumed).toBe(true);
		const evidence = await readTaskEvidence(directory, TASK_ID);
		expect(evidence?.workflow?.state).toBe('tests_run');
		expect(evidence?.workflow?.lastOutcome).not.toBe('stage_b_failed');
		expect(evidence?.gates?.test_engineer).toBeDefined();
	});

	test('regression: a lower-case approved verdict settles the reviewer gate instead of rejecting the task', async () => {
		// Same comparison as the pass case, exercised through the reviewer role:
		// `approved` used to fall through to the failure branch.
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: `coder:${TASK_ID}`,
		});
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: `stage-a:${TASK_ID}`,
		});
		const session = swarmState.agentSessions.get('parent-2756-skip')!;
		session.taskWorkflowStates.set(TASK_ID, 'pre_check_passed');
		const text = `[reviewed] | task-${TASK_ID} | approved | fine`;

		const outcome = await ingestBackgroundStageBCompletion({
			directory,
			record: {
				...stageBRecord(captureWorkspaceSnapshot(directory)),
				normalizedAgent: 'reviewer',
				swarmPrefixedAgent: 'reviewer',
			},
			result: {
				text,
				chars: text.length,
				truncated: false,
				digest: 'call-2756-skip:digest',
			},
		});

		expect(outcome.ok).toBe(true);
		const evidence = await readTaskEvidence(directory, TASK_ID);
		expect(evidence?.workflow?.state).toBe('reviewer_run');
		expect(evidence?.workflow?.lastOutcome).not.toBe('stage_b_failed');
		expect(evidence?.gates?.reviewer).toBeDefined();
	});

	test('genuine FAIL ingest keeps the rejection semantics', async () => {
		await prepareTask();

		const outcome = await ingest(
			`[TESTED] | task-${TASK_ID} | FAIL | 6/10 tests passed - missing error path tests`,
		);

		expect(outcome.skipped).toBeUndefined();
		expect(outcome.consumed).toBe(true);
		expect(outcome.ok).toBe(false);
		expect(outcome.reason ?? '').toMatch(/rejected task/);

		const session = swarmState.agentSessions.get('parent-2756-skip')!;
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('rework_required');

		const evidence = await readTaskEvidence(directory, TASK_ID);
		expect(evidence?.workflow?.state).toBe('rework_required');
		expect(evidence?.workflow?.lastOutcome).toBe('stage_b_failed');
		expect(evidence?.gates?.reviewer).toBeUndefined();
	});

	test('unparseable output (no structured verdict line) keeps the fail-closed rejection', async () => {
		await prepareTask();

		const outcome = await ingest('VERDICT: unclear, no structured line');

		expect(outcome.skipped).toBeUndefined();
		expect(outcome.ok).toBe(false);
		const session = swarmState.agentSessions.get('parent-2756-skip')!;
		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('rework_required');
	});
});

describe('completion observer publishes the dedicated skip advisory (#2756, PRR-006)', () => {
	const CORRELATION_ID = 'call-2756-skip-obs';
	const PARENT = 'parent-2756-skip';
	const SKIP_TEXT = `[TESTED] | task-${TASK_ID} | SKIPPED | PROHIBITED SCOPE: tests not run`;

	function completedEnvelope(): object {
		return {
			event: {
				type: 'message.part.updated',
				properties: {
					part: {
						type: 'text',
						synthetic: true,
						sessionID: PARENT,
						text: `<task id="${CORRELATION_ID}" state="completed">\n<task_result>${SKIP_TEXT}\n</task_result>\n</task>`,
					},
				},
			},
		};
	}

	test('observer path: skip advisory queued for the session, no stage_b_failed, record consumed', async () => {
		await prepareTask();
		const session = swarmState.agentSessions.get(PARENT)!;
		await recordPendingDelegation(directory, {
			correlationId: CORRELATION_ID,
			jobId: `${CORRELATION_ID}:job`,
			subagentSessionId: CORRELATION_ID,
			parentSessionId: PARENT,
			callID: CORRELATION_ID,
			normalizedAgent: 'test_engineer',
			swarmPrefixedAgent: 'test_engineer',
			planTaskId: TASK_ID,
			evidenceTaskId: TASK_ID,
			workflowGeneration: 1,
			workspace: captureWorkspaceSnapshot(directory),
		});

		const observer = createBackgroundCompletionObserver({
			config: { enabled: true },
			directory,
		});
		await observer.event(completedEnvelope());

		const advisories = session.pendingAdvisoryMessages ?? [];
		expect(
			advisories.some((message) => message.includes('skipped (tests not run)')),
		).toBe(true);
		expect(
			advisories.some((message) => message.includes('ingestion failed')),
		).toBe(false);

		const record = findByCorrelationId(directory, CORRELATION_ID);
		expect(record?.status).not.toBe('stale');

		expect(session.taskWorkflowStates.get(TASK_ID)).toBe('reviewer_run');
		const evidence = await readTaskEvidence(directory, TASK_ID);
		expect(evidence?.workflow?.lastOutcome).not.toBe('stage_b_failed');
		expect(evidence?.gates?.reviewer).toBeDefined();
	});
});
