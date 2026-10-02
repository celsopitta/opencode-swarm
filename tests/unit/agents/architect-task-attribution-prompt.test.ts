import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import { resolveTaskId } from '../../../src/hooks/task-id-resolver';

describe('Architect prompt — task attribution guidance', () => {
	it('requires numeric task identity on task-scoped delegations', () => {
		const prompt = createArchitectAgent('test-model').config.prompt ?? '';

		expect(prompt).toContain('TASK ATTRIBUTION');
		expect(prompt).toContain(
			'alone on a standalone `TASK:` line (for example, `TASK: 1.1`)',
		);
		expect(prompt).not.toContain('TASK: 1.1 —');
		// The host's Task tool reads `task_id` as a sub-agent session handle and
		// rejects a plan id outright, so the prompt must never ask for one there.
		expect(prompt).toContain("Leave the Task tool's `task_id` argument unset");
		expect(prompt).not.toContain('same numeric value as a tool argument');
		expect(prompt).toContain('Plan-level critics');

		const shippedExample = /for example, `(TASK: \d+\.\d+(?:\.\d+)*)`/.exec(
			prompt,
		)?.[1];
		expect(shippedExample).toBe('TASK: 1.1');
		expect(
			resolveTaskId(
				{ prompt: shippedExample },
				{ policy: 'attribution', knownPlanTaskIds: new Set(['1.1']) },
			),
		).toEqual({ status: 'resolved', taskId: '1.1', source: 'marker' });
	});
});
