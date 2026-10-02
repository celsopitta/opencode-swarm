import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { PluginConfig } from '../../../src/config';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
} from '../../../src/hooks/pr-workflow-gate';
import {
	issuePrReviewReentryAuthorization,
	_internals as reentryInternals,
} from '../../../src/pr-review/authorization';
import {
	recordPrWorkflowStartupState,
	resetPrWorkflowStartupState,
} from '../../../src/pr-review/enablement';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import {
	PR_ARTIFACT_HEAD_SHA,
	PR_ARTIFACT_REVISION_DIGEST,
	PR_ARTIFACT_SESSION_ID,
} from '../../helpers/pr-review-artifact-fixtures';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const config = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
} as PluginConfig;

let tmpDir = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
const originalResolveCurrentGitHeadAsync =
	gateInternals.resolveCurrentGitHeadAsync;
const originalResolveRevisionDigest =
	gateInternals.resolvePrWorkflowRevisionDigest;

beforeEach(async () => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	gateInternals.resetTrackedStateCache();
	tmpDir = canonicalMkdtemp('dg-reentry-test-');
	await fs.mkdir(`${tmpDir}/.swarm`, { recursive: true });
	await fs.mkdir(`${tmpDir}/.opencode`, { recursive: true });
	gateInternals.resolveCurrentGitHeadAsync = async () => PR_ARTIFACT_HEAD_SHA;
	gateInternals.resolvePrWorkflowRevisionDigest = () =>
		PR_ARTIFACT_REVISION_DIGEST;
});

afterEach(async () => {
	resetSwarmState();
	resetPrWorkflowStartupState();
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHeadAsync = originalResolveCurrentGitHeadAsync;
	gateInternals.resolvePrWorkflowRevisionDigest = originalResolveRevisionDigest;
	closeAllProjectDbs();
	await fs.rm(tmpDir, { recursive: true, force: true });
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

/** Task evidence at a pre-Stage-A state, so reviewer dispatch needs a bypass. */
async function seedPreStageATask(taskId: string): Promise<void> {
	await transitionTaskWorkflowEvidence(tmpDir, taskId, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: `seed-coder:${taskId}`,
	});
}

async function dispatchReviewer(callID: string): Promise<void> {
	const hook = createDelegationGateHook(config, tmpDir);
	await hook.toolBefore(
		{ tool: 'Task', sessionID: PR_ARTIFACT_SESSION_ID, callID },
		{
			args: {
				subagent_type: 'reviewer',
				task_id: '1.1',
				prompt:
					'TASK: 1.1\nACCEPTANCE: Verify the exact task and report a bound positive verdict.',
			},
		},
	);
}

describe('delegation gate PR-review re-entry bypass (issue #2383)', () => {
	test('without an authorization, the generic Stage-A requirement still throws', async () => {
		await seedPreStageATask('1.1');
		await expect(dispatchReviewer('call-plain')).rejects.toThrow(
			/TASK_WORKFLOW_STAGE_A_REQUIRED/,
		);
	});

	test('the Stage-A error points at the re-entry tool only while PR workflows are enabled', async () => {
		const hint = 'authorize_pr_review_reentry';
		await seedPreStageATask('1.1');

		await expect(dispatchReviewer('call-hint-on')).rejects.toThrow(hint);

		// pr_workflow.enabled: false denies that tool, so the hint is dropped
		// while the error itself still fires.
		recordPrWorkflowStartupState(tmpDir, { pr_workflow: { enabled: false } });
		const error = await dispatchReviewer('call-hint-off').then(
			() => null,
			(thrown: unknown) => thrown as Error,
		);
		expect(error?.message).toContain('TASK_WORKFLOW_STAGE_A_REQUIRED');
		expect(error?.message).not.toContain(hint);
	});

	test('an ordinary session with no PR_REVIEW gate is unchanged (no bypass)', async () => {
		await seedPreStageATask('1.1');
		await expect(dispatchReviewer('call-no-gate')).rejects.toThrow(
			/TASK_WORKFLOW_STAGE_A_REQUIRED/,
		);
	});

	test('a consumed one-use authorization bypasses ONLY the Stage-A throw', async () => {
		await seedPreStageATask('1.1');
		await activatePrWorkflow(tmpDir, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		const record = await issuePrReviewReentryAuthorization(
			tmpDir,
			PR_ARTIFACT_SESSION_ID,
			{ prHeadSha: PR_ARTIFACT_HEAD_SHA, role: 'reviewer' },
		);
		expect(record.role).toBe('reviewer');
		// The dispatch passes (no throw) and the authorization is consumed.
		await dispatchReviewer('call-authorized');
		const store = JSON.parse(
			readFileSync(
				reentryInternals.reentryAuthorizationFilePath(
					tmpDir,
					PR_ARTIFACT_SESSION_ID,
				),
				'utf8',
			),
		).authorizations as Array<{ consumedAt?: string }>;
		expect(store.some((entry) => entry.consumedAt)).toBe(true);
	});

	test('an authorized re-entry reply without a Stage B row is not reported as a dropped settlement', async () => {
		// The re-entry dispatch carries a task id but binds no task for Stage B
		// settlement, so no row could settle there and a missing row is not a
		// drop. Reporting it would tell the architect to re-dispatch a gate
		// that cannot be re-dispatched without a fresh authorization.
		await seedPreStageATask('1.1');
		await activatePrWorkflow(tmpDir, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		await issuePrReviewReentryAuthorization(tmpDir, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		const hook = createDelegationGateHook(config, tmpDir);
		const args = {
			subagent_type: 'reviewer',
			task_id: '1.1',
			prompt:
				'TASK: 1.1\nACCEPTANCE: Verify the exact task and report a bound positive verdict.',
		};
		const call = {
			tool: 'Task',
			sessionID: PR_ARTIFACT_SESSION_ID,
			callID: 'call-reentry-no-row',
		};
		await hook.toolBefore(call, { args });
		await hook.toolAfter(
			{ ...call, args },
			{ output: 'VERDICT: APPROVED\nNo structured Stage B row here.' },
		);

		const dropped = (
			ensureAgentSession(PR_ARTIFACT_SESSION_ID).pendingAdvisoryMessages ?? []
		).filter((m) => m.includes('STAGE B SETTLEMENT DROPPED'));
		expect(dropped).toEqual([]);
	});

	test('the bypass is one-use: a second dispatch hits Stage-A again', async () => {
		await seedPreStageATask('1.1');
		await activatePrWorkflow(tmpDir, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		await issuePrReviewReentryAuthorization(tmpDir, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'reviewer',
		});
		await dispatchReviewer('call-first');
		await expect(dispatchReviewer('call-second')).rejects.toThrow(
			/TASK_WORKFLOW_STAGE_A_REQUIRED/,
		);
	});

	test('a wrong-role authorization does not bypass a reviewer dispatch', async () => {
		await seedPreStageATask('1.1');
		await activatePrWorkflow(tmpDir, PR_ARTIFACT_SESSION_ID, 'PR_REVIEW', {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
		});
		await issuePrReviewReentryAuthorization(tmpDir, PR_ARTIFACT_SESSION_ID, {
			prHeadSha: PR_ARTIFACT_HEAD_SHA,
			role: 'test_engineer',
		});
		await expect(dispatchReviewer('call-wrong-role')).rejects.toThrow(
			/TASK_WORKFLOW_STAGE_A_REQUIRED/,
		);
	});
});
