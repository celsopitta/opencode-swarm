/**
 * pr_workflow.enabled — what the flag means, and that a disabled PR workflow
 * cannot be started through the commands or the gate.
 *
 * The flag is a startup-time value: plugin init records it per project root
 * and the runtime checks answer from that record. These tests record it
 * directly, so none of them reads the machine's own opencode-swarm.json.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { isPrFeedbackLoopEnabled } from '../../../src/background/pr-feedback-loop-runtime';
import { COMMAND_REGISTRY } from '../../../src/commands/registry';
import { PR_WORKFLOW_TOOL_NAMES } from '../../../src/config/constants';
import {
	PluginConfigSchema,
	PrMonitorConfigSchema,
} from '../../../src/config/schema';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	activatePrWorkflow,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	isPrWorkflowEnabled,
	isPrWorkflowEnabledForDirectory,
	PR_WORKFLOW_DISABLED_MESSAGE,
	recordPrWorkflowStartupState,
	resetPrWorkflowStartupState,
	resolvePrMonitorConfigForPrWorkflow,
} from '../../../src/pr-review/enablement';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const DISABLED = PluginConfigSchema.parse({ pr_workflow: { enabled: false } });
const ENABLED = PluginConfigSchema.parse({});

afterEach(() => {
	resetPrWorkflowStartupState();
});

describe('PR_WORKFLOW_TOOL_NAMES', () => {
	test('is exactly the ten PR-only tools; the checkout tool that also restores work is not one of them', () => {
		expect([...PR_WORKFLOW_TOOL_NAMES]).toEqual([
			'abort_pr_workflow',
			'authorize_pr_review_reentry',
			'complete_pr_workflow',
			'invalidate_pr_feedback_publication',
			'pr_workflow_status',
			'prepare_pr_feedback_scope',
			'rebind_pr_feedback_head',
			'run_pr_feedback_stage_a',
			'write_pr_review_artifact',
			'write_pr_review_trigger_eval',
		]);
	});
});

describe('PR_WORKFLOW_DISABLED_MESSAGE', () => {
	test('names the setting, the restart, and the commands it affects', () => {
		for (const fragment of [
			'`pr_workflow.enabled`',
			'when OpenCode started',
			'restart OpenCode',
			'/swarm pr-review',
			'/swarm pr-feedback',
			'/swarm ci-monitor',
		]) {
			expect(PR_WORKFLOW_DISABLED_MESSAGE).toContain(fragment);
		}
	});
});

describe('isPrWorkflowEnabled', () => {
	test('is on unless the config explicitly turns it off', () => {
		expect(isPrWorkflowEnabled(undefined)).toBe(true);
		expect(isPrWorkflowEnabled(PluginConfigSchema.parse({}))).toBe(true);
		expect(
			isPrWorkflowEnabled(PluginConfigSchema.parse({ pr_workflow: {} })),
		).toBe(true);
		expect(
			isPrWorkflowEnabled(
				PluginConfigSchema.parse({ pr_workflow: { enabled: true } }),
			),
		).toBe(true);
		expect(
			isPrWorkflowEnabled(
				PluginConfigSchema.parse({ pr_workflow: { enabled: false } }),
			),
		).toBe(false);
	});
});

describe('isPrWorkflowEnabledForDirectory', () => {
	let root = '';
	let cleanup: () => void = () => {};

	beforeEach(() => {
		const created = createSafeTestDir('pr-workflow-roots-');
		root = created.dir;
		cleanup = created.cleanup;
		mkdirSync(path.join(root, 'project', 'packages', 'app'), {
			recursive: true,
		});
		mkdirSync(path.join(root, 'project-two'), { recursive: true });
	});

	afterEach(() => {
		cleanup();
	});

	test('a directory under no recorded root has the default (enabled)', () => {
		expect(isPrWorkflowEnabledForDirectory(path.join(root, 'project'))).toBe(
			true,
		);
	});

	test('answers from the value recorded at startup for the root and everything under it', () => {
		const project = path.join(root, 'project');
		recordPrWorkflowStartupState(project, DISABLED);

		expect(isPrWorkflowEnabledForDirectory(project)).toBe(false);
		expect(
			isPrWorkflowEnabledForDirectory(path.join(project, 'packages', 'app')),
		).toBe(false);
		// A sibling whose name merely starts with the root's name is not inside it.
		expect(
			isPrWorkflowEnabledForDirectory(path.join(root, 'project-two')),
		).toBe(true);
		expect(isPrWorkflowEnabledForDirectory(root)).toBe(true);
	});

	test('the most specific recorded root decides', () => {
		const project = path.join(root, 'project');
		const nested = path.join(project, 'packages', 'app');
		recordPrWorkflowStartupState(project, DISABLED);
		recordPrWorkflowStartupState(nested, ENABLED);

		expect(isPrWorkflowEnabledForDirectory(nested)).toBe(true);
		expect(
			isPrWorkflowEnabledForDirectory(path.join(project, 'packages')),
		).toBe(false);

		recordPrWorkflowStartupState(project, ENABLED);
		recordPrWorkflowStartupState(nested, DISABLED);
		expect(isPrWorkflowEnabledForDirectory(nested)).toBe(false);
		expect(isPrWorkflowEnabledForDirectory(project)).toBe(true);
	});

	test('a later startup of the same root replaces its record; reset forgets it', () => {
		const project = path.join(root, 'project');
		recordPrWorkflowStartupState(project, DISABLED);
		recordPrWorkflowStartupState(project, ENABLED);
		expect(isPrWorkflowEnabledForDirectory(project)).toBe(true);

		recordPrWorkflowStartupState(project, DISABLED);
		expect(isPrWorkflowEnabledForDirectory(project)).toBe(false);
		resetPrWorkflowStartupState();
		expect(isPrWorkflowEnabledForDirectory(project)).toBe(true);
	});

	test('a non-canonical spelling of a directory resolves to the same root', () => {
		const project = path.join(root, 'project');
		recordPrWorkflowStartupState(
			path.join(project, 'packages', '..'),
			DISABLED,
		);

		expect(
			isPrWorkflowEnabledForDirectory(
				`${path.join(project, 'packages', 'app', '..')}${path.sep}`,
			),
		).toBe(false);
	});

	test.skipIf(process.platform === 'win32')(
		'a symlink to the project and the project itself are the same root',
		() => {
			const project = path.join(root, 'project');
			const alias = path.join(root, 'alias');
			symlinkSync(project, alias, 'dir');

			recordPrWorkflowStartupState(alias, DISABLED);
			expect(isPrWorkflowEnabledForDirectory(project)).toBe(false);

			resetPrWorkflowStartupState();
			recordPrWorkflowStartupState(project, DISABLED);
			expect(
				isPrWorkflowEnabledForDirectory(path.join(alias, 'packages')),
			).toBe(false);
		},
	);
});

describe('resolvePrMonitorConfigForPrWorkflow', () => {
	const autoFeedbackOn = PrMonitorConfigSchema.parse({
		enabled: true,
		auto_pr_feedback: true,
	});
	const autoFeedbackOff = PrMonitorConfigSchema.parse({ enabled: true });

	test('leaves the monitor config untouched while PR workflows are enabled', () => {
		const resolved = resolvePrMonitorConfigForPrWorkflow(
			autoFeedbackOn,
			PluginConfigSchema.parse({}),
		);

		expect(resolved.config).toBe(autoFeedbackOn);
		expect(resolved.autoFeedbackSuppressed).toBe(false);
	});

	test('switches automatic PR feedback off when PR workflows are disabled, and says so', () => {
		const resolved = resolvePrMonitorConfigForPrWorkflow(
			autoFeedbackOn,
			PluginConfigSchema.parse({ pr_workflow: { enabled: false } }),
		);

		expect(resolved.autoFeedbackSuppressed).toBe(true);
		expect(resolved.config).toEqual({
			...autoFeedbackOn,
			auto_pr_feedback: false,
		});
		// Notifications themselves stay on, and the input is not mutated.
		expect(resolved.config.enabled).toBe(true);
		expect(autoFeedbackOn.auto_pr_feedback).toBe(true);
	});

	test('reports nothing suppressed when automatic feedback was already off', () => {
		const resolved = resolvePrMonitorConfigForPrWorkflow(
			autoFeedbackOff,
			PluginConfigSchema.parse({ pr_workflow: { enabled: false } }),
		);

		expect(resolved.config).toBe(autoFeedbackOff);
		expect(resolved.autoFeedbackSuppressed).toBe(false);
	});
});

describe('isPrFeedbackLoopEnabled', () => {
	const tripleOptIn = {
		pr_monitor: { enabled: true, auto_pr_feedback: true },
		pr_feedback_loop: { enabled: true },
	};

	test('the triple opt-in still enables the loop by default', () => {
		expect(isPrFeedbackLoopEnabled(PluginConfigSchema.parse(tripleOptIn))).toBe(
			true,
		);
	});

	test('the loop is off when PR workflows are disabled', () => {
		expect(
			isPrFeedbackLoopEnabled(
				PluginConfigSchema.parse({
					...tripleOptIn,
					pr_workflow: { enabled: false },
				}),
			),
		).toBe(false);
	});
});

describe('a disabled PR workflow cannot be started', () => {
	let directory = '';
	let cleanup: () => void = () => {};
	const originalResolveCurrentGitHead = gateInternals.resolveCurrentGitHead;
	const originalResolveIsWorkingTreeClean =
		gateInternals.resolveIsWorkingTreeClean;
	const originalGetSessionOps = gateInternals.getSessionOps;
	const PR_URL = 'https://github.com/example/repo/pull/42';

	beforeEach(() => {
		const created = createSafeTestDir('pr-workflow-flag-');
		directory = created.dir;
		cleanup = created.cleanup;
		mkdirSync(path.join(directory, '.git'), { recursive: true });
		gateInternals.resetTrackedStateCache();
		gateInternals.resolveCurrentGitHead = () => 'abc123';
		gateInternals.resolveIsWorkingTreeClean = () => true;
		gateInternals.getSessionOps = () => null;
	});

	afterEach(() => {
		gateInternals.resetTrackedStateCache();
		gateInternals.resolveCurrentGitHead = originalResolveCurrentGitHead;
		gateInternals.resolveIsWorkingTreeClean = originalResolveIsWorkingTreeClean;
		gateInternals.getSessionOps = originalGetSessionOps;
		closeAllProjectDbs();
		cleanup();
	});

	function commandContext(args: string[], sessionID: string) {
		return { directory, args, sessionID, agents: {} };
	}

	test.each([
		'PR_REVIEW',
		'PR_FEEDBACK',
	] as const)('activatePrWorkflow refuses %s and writes no gate state', async (mode) => {
		recordPrWorkflowStartupState(directory, DISABLED);

		await expect(
			activatePrWorkflow(directory, 'session-off', mode),
		).rejects.toThrow(`BLOCKED: ${PR_WORKFLOW_DISABLED_MESSAGE}`);
		expect(await readPrWorkflowGateState(directory, 'session-off')).toBeNull();
	});

	test('activatePrWorkflow still activates when the flag is on', async () => {
		recordPrWorkflowStartupState(directory, ENABLED);

		const state = await activatePrWorkflow(
			directory,
			'session-on',
			'PR_REVIEW',
		);

		expect(state.mode).toBe('PR_REVIEW');
		expect((await readPrWorkflowGateState(directory, 'session-on'))?.mode).toBe(
			'PR_REVIEW',
		);
	});

	test.each([
		['pr-review', [PR_URL]],
		['pr-feedback', [PR_URL]],
		['ci-monitor', [PR_URL]],
	] as const)('/swarm %s fails with the explanation instead of emitting a MODE signal', async (command, args) => {
		recordPrWorkflowStartupState(directory, DISABLED);
		const sessionID = `session-${command}`;

		const result = await COMMAND_REGISTRY[command].handler(
			commandContext([...args], sessionID),
		);

		expect(result).toEqual({
			ok: false,
			text: `Error: ${PR_WORKFLOW_DISABLED_MESSAGE}`,
		});
		expect(await readPrWorkflowGateState(directory, sessionID)).toBeNull();
	});

	test('/swarm ci-monitor emits its MODE signal when the flag is on', async () => {
		recordPrWorkflowStartupState(directory, ENABLED);

		const result = await COMMAND_REGISTRY['ci-monitor'].handler(
			commandContext([PR_URL], 'session-ci'),
		);

		expect(result).toBe(`[MODE: CI_MONITOR pr="${PR_URL}"]`);
	});

	test('regression: editing the config after startup does not change the answer until a restart', async () => {
		// Previous code re-read opencode-swarm.json in the commands and the
		// gate. Tool lists and the architect prompt are fixed at startup, so
		// switching the file to enabled:true let /swarm pr-review activate a
		// workflow whose mode section and tools the running architect lacked.
		recordPrWorkflowStartupState(directory, DISABLED);
		mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ pr_workflow: { enabled: true } }),
		);

		const result = await COMMAND_REGISTRY['pr-review'].handler(
			commandContext([PR_URL], 'session-flip'),
		);

		expect(result).toEqual({
			ok: false,
			text: `Error: ${PR_WORKFLOW_DISABLED_MESSAGE}`,
		});
		await expect(
			activatePrWorkflow(directory, 'session-flip', 'PR_REVIEW'),
		).rejects.toThrow('BLOCKED: PR workflows are disabled');
		expect(await readPrWorkflowGateState(directory, 'session-flip')).toBeNull();
	});
});
