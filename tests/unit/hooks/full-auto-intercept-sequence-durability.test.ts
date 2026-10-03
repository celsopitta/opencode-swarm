/**
 * Issue #3011: the v2 reactive-intercept mirror must allocate its
 * `oversight_sequence` from the DURABLE allocator
 * (`nextFullAutoOversightSequence`, `src/full-auto/state.ts`) — the same
 * collision domain the v1 dispatcher (`dispatchFullAutoOversight`) uses —
 * instead of a process-local module counter that re-zeroes on restart.
 *
 * Before the fix, a restart re-issued sequences 1, 2, … which duplicated
 * event identity in `.swarm/events.jsonl` and destructively overwrote
 * persisted `.swarm/evidence/{phase}/full-auto-N.json` records (the evidence
 * writer derives its filename from the stamped sequence).
 *
 * Fresh-process mechanics: every behavioral case spawns real bun child
 * processes via spawnSync (array-form argv, stdin detached via stdio, 30 s
 * child timeout) so a
 * "process restart" is genuine module-state reset, not a cache-busting trick.
 * Infra failures throw with the SEQ_TEST_INFRA: prefix so they can never be
 * confused with contract failures. Uses the `_internals.swarmState
 * .opencodeClient` injection seam (no `mock.module`) per AGENTS.md invariant
 * 7, mirroring tests/unit/hooks/full-auto-intercept-fallback.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const srcAbs = (p: string): string =>
	pathToFileURL(path.join(repoRoot, 'src', p)).href;

const CHILD_SCRIPT = `/**
 * Issue #3011 regression child.
 * Modes:
 *   seed <oversightSequence>  — durable RUNNING session (phase 1) via the real
 *                               startFullAutoRun API, then set the persisted
 *                               oversightSequence (default: leave at 0).
 *   seed-evidence             — write a sentinel evidence/1/full-auto-1.json
 *                               with distinct content (simulates a persisted
 *                               pre-restart / buggy-era record).
 *   dispatch                  — fresh-process reactive-intercept dispatch
 *                               (phase_completion, APPROVED) via a mocked SDK
 *                               client, then print observables.
 *   dispatch-v1               — fresh-process v1 dispatcher
 *                               (dispatchFullAutoOversight, phase_boundary).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = ${JSON.stringify(repoRoot)};
const src = (p) => pathToFileURL(path.join(repoRoot, 'src', p)).href;
const [, , workDir, mode, arg] = process.argv;

const APPROVED_CLIENT = {
	session: {
		create: async () => ({ data: { id: 'critic-session' }, error: null }),
		prompt: async () => ({
			data: {
				parts: [
					{
						type: 'text',
						text: 'VERDICT: APPROVED\\nREASONING: probe approval\\nEVIDENCE CHECKED: none',
					},
				],
			},
		}),
		delete: async () => ({}),
	},
};

if (mode === 'seed') {
	const { startFullAutoRun } = await import(src('full-auto/state.js'));
	startFullAutoRun(workDir, 'sess-3011', undefined, {
		planID: 'plan-3011',
		phase: 1,
	});
	if (arg !== undefined) {
		const statePath = path.join(workDir, '.swarm', 'full-auto-state.json');
		const persisted = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
		persisted.oversightSequence = Number(arg);
		fs.writeFileSync(statePath, JSON.stringify(persisted, null, 2), 'utf-8');
	}
	console.log('CHILD_OK seed');
	process.exit(0);
}

if (mode === 'seed-evidence') {
	const evidenceDir = path.join(workDir, '.swarm', 'evidence', '1');
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'full-auto-1.json'),
		JSON.stringify(
			{
				type: 'full_auto_oversight',
				sentinel: 'PRE-RESTART-SENTINEL',
				// Static literal: inert fixture timestamp (check:test-clock-safe).
				timestamp: '2026-10-01T00:00:00.000Z',
				phase: 1,
				trigger_source: 'phase_boundary',
				verdict: 'APPROVED',
				oversight_sequence: 1,
			},
			null,
			2,
		) + '\\n',
		'utf-8',
	);
	console.log('CHILD_OK seed-evidence');
	process.exit(0);
}

if (mode === 'dispatch' || mode === 'dispatch-v1') {
	const stateDI = await import(src('full-auto/state.js'));
	const rootDI = await import(src('state.js'));
	rootDI._internals.swarmState.opencodeClient = APPROVED_CLIENT;
	if (mode === 'dispatch') {
		const { dispatchCriticAndWriteEvent } = await import(
			src('hooks/full-auto-intercept.js')
		);
		await dispatchCriticAndWriteEvent(
			workDir,
			'architect output requesting phase completion',
			'critic context',
			'prov/primary-critic',
			'phase_completion',
			1,
			0,
			'critic_oversight',
			'sess-3011',
			2,
			3,
		);
	} else {
		const { dispatchFullAutoOversight } = await import(
			src('full-auto/oversight.js')
		);
		await dispatchFullAutoOversight({
			directory: workDir,
			sessionID: 'sess-3011',
			trigger: 'probe',
			triggerSource: 'phase_boundary',
			phase: 1,
			criticModel: 'prov/primary-critic',
			oversightAgentName: 'critic_oversight',
		});
	}
	const eventsPath = path.join(workDir, '.swarm', 'events.jsonl');
	const lines = fs.existsSync(eventsPath)
		? fs.readFileSync(eventsPath, 'utf-8').split('\\n').filter(Boolean)
		: [];
	const v2 = lines
		.map((l) => JSON.parse(l))
		.filter((e) => e.type === 'full_auto_oversight');
	const last = v2[v2.length - 1];
	const evidenceDir = path.join(workDir, '.swarm', 'evidence', '1');
	const files = fs.existsSync(evidenceDir)
		? fs.readdirSync(evidenceDir).sort()
		: [];
	console.log(
		'OBS seq=' +
			String(last?.oversight_sequence) +
			' files=' +
			files.join(','),
	);
	process.exit(0);
}

console.error('CHILD unknown mode: ' + String(mode));
process.exit(2);
`;

interface Observables {
	seq: number;
	files: string[];
}

interface ChildOutcome {
	status: number | null;
	stdout: string;
	stderr: string;
}

function runChild(
	childScript: string,
	cwd: string,
	workDir: string,
	...args: string[]
): ChildOutcome {
	const res = spawnSync(process.execPath, [childScript, workDir, ...args], {
		cwd,
		// spawnSync's real option is stdio (not stdin): ignore stdin only and
		// pipe stdout/stderr so the child's observables stay capturable.
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
		encoding: 'utf-8',
	});
	return {
		status: res.status,
		stdout: res.stdout ?? '',
		stderr: res.stderr ?? '',
	};
}

function runChildOk(
	childScript: string,
	cwd: string,
	workDir: string,
	...args: string[]
): void {
	const res = runChild(childScript, cwd, workDir, ...args);
	if (res.status !== 0 || !res.stdout.includes('CHILD_OK')) {
		throw new Error(
			`SEQ_TEST_INFRA: child(${args[0] ?? '?'}) exited ${res.status}: ${(res.stderr || res.stdout).slice(0, 1500)}`,
		);
	}
}

function runChildOrFail(
	childScript: string,
	cwd: string,
	workDir: string,
	...args: string[]
): Observables {
	const res = runChild(childScript, cwd, workDir, ...args);
	if (res.status !== 0) {
		throw new Error(
			`SEQ_TEST_INFRA: child(${args[0] ?? '?'}) exited ${res.status}: ${res.stderr.slice(0, 1500)}`,
		);
	}
	const match = res.stdout.match(/OBS seq=(-?\d+) files=([^\n]*)/);
	if (!match) {
		throw new Error(
			`SEQ_TEST_INFRA: child observables missing from output: ${res.stdout.slice(0, 500)}`,
		);
	}
	return { seq: Number(match[1]), files: match[2].split(',').filter(Boolean) };
}

function evidenceEntry(workDir: string, file: string): string {
	return fs.readFileSync(
		path.join(workDir, '.swarm', 'evidence', '1', file),
		'utf-8',
	);
}

function makeWorkspace(): { tmpBase: string; workDir: string; script: string } {
	const tmpBase = canonicalMkdtemp('p3011-durability-');
	const workDir = path.join(tmpBase, 'work');
	fs.mkdirSync(workDir, { recursive: true });
	const script = path.join(tmpBase, 'child-3011-durability.ts');
	fs.writeFileSync(script, CHILD_SCRIPT, 'utf-8');
	return { tmpBase, workDir, script };
}

describe('issue #3011 — mirror oversight_sequence durability', () => {
	test('fresh process continues from the persisted counter (seed 3 → 4)', async () => {
		const { tmpBase, workDir, script } = makeWorkspace();
		try {
			runChildOk(script, tmpBase, workDir, 'seed', '3');
			const observed = runChildOrFail(script, tmpBase, workDir, 'dispatch');
			expect(observed.seq).toBe(4);
			expect(observed.files).toContain('full-auto-4.json');
		} finally {
			fs.rmSync(tmpBase, { recursive: true, force: true });
		}
	}, 150_000);

	test('two fresh processes coexist: no evidence overwrite, no reused sequence', async () => {
		const { tmpBase, workDir, script } = makeWorkspace();
		try {
			runChildOk(script, tmpBase, workDir, 'seed', '3');
			runChildOk(script, tmpBase, workDir, 'seed-evidence');
			const first = runChildOrFail(script, tmpBase, workDir, 'dispatch');
			const second = runChildOrFail(script, tmpBase, workDir, 'dispatch');
			expect(first.seq).toBe(4);
			expect(second.seq).toBe(5);
			expect(second.files).toContain('full-auto-4.json');
			expect(second.files).toContain('full-auto-5.json');
			expect(evidenceEntry(workDir, 'full-auto-1.json')).toContain(
				'PRE-RESTART-SENTINEL',
			);
		} finally {
			fs.rmSync(tmpBase, { recursive: true, force: true });
		}
	}, 150_000);

	test('v1 dispatch then mirror in a fresh process share one collision domain', async () => {
		const { tmpBase, workDir, script } = makeWorkspace();
		try {
			runChildOk(script, tmpBase, workDir, 'seed');
			const v1 = runChildOrFail(script, tmpBase, workDir, 'dispatch-v1');
			expect(v1.seq).toBe(1);
			expect(v1.files).toContain('full-auto-1.json');
			const v1Content = evidenceEntry(workDir, 'full-auto-1.json');
			const mirror = runChildOrFail(script, tmpBase, workDir, 'dispatch');
			expect(mirror.seq).toBe(2);
			expect(mirror.files).toContain('full-auto-1.json');
			expect(mirror.files).toContain('full-auto-2.json');
			// The v1 record survives byte-identical — no destructive overwrite.
			expect(evidenceEntry(workDir, 'full-auto-1.json')).toBe(v1Content);
		} finally {
			fs.rmSync(tmpBase, { recursive: true, force: true });
		}
	}, 150_000);

	test('buggy-era directory (evidence ahead of counter) heals without overwrite', async () => {
		const { tmpBase, workDir, script } = makeWorkspace();
		try {
			// counter stays at 0; a legacy full-auto-1.json exists on disk.
			runChildOk(script, tmpBase, workDir, 'seed');
			runChildOk(script, tmpBase, workDir, 'seed-evidence');
			const observed = runChildOrFail(script, tmpBase, workDir, 'dispatch');
			expect(observed.seq).toBe(2);
			expect(observed.files).toContain('full-auto-1.json');
			expect(observed.files).toContain('full-auto-2.json');
			expect(evidenceEntry(workDir, 'full-auto-1.json')).toContain(
				'PRE-RESTART-SENTINEL',
			);
		} finally {
			fs.rmSync(tmpBase, { recursive: true, force: true });
		}
	}, 150_000);

	test('phase approval accepts gap-holed, non-contiguous evidence directories', async () => {
		const { verifyFullAutoPhaseApproval } = await import(
			srcAbs('full-auto/phase-approval.js')
		);
		const { startFullAutoRun } = await import(srcAbs('full-auto/state.js'));
		const tmpBase = canonicalMkdtemp('p3011-gaps-');
		try {
			startFullAutoRun(tmpBase, 'sess-gaps', undefined, {
				planID: 'plan-gaps',
				phase: 1,
			});
			const evidenceDir = path.join(tmpBase, '.swarm', 'evidence', '1');
			fs.mkdirSync(evidenceDir, { recursive: true });
			// Sequences 2 and 5 only — a directory the allocator deliberately
			// permits (gaps from restart-mid-sequence; interleave with v1).
			for (const seq of [2, 5]) {
				fs.writeFileSync(
					path.join(evidenceDir, `full-auto-${seq}.json`),
					JSON.stringify({
						type: 'full_auto_oversight',
						timestamp: '2026-10-01T00:00:00.000Z',
						phase: 1,
						trigger_source: 'phase_boundary',
						// Static literal timestamp above: inert fixture (check:test-clock-safe).
						verdict: 'APPROVED',
						evidence_checked: [
							'tests/unit/hooks/full-auto-intercept-sequence-durability.test.ts',
						],
						oversight_sequence: seq,
					}) + '\n',
					'utf-8',
				);
			}
			// The fixture timestamp is a fixed literal; freeze the read clock just
			// after it so phase-approval's 24h staleness TTL can never age the
			// record out (deterministic regardless of when the suite runs).
			const FROZEN_NOW = Date.parse('2026-10-01T00:00:00.000Z') + 1_000;
			const decision = withFrozenClock(
				() =>
					verifyFullAutoPhaseApproval(
						tmpBase,
						'sess-gaps',
						1,
						{} as Parameters<typeof verifyFullAutoPhaseApproval>[3],
					),
				{ fixedNow: FROZEN_NOW },
			);
			expect(decision.ok).toBe(true);
		} finally {
			fs.rmSync(tmpBase, { recursive: true, force: true });
		}
	}, 120_000);
});
