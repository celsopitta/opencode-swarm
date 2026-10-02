import {
	getTaskWorkflowSnapshot,
	type TaskEvidence,
} from '../gate-evidence.js';
import { type AgentSessionState, updateTaskWorkflowCache } from '../state.js';

/**
 * Bring one session's in-memory copy of a task's workflow in line with the
 * durable evidence.
 *
 * Stage B dispatch admission and task completion read the evidence file. The
 * Stage B settlement path decides eligibility from
 * `session.taskWorkflowStates`. When the durable workflow is rewritten outside
 * the session's own transitions (a supervised recovery, the `/swarm recover`
 * scan, another process), the session keeps the pre-write state: the dispatch
 * is admitted and the verdict that comes back is then skipped. Callers that
 * have just read or written authoritative evidence use this to close that gap.
 *
 * Rules:
 * - Evidence that is missing or not authoritative is never written into the
 *   session (same rule as session rehydration).
 * - Nothing changes when the session already agrees on state and generation.
 * - A Stage B completion marker is removed when the evidence no longer holds
 *   the reviewer / test_engineer gate it stands for (the gate was cleared by
 *   a rejection, a new mutation or a repair). A marker whose gate is still
 *   recorded is kept, and no marker is added: markers are written by the
 *   settlement path only.
 * - Council state (`taskCouncilWorkflowGeneration`, `taskCouncilApproved`) is
 *   never touched. A council generation bound at an older durable generation
 *   must stay as it is, so the council evidence writer keeps rejecting
 *   verdicts collected before the generation changed.
 *
 * @returns true when the session copy was changed.
 */
export function reconcileSessionWorkflowWithEvidence(
	session: AgentSessionState,
	taskId: string,
	evidence: TaskEvidence | null | undefined,
): boolean {
	const workflow = getTaskWorkflowSnapshot(evidence);
	if (!workflow.authoritative) return false;
	const sameState = session.taskWorkflowStates.get(taskId) === workflow.state;
	const sameGeneration =
		session.taskWorkflowCache?.get(taskId)?.generation === workflow.generation;
	if (sameState && sameGeneration) return false;

	const markers = session.stageBCompletion?.get(taskId);
	if (markers) {
		for (const agent of [...markers]) {
			if (!evidence?.gates?.[agent]) markers.delete(agent);
		}
		if (markers.size === 0) session.stageBCompletion?.delete(taskId);
	}

	session.taskWorkflowStates.set(taskId, workflow.state);
	updateTaskWorkflowCache(session, taskId, workflow);
	return true;
}
