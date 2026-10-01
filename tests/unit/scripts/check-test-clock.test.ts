/**
 * Issue #2094 — regression coverage for the TypeScript-owned test-clock gate.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	collectTestFiles,
	diffAddsRawClockLine,
	evaluateClockFile,
	fileHasClockHelper,
	parseAddedLines,
	main as runDirectMain,
} from '../../../scripts/check-test-clock';
import { bashCommand } from '../../helpers/bash';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TS_GATE = path.resolve(process.cwd(), 'scripts', 'check-test-clock.ts');
const SH_SHIM = path.resolve(process.cwd(), 'scripts', 'check-test-clock.sh');
const tempRoots: string[] = [];

interface SpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function spawn(cmd: string[], cwd: string): SpawnResult {
	const proc = Bun.spawnSync({
		cmd,
		cwd,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function runScript(repoDir: string): SpawnResult {
	return spawn([process.execPath, 'run', TS_GATE], repoDir);
}

function runShim(repoDir: string): SpawnResult {
	return spawn(bashCommand(SH_SHIM), repoDir);
}

function git(repoDir: string, ...args: string[]): void {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd: repoDir,
		env: process.env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	if (proc.exitCode !== 0) {
		throw new Error(
			`git ${args.join(' ')} failed in ${repoDir}: ${proc.stderr.toString()}`,
		);
	}
}

function write(repoDir: string, relPath: string, content: string): void {
	const full = path.join(repoDir, relPath);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content, 'utf-8');
}

function commit(repoDir: string, message: string): void {
	git(repoDir, 'add', '-A');
	git(repoDir, 'commit', '-q', '-m', message);
}

function makeRepo(): string {
	const repoDir = canonicalMkdtemp('clock-gate-2094-');
	git(repoDir, 'init', '-q', '-b', 'main');
	git(repoDir, 'config', 'user.email', 'test@example.com');
	git(repoDir, 'config', 'user.name', 'Test');
	write(repoDir, 'README.md', 'base\n');
	commit(repoDir, 'init');
	git(repoDir, 'branch', 'origin/main');
	tempRoots.push(repoDir);
	return repoDir;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) {
			fs.rmSync(root, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		}
	}
});

describe('check-test-clock — pure decision coverage', () => {
	test('helper detection requires import or call, not a bare comment mention', () => {
		expect(fileHasClockHelper('// TODO: use freezeClock someday\n')).toBe(
			false,
		);
		expect(
			fileHasClockHelper(
				"import { withFrozenClock } from '../../helpers/test-clock.js';\n",
			),
		).toBe(true);
		expect(fileHasClockHelper('withFrozenClock(() => {});\n')).toBe(true);
	});

	test('added-line parsing ignores headers and finds new raw clock lines', () => {
		const addedLines = parseAddedLines(
			[
				'diff --git a/tests/fixture.test.ts b/tests/fixture.test.ts',
				'+++ b/tests/fixture.test.ts',
				'@@ -0,0 +1,2 @@',
				'+const now = Date.now();',
				'+const fixed = new Date("2024-01-01");',
			].join('\n'),
		);
		expect(addedLines).toEqual([
			'const now = Date.now();',
			'const fixed = new Date("2024-01-01");',
		]);
		expect(diffAddsRawClockLine(addedLines)).toBe(true);
	});

	test('evaluateClockFile blocks only when a diff adds raw clock usage without helper coverage', () => {
		const blocking = evaluateClockFile({
			file: 'tests/fixture.test.ts',
			content: 'const now = Date.now();\n',
			inDiff: true,
			addedLines: ['const now = Date.now();'],
		});
		expect(blocking.blockingViolations.join('\n')).toContain(
			'does not import or call the freezeClock helper',
		);

		const preExisting = evaluateClockFile({
			file: 'tests/fixture.test.ts',
			content: 'const now = Date.now();\n',
			inDiff: true,
			addedLines: ['const value = 1;'],
		});
		expect(preExisting.preExistingViolations).toEqual([
			'tests/fixture.test.ts',
		]);
	});
});

describe('check-test-clock — end to end', () => {
	test('new raw Date.now() usage without helper is blocking', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  Date.now();',
				'});',
			].join('\n'),
		);
		commit(repo, 'add clock violation');

		const result = runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('freezeClock helper');
	}, 30_000);

	test('withFrozenClock call site satisfies the gate', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses frozen time", () => {',
				'  withFrozenClock(() => Date.now());',
				'});',
			].join('\n'),
		);
		commit(repo, 'add frozen clock usage');

		const result = runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('All test-clock checks passed.');
	}, 30_000);

	test('pre-existing raw clock usage touched for unrelated reasons stays non-blocking', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  Date.now();',
				'});',
			].join('\n'),
		);
		commit(repo, 'seed clock violation');
		git(repo, 'branch', '-f', 'origin/main');

		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'// unrelated edit',
				'test("uses real time", () => {',
				'  Date.now();',
				'});',
			].join('\n'),
		);
		commit(repo, 'touch file without new clock line');

		const result = runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'Pre-existing violations (non-blocking warnings): 1',
		);
	}, 30_000);

	test('repo-root resolution and shell shim stay aligned', async () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/fixture.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  Date.now();',
				'});',
			].join('\n'),
		);
		write(repo, 'src/nested/keep.ts', 'export const keep = 1;\n');
		commit(repo, 'add clock violation');

		const fromRoot = runScript(repo);
		const fromSubdir = runScript(path.join(repo, 'src', 'nested'));
		const shim = runShim(repo);
		expect(fromSubdir.stdout).toBe(fromRoot.stdout);
		expect(fromSubdir.exitCode).toBe(fromRoot.exitCode);
		expect(shim.stdout).toBe(fromRoot.stdout);
		expect(shim.exitCode).toBe(fromRoot.exitCode);
		expect(await runDirectMain(repo)).toBe(fromRoot.exitCode);
	}, 30_000);

	test('the shim carries no raw-clock policy logic', () => {
		const shimSource = fs.readFileSync(SH_SHIM, 'utf-8');
		const body = shimSource
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('#'))
			.join('\n');
		expect(body).not.toContain('Date.now');
		expect(body).not.toContain('freezeClock');
		expect(body).toContain('check-test-clock.ts');
	});
});

describe('check-test-clock — src scan surface (issue #2951)', () => {
	test('collectTestFiles scans both roots and honors exclusions under src', () => {
		const repo = makeRepo();
		write(repo, 'tests/a.test.ts', 'export const a = 1;\n');
		write(repo, 'src/b.test.ts', 'export const b = 1;\n');
		write(repo, 'src/nested/c.test.ts', 'export const c = 1;\n');
		write(repo, 'src/node_modules/x.test.ts', 'export const noise = 1;\n');
		write(repo, 'src/dist/y.test.ts', 'export const noise2 = 1;\n');

		const relative = collectTestFiles(repo).map((absFile) =>
			path.relative(repo, absFile).replaceAll(path.sep, '/'),
		);
		expect(relative).toEqual([
			'src/b.test.ts',
			'src/nested/c.test.ts',
			'tests/a.test.ts',
		]);
	}, 30_000);

	test('new src raw Date.now() usage without helper is blocking and counted in the ratchet', () => {
		const repo = makeRepo();
		write(
			repo,
			'src/in-tree.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  const nowMs = Date.now();',
				'  expect(nowMs).toBeGreaterThan(0);',
				'});',
			].join('\n'),
		);
		commit(repo, 'add src clock violation');

		const result = runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('New violations (blocking): 1');
		expect(result.stdout).toContain('src/in-tree.test.ts');
		expect(result.stdout).toContain('Raw-clock-no-helper files (ratchet): 1');
	}, 30_000);

	test('pre-existing src violator untouched by the branch is a warning, not a block', () => {
		const repo = makeRepo();
		write(
			repo,
			'src/legacy.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  const nowMs = Date.now();',
				'  expect(nowMs).toBeGreaterThan(0);',
				'});',
			].join('\n'),
		);
		commit(repo, 'seed src clock violation');
		git(repo, 'branch', '-f', 'origin/main');
		write(repo, 'README.md', 'base\nunrelated edit\n');
		commit(repo, 'touch README only');

		const result = runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'Pre-existing violations (non-blocking warnings): 1',
		);
		expect(result.stdout).toContain('Raw-clock-no-helper files (ratchet): 1');
		expect(result.stdout).toContain('All test-clock checks passed.');
	}, 30_000);

	test('pre-existing src violator edited without new clock lines stays grandfathered', () => {
		const repo = makeRepo();
		write(
			repo,
			'src/legacy.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  const nowMs = Date.now();',
				'  expect(nowMs).toBeGreaterThan(0);',
				'});',
			].join('\n'),
		);
		commit(repo, 'seed src clock violation');
		git(repo, 'branch', '-f', 'origin/main');
		write(
			repo,
			'src/legacy.test.ts',
			[
				"import { test } from 'bun:test';",
				'// unrelated edit',
				'test("uses real time", () => {',
				'  const nowMs = Date.now();',
				'  expect(nowMs).toBeGreaterThan(0);',
				'});',
			].join('\n'),
		);
		commit(repo, 'touch the violating file without new clock lines');

		const result = runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'Pre-existing violations (non-blocking warnings): 1',
		);
		expect(result.stdout).toContain('Raw-clock-no-helper files (ratchet): 1');
	}, 30_000);

	test('ratchet counts raw-clock-no-helper files monotonically and skips helper files', () => {
		const repo = makeRepo();
		const violating = [
			"import { test } from 'bun:test';",
			'test("uses real time", () => {',
			'  const nowMs = Date.now();',
			'  expect(nowMs).toBeGreaterThan(0);',
			'});',
		].join('\n');
		write(repo, 'src/a-legacy.test.ts', violating);
		write(repo, 'src/b-legacy.test.ts', violating);
		write(
			repo,
			'src/c-helper.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("frozen", () => {',
				'  withFrozenClock(() => {',
				'    const frozenMs = Date.now();',
				'    expect(frozenMs).toBe(frozenMs);',
				'  });',
				'});',
			].join('\n'),
		);
		commit(repo, 'seed two violators and one helper user');
		git(repo, 'branch', '-f', 'origin/main');

		const before = runScript(repo);
		expect(before.exitCode).toBe(0);
		expect(before.stdout).toContain('Raw-clock-no-helper files (ratchet): 2');

		fs.rmSync(path.join(repo, 'src', 'b-legacy.test.ts'));
		commit(repo, 'remove one violator');

		const after = runScript(repo);
		expect(after.exitCode).toBe(0);
		expect(after.stdout).toContain('Raw-clock-no-helper files (ratchet): 1');
	}, 30_000);

	test('ratchet spans both scan roots, not src alone', () => {
		const repo = makeRepo();
		const violating = [
			"import { test } from 'bun:test';",
			'test("uses real time", () => {',
			'  const nowMs = Date.now();',
			'  expect(nowMs).toBeGreaterThan(0);',
			'});',
		].join('\n');
		write(repo, 'src/one.test.ts', violating);
		write(repo, 'tests/unit/two.test.ts', violating);
		commit(repo, 'seed one violator per scan root');
		git(repo, 'branch', '-f', 'origin/main');

		const result = runScript(repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'Pre-existing violations (non-blocking warnings): 2',
		);
		expect(result.stdout).toContain('Raw-clock-no-helper files (ratchet): 2');
	}, 30_000);

	test('ratchet sums blocking and pre-existing buckets (PRR-005)', () => {
		const repo = makeRepo();
		const violating = [
			"import { test } from 'bun:test';",
			'test("uses real time", () => {',
			'  const nowMs = Date.now();',
			'  expect(nowMs).toBeGreaterThan(0);',
			'});',
		].join('\n');
		write(repo, 'src/legacy.test.ts', violating);
		commit(repo, 'seed pre-existing src violator');
		git(repo, 'branch', '-f', 'origin/main');
		write(repo, 'src/fresh.test.ts', violating);
		commit(repo, 'add a second violating src file on the branch');

		const result = runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('New violations (blocking): 1');
		expect(result.stdout).toContain(
			'Pre-existing violations (non-blocking warnings): 1',
		);
		expect(result.stdout).toContain('Raw-clock-no-helper files (ratchet): 2');
	}, 30_000);

	test('tests/ control: new raw clock usage blocks (PRR-012, issue AC1)', () => {
		const repo = makeRepo();
		write(
			repo,
			'tests/unit/control.test.ts',
			[
				"import { test } from 'bun:test';",
				'test("uses real time", () => {',
				'  const nowMs = Date.now();',
				'  expect(nowMs).toBeGreaterThan(0);',
				'});',
			].join('\n'),
		);
		commit(repo, 'add tests-tree control violation');

		const result = runScript(repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain('New violations (blocking): 1');
		expect(result.stdout).toContain('tests/unit/control.test.ts');
	}, 30_000);
});
