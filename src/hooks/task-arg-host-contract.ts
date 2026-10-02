/**
 * Host contract for the Task tool's `task_id` argument.
 *
 * The OpenCode host defines `task_id` on its Task tool as a handle for
 * resuming an existing sub-agent session. Since the session-id branding work
 * (host v1.18.x, the pinned range) the value is validated before the tolerant
 * lookup runs: anything that is not a session id (`ses…`) makes the tool throw
 * `Expected a string starting with "ses"`. That throw happens AFTER the
 * plugin's `tool.execute.before` chain has run and admitted the call — so a
 * coder settlement begun for it stays DISPATCHED, and `tool.execute.after`
 * never fires to settle or roll it back (observed live: every retry refused
 * with CODER_DISPATCH_IN_PROGRESS until a human ran `/swarm recover`).
 *
 * The plugin's own attribution contract used the same field name for the
 * numeric plan task id ("1.1"), and the architect prompt once asked for it as
 * a tool argument. On the parallel (worktree) path the plugin overwrites the
 * field with a real child session id before the host sees it; on the serial
 * path the numeric value went straight to the host and was rejected.
 *
 * This module is the single place that reconciles the two meanings at the
 * host boundary: a `task_id` that is not a session handle is removed from the
 * arguments the host will execute, and the plan-shaped value it carried is
 * handed back so the caller can preserve it on the plugin side
 * (`plan_task_id`, which the task-id resolver already honours).
 */

/** The host's own test: a session id starts with `ses` (case-sensitive). */
export function isHostSessionHandle(value: unknown): value is string {
	return typeof value === 'string' && value.startsWith('ses');
}

export interface TaskArgsHostNormalization {
	/** True when `task_id` was removed from `args`. */
	stripped: boolean;
	/**
	 * The trimmed non-session value that was removed, when it was a non-empty
	 * string. Undefined when nothing was stripped or the value was blank.
	 */
	planTaskId?: string;
}

/**
 * Remove a non-session `task_id` from Task tool arguments IN PLACE so the host
 * never sees it, returning what was removed. Session handles (`ses…`) are left
 * untouched: they are the host's resume contract and the worktree path relies
 * on them. Non-string values are removed too — the host validates the field as
 * a string and would reject them the same way.
 */
export function stripNonSessionTaskIdArg(
	args: Record<string, unknown> | undefined,
): TaskArgsHostNormalization {
	if (!args || !('task_id' in args)) return { stripped: false };
	const raw = args.task_id;
	if (isHostSessionHandle(raw)) return { stripped: false };
	delete args.task_id;
	const planTaskId =
		typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined;
	return planTaskId === undefined
		? { stripped: true }
		: { stripped: true, planTaskId };
}
