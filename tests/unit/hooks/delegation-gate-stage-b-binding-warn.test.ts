/**
 * The always-on "Stage B durable binding write FAILED" warning must mean a
 * write failed. A gate-agent dispatch that carries no task binding (a plan
 * critic, a sounding-board consultation) has nothing to persist: it must not
 * touch the durable store and must not raise the warning. A dispatch that
 * does carry a binding keeps the warning when the write genuinely fails.
 *
 * Observed live: every task-free critic dispatch painted the CRITICAL-WARN
 * line over the host TUI although nothing had failed.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readStageBDispatchBindings } from '../../../src/background/stage-b-dispatch-binding-store';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';
import * as logger from '../../../src/utils/logger';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import {
	drainRehydrations,
	fullConfig,
	makeTempDir,
	seedReviewerApproved,
	TASK_ID,
	testEngineerArgs,
	writePlan,
} from './_stage-b-settlement-2817-helpers.js';

const WARNING = 'Stage B durable binding write FAILED';
const STORE_DIR = 'stage-b-dispatch-bindings';

let tempDir = '';
let isolatedEnv: ReturnType<typeof createIsolatedTestEnv> | undefined;
let criticalWarnSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
	isolatedEnv = createIsolatedTestEnv();
	resetSwarmState();
	criticalWarnSpy = spyOn(logger, 'criticalWarn').mockImplementation(() => {});
});

afterEach(() => {
	criticalWarnSpy?.mockRestore();
	criticalWarnSpy = undefined;
	resetSwarmState();
	try {
		if (tempDir) safeRmRecursive(tempDir);
	} catch {
		// best-effort cleanup (temp dir only)
	}
	tempDir = '';
	isolatedEnv?.cleanup();
	isolatedEnv = undefined;
});

function bindingWarnings(): string[] {
	return (criticalWarnSpy?.mock.calls ?? [])
		.map((call) => String(call[0]))
		.filter((line) => line.includes(WARNING));
}

function storeEntries(): string[] {
	const root = path.join(tempDir, '.swarm', STORE_DIR);
	if (!fs.existsSync(root)) return [];
	return fs.readdirSync(root, { recursive: true }).map(String);
}

function durableConfig(): ReturnType<typeof fullConfig> {
	const cfg = fullConfig();
	cfg.review_routing = { enforce_receipts: false };
	return cfg;
}

describe('Stage B durable binding warning — regression: an empty binding list was reported as a failed write (live run 2026-10-02)', () => {
	// Previous code passed every dispatch to the durable store. The store
	// returns `false` for an empty binding list before writing anything, and
	// the caller reported every `false` as "write FAILED" on the always-on
	// channel, so each task-free critic dispatch raised a critical warning.
	for (const agent of ['critic', 'critic_sounding_board']) {
		it(`a task-free ${agent} dispatch raises no warning and writes no record`, async () => {
			const sessionID = `sess-binding-warn-${agent}`;
			tempDir = makeTempDir('dg-binding-warn-free-');
			writePlan(tempDir);
			startAgentSession(sessionID, 'architect', tempDir);
			await drainRehydrations();

			const hook = createDelegationGateHook(durableConfig(), tempDir);
			await hook.toolBefore(
				{ tool: 'Task', sessionID, callID: `call-free-${agent}` },
				{
					args: {
						subagent_type: agent,
						description: 'Review the plan',
						prompt: 'Review the implementation plan for completeness.',
					},
				},
			);

			expect(bindingWarnings()).toEqual([]);
			expect(storeEntries()).toEqual([]);
		});
	}

	it('a dispatch with a binding persists it and raises no warning', async () => {
		const sessionID = 'sess-binding-warn-ok';
		const callID = 'call-binding-warn-ok';
		tempDir = makeTempDir('dg-binding-warn-ok-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'warn-ok');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;

		const hook = createDelegationGateHook(durableConfig(), tempDir);
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{ args: testEngineerArgs() },
		);

		expect(bindingWarnings()).toEqual([]);
		const record = readStageBDispatchBindings(tempDir, sessionID, callID);
		expect(record?.bindings.map((b) => b.taskId)).toEqual([TASK_ID]);
	});

	it('a dispatch with a binding still warns when the write fails, and still proceeds', async () => {
		const sessionID = 'sess-binding-warn-fail';
		const callID = 'call-binding-warn-fail';
		tempDir = makeTempDir('dg-binding-warn-fail-');
		startAgentSession(sessionID, 'architect', tempDir);
		await drainRehydrations();
		await seedReviewerApproved(tempDir, 'warn-fail');
		const session = ensureAgentSession(sessionID);
		session.taskWorkflowStates.set(TASK_ID, 'reviewer_run');
		session.currentTaskId = TASK_ID;
		// A regular file where the store directory must be created makes the
		// real write fail on every platform.
		fs.writeFileSync(path.join(tempDir, '.swarm', STORE_DIR), 'not a dir');

		const hook = createDelegationGateHook(durableConfig(), tempDir);
		await hook.toolBefore(
			{ tool: 'Task', sessionID, callID },
			{ args: testEngineerArgs() },
		);

		const warnings = bindingWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(callID);
		expect(readStageBDispatchBindings(tempDir, sessionID, callID)).toBeNull();
	});
});
