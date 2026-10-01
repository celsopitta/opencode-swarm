/**
 * Real-disk round-trip coverage for in-call multi-decision allocation
 * (PR #3015 review finding PRR-005): the frozen decision-id-allocation
 * suite witnesses restart durability on disk only 1-decision-per-call, and
 * the in-call sequencing witness is seam-mocked. This file closes the
 * intersection: multiple decisions recorded in ONE call, witnessed through
 * the real save/load persistence path.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { updateContextMapAfterAgent } from '../../../src/context-map/post-agent-update';
import type { ContextMap } from '../../../src/types/context-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('in-call multi-decision ids on real disk (PRR-005)', () => {
	test('two decisions in one call persist distinct sequential ids through real save/load', () => {
		const dir = canonicalMkdtemp('ctxmap-2720-rt2-');
		try {
			// Seed a persisted map holding A1..A3, as a previous process left it.
			const seed = {
				schema_version: 1,
				generated_at: '2026-01-01T00:00:00.000Z',
				repo_fingerprint: 'test-fingerprint',
				files: {},
				task_history: {},
				decisions: [
					{
						id: 'A1',
						decision: 'seed 1',
						rationale: 'r',
						timestamp: '2026-01-01T00:00:00.000Z',
						task_id: '0.0',
					},
					{
						id: 'A2',
						decision: 'seed 2',
						rationale: 'r',
						timestamp: '2026-01-01T00:00:00.000Z',
						task_id: '0.0',
					},
					{
						id: 'A3',
						decision: 'seed 3',
						rationale: 'r',
						timestamp: '2026-01-01T00:00:00.000Z',
						task_id: '0.0',
					},
				],
			} satisfies ContextMap;
			const mapPath = path.join(dir, '.swarm', 'context-map.json');
			fs.mkdirSync(path.dirname(mapPath), { recursive: true });
			fs.writeFileSync(mapPath, JSON.stringify(seed, null, 2), 'utf-8');

			// One call recording TWO decisions; the persisted file is the witness.
			updateContextMapAfterAgent({
				task_id: '4.1',
				agent_role: 'coder',
				files_touched: [],
				implementation_summary: 'multi-decision in-call write',
				task_goal: 'verify in-call sequencing on real disk',
				final_status: 'completed',
				decisions: [
					{ decision: 'first in-call decision', rationale: 'r1' },
					{ decision: 'second in-call decision', rationale: 'r2' },
				],
				directory: dir,
			});

			const persisted = JSON.parse(
				fs.readFileSync(mapPath, 'utf-8'),
			) as ContextMap;
			const ids = persisted.decisions.map((d) => d.id);
			expect(ids).toEqual(['A1', 'A2', 'A3', 'A4', 'A5']);
			expect(new Set(ids).size).toBe(ids.length);
			const inCall = persisted.decisions.filter((d) => d.task_id === '4.1');
			expect(inCall.map((d) => d.id)).toEqual(['A4', 'A5']);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
