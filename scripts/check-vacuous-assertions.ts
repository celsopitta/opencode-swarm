#!/usr/bin/env bun
/**
 * Issue #2903 — diff-scoped ratchet for structurally vacuous test assertions.
 *
 * A vacuous assertion cannot fail regardless of the behavior under test, so a
 * test carrying one proves nothing (e.g. `expect(x.length).toBeGreaterThanOrEqual(0)`,
 * `expect(true).toBe(true)`). This gate blocks NEW occurrences in `*.test.ts`
 * files under `tests/` and `src/`, mirroring the shape of
 * `scripts/check-test-file-cap.ts` (issue #2078): TypeScript, pure decision
 * logic behind injected I/O, `git diff --name-only -z <base> HEAD`, repo root
 * via `git rev-parse --show-toplevel`.
 *
 * Run it anywhere:
 *
 *   bun run scripts/check-vacuous-assertions.ts
 *
 * Modes:
 *   (default)         diff-scoped ratchet: changed *.test.ts files must not
 *                     gain unmarked vacuous sites beyond the committed
 *                     baseline; the baseline itself may only shrink vs the
 *                     base branch. Exit 1 on violations.
 *   --all             full scan of tests/ + src/ *.test.ts; lists every
 *                     UNMARKED site as `file:line: rule <id>` plus a summary;
 *                     exit 0 (listing mode).
 *   --check-file <p>  scan one file, print `file:line: rule <id>` lines; exit 0.
 *   --write-baseline  regenerate scripts/vacuous-assertion-baseline.json from
 *                     the current tree (maintenance; growth is still blocked
 *                     by the baseline arm at check time).
 *
 * Ratchet semantics:
 *   - Reporting is MARKER-scoped: a site whose own line or the immediately
 *     preceding line contains `// vacuous-ok: <reason>` is exempt everywhere.
 *   - The baseline (flat JSON map path -> unmarked-site count) affects only
 *     the diff arm: a changed file with no entry must be at 0, with an entry
 *     must be <= the entry. Shrinking is always allowed.
 *   - Rules are evaluated per line in a fixed order and the FIRST match wins
 *     (at most one finding per line), so `expect(true).toBe(true)` reports as
 *     true-to-be-true, not literal-same-to-be.
 *   - len-ge-0 / size-ge-0 deliberately use the same no-inner-paren body as
 *     the issue #2903 enumeration (indexOf/findIndex/search results cannot
 *     match because their inner parens cannot be crossed and they carry no
 *     .length/.size accessor).
 *   - Known residual gap, documented deliberately: `expect(NaN).toBe(NaN)` is
 *     vacuous under Object.is but outside the frozen rule set.
 *   - `expect(null).toBeDefined()` IS flagged (null is a defined value, so the
 *     assertion can never fail); `expect(undefined).toBeDefined()` is not —
 *     it is unsatisfiable rather than vacuous, so flagging it would be noise.
 *   - A corrupt or unreadable BASE-side baseline collapses into the
 *     "Baseline introduction" path (the shrink-only arm then starts on the
 *     next PR); a corrupt WORKING-TREE baseline instead degrades to an empty
 *     map, which makes the diff arm stricter (fail-closed).
 *   - Base-drift note: like every frozen-baseline gate, a main-side PR that
 *     lands an unmarked site after this branch point can surface as a diff-arm
 *     violation here; the sanctioned recovery is rebase onto fresh main, then
 *     `--write-baseline` (introduction merges skip the baseline arm), then
 *     re-run.
 *
 * Escape hatch: VACUOUS_ASSERT_ENFORCE. Default is ENFORCE (unset → fail).
 * Set VACUOUS_ASSERT_ENFORCE=0|false|no|off to soft-warn (print violations,
 * exit 0) — useful for a deliberate probe PR.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The five frozen rule ids, in evaluation (precedence) order. */
export const RULE_IDS = [
	'len-ge-0',
	'size-ge-0',
	'true-to-be-true',
	'literal-same-to-be',
	'literal-to-be-defined',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/** Only `*.test.ts` files participate. */
export const TEST_FILE_PATTERN = /\.test\.ts$/;

/** Directories never scanned by --all (defensive; none expected under tests/src). */
const SKIPPED_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);

/** Marker that exempts a site on its own or the preceding line. */
export const MARKER = 'vacuous-ok:';

/**
 * Byte-compatible with the issue #2903 enumeration scanner: the body cannot
 * cross an inner paren pair, so indexOf(...)/findIndex(...)/search(...) call
 * results never match, and the required .length/.size accessor excludes bare
 * numeric counters.
 */
const LEN_GE_0 = /expect\([^()\r\n]*\.length\)\.toBeGreaterThanOrEqual\(\s*0\s*\)/;
const SIZE_GE_0 = /expect\([^()\r\n]*\.size\)\.toBeGreaterThanOrEqual\(\s*0\s*\)/;
const TRUE_TO_BE_TRUE = /expect\(\s*true\s*\)\s*\.\s*toBe\(\s*true\s*\)/;

/** A single literal token: quoted string, numeric literal, or keyword. */
const LITERAL_BODY = String.raw`(?:'(?:[^'\\\r\n]|\\.)*'|"(?:[^"\\\r\n]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null|undefined)`;
const LITERAL_SAME_TO_BE = new RegExp(
	`expect\\((\\s*${LITERAL_BODY}\\s*)\\)\\s*\\.\\s*toBe\\((\\s*${LITERAL_BODY}\\s*)\\)`,
);
const LITERAL_TO_BE_DEFINED = new RegExp(
	`expect\\(\\s*(?:'(?:[^'\\\r\n]|\\\\.)*'|"(?:[^"\\\r\n]|\\\\.)*"|-?\\d+(?:\\.\\d+)?|true|false|null)\\s*\\)\\s*\\.\\s*toBeDefined\\(\\)`,
);

interface NormalizedLiteral {
	kind: 'string' | 'number' | 'keyword';
	value: string;
}

/** Trim, unquote, and kind-tag a captured literal so `'a'` equals `"a"` and `7` equals ` 7 `. */
export function normalizeLiteral(raw: string): NormalizedLiteral | null {
	const t = raw.trim();
	if (t.length === 0) {
		return null;
	}
	if (
		(t.startsWith("'") && t.endsWith("'") && t.length >= 2) ||
		(t.startsWith('"') && t.endsWith('"') && t.length >= 2)
	) {
		return { kind: 'string', value: t.slice(1, -1) };
	}
	if (/^-?\d+(?:\.\d+)?$/.test(t)) {
		return { kind: 'number', value: String(Number(t)) };
	}
	if (t === 'true' || t === 'false' || t === 'null' || t === 'undefined') {
		return { kind: 'keyword', value: t };
	}
	return null;
}

/** Kind-tagged equality: quoted content never equals a numeric value (`expect('7').toBe(7)` is NOT flagged). */
export function literalsEqual(a: string, b: string): boolean {
	const na = normalizeLiteral(a);
	const nb = normalizeLiteral(b);
	if (!na || !nb || na.kind !== nb.kind) {
		return false;
	}
	return na.value === nb.value;
}

export interface VacuousSite {
	line: number;
	rule: RuleId;
}

/**
 * Scan one file's content. `content` is raw (CRLF or LF); lines are split on
 * CR-stripped boundaries. Marker exemption: own line or preceding line.
 */
export function scanContent(content: string): VacuousSite[] {
	const lines = content.replace(/\r/g, '').split('\n');
	const sites: VacuousSite[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (line.includes(MARKER)) {
			continue;
		}
		if (i > 0 && lines[i - 1].includes(MARKER)) {
			continue;
		}
		let rule: RuleId | null = null;
		if (LEN_GE_0.test(line)) {
			rule = 'len-ge-0';
		} else if (SIZE_GE_0.test(line)) {
			rule = 'size-ge-0';
		} else if (TRUE_TO_BE_TRUE.test(line)) {
			rule = 'true-to-be-true';
		} else {
			const same = line.match(LITERAL_SAME_TO_BE);
			if (same && literalsEqual(same[1] ?? '', same[2] ?? '')) {
				rule = 'literal-same-to-be';
			} else if (LITERAL_TO_BE_DEFINED.test(line)) {
				rule = 'literal-to-be-defined';
			}
		}
		if (rule) {
			sites.push({ line: i + 1, rule });
		}
	}
	return sites;
}

/**
 * VACUOUS_ASSERT_ENFORCE truth table (mirrors TEST_CAP_ENFORCE): unset or any
 * value other than 0/false/no/off → enforce; those four → soft-warn.
 */
export function resolveEnforce(raw: string | undefined): boolean {
	if (raw === undefined) {
		return true;
	}
	switch (raw.toLowerCase()) {
		case '0':
		case 'false':
		case 'no':
		case 'off':
			return false;
		default:
			return true;
	}
}

/** Parse the flat baseline map: numeric-valued top-level keys only; `$comment` and friends ignored. */
export function parseBaseline(text: string): Record<string, number> {
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('check-vacuous-assertions: baseline must be a flat JSON object');
	}
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
			out[key] = value;
		}
	}
	return out;
}

export interface RatchetEvaluationInput {
	/** Files changed between the base branch and HEAD (repo-relative paths). */
	changedFiles: string[];
	/** Current unmarked-site count, or null when the path is absent (deleted). */
	currentCount: (file: string) => number | null;
	/** The committed baseline map (flat path -> count). */
	baseline: Record<string, number>;
	/** The base branch's baseline map, or null when the baseline is absent at base (introduction). */
	baselineAtBase: Record<string, number> | null;
	enforce: boolean;
}

export interface RatchetEvaluationResult {
	messages: string[];
	newFileViolations: number;
	ratchetViolations: number;
	baselineGrowthViolations: number;
	violations: number;
	exitCode: number;
}

/** Pure ratchet evaluation. All I/O (git, filesystem) is injected. */
export function evaluateRatchet(input: RatchetEvaluationInput): RatchetEvaluationResult {
	const messages: string[] = [];
	let newFileViolations = 0;
	let ratchetViolations = 0;

	for (const file of input.changedFiles) {
		if (!file || !TEST_FILE_PATTERN.test(file)) {
			continue;
		}
		const now = input.currentCount(file);
		if (now === null) {
			// Deleted in the diff, or otherwise not a file in the tree.
			continue;
		}
		const allowed = input.baseline[file];
		if (allowed === undefined) {
			if (now > 0) {
				messages.push(
					`ERROR (new occurrences): ${file} has ${now} unmarked vacuous assertion site(s) and no usable baseline entry (missing or dropped as non-numeric) (issue #2903).`,
				);
				messages.push(
					'  Replace with a concrete falsifiable expectation, or mark the deliberate probe with `// vacuous-ok: <reason>`.',
				);
				newFileViolations++;
			}
			continue;
		}
		if (now > allowed) {
			messages.push(
				`ERROR (ratchet): ${file} grew from ${allowed} to ${now} unmarked vacuous assertion site(s) (issue #2903).`,
			);
			messages.push(
				'  Vacuous-assertion debt may only shrink. Fix or mark the new site(s); do not raise the baseline.',
			);
			ratchetViolations++;
		}
	}

	let baselineGrowthViolations = 0;
	if (input.baselineAtBase !== null) {
		for (const [file, count] of Object.entries(input.baseline)) {
			const baseCount = input.baselineAtBase[file];
			if (baseCount === undefined) {
				messages.push(
					`ERROR (baseline growth): baseline gained new entry ${file} (${count}) vs the base branch (issue #2903).`,
				);
				baselineGrowthViolations++;
			} else if (count > baseCount) {
				messages.push(
					`ERROR (baseline growth): baseline entry ${file} grew from ${baseCount} to ${count} vs the base branch (issue #2903).`,
				);
				baselineGrowthViolations++;
			}
		}
	} else {
		messages.push(
			'Baseline introduction: no baseline at the base branch — the shrink-only arm starts on the next PR.',
		);
	}

	const violations = newFileViolations + ratchetViolations + baselineGrowthViolations;
	messages.push('');
	messages.push('=== Vacuous assertion ratchet (issue #2903) summary ===');
	messages.push(`New-occurrence violations: ${newFileViolations}`);
	messages.push(`Ratchet violations:        ${ratchetViolations}`);
	messages.push(`Baseline-growth violations: ${baselineGrowthViolations}`);

	let exitCode = 0;
	if (violations > 0) {
		if (input.enforce) {
			messages.push('VACUOUS_ASSERT_ENFORCE is on (default). Failing the build.');
			exitCode = 1;
		} else {
			messages.push('VACUOUS_ASSERT_ENFORCE is off — soft-warn (non-blocking).');
		}
	} else {
		messages.push('All vacuous-assertion checks passed.');
	}

	return {
		messages,
		newFileViolations,
		ratchetViolations,
		baselineGrowthViolations,
		violations,
		exitCode,
	};
}

// --- git plumbing -----------------------------------------------------------

interface GitResult {
	exitCode: number;
	stdout: string;
}

function runGit(args: string[], cwd: string): GitResult {
	let proc: ReturnType<typeof Bun.spawnSync>;
	try {
		proc = Bun.spawnSync({
			cmd: ['git', ...args],
			cwd,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
		});
	} catch (error) {
		throw new Error(
			`check-vacuous-assertions: failed to run \`git ${args.join(' ')}\` — is git on PATH? (${String(error)})`,
		);
	}
	return {
		exitCode: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
	};
}

/** Resolve the repository root so the gate behaves identically from any cwd (issue #2078 review finding 2). */
export function resolveRepoRoot(cwd: string): string {
	const top = runGit(['rev-parse', '--show-toplevel'], cwd);
	if (top.exitCode !== 0) {
		return cwd;
	}
	const trimmed = top.stdout.trim();
	return trimmed.length > 0 ? path.resolve(trimmed) : cwd;
}

/** Split a NUL-separated `git -z` path list. */
export function splitNulList(raw: string): string[] {
	return raw.split('\0').filter((entry) => entry.length > 0);
}

export const BASE_BRANCH_CANDIDATES = [
	'origin/main',
	'origin/master',
	'main',
	'master',
] as const;

export function resolveBaseBranch(cwd: string): string | null {
	for (const branch of BASE_BRANCH_CANDIDATES) {
		if (runGit(['rev-parse', branch], cwd).exitCode === 0) {
			return branch;
		}
	}
	return null;
}

const BASELINE_PATH = 'scripts/vacuous-assertion-baseline.json';

function readBaselineAt(root: string): Record<string, number> {
	const abs = path.join(root, BASELINE_PATH);
	const text = fs.readFileSync(abs, 'utf8');
	return parseBaseline(text);
}

/** Recursively collect *.test.ts files under the two scan roots. */
export function collectTestFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (SKIPPED_DIR_NAMES.has(entry.name)) {
				continue;
			}
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(abs);
			} else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
				out.push(path.relative(root, abs).split(path.sep).join('/'));
			}
		}
	};
	for (const scanRoot of ['tests', 'src']) {
		walk(path.join(root, scanRoot));
	}
	out.sort();
	return out;
}

function countFile(root: string, rel: string): number | null {
	const abs = path.resolve(root, rel);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(abs);
	} catch {
		return null;
	}
	if (!stat.isFile()) {
		return null;
	}
	return scanContent(fs.readFileSync(abs, 'utf8')).length;
}

function printSites(root: string, files: string[]): number {
	const byRule = new Map<RuleId, number>();
	let total = 0;
	for (const rel of files) {
		const sites = scanContent(fs.readFileSync(path.resolve(root, rel), 'utf8'));
		for (const site of sites) {
			console.log(`${rel}:${site.line}: rule ${site.rule}`);
			byRule.set(site.rule, (byRule.get(site.rule) ?? 0) + 1);
			total++;
		}
	}
	console.log('');
	console.log('=== Vacuous assertion scan (issue #2903) summary ===');
	for (const id of RULE_IDS) {
		console.log(`${id}: ${byRule.get(id) ?? 0}`);
	}
	console.log(`total: ${total}`);
	return total;
}

export function main(startDir: string = process.cwd(), argv: string[] = process.argv.slice(2)): number {
	const cwd = resolveRepoRoot(startDir);

	if (argv.includes('--write-baseline')) {
		const files = collectTestFiles(cwd);
		const entries: Record<string, number> = {
			$comment:
				'Issue #2903 vacuous-assertion debt baseline. Flat map: repo-relative *.test.ts path -> unmarked site count. May only shrink vs the base branch; regenerate with `bun scripts/check-vacuous-assertions.ts --write-baseline` AFTER removing sites.',
		};
		let total = 0;
		for (const rel of files) {
			const count = countFile(cwd, rel);
			if (count !== null && count > 0) {
				entries[rel] = count;
				total += count;
			}
		}
		fs.writeFileSync(
			path.join(cwd, BASELINE_PATH),
			`${JSON.stringify(entries, null, '\t')}\n`,
			'utf8',
		);
		console.log(`Baseline written: ${Object.keys(entries).length - 1} file(s), ${total} unmarked site(s).`);
		return 0;
	}

	const checkFileIdx = argv.indexOf('--check-file');
	if (checkFileIdx !== -1) {
		const target = argv[checkFileIdx + 1];
		if (!target) {
			console.error('check-vacuous-assertions: --check-file requires a path argument');
			return 2;
		}
		const rel = path.isAbsolute(target)
			? path.relative(cwd, target).split(path.sep).join('/')
			: target;
		let sites: VacuousSite[];
		try {
			sites = scanContent(fs.readFileSync(path.resolve(cwd, rel), 'utf8'));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | null)?.code ?? 'unreadable';
			console.error(`check-vacuous-assertions: cannot read ${rel} (${code})`);
			return 2;
		}
		for (const site of sites) {
			console.log(`${rel}:${site.line}: rule ${site.rule}`);
		}
		console.log('');
		console.log(`${rel}: ${sites.length} unmarked site(s).`);
		return 0;
	}

	if (argv.includes('--all')) {
		const files = collectTestFiles(cwd);
		printSites(cwd, files);
		return 0;
	}

	// Default: diff-scoped ratchet.
	const baseBranch = resolveBaseBranch(cwd);
	let changedFiles: string[] = [];
	if (baseBranch) {
		const changed = runGit(['diff', '--name-only', '-z', baseBranch, 'HEAD'], cwd);
		if (changed.exitCode === 0) {
			changedFiles = splitNulList(changed.stdout);
		}
	} else {
		messagesNoBase();
	}

	let baseline: Record<string, number> = {};
	try {
		baseline = readBaselineAt(cwd);
	} catch {
		baseline = {};
	}

	let baselineAtBase: Record<string, number> | null = null;
	if (baseBranch) {
		const show = runGit(['show', `${baseBranch}:${BASELINE_PATH}`], cwd);
		if (show.exitCode === 0) {
			try {
				baselineAtBase = parseBaseline(show.stdout);
			} catch {
				baselineAtBase = null;
			}
		}
	}

	const result = evaluateRatchet({
		changedFiles,
		baseline,
		baselineAtBase,
		enforce: resolveEnforce(process.env.VACUOUS_ASSERT_ENFORCE),
		currentCount: (file) => countFile(cwd, file),
	});
	for (const line of result.messages) {
		console.log(line);
	}
	return result.exitCode;
}

function messagesNoBase(): void {
	console.log('check-vacuous-assertions: no base branch resolved; the diff arm is vacuous in this checkout.');
	console.log('  (This is expected outside a git worktree with a main/master ref.)');
}

const isDirectRun =
	typeof process.argv[1] === 'string' &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
	process.exit(main());
}
