import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	changedFilesForGuard,
	evaluateReleaseOwnership,
	main,
	type TrustedGitHubContext,
} from '../../../scripts/check-required-check-contract';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #2997: the release-owner guard must evaluate the PR's OWN edits only.
 * GitHub's pull_request.base.sha is the moving main tip, so the guard resolves
 * the merge-base of the trusted range before diffing. These tests pin the
 * two-dot-vs-merge-base contrast across a release-please-style main-side
 * owner-file bump, the genuine-edit true positive (with message precision),
 * merge_group equivalence (single-PR and chained batches), and both fail-closed
 * legs (unresolvable merge-base; merge_group base that is not the merge-base).
 */

const OWNER_FILES = [
	'package.json',
	'CHANGELOG.md',
	'.release-please-manifest.json',
] as const;

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	if (proc.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
	}
	return proc.stdout.toString().trim();
}

interface GuardFixture {
	root: string;
	forkPoint: string;
	mainTip: string;
	cleanHead: string;
	ownerHead: string;
	orphanHead: string;
	groupHead: string;
	ownerGroupHead: string;
	chainedCleanGroupHead: string;
	chainedOwnerGroupHead: string;
	pr2Head: string;
}

function buildFixture(): GuardFixture {
	const root = canonicalMkdtemp('required-check-2997-');
	git(root, 'init', '-q', '-b', 'main');
	git(root, 'config', 'user.email', 'test@example.com');
	git(root, 'config', 'user.name', 'Test');
	writeFileSync(join(root, 'README.md'), 'base\n');
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'fork point');
	const forkPoint = git(root, 'rev-parse', 'HEAD');

	// Clean PR branch: touches src/ only, never an owner file.
	git(root, 'checkout', '-q', '-b', 'feature');
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'src', 'feature.ts'), 'feature\n');
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'pr change (no owner files)');
	const cleanHead = git(root, 'rev-parse', 'HEAD');

	// Genuine-edit PR branch: src change + a real package.json edit.
	git(root, 'checkout', '-q', '-b', 'feature-owner', forkPoint);
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'src', 'feature.ts'), 'feature\n');
	writeFileSync(join(root, 'package.json'), '{\n  "name": "pr-edit"\n}\n');
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'pr change (genuine owner edit)');
	const ownerHead = git(root, 'rev-parse', 'HEAD');

	// Main advances with a release-please-style owner-file bump after the fork.
	git(root, 'checkout', '-q', 'main');
	writeFileSync(
		join(root, 'package.json'),
		'{\n  "name": "opencode-swarm",\n  "version": "7.187.4"\n}\n',
	);
	writeFileSync(
		join(root, 'CHANGELOG.md'),
		'# Changelog\n\n## 7.187.4 (2026-09-29)\n\nmain-side release bump.\n',
	);
	writeFileSync(
		join(root, '.release-please-manifest.json'),
		'{\n  ".": "7.187.4"\n}\n',
	);
	git(root, 'add', '.');
	git(root, 'commit', '-q', '-m', 'chore(main): release 7.187.4');
	const mainTip = git(root, 'rev-parse', 'HEAD');

	// Orphan history for the unresolvable-merge-base leg.
	git(root, 'checkout', '-q', '--orphan', 'orphan');
	writeFileSync(join(root, 'unrelated.txt'), 'unrelated\n');
	git(root, 'add', 'unrelated.txt');
	git(root, 'commit', '-q', '-m', 'orphan root');
	const orphanHead = git(root, 'rev-parse', 'HEAD');
	git(root, 'checkout', '-q', 'main');

	// Single-PR merge group heads (feature merged onto the main tip). The
	// owner-edit merges would add/add-conflict with main's release bump
	// (both sides created package.json after the fork), so they take the PR
	// side explicitly — the deterministic, conflict-free stand-in for a queue
	// merge whose package.json content is the PR edit.
	git(root, 'checkout', '-q', '-b', 'group', mainTip);
	git(
		root,
		'merge',
		'-q',
		'--no-ff',
		'-m',
		'Merge pull request #3000 from ZaxbyHub/fix/clean',
		cleanHead,
	);
	const groupHead = git(root, 'rev-parse', 'HEAD');
	git(root, 'checkout', '-q', '-b', 'owner-group', mainTip);
	git(
		root,
		'merge',
		'-q',
		'--no-ff',
		'-X',
		'theirs',
		'-m',
		'Merge pull request #3001 from ZaxbyHub/fix/owner',
		ownerHead,
	);
	const ownerGroupHead = git(root, 'rev-parse', 'HEAD');

	// Chained two-PR batch: head = merge(merge(base, pr1), pr2) — base is a
	// non-first-parent ancestor of the final head, matching a stacked queue.
	git(root, 'checkout', '-q', '-b', 'pr2', forkPoint);
	mkdirSync(join(root, 'src'));
	writeFileSync(join(root, 'src', 'pr2.ts'), 'pr2\n');
	git(root, 'add', 'src/pr2.ts');
	git(root, 'commit', '-q', '-m', 'second pr change');
	const pr2Head = git(root, 'rev-parse', 'HEAD');
	git(root, 'checkout', '-q', '-b', 'chained-group', mainTip);
	git(
		root,
		'merge',
		'-q',
		'--no-ff',
		'-m',
		'Merge pull request #3000 from ZaxbyHub/fix/clean',
		cleanHead,
	);
	git(
		root,
		'merge',
		'-q',
		'--no-ff',
		'-m',
		'Merge pull request #3002 from ZaxbyHub/fix/pr2',
		pr2Head,
	);
	const chainedCleanGroupHead = git(root, 'rev-parse', 'HEAD');
	git(root, 'checkout', '-q', '-b', 'chained-owner-group', mainTip);
	git(
		root,
		'merge',
		'-q',
		'--no-ff',
		'-m',
		'Merge pull request #3000 from ZaxbyHub/fix/clean',
		cleanHead,
	);
	git(
		root,
		'merge',
		'-q',
		'--no-ff',
		'-X',
		'theirs',
		'-m',
		'Merge pull request #3001 from ZaxbyHub/fix/owner',
		ownerHead,
	);
	const chainedOwnerGroupHead = git(root, 'rev-parse', 'HEAD');
	git(root, 'checkout', '-q', 'main');

	return {
		root,
		forkPoint,
		mainTip,
		cleanHead,
		ownerHead,
		orphanHead,
		groupHead,
		ownerGroupHead,
		chainedCleanGroupHead,
		chainedOwnerGroupHead,
		pr2Head,
	};
}

function guardContext(
	baseSha: string,
	headSha: string,
	event: 'pull_request' | 'merge_group' = 'pull_request',
): TrustedGitHubContext {
	return {
		event,
		actor: 'contributor',
		repository: 'ZaxbyHub/opencode-swarm',
		baseSha,
		headSha,
	};
}

function writePrEvent(root: string, base: string, head: string): string {
	const p = join(root, 'pr-event.json');
	writeFileSync(
		p,
		JSON.stringify({
			pull_request: {
				base: { sha: base },
				head: {
					sha: head,
					ref: 'feature',
					repo: { full_name: 'ZaxbyHub/opencode-swarm' },
				},
				user: { login: 'contributor' },
			},
		}),
	);
	return p;
}

function writeMgEvent(root: string, base: string, head: string): string {
	const p = join(root, 'mg-event.json');
	writeFileSync(
		p,
		JSON.stringify({ merge_group: { base_sha: base, head_sha: head } }),
	);
	return p;
}

function withGuardEnv(
	eventPath: string,
	eventName: 'pull_request' | 'merge_group',
	fn: () => number,
): number {
	const updates = {
		GITHUB_EVENT_NAME: eventName,
		GITHUB_ACTOR: 'contributor',
		GITHUB_REPOSITORY: 'ZaxbyHub/opencode-swarm',
		GITHUB_EVENT_PATH: eventPath,
	};
	const previous = Object.fromEntries(
		Object.keys(updates).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, updates);
	try {
		return fn();
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

describe('issue #2997 release-owner guard merge-base diff semantics', () => {
	test('clean PR across a release-please merge is accepted (two-dot vs merge-base contrast)', () => {
		const f = buildFixture();
		try {
			// The raw two-dot diff against the moving base tip blames the PR
			// for all three main-side owner-file edits…
			const twoDot = git(
				f.root,
				'diff',
				'--name-only',
				'--no-renames',
				f.mainTip,
				f.cleanHead,
				'--',
				...OWNER_FILES,
			).split(/\r?\n/);
			expect(twoDot.filter(Boolean).sort()).toEqual([...OWNER_FILES].sort());
			// …while the guard's merge-base-relative resolution sees none of them.
			const changed = changedFilesForGuard(
				f.root,
				guardContext(f.mainTip, f.cleanHead),
			);
			expect(changed).toEqual([]);
			const decision = evaluateReleaseOwnership({
				changedFiles: changed,
				releaseAutomation: false,
			});
			expect(decision.code).toBe('NO_RELEASE_OWNER_EDIT');
			expect(decision.ok).toBe(true);
			expect(
				withGuardEnv(
					writePrEvent(f.root, f.mainTip, f.cleanHead),
					'pull_request',
					() => main(['--release-owner'], f.root),
				),
			).toBe(0);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}, 20_000);

	test('genuine PR-side owner edit is still accused, naming only the edited file', () => {
		const f = buildFixture();
		try {
			const changed = changedFilesForGuard(
				f.root,
				guardContext(f.mainTip, f.ownerHead),
			);
			expect(changed).toEqual(['package.json']);
			const decision = evaluateReleaseOwnership({
				changedFiles: changed,
				releaseAutomation: false,
			});
			expect(decision.code).toBe('UNAUTHORIZED_RELEASE_OWNER_EDIT');
			expect(decision.ok).toBe(false);
			expect(decision.message).toContain('package.json');
			expect(decision.message).not.toContain('CHANGELOG.md');
			expect(decision.message).not.toContain('.release-please-manifest.json');
			expect(
				withGuardEnv(
					writePrEvent(f.root, f.mainTip, f.ownerHead),
					'pull_request',
					() => main(['--release-owner'], f.root),
				),
			).toBe(1);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}, 20_000);

	test('merge_group equivalence: single-PR and chained batches resolve the declared-base range', () => {
		const f = buildFixture();
		try {
			// Single-PR group: clean -> no owner edits; genuine-edit group -> only
			// the PR-side edit, identical to the declared-base two-dot range.
			expect(
				changedFilesForGuard(
					f.root,
					guardContext(f.mainTip, f.groupHead, 'merge_group'),
				),
			).toEqual([]);
			expect(
				changedFilesForGuard(
					f.root,
					guardContext(f.mainTip, f.ownerGroupHead, 'merge_group'),
				),
			).toEqual(['package.json']);
			const declaredRange = git(
				f.root,
				'diff',
				'--name-only',
				'--no-renames',
				f.mainTip,
				f.ownerGroupHead,
				'--',
				...OWNER_FILES,
			)
				.split(/\r?\n/)
				.filter(Boolean);
			expect(declaredRange).toEqual(['package.json']);

			// Chained two-PR batch (base is a non-first-parent ancestor): the
			// merge-base resolves to the declared base, so both legs agree.
			expect(
				changedFilesForGuard(
					f.root,
					guardContext(f.mainTip, f.chainedCleanGroupHead, 'merge_group'),
				),
			).toEqual([]);
			expect(
				changedFilesForGuard(
					f.root,
					guardContext(f.mainTip, f.chainedOwnerGroupHead, 'merge_group'),
				),
			).toEqual(['package.json']);
			const chainedDeclaredRange = git(
				f.root,
				'diff',
				'--name-only',
				'--no-renames',
				f.mainTip,
				f.chainedOwnerGroupHead,
				'--',
				...OWNER_FILES,
			)
				.split(/\r?\n/)
				.filter(Boolean);
			expect(chainedDeclaredRange).toEqual(['package.json']);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}, 20_000);

	test('fail closed when the merge-base cannot be resolved (orphan histories)', () => {
		const f = buildFixture();
		try {
			expect(() =>
				changedFilesForGuard(f.root, guardContext(f.mainTip, f.orphanHead)),
			).toThrow(/cannot resolve merge-base/);
			expect(
				withGuardEnv(
					writePrEvent(f.root, f.mainTip, f.orphanHead),
					'pull_request',
					() => main(['--release-owner'], f.root),
				),
			).toBe(1);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}, 20_000);

	test('fail closed when a merge_group base is not the merge-base of the group head', () => {
		const f = buildFixture();
		try {
			// Shared history, but the base tip is NOT an ancestor of the head
			// (head branched at the pre-bump fork point): merge-base resolves to
			// the fork point, so the equivalence assert must fire — never a
			// silent pass and never the resolution throw.
			expect(() =>
				changedFilesForGuard(
					f.root,
					guardContext(f.mainTip, f.cleanHead, 'merge_group'),
				),
			).toThrow(/is not the merge-base/);
			expect(
				withGuardEnv(
					writeMgEvent(f.root, f.mainTip, f.cleanHead),
					'merge_group',
					() => main(['--release-owner'], f.root),
				),
			).toBe(1);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	}, 20_000);
});
