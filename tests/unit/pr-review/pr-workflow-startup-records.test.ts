/**
 * pr_workflow.enabled — the per-project startup records: which roots are
 * recorded, how they stay independent of each other, and how the table stays
 * bounded without ever switching a disabled project back on.
 *
 * Split from pr-workflow-enablement.test.ts for the FR-006 500-line cap.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { LaneContext } from '../../../src/config/lane-context';
import { PluginConfigSchema } from '../../../src/config/schema';
import {
	_internals as enablementInternals,
	isPrWorkflowEnabledForDirectory,
	recordPrWorkflowStartupState,
	resetPrWorkflowStartupState,
} from '../../../src/pr-review/enablement';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const DISABLED = PluginConfigSchema.parse({ pr_workflow: { enabled: false } });
const ENABLED = PluginConfigSchema.parse({});
const realResolveLaneContext = enablementInternals.resolveLaneContext;

let root = '';
let cleanup: () => void = () => {};
const enabledAt = (...segments: string[]) =>
	isPrWorkflowEnabledForDirectory(path.join(root, ...segments));

beforeEach(() => {
	const created = createSafeTestDir('pr-workflow-records-');
	root = created.dir;
	cleanup = created.cleanup;
});

afterEach(() => {
	enablementInternals.resolveLaneContext = realResolveLaneContext;
	resetPrWorkflowStartupState();
	cleanup();
});

/** Treat every directory under a `.swarm-worktrees` base as a swarm lane. */
function recogniseLanes(): void {
	enablementInternals.resolveLaneContext = (directory: string) =>
		directory.includes('.swarm-worktrees')
			? ({
					lanePath: directory,
					parentProjectPath: path.join(root, 'project'),
				} satisfies LaneContext)
			: null;
}

describe('worktree lanes are not recorded', () => {
	test('regression: starting many lanes under a disabled project does not push the project out', () => {
		// Previous code stored every started root and evicted the oldest past
		// 64. Each worktree lane starts the plugin in its own directory, so 64
		// lanes evicted the project itself; an unrecorded project read as
		// enabled and /swarm pr-review started a workflow in a session whose
		// architect had no PR tools.
		recogniseLanes();
		const project = path.join(root, 'project');
		recordPrWorkflowStartupState(project, DISABLED);
		for (let lane = 0; lane < 200; lane += 1) {
			recordPrWorkflowStartupState(
				path.join(project, '.swarm-worktrees', 'session', `lane-${lane}`),
				DISABLED,
			);
		}

		expect(enabledAt('project')).toBe(false);
		expect(enabledAt('project', '.swarm-worktrees', 'session', 'lane-0')).toBe(
			false,
		);
		// No lane was stored, so the table never filled: an unrelated directory
		// still has the default.
		expect(enabledAt('other')).toBe(true);
	});

	test('regression: lanes whose own config differs cannot make an enabled project refuse', () => {
		// Previous code stored a nested root whose value differed from its
		// project's. A lane worktree lacks an untracked project config, so with
		// PR workflows off in the user-level config every lane was stored as
		// disabled; the 65th dropped a disabled entry and the enabled project's
		// own commands were then refused.
		recogniseLanes();
		const project = path.join(root, 'project');
		recordPrWorkflowStartupState(project, ENABLED);
		for (let lane = 0; lane < 200; lane += 1) {
			recordPrWorkflowStartupState(
				path.join(project, '.swarm-worktrees', 'session', `lane-${lane}`),
				DISABLED,
			);
		}

		expect(enabledAt('project')).toBe(true);
		// A lane reads its project's value, not the one it started with.
		expect(enabledAt('project', '.swarm-worktrees', 'session', 'lane-7')).toBe(
			true,
		);
	});

	test('the real detector: a linked worktree on a swarm lane branch is skipped, its project is recorded', () => {
		// What `git worktree add` leaves on disk for a swarm lane, written by
		// hand: the lane's `.git` FILE points at the project's per-worktree git
		// directory, whose HEAD names a swarm lane branch.
		const project = path.join(root, 'project');
		const lane = path.join(project, '.swarm-worktrees', 'ses_abc123', 'lane-1');
		const gitDir = path.join(project, '.git', 'worktrees', 'lane-1');
		mkdirSync(gitDir, { recursive: true });
		mkdirSync(lane, { recursive: true });
		writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
		writeFileSync(
			path.join(gitDir, 'HEAD'),
			'ref: refs/heads/swarm-lane/ses_abc123/lane-1\n',
		);
		writeFileSync(path.join(lane, '.git'), `gitdir: ${gitDir}\n`);

		recordPrWorkflowStartupState(project, ENABLED);
		recordPrWorkflowStartupState(lane, DISABLED);

		// The lane's own value was not recorded; it reads its project's.
		expect(isPrWorkflowEnabledForDirectory(lane)).toBe(true);
		expect(isPrWorkflowEnabledForDirectory(project)).toBe(true);

		// The project itself — a main working tree — is recorded.
		recordPrWorkflowStartupState(project, DISABLED);
		expect(isPrWorkflowEnabledForDirectory(project)).toBe(false);
		expect(isPrWorkflowEnabledForDirectory(lane)).toBe(false);
	});
});

describe('every project root keeps the value it started with', () => {
	test('regression: a nested project does not follow a later change of the project around it', () => {
		// Previous code did not store a nested root whose value matched what it
		// inherited, so it silently followed the outer project: when that one
		// restarted with PR workflows enabled, the nested project — whose
		// architect was still built without the PR modes and tools — started
		// accepting /swarm pr-review.
		recordPrWorkflowStartupState(path.join(root, 'outer'), DISABLED);
		recordPrWorkflowStartupState(path.join(root, 'outer', 'nested'), DISABLED);

		recordPrWorkflowStartupState(path.join(root, 'outer'), ENABLED);

		expect(enabledAt('outer')).toBe(true);
		expect(enabledAt('outer', 'nested')).toBe(false);
	});

	test('regression: a project started between two others does not change the innermost one', () => {
		recordPrWorkflowStartupState(path.join(root, 'outer'), DISABLED);
		recordPrWorkflowStartupState(path.join(root, 'outer', 'a', 'b'), DISABLED);

		recordPrWorkflowStartupState(path.join(root, 'outer', 'a'), ENABLED);

		expect(enabledAt('outer', 'a')).toBe(true);
		expect(enabledAt('outer', 'a', 'b')).toBe(false);
	});
});

describe('the table is bounded without ever re-enabling a disabled root', () => {
	test('enabled entries are dropped before any disabled one, oldest first', () => {
		recordPrWorkflowStartupState(path.join(root, 'project'), DISABLED);
		for (let i = 0; i < 70; i += 1) {
			recordPrWorkflowStartupState(
				path.join(root, 'project', `nested-${i}`),
				ENABLED,
			);
		}

		// The disabled project is still recorded, the newest enabled entry is
		// still there, and the oldest enabled entry now inherits "disabled".
		expect(enabledAt('project')).toBe(false);
		expect(enabledAt('project', 'nested-69')).toBe(true);
		expect(enabledAt('project', 'nested-7')).toBe(true);
		expect(enabledAt('project', 'nested-6')).toBe(false);
		expect(enabledAt('project', 'nested-0')).toBe(false);
		// No disabled entry was dropped, so the default is unchanged.
		expect(enabledAt('other')).toBe(true);
	});

	test('starting a root again makes it the newest', () => {
		recordPrWorkflowStartupState(path.join(root, 'project'), DISABLED);
		recordPrWorkflowStartupState(path.join(root, 'project', 'first'), ENABLED);
		recordPrWorkflowStartupState(path.join(root, 'project', 'second'), ENABLED);
		recordPrWorkflowStartupState(path.join(root, 'project', 'first'), ENABLED);
		for (let i = 0; i < 61; i += 1) {
			recordPrWorkflowStartupState(path.join(root, `filler-${i}`), DISABLED);
		}
		expect(enabledAt('project', 'second')).toBe(true);

		// One over the bound: the oldest enabled entry goes, and that is now
		// "second" because "first" was started again after it.
		recordPrWorkflowStartupState(path.join(root, 'filler-61'), DISABLED);

		expect(enabledAt('project', 'second')).toBe(false);
		expect(enabledAt('project', 'first')).toBe(true);
	});

	test('when a disabled root has to be dropped, unknown directories read as disabled', () => {
		for (let i = 0; i < 64; i += 1) {
			recordPrWorkflowStartupState(path.join(root, `root-${i}`), DISABLED);
		}
		// Exactly at the bound nothing has been dropped yet.
		expect(enabledAt('other')).toBe(true);

		recordPrWorkflowStartupState(path.join(root, 'root-64'), DISABLED);

		// root-0 was dropped from the table but still reads as disabled.
		for (const name of ['root-0', 'root-1', 'root-64', 'other']) {
			expect(enabledAt(name), name).toBe(false);
		}
		// A root that starts enabled after that is recorded as such.
		recordPrWorkflowStartupState(path.join(root, 'on'), ENABLED);
		expect(enabledAt('on')).toBe(true);

		resetPrWorkflowStartupState();
		expect(enabledAt('root-0')).toBe(true);
	});
});
