import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Issue #3022 guardrail (Phase 4.2, plan Part F): the v2 event mapper's
 * case-label set is pinned EXACTLY. Every label is either a live plugin-stream
 * name (D3 capture, @opencode/cli 2.0.21), an SDK SSE/REST-dialect name, or a
 * documented vendored-era legacy name. Adding or removing a label without
 * updating this frozen set (and the inventory row) is a contract change the
 * test forces you to make consciously — the #3022 defect class was exactly an
 * unverified name drifting from every real host dialect.
 */
const FROZEN_CASE_LABELS = [
	'session.idle',
	'session.status.updated',
	'session.status',
	'session.error',
	'session.execution.failed',
	'session.deleted',
	'session.created',
	'session.text.delta',
	'session.tool.called',
	'session.tool.input.delta',
	'session.text.ended',
	'session.tool.success',
	'session.tool.failed',
] as const;

describe('#3022 v2 event-name contract (mapV2EventToV1 case labels)', () => {
	test('the mapper case-label set matches the frozen contract exactly', () => {
		const sourcePath = path.resolve(
			import.meta.dir,
			'../../../../src/host/v2/events.ts',
		);
		const source = fs.readFileSync(sourcePath, 'utf-8');
		const labels = [...source.matchAll(/^\t\tcase '([^']+)':/gm)].map(
			(m) => m[1] as string,
		);
		expect([...labels].sort()).toEqual([...FROZEN_CASE_LABELS].sort());
	});
});
