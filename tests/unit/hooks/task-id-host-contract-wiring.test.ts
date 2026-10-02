/**
 * Wiring guard for the Task.task_id host-contract strip
 * (src/hooks/task-arg-host-contract.ts, called from src/index.ts).
 *
 * The strip mutates the Task args the chain already resolved. It must be the
 * LAST step of the `tool.execute.before` try block: after
 * `resetGateDenialStreaks`, whose discriminator must be the same args the
 * denial side keyed on (AGENTS.md invariant 9 — a corrected execution clears
 * only the matching action's circuits), and after the delegation telemetry.
 * It must never run from the catch (a denied call is rethrown unchanged).
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.join(import.meta.dir, '../../../src/index.ts');
const source = fs.readFileSync(indexPath, 'utf-8');
const blockStart = source.indexOf("'tool.execute.before':");
const blockEnd = source.indexOf("'tool.execute.after':", blockStart);
const toolBeforeBlock = source.slice(blockStart, blockEnd);

describe('Task.task_id strip wiring', () => {
	test('the strip is the last step of the try: after the streak reset and the delegation telemetry', () => {
		const stripIdx = toolBeforeBlock.indexOf('stripNonSessionTaskIdArg(');
		const resetIdx = toolBeforeBlock.indexOf('resetGateDenialStreaks(');
		const telemetryIdx = toolBeforeBlock.indexOf('telemetry.delegationBegin(');
		const catchIdx = toolBeforeBlock.search(/\}\s*catch\s*\(err\)\s*\{/);
		expect(stripIdx).toBeGreaterThan(0);
		expect(resetIdx).toBeGreaterThan(0);
		expect(telemetryIdx).toBeGreaterThan(0);
		expect(catchIdx).toBeGreaterThan(0);
		expect(stripIdx).toBeGreaterThan(resetIdx);
		expect(stripIdx).toBeGreaterThan(telemetryIdx);
		expect(stripIdx).toBeLessThan(catchIdx);
		// Exactly one strip site in the registration, and none in the catch.
		expect(toolBeforeBlock.split('stripNonSessionTaskIdArg(').length - 1).toBe(
			1,
		);
	});

	test('the stripped plan id is re-stored as plan_task_id for toolAfter readers', () => {
		expect(toolBeforeBlock).toMatch(
			/setStoredInputArgs\(\s*input\.callID,\s*normalized\.planTaskId === undefined\s*\?\s*\{\s*\.\.\.toolBeforeArgs\s*\}\s*:\s*\{\s*\.\.\.toolBeforeArgs,\s*plan_task_id: normalized\.planTaskId\s*\}/,
		);
	});

	test('a host-failed Task part triggers the rollback with an honest reason, only on status error', () => {
		const eventStart = source.indexOf("'message.part.updated'");
		expect(eventStart).toBeGreaterThan(0);
		const rollbackIdx = source.indexOf(
			'Task tool failed in the host after the dispatch was admitted',
		);
		expect(rollbackIdx).toBeGreaterThan(0);
		const branchStart = source.indexOf('// Host-side Task failure (v1 hosts)');
		expect(branchStart).toBeGreaterThan(0);
		expect(branchStart).toBeLessThan(rollbackIdx);
		const branch = source.slice(branchStart, rollbackIdx);
		expect(branch).toContain("part.state?.status === 'error'");
		expect(branch).not.toContain("'completed'");
		expect(branch).not.toContain("'running'");
	});
});
