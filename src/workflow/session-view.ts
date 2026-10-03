import {
	compareTaskWorkflowStateRank,
	type TaskWorkflowSnapshot,
} from '../gate-evidence.js';
import {
	type AgentSessionState,
	type TaskWorkflowState,
	updateTaskWorkflowCache,
} from '../state.js';

/**
 * Session-view refresh for Stage A recovery writers (issue #3043).
 *
 * The Stage B settlement loop filters on the session's in-memory
 * `taskWorkflowStates` view while dispatch admission reads the durable
 * workflow evidence, so a recovery writer that advances the durable evidence
 * WITHOUT refreshing the calling session's in-memory twin leaves every later
 * verdict in that session silently skipped — the #3032 split-brain class.
 * The blocked-start arm was the last uncovered shape: `blocked` is
 * at-or-above the durable eligible states, so PR #3038's consumer-side
 * `isRepairableStageBView` guard deliberately refuses to repair it (it
 * protects `update_task_status`'s permissive fallback), and only the WRITER —
 * whose own audited repair write is the authority that the blocked label was
 * drift, not a real block — may refresh it.
 */

/**
 * Apply a durable workflow snapshot to one session's in-memory view of one
 * task. The exact mutation steps of the update_task_status recovery legs'
 * `syncCallerWorkflowFromEvidence` (extracted so the clear-set can never
 * drift between the two surfaces); the caller owns the refresh DECISION.
 * Pure in-memory bookkeeping aligned to a durable write the caller already
 * made or verified — it must never throw into the recovery result.
 */
export function applySessionWorkflowView(
	session: AgentSessionState,
	taskId: string,
	workflow: TaskWorkflowSnapshot,
): void {
	session.taskWorkflowStates.set(taskId, workflow.state);
	session.stageBCompletion?.delete(taskId);
	session.taskCouncilApproved?.delete(taskId);
	session.taskCouncilWorkflowGeneration?.delete(taskId);
	updateTaskWorkflowCache(session, taskId, workflow);
}

/** States a Stage A recovery writer can leave durable evidence at. */
export type StageARecoveredState =
	| 'pre_check_passed'
	| 'reviewer_run'
	| 'tests_run';

const STAGE_A_RECOVERED_STATES: readonly StageARecoveredState[] = [
	'pre_check_passed',
	'reviewer_run',
	'tests_run',
];

export function isStageARecoveredState(
	state: string,
): state is StageARecoveredState {
	return (STAGE_A_RECOVERED_STATES as readonly string[]).includes(state);
}

/**
 * Whether a session's in-memory view may be refreshed to `recoveredState`
 * after a Stage A recovery writer committed (or verified) that durable state.
 *
 * One ordered rule:
 * - absent / `rework_required` / `blocked` views always refresh — the first
 *   two mirror the #3038 consumer-side guard's forward-progress exceptions;
 *   `blocked` is the #3043 arm and is repairable HERE only, because this
 *   predicate runs at the writer that just proved the blocked label was
 *   drift (the consumer-side guard keeps refusing it).
 * - otherwise refresh only when the view is not barrier-ahead-or-terminal
 *   (`tests_run` / `closed` / `complete` are never downgraded — a map ahead
 *   of durable is the legitimate settlement-barrier shape, and terminal
 *   completions are never un-completed in memory) AND ranks below the
 *   recovered state (the map lags durable; refreshing is forward, not a
 *   downgrade).
 */
export function shouldRefreshStageARecoveryView(
	view: TaskWorkflowState | undefined,
	recoveredState: StageARecoveredState,
): boolean {
	if (view === undefined) return true;
	if (view === 'rework_required' || view === 'blocked') return true;
	if (view === 'tests_run' || view === 'closed' || view === 'complete') {
		return false;
	}
	return compareTaskWorkflowStateRank(recoveredState, view) > 0;
}
