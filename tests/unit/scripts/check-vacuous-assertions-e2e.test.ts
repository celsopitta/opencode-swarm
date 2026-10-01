/**
 * E2E integration tests for scripts/check-vacuous-assertions.ts main()
 * (issue #2903 feedback PRR-002): exercises the REAL gate the way CI and
 * contributors do, in disposable git repositories — the same harness shape
 * as tests/unit/scripts/check-test-file-cap.test.ts. Covers the fail-open
 * direction (no-base-branch checkout exits 0), the red-violation direction
 * (head commit adding one vacuous assertion exits 1 with an ERROR line),
 * the VACUOUS_ASSERT_ENFORCE=0 soft-warn, and the --check-file mode.
 *
 * Fixture assertions are built by string concatenation so no source line in
 * this file is itself an unmarked detector match (the one concatenated line
 * that would match carries the detector's marker comment).
 */
import { afterAll, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const DETECTOR = path
	.join(process.cwd(), 'scripts', 'check-vacuous-assertions.ts')
	.split(path.sep)
	.join('/');

/** The concatenated pair defeats the line-scoped detector in THIS source file. */
const VACUOUS_LINE = 'expect(items.' + 'length).toBeGreaterThanOrEqual(0);'; // vacuous-ok: detector fixture

const CLEAN_CONTENT = [
	"describe('clean', () => {",
	"\tit('has a real assertion', () => {",
	'\t\texpect([1].length).toBe(1);',
	'\t});',
	'});',
	'',
].join('\n');

const GROWN_CONTENT = `${CLEAN_CONTENT}describe('grown', () => {\n\tit('one vacuous assertion', () => {\n\t\t${VACUOUS_LINE}\n\t});\n});\n`;

let tempRoots: string[] = [];
function track(dir: string): void {
	// Track the mkdtemp DIRECTORY itself (never its parent — the parent is the
	// shared system temp root); mirrors the check-test-file-cap exemplar.
	tempRoots.push(dir);
}

afterAll(() => {
	for (const dir of tempRoots) {
		try {
			fs.rmSync(dir, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 100,
			});
		} catch {
			// best-effort cleanup
		}
	}
	tempRoots = [];
});

function git(cwd: string, args: string[]): void {
	const r = Bun.spawnSync(['git', ...args], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30000,
	});
	if (r.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed (${r.exitCode}): ${String(r.stderr)}`,
		);
	}
}

interface GateResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runGate(
	cwd: string,
	args: string[] = [],
	env?: Record<string, string>,
): GateResult {
	const r = Bun.spawnSync(['bun', DETECTOR, ...args], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 120000,
		env: env ? { ...process.env, ...env } : process.env,
	});
	return {
		exitCode: r.exitCode ?? 1,
		stdout: String(r.stdout),
		stderr: String(r.stderr),
	};
}

/** Build a two-commit repo: `main` holds the clean state; HEAD (feature) adds one vacuous site. */
function makeRepo(base: string): string {
	const repo = path.join(base, 'repo');
	fs.mkdirSync(repo, { recursive: true });
	git(repo, ['init', '-b', 'main']);
	git(repo, ['config', 'user.email', 'e2e@example.invalid']);
	git(repo, ['config', 'user.name', 'vacuous e2e']);
	fs.writeFileSync(path.join(repo, 'a.test.ts'), CLEAN_CONTENT);
	git(repo, ['add', '-A']);
	git(repo, ['commit', '-m', 'clean base']);
	git(repo, ['checkout', '-b', 'feature']);
	fs.writeFileSync(path.join(repo, 'a.test.ts'), GROWN_CONTENT);
	git(repo, ['add', '-A']);
	git(repo, ['commit', '-m', 'add exactly one vacuous assertion']);
	return repo;
}

describe('check-vacuous-assertions e2e (real gate, disposable repos)', () => {
	it('red demonstration: head commit adding one vacuous assertion exits 1 with an ERROR line naming the file', () => {
		const base = canonicalMkdtemp('vacuous-e2e-red-');
		track(base);
		const repo = makeRepo(base);
		const res = runGate(repo);
		expect(res.exitCode).toBe(1);
		expect(res.stdout).toMatch(/^ERROR/m);
		expect(res.stdout).toContain('a.test.ts');
	});

	it('VACUOUS_ASSERT_ENFORCE=0 soft-warns the same tree to exit 0', () => {
		const base = canonicalMkdtemp('vacuous-e2e-soft-');
		track(base);
		const repo = makeRepo(base);
		const res = runGate(repo, [], { VACUOUS_ASSERT_ENFORCE: '0' });
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toContain('soft-warn');
	});

	it('clean tree passes: gate at the clean commit exits 0', () => {
		const base = canonicalMkdtemp('vacuous-e2e-clean-');
		track(base);
		const repo = makeRepo(base);
		// Back to the clean commit: main == HEAD, the diff arm is empty.
		git(repo, ['checkout', 'main']);
		const res = runGate(repo);
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toContain('All vacuous-assertion checks passed.');
	});

	it('no-base-branch checkout is asserted explicitly: exit 0 with the vacuous-diff-arm disclosure, not a silent pass', () => {
		const base = canonicalMkdtemp('vacuous-e2e-nobase-');
		track(base);
		const repo = path.join(base, 'repo');
		fs.mkdirSync(repo, { recursive: true });
		// Unborn branch: a real git worktree whose only branch has no commits.
		git(repo, ['init', '-b', 'main']);
		git(repo, ['config', 'user.email', 'e2e@example.invalid']);
		git(repo, ['config', 'user.name', 'vacuous e2e']);
		const res = runGate(repo);
		expect(res.exitCode).toBe(0);
		expect(res.stdout).toContain('no base branch resolved');
	});

	it('--check-file lists exactly one finding for a one-vacuous fixture and exits 0', () => {
		const base = canonicalMkdtemp('vacuous-e2e-checkfile-');
		track(base);
		const fixture = path.join(base, 'fixture.test.ts');
		fs.writeFileSync(fixture, `${CLEAN_CONTENT}${VACUOUS_LINE}\n`);
		const res = runGate(base, [
			'--check-file',
			fixture.split(path.sep).join('/'),
		]);
		expect(res.exitCode).toBe(0);
		const ruleLines = res.stdout
			.split('\n')
			.filter((l) => l.includes(': rule '));
		expect(ruleLines.length).toBe(1);
		expect(ruleLines[0]).toContain('rule len-ge-0');
	});

	it('--check-file on a missing path reports a clean error and exits 2 (no raw stack)', () => {
		const base = canonicalMkdtemp('vacuous-e2e-missing-');
		track(base);
		const res = runGate(base, [
			'--check-file',
			path.join(base, 'does-not-exist.test.ts').split(path.sep).join('/'),
		]);
		expect(res.exitCode).toBe(2);
		expect(res.stderr).toContain('cannot read');
		expect(res.stderr).not.toMatch(/at\s+\S*main\b/);
	});
});
