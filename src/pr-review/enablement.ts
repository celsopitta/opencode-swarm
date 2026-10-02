/**
 * PR-workflow enablement (`pr_workflow.enabled`).
 *
 * The PR workflows — the architect's PR_REVIEW, PR_FEEDBACK and CI_MONITOR
 * modes — are ON by default. A deployment that never runs them can set
 * `pr_workflow.enabled: false`; this module is the single definition of what
 * that flag means for every consumer.
 *
 * The flag is read ONCE, at plugin startup. Agent tool allow-lists and the
 * architect prompt are built then and cannot change until the host restarts,
 * so the runtime checks (the `/swarm` commands, the PR workflow gate) must
 * answer from the same startup value: a live re-read would let an edited
 * config start a workflow whose mode section and tools the running architect
 * does not have. Plugin init records the value per project root through
 * {@link recordPrWorkflowStartupState}; {@link isPrWorkflowEnabledForDirectory}
 * answers from that record. Each started project root keeps its own value, so
 * a project nested inside another is unaffected by what the outer one does
 * later.
 */
import * as path from 'node:path';
import { resolveLaneContext } from '../config/lane-context.js';
import type { PluginConfig, PrMonitorConfig } from '../config/schema.js';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';

/** User-facing explanation returned wherever a disabled PR workflow is refused. */
export const PR_WORKFLOW_DISABLED_MESSAGE =
	'PR workflows are disabled: `pr_workflow.enabled` was false in opencode-swarm.json when OpenCode started. ' +
	'Set `pr_workflow.enabled` to true (or remove the setting) and restart OpenCode ' +
	'to use /swarm pr-review, /swarm pr-feedback and /swarm ci-monitor.';

/** True unless the config explicitly sets `pr_workflow.enabled: false`. */
export function isPrWorkflowEnabled(
	config: Pick<PluginConfig, 'pr_workflow'> | undefined,
): boolean {
	return config?.pr_workflow?.enabled !== false;
}

/** Bound on remembered project roots (AGENTS.md invariant 8: bounded module state). */
const MAX_STARTUP_ROOTS = 64;

/** Canonical project root → the flag's value when the plugin started there, oldest first. */
const startupState = new Map<string, boolean>();

/**
 * Set once a DISABLED root had to be dropped to respect the bound. From then
 * on a directory under no recorded root reads as disabled: forgetting a
 * disabled root must never turn it back on.
 */
let disabledRootDropped = false;

/** Test seam: how a started root is recognised as a swarm worktree lane. */
export const _internals = {
	resolveLaneContext,
};

/** The value `key` has from the records: its own, else its closest ancestor's, else the default. */
function lookup(key: string): boolean {
	let owner: string | undefined;
	for (const root of startupState.keys()) {
		const contains =
			key === root ||
			key.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
		if (contains && (owner === undefined || root.length > owner.length)) {
			owner = root;
		}
	}
	return owner === undefined
		? !disabledRootDropped
		: startupState.get(owner) === true;
}

/**
 * Records the flag for a project root at plugin startup. A later init of the
 * same root replaces its record.
 *
 * A swarm worktree lane is NOT recorded. Every lane is a host instance of its
 * own and starts the plugin too, but a lane never starts a PR workflow, its
 * config can differ from its project's (an untracked project config is absent
 * from the worktree), and a long session creates lanes without limit. Recording
 * them would fill the table with entries that say nothing about the project.
 * A lane directory inside its project reads the project's value.
 *
 * The table is bounded. When it is full an ENABLED entry is dropped first,
 * and only when none is left a disabled one — after which a directory under no
 * recorded root reads as disabled. Forgetting can therefore refuse a workflow
 * that was enabled; it can never start one that was disabled.
 */
export function recordPrWorkflowStartupState(
	root: string,
	config: Pick<PluginConfig, 'pr_workflow'> | undefined,
): void {
	if (_internals.resolveLaneContext(root) !== null) return;
	const key = canonicalRootKeyFresh(root);
	startupState.delete(key);
	startupState.set(key, isPrWorkflowEnabled(config));
	while (startupState.size > MAX_STARTUP_ROOTS) {
		let victim: string | undefined;
		for (const [candidate, candidateEnabled] of startupState) {
			if (candidate !== key && candidateEnabled) {
				victim = candidate;
				break;
			}
		}
		if (victim === undefined) {
			victim = startupState.keys().next().value as string;
			disabledRootDropped = true;
		}
		startupState.delete(victim);
	}
}

/** Forgets every recorded root. For tests. */
export function resetPrWorkflowStartupState(): void {
	startupState.clear();
	disabledRootDropped = false;
}

/**
 * Whether PR workflows are enabled for `directory`: the value recorded at
 * startup for the project root that is, or most closely contains, that
 * directory. A directory under no recorded root — a process where the plugin
 * never started, such as the standalone CLI or a unit test — has the default
 * (enabled).
 */
export function isPrWorkflowEnabledForDirectory(directory: string): boolean {
	return lookup(canonicalRootKeyFresh(directory));
}

/**
 * The PR-monitor settings the background workers should run with.
 *
 * `pr_monitor.auto_pr_feedback` makes the monitor append a
 * `[MODE: PR_FEEDBACK …]` signal to PR events. With the PR workflows disabled
 * that signal would name a mode the architect has no section or tools for, so
 * it is switched off here; plain PR notifications are unaffected.
 * `autoFeedbackSuppressed` is true when a configured `auto_pr_feedback: true`
 * was overridden, so the caller can tell the operator.
 */
export function resolvePrMonitorConfigForPrWorkflow(
	prMonitor: PrMonitorConfig,
	config: Pick<PluginConfig, 'pr_workflow'> | undefined,
): { config: PrMonitorConfig; autoFeedbackSuppressed: boolean } {
	if (isPrWorkflowEnabled(config) || !prMonitor.auto_pr_feedback) {
		return { config: prMonitor, autoFeedbackSuppressed: false };
	}
	return {
		config: { ...prMonitor, auto_pr_feedback: false },
		autoFeedbackSuppressed: true,
	};
}
