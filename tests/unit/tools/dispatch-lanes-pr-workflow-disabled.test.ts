/**
 * pr_workflow.enabled: false — a lane dispatch that would START a PR workflow
 * is refused cleanly. `dispatch_lanes_async` activates the PR_REVIEW gate on
 * the first `swarm-pr-review:` dispatch, so it is an entry point of its own.
 *
 * Kept apart from dispatch-lanes-pr-workflow-gate.test.ts for the FR-006
 * 500-line cap; the fixtures are the ones that suite uses.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
	_test_exports as gateInternals,
	PR_REVIEW_BASE_DIMENSION_IDS,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	PR_WORKFLOW_DISABLED_MESSAGE,
	recordPrWorkflowStartupState,
	resetPrWorkflowStartupState,
} from '../../../src/pr-review/enablement';
import {
	_internals as dispatchInternals,
	executeDispatchLanesAsync,
} from '../../../src/tools/dispatch-lanes.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { initializeGitRepository } from '../helpers/git-repository.js';
import {
	installLegacyPrReviewPolicy,
	restorePrReviewPolicy,
} from './dispatch-lanes-pr-workflow-gate.test-fixtures.js';

let directory = '';
const createSession = mock(async () => ({ data: { id: 'lane-session' } }));
const original = {
	getSessionOps: dispatchInternals.getSessionOps,
	resolveRevision: dispatchInternals.resolvePrWorkflowRevisionDigest,
	resolveRevisionAsync: dispatchInternals.resolvePrWorkflowRevisionDigestAsync,
	resolveMergeBase: dispatchInternals.resolveExactMergeBase,
	resolveMergeBaseAsync: dispatchInternals.resolveExactMergeBaseAsync,
	resolveHead: gateInternals.resolveCurrentGitHead,
	resolveHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	resolveClean: gateInternals.resolveIsWorkingTreeClean,
	resolveCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
	resolveDiffStats: gateInternals.resolvePrReviewDiffStats,
	resolveDiffStatsAsync: gateInternals.resolvePrReviewDiffStatsAsync,
};

beforeEach(async () => {
	directory = canonicalMkdtemp('dispatch-pr-disabled-');
	await initializeGitRepository(directory);
	createSession.mockClear();
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
	gateInternals.resolvePrReviewDiffStats = () => ({
		changedLines: 12,
		changedFiles: 2,
		hasSubmoduleChange: false,
	});
	gateInternals.resolvePrReviewDiffStatsAsync = async (...args) =>
		gateInternals.resolvePrReviewDiffStats(...args);
	dispatchInternals.resolvePrWorkflowRevisionDigest = () => 'revision-1';
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync = async () =>
		'revision-1';
	dispatchInternals.resolveExactMergeBase = () => 'def456';
	dispatchInternals.resolveExactMergeBaseAsync = async () => 'def456';
	installLegacyPrReviewPolicy();
	let created = 0;
	createSession.mockImplementation(async () => {
		created += 1;
		return { data: { id: `lane-session-${created}` } };
	});
	dispatchInternals.getSessionOps = () => ({
		create: createSession,
		promptAsync: mock(async () => ({ data: undefined, error: undefined })),
		delete: mock(async () => undefined),
	});
});

afterEach(() => {
	resetPrWorkflowStartupState();
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = original.resolveHead;
	gateInternals.resolveCurrentGitHeadAsync = original.resolveHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = original.resolveClean;
	gateInternals.resolveIsWorkingTreeCleanAsync = original.resolveCleanAsync;
	gateInternals.resolvePrReviewDiffStats = original.resolveDiffStats;
	gateInternals.resolvePrReviewDiffStatsAsync = original.resolveDiffStatsAsync;
	dispatchInternals.resolvePrWorkflowRevisionDigest = original.resolveRevision;
	dispatchInternals.resolvePrWorkflowRevisionDigestAsync =
		original.resolveRevisionAsync;
	dispatchInternals.resolveExactMergeBase = original.resolveMergeBase;
	dispatchInternals.resolveExactMergeBaseAsync = original.resolveMergeBaseAsync;
	restorePrReviewPolicy();
	dispatchInternals.getSessionOps = original.getSessionOps;
	safeRmRecursive(directory);
});

/** A base wave the gate accepts at depth tier S (two consolidated lanes). */
function dispatchBaseWave(sessionID: string) {
	const lane = (id: string, owned: readonly string[]) => ({
		id,
		agent: 'explorer',
		prompt: `Inspect ${id}`,
		workflow_lane: owned[0],
		owned_workflow_lanes: [...owned],
	});
	return executeDispatchLanesAsync(
		{
			mode: 'swarm-pr-review:base',
			pr_head_sha: 'abc123',
			base_sha: 'def456',
			base_ref: 'origin/main',
			max_concurrent: 2,
			lanes: [
				lane('sweep-a', PR_REVIEW_BASE_DIMENSION_IDS.slice(0, 3)),
				lane('sweep-b', PR_REVIEW_BASE_DIMENSION_IDS.slice(3)),
			],
		},
		directory,
		{ sessionID },
	);
}

describe('dispatch_lanes_async with PR workflows disabled', () => {
	test('enabled: the base wave is dispatched and activates the PR_REVIEW gate', async () => {
		const result = await dispatchBaseWave('enabled-session');

		expect(result.success).toBe(true);
		expect(result.pending).toBe(2);
		expect(
			(await readPrWorkflowGateState(directory, 'enabled-session'))?.mode,
		).toBe('PR_REVIEW');
	});

	test('disabled: the same dispatch is refused with the explanation, starts no lane and writes no gate', async () => {
		recordPrWorkflowStartupState(directory, {
			pr_workflow: { enabled: false },
		});

		const result = await dispatchBaseWave('disabled-session');

		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).toContain(
			`BLOCKED: ${PR_WORKFLOW_DISABLED_MESSAGE}`,
		);
		expect(createSession).not.toHaveBeenCalled();
		expect(
			await readPrWorkflowGateState(directory, 'disabled-session'),
		).toBeNull();
	});
});
