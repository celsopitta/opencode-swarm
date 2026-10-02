/**
 * pr_workflow.enabled through the REAL plugin: boots `src/index.ts` against a
 * project config and reads the agents it hands the host, so the flag is proven
 * wired from config file to prompt, permissions and startup advisories — not
 * only inside the helpers the unit tests call directly.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getGlobalEventBus } from '../../src/background/event-bus';
import { _internals as prEventInternals } from '../../src/background/pr-event-subscribers';
import { COMMAND_REGISTRY } from '../../src/commands/registry';
import { PR_WORKFLOW_TOOL_NAMES } from '../../src/config/constants';
import type { PrMonitorConfig } from '../../src/config/schema';
import OpenCodeSwarmPlugin from '../../src/index';
import {
	isPrWorkflowEnabledForDirectory,
	PR_WORKFLOW_DISABLED_MESSAGE,
	resetPrWorkflowStartupState,
} from '../../src/pr-review/enablement';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../src/services/warning-buffer';
import { resetSwarmState } from '../../src/state';
import { createIsolatedTestEnv } from '../helpers/isolated-test-env';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../helpers/knowledge-real-host';
import { safeRmRecursive } from '../helpers/safe-test-dir';

type HostAgent = { prompt?: string; permission?: Record<string, unknown> };

const SUPPRESSED = 'pr_monitor.auto_pr_feedback is ignored';

async function bootArchitect(
	directory: string,
	overrides: Record<string, unknown>,
): Promise<HostAgent> {
	const plugin = await bootKnowledgeHost(directory, {
		knowledge: { enabled: false },
		default_agent: 'architect',
		...overrides,
	});
	const hostConfig: { agent?: Record<string, HostAgent> } = {};
	await plugin.hooks.config(hostConfig);
	const architect = hostConfig.agent?.architect;
	expect(architect).toBeDefined();
	return architect as HostAgent;
}

describe('pr_workflow.enabled through the real plugin', () => {
	let directory = '';
	const realHandlePrEvent = prEventInternals.handlePrEvent;

	/**
	 * Publishes a PR event on the real bus and returns the monitor config the
	 * plugin's own subscriber was registered with (captured at the
	 * `handlePrEvent` seam, so nothing is delivered anywhere).
	 */
	async function monitorConfigSeenBySubscriber(): Promise<PrMonitorConfig[]> {
		const seen: PrMonitorConfig[] = [];
		prEventInternals.handlePrEvent = async (_event, eventDirectory, config) => {
			if (eventDirectory === directory) seen.push(config);
		};
		await getGlobalEventBus().publish('pr.ci.failed', {
			prNumber: 42,
			repoFullName: 'example/repo',
			prUrl: 'https://github.com/example/repo/pull/42',
		});
		return seen;
	}

	beforeEach(() => {
		resetSwarmState();
		clearDeferredWarnings();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		prEventInternals.handlePrEvent = realHandlePrEvent;
		resetPrWorkflowStartupState();
		resetSwarmState();
		clearDeferredWarnings();
		try {
			safeRmRecursive(directory);
		} catch {
			// Background workers can retain Windows handles briefly; the temp root is
			// OS-reclaimed and cleanup is not part of the behavioral assertion.
		}
	});

	test('default config: the architect has the PR modes and tools, and nothing is suppressed', async () => {
		const architect = await bootArchitect(directory, {
			pr_monitor: { enabled: true, auto_pr_feedback: true },
		});

		expect(architect.prompt).toContain('### MODE: PR_REVIEW');
		expect(architect.prompt).toContain('### MODE: PR_FEEDBACK');
		expect(architect.prompt).toContain('### MODE: CI_MONITOR');
		for (const tool of PR_WORKFLOW_TOOL_NAMES) {
			expect(architect.permission?.[tool], tool).toBeUndefined();
		}
		expect(
			getDeferredWarnings().some((warning) => warning.includes(SUPPRESSED)),
		).toBe(false);
		// The monitor's subscriber runs with automatic PR feedback as configured.
		const seen = await monitorConfigSeenBySubscriber();
		expect(seen).toHaveLength(1);
		expect(seen[0].auto_pr_feedback).toBe(true);
	});

	test('enabled: false removes the PR modes and tools and reports the ignored auto feedback', async () => {
		const architect = await bootArchitect(directory, {
			pr_workflow: { enabled: false },
			pr_monitor: { enabled: true, auto_pr_feedback: true },
		});

		expect(architect.prompt).not.toContain('### MODE: PR_REVIEW');
		expect(architect.prompt).not.toContain('### MODE: PR_FEEDBACK');
		expect(architect.prompt).not.toContain('### MODE: CI_MONITOR');
		expect(architect.prompt).toContain('### MODE: ISSUE_INGEST');
		for (const tool of PR_WORKFLOW_TOOL_NAMES) {
			expect(architect.permission?.[tool], tool).toBe('deny');
			expect(architect.prompt?.includes(tool), tool).toBe(false);
		}
		expect(
			getDeferredWarnings().filter((warning) => warning.includes(SUPPRESSED)),
		).toHaveLength(1);
		// The checkout tool is kept: its restore operation must stay callable.
		expect(architect.permission?.prepare_pr_workflow_checkout).toBeUndefined();
		// PR events are still delivered, but the subscriber no longer asks for
		// PR_FEEDBACK.
		const seen = await monitorConfigSeenBySubscriber();
		expect(seen).toHaveLength(1);
		expect(seen[0].enabled).toBe(true);
		expect(seen[0].auto_pr_feedback).toBe(false);
	});

	test('enabled: false makes the PR commands refuse, and stays in force when the file is edited without a restart', async () => {
		await bootArchitect(directory, { pr_workflow: { enabled: false } });
		const run = () =>
			COMMAND_REGISTRY['pr-review'].handler({
				directory,
				args: ['https://github.com/example/repo/pull/42'],
				sessionID: 'real-plugin-session',
				agents: {},
			});
		const refused = {
			ok: false,
			text: `Error: ${PR_WORKFLOW_DISABLED_MESSAGE}`,
		};

		expect(await run()).toEqual(refused);

		// The running architect was built without the PR modes and tools, so
		// re-enabling in the file must not take effect until the next startup.
		writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				version_check: false,
				knowledge: { enabled: false },
				pr_workflow: { enabled: true },
			}),
		);
		expect(await run()).toEqual(refused);
	});

	test('enabled: false without automatic feedback configured reports nothing', async () => {
		await bootArchitect(directory, { pr_workflow: { enabled: false } });

		expect(
			getDeferredWarnings().some((warning) => warning.includes(SUPPRESSED)),
		).toBe(false);
	});

	test('the shared real-host fixture is not switched off by a user-level config', async () => {
		// Plugin boot records the MERGED config, so a developer who disables PR
		// workflows in their own user-level config would otherwise break every
		// real-host PR suite. The fixture pins the flag on unless a test
		// overrides it.
		const isolated = createIsolatedTestEnv();
		try {
			mkdirSync(path.join(isolated.configDir, 'opencode'), {
				recursive: true,
			});
			writeFileSync(
				path.join(isolated.configDir, 'opencode', 'opencode-swarm.json'),
				JSON.stringify({ pr_workflow: { enabled: false } }),
			);

			const architect = await bootArchitect(directory, {});

			expect(architect.prompt).toContain('### MODE: PR_REVIEW');
			expect(isPrWorkflowEnabledForDirectory(directory)).toBe(true);
		} finally {
			isolated.cleanup();
		}
	});

	test('a workspace opened in a subdirectory records the flag for the owning project root', async () => {
		// The project root (`.git` + `.swarm` + the config) owns the workspace;
		// the /swarm commands receive that root, not the opened subdirectory.
		mkdirSync(path.join(directory, '.git'), { recursive: true });
		mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				version_check: false,
				quiet: true,
				knowledge: { enabled: false },
				pr_workflow: { enabled: false },
			}),
		);
		const child = path.join(directory, 'packages', 'app');
		mkdirSync(child, { recursive: true });

		await (
			OpenCodeSwarmPlugin as unknown as {
				server: (ctx: unknown) => Promise<unknown>;
			}
		).server({
			client: {},
			project: {},
			directory: child,
			worktree: child,
			serverUrl: new URL('http://localhost:3000'),
			$: {},
		});

		expect(isPrWorkflowEnabledForDirectory(directory)).toBe(false);
		expect(isPrWorkflowEnabledForDirectory(child)).toBe(false);
	});
});
