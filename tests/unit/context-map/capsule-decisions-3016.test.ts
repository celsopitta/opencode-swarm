/**
 * Tests for issue #3016 — the critic-capsule decisions consumer.
 *
 * Covers the Decisions section in buildCapsule output (critic only, gated
 * by RoleProfile.include_decisions), task-scoped-first selection with the
 * MAX_CAPSULE_DECISIONS cap, the structured capsule.decisions field, and
 * prune-order behavior under token pressure.
 *
 * bun:test native APIs; temp dirs via canonicalMkdtemp (FR-011).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
	buildCapsule,
	estimateTokens,
	MAX_CAPSULE_DECISIONS,
	selectCapsuleDecisions,
} from '../../../src/context-map/capsule-builder';
import type { DecisionEntry } from '../../../src/types/context-map';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const tempDirs: string[] = [];

function makeMapProject(decisions: DecisionEntry[]): string {
	const dir = canonicalMkdtemp('capsule-decisions-3016-');
	tempDirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'context-map.json'),
		JSON.stringify({
			schema_version: 1,
			generated_at: '2026-10-01T00:00:00.000Z',
			repo_fingerprint: '',
			files: {},
			task_history: {},
			decisions,
		}),
		'utf-8',
	);
	return dir;
}

function decision(n: number, taskId?: string): DecisionEntry {
	return {
		id: `A${n}`,
		decision: `Decision ${n}`,
		rationale: `rationale ${n}`,
		timestamp: '2026-10-01T00:00:00.000Z',
		...(taskId === undefined ? {} : { task_id: taskId }),
	};
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('buildCapsule decisions section (#3016)', () => {
	test('critic capsule includes a Decisions section with id, text, rationale, task', () => {
		const dir = makeMapProject([decision(1, '1.1')]);
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: [],
			task_goal: 'review the plan',
			directory: dir,
		});
		expect(capsule.content).toContain('## Decisions');
		expect(capsule.content).toContain('[A1] Decision 1');
		expect(capsule.content).toContain('— rationale 1');
		expect(capsule.content).toContain('(task 1.1)');
	});

	test('non-critic roles do not include a Decisions section', () => {
		const dir = makeMapProject([decision(1, '1.1')]);
		for (const role of ['coder', 'reviewer', 'test_engineer', 'sme'] as const) {
			const { capsule } = buildCapsule({
				task_id: '1.1',
				agent_role: role,
				delegation_reason: 'new_task',
				files_in_scope: [],
				task_goal: 'g',
				directory: dir,
			});
			expect(capsule.content).not.toContain('## Decisions');
			expect(capsule.decisions).toBeUndefined();
		}
	});

	test('critic capsule carries the structured decisions field; coder does not', () => {
		const dir = makeMapProject([decision(1, '1.1')]);
		const critic = buildCapsule({
			task_id: '1.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: [],
			task_goal: 'g',
			directory: dir,
		});
		expect(critic.capsule.decisions).toHaveLength(1);
		expect(critic.capsule.decisions?.[0].id).toBe('A1');
	});

	test('empty map yields no section and no field', () => {
		const dir = makeMapProject([]);
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: [],
			task_goal: 'g',
			directory: dir,
		});
		expect(capsule.content).not.toContain('## Decisions');
		expect(capsule.decisions).toBeUndefined();
	});

	test('entries without rationale or task render without suffixes', () => {
		const dir = makeMapProject([
			{
				id: 'A7',
				decision: 'Bare decision',
				rationale: '',
				timestamp: '2026-10-01T00:00:00.000Z',
			},
		]);
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: [],
			task_goal: 'g',
			directory: dir,
		});
		expect(capsule.content).toContain('- [A7] Bare decision\n');
	});

	test('empty-object entry renders a placeholder, never undefined (#3023 PRR-009)', () => {
		const dir = makeMapProject([{} as unknown as DecisionEntry]);
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: [],
			task_goal: 'g',
			directory: dir,
		});
		expect(capsule.content).toContain('## Decisions');
		expect(capsule.content).toContain('(malformed entry)');
		expect(capsule.content).not.toContain('undefined');
	});

	test('null/malformed stored entries are skipped, not thrown on (#3016 review)', () => {
		const dir = makeMapProject([
			null,
			{ ...decision(2, '1.1'), rationale: 42 as unknown as string },
			decision(1, '1.1'),
		]);
		const { capsule } = buildCapsule({
			task_id: '1.1',
			agent_role: 'critic',
			delegation_reason: 'critic_plan_review',
			files_in_scope: [],
			task_goal: 'g',
			directory: dir,
		});
		// The null entry is skipped; the well-formed entry renders; the
		// non-string rationale on an object entry renders without suffixes.
		expect(capsule.content).toContain('## Decisions');
		expect(capsule.content).toContain('[A1] Decision 1 — rationale 1');
		expect(capsule.decisions?.map((d) => d.id)).toEqual(['A2', 'A1']);
		expect(capsule.content).not.toContain('[undefined]');
	});

	test('Decisions survives pruning when File Details is dropped first', () => {
		const dir = makeMapProject([decision(1, '1.1')]);
		// Seed one file entry so File Details exists to be pruned first.
		const mapPath = path.join(dir, '.swarm', 'context-map.json');
		const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
		map.files['src/big/example.ts'] = {
			path: 'src/big/example.ts',
			content_hash: 'x',
			mtime_ms: 0,
			purpose: 'p',
			summary: 's',
		};
		fs.writeFileSync(mapPath, JSON.stringify(map), 'utf-8');

		const build = (max: number) =>
			buildCapsule({
				task_id: '1.1',
				agent_role: 'critic',
				delegation_reason: 'critic_plan_review',
				files_in_scope: ['src/big/example.ts'],
				task_goal: 'g',
				directory: dir,
				max_capsule_tokens: max,
			});

		// Self-calibrating budget: exactly the token cost of the capsule with
		// the (last-positioned) File Details section removed — so the pruner
		// removes File Details first and stops, keeping Decisions.
		const full = build(1_000_000);
		const withoutFileDetails = full.capsule.content.replace(
			/## File Details[\s\S]*$/,
			'',
		);
		const budget = estimateTokens(withoutFileDetails);

		const { capsule } = build(budget);
		expect(capsule.content).not.toContain('## File Details');
		expect(capsule.content).toContain('[A1] Decision 1');
	});
});

describe('selectCapsuleDecisions', () => {
	test('task-scoped decisions come first, then most recent others, capped', () => {
		const all: DecisionEntry[] = [];
		for (let i = 1; i <= 30; i++) {
			all.push(decision(i, i % 2 === 0 ? 'other.1' : '2.2'));
		}
		const selected = selectCapsuleDecisions(all, '2.2');
		expect(selected).toHaveLength(MAX_CAPSULE_DECISIONS);
		// 15 task-scoped (odd ids) exceed the cap alone: the most recent 10
		// scoped entries win (A11..A29 odd) and no others fit.
		expect(selected.map((d) => d.id)).toEqual([
			'A11',
			'A13',
			'A15',
			'A17',
			'A19',
			'A21',
			'A23',
			'A25',
			'A27',
			'A29',
		]);
	});

	test('few scoped entries leave room for the most recent others', () => {
		const all: DecisionEntry[] = [];
		for (let i = 1; i <= 12; i++) {
			all.push(decision(i, i <= 2 ? '1.1' : 'other.1'));
		}
		const selected = selectCapsuleDecisions(all, '1.1');
		expect(selected.map((d) => d.id)).toEqual([
			'A1',
			'A2',
			'A5',
			'A6',
			'A7',
			'A8',
			'A9',
			'A10',
			'A11',
			'A12',
		]);
	});

	test('returns [] for an empty log', () => {
		expect(selectCapsuleDecisions([], '1.1')).toEqual([]);
	});
});
