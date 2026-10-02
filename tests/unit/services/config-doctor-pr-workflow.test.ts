/**
 * Config-doctor coverage for the `pr_workflow` section.
 *
 * New file: `src/services/config-doctor.test.ts` is over the FR-006 500-line
 * cap and must not grow.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { PluginConfig } from '../../../src/config/schema';
import { runConfigDoctor } from '../../../src/services/config-doctor';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let cleanup: () => void = () => {};

afterEach(() => {
	cleanup();
	cleanup = () => {};
});

/** Findings the doctor reports at the `pr_workflow` path. */
function findingsFor(prWorkflow: unknown) {
	const created = createSafeTestDir('doctor-pr-workflow-');
	cleanup = created.cleanup;
	const config = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
		pr_workflow: prWorkflow,
	} as unknown as PluginConfig;
	return runConfigDoctor(config, created.dir).findings.filter(
		(finding) => finding.path === 'pr_workflow',
	);
}

describe('config doctor — pr_workflow section', () => {
	it.each([
		['a boolean', false],
		['a string', 'off'],
		['an array', [false]],
	])('flags %s where an object is expected', (_label, value) => {
		const findings = findingsFor(value);

		expect(findings).toHaveLength(1);
		expect(findings[0]?.id).toBe('invalid-pr_workflow-type');
		expect(findings[0]?.severity).toBe('error');
	});

	it.each([
		['enabled: false', { enabled: false }],
		['enabled: true', { enabled: true }],
		['an empty object', {}],
	])('accepts %s', (_label, value) => {
		expect(findingsFor(value)).toEqual([]);
	});
});
