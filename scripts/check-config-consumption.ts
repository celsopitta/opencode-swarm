/**
 * Config-consumption ratchet (issue #2904).
 *
 * Verifies every `CONFIG_CONSUMERS` declaration against the tree: each cited consumer
 * must exist, declare the cited symbol, and actually reference the key; a key with
 * neither real consumers nor an `inert` declaration fails. Closes the class behind
 * #2/#1663/#2109/#2524/#2580/#2583: config keys whose docs promise behavior nothing
 * reads.
 *
 * Matching model (round-hardened; the adversarial construction suite lives in
 * tests/unit/scripts/check-config-consumption.test.ts):
 *  - a reference means member access (`.KEY` with an identifier boundary), bracket
 *    access (`obj['KEY']` with a non-reserved identifier or `]` before the bracket —
 *    keyword tails like `return [` are array literals, not reads), destructure
 *    shorthand (`{ KEY`), or a quoted case label (`case 'KEY':` with a word boundary)
 *  - matching runs over comment-stripped, string-masked source: comments are inert
 *    inside strings, backslash escapes never terminate a literal, template `${...}`
 *    interpolation is scanned as code, and plain-string contents are masked EXCEPT
 *    single-token strings whose content is exactly the key (the quoted-key access
 *    form), so bracket/case text inside help strings never validates
 *  - citation paths are canonicalized (resolve `.`/`..` runs; root escape rejects;
 *    case-folded comparisons) before every rule
 *  - a citation into src/services/config-doctor.ts never satisfies the ratchet alone
 *    (that file references every key via validateConfigKey cases); keys genuinely
 *    doctor-owned are enumerated in DOCTOR_FILE_EXEMPT
 *  - DI/test seams (`_internals`, `_test_exports`) are never consumers, and
 *    src/config/schema.ts is never a consumer (schema-definition is not consumption)
 *
 * Soft-warn escape hatch: CONFIG_CONSUMPTION_ENFORCE=0|false|no|off prints findings
 * but exits 0 (mirrors resolveEnforce in check-invariants.ts; default enforces).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const DOCTOR_FILE = 'src/services/config-doctor.ts';
/** Keys genuinely owned by the doctor (issue #2904's own parenthetical): their real
 * consumers are the doctor's type-check case / migration table; no non-doctor reader exists. */
export const DOCTOR_FILE_EXEMPT = new Set(['$schema', 'config_format_version']);
/** DI/test seams — not consumers regardless of what the surrounding file reads. */
export const SEAM_SYMBOLS = new Set(['_internals', '_test_exports']);
const SCHEMA_FILE = 'src/config/schema.ts';
/** The declaration file itself references every key (the Record is exhaustive),
 * so a self-citation would let a dead key certify itself — declaration-definition
 * is not consumption, same rationale as the schema.ts ban. */
const DECLARATION_FILE = 'src/config/consumers.ts';

/** Reserved introducers whose final word-chars would otherwise read as an identifier
 * before an array literal (`return ['KEY']`, `yield ['KEY']`, ...). */
const RESERVED_BEFORE_ARRAY = new Set([
	'return', 'yield', 'typeof', 'void', 'delete', 'throw', 'new', 'in', 'of', 'else',
	'do', 'case', 'instanceof', 'default', 'await', 'extends', 'let', 'var', 'const',
]);

export type Scanned = { noComment: string; masked: string };
export type SourceTree = {
	files: Set<string>;
	readFile: (relPath: string) => string | null;
};

export type ConsumptionFinding = {
	kind:
		| 'undeclared-key'
		| 'missing-file'
		| 'symbol-missing'
		| 'stale-citation'
		| 'path-not-allowed'
		| 'seam-symbol'
		| 'empty-consumers'
		| 'empty-inert-reason'
		| 'dual-shape'
		| 'doctor-file-only';
	key: string;
	citation?: string;
	detail: string;
};

// ---------------------------------------------------------------------------
// Scanner: comments stripped string-aware; plain-string contents masked (except
// exact-key tokens); template text masked with ${...} interpolation kept as code.
// ---------------------------------------------------------------------------
export function scanSource(src: string, keep?: string): Scanned {
	const n = src.length;
	const nc = src.split('');
	const mk = src.split('');
	const mask = (i: number) => {
		nc[i] = ' ';
		mk[i] = ' ';
	};
	const maskRun = (a: number, b: number) => {
		for (let k = a; k < b; k++) {
			if (mk[k] !== '\n') mk[k] = ' ';
		}
	};
	let i = 0;
	const stack: Array<{ kind: 'tpl' | 'interp'; depth: number }> = [];
	const st = (): 'code' | 'interp' | 'tpl' =>
		stack.length === 0 ? 'code' : stack[stack.length - 1].kind;
	while (i < n) {
		const c = src[i];
		const c2 = src[i + 1];
		const s = st();
		if (s === 'code' || s === 'interp') {
			if (c === '/' && c2 === '/') {
				let j = i;
				while (j < n && src[j] !== '\n') {
					mask(j);
					j++;
				}
				i = j;
				continue;
			}
			if (c === '/' && c2 === '*') {
				let j = i + 2;
				while (j < n - 1 && !(src[j] === '*' && src[j + 1] === '/')) {
					mask(j);
					j++;
				}
				for (let k = i; k < Math.min(j + 2, n); k++) mask(k);
				i = j + 2;
				continue;
			}
			if (c === "'" || c === '"') {
				let j = i + 1;
				while (j < n) {
					if (src[j] === '\\') {
						j += 2;
						continue;
					}
					if (src[j] === c) break;
					if (src[j] === '\n') break;
					j++;
				}
				const content = src.slice(i + 1, Math.min(j, n));
				if (content !== keep) maskRun(i + 1, Math.min(j, n));
				i = Math.min(j + 1, n);
				continue;
			}
			if (c === '`') {
				stack.push({ kind: 'tpl', depth: 0 });
				i++;
				continue;
			}
			if (s === 'interp') {
				const top = stack[stack.length - 1];
				if (c === '{') {
					top.depth++;
					i++;
					continue;
				}
				if (c === '}') {
					top.depth--;
					if (top.depth <= 0) stack.pop();
					i++;
					continue;
				}
			}
			i++;
			continue;
		}
		// template text
		if (c === '\\') {
			mk[i] = ' ';
			if (i + 1 < n) mk[i + 1] = ' ';
			i += 2;
			continue;
		}
		if (c === '`') {
			stack.pop();
			i++;
			continue;
		}
		if (c === '$' && c2 === '{') {
			stack.push({ kind: 'interp', depth: 1 });
			i += 2;
			continue;
		}
		if (c !== '\n') mk[i] = ' ';
		i++;
		continue;
	}
	return { noComment: nc.join(''), masked: mk.join('') };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Token-precise bracket-access detection: `['KEY']` preceded by a non-reserved
 * identifier (e.g. `cfg['KEY']`) or `]` (chained `rows[0]['KEY']`). Keyword tails
 * (`return [`, `yield [`) and non-identifier contexts (`=`, `,`, `:`, `(`) are array
 * literals or non-access; bare `)` before `[` (the `fn()['KEY']` form) is deliberately
 * narrowed out — no such form exists among real citations and the narrowing is
 * suite-pinned. */
export function bracketAccessMatches(masked: string, key: string): boolean {
	const k = escapeRe(key);
	const re = new RegExp(`\\[\\s*['"]${k}['"]\\s*\\]`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(masked)) !== null) {
		let i = m.index - 1;
		while (i >= 0 && /\s/.test(masked[i])) i--;
		if (i < 0) continue;
		const ch = masked[i];
		if (ch === ']') return true;
		if (/[A-Za-z0-9_$]/.test(ch)) {
			let j = i;
			while (j >= 0 && /[A-Za-z0-9_$]/.test(masked[j])) j--;
			const ident = masked.slice(j + 1, i + 1);
			if (!RESERVED_BEFORE_ARRAY.has(ident)) return true;
			continue;
		}
		// anything else — array literal or non-access context; keep looking
	}
	return false;
}

export function keyReferenced(key: string, noKeep: Scanned, keep: Scanned): boolean {
	const k = escapeRe(key);
	if (new RegExp(`\\.${k}\\b`).test(noKeep.masked)) return true;
	if (new RegExp(`\\{\\s*${k}\\b`).test(noKeep.masked)) return true;
	if (bracketAccessMatches(keep.masked, key)) return true;
	if (new RegExp(`\\bcase\\s*['"]${k}['"]`).test(keep.masked)) return true;
	return false;
}

export function symbolDeclared(sym: string, scanned: Scanned): boolean {
	const s = escapeRe(sym);
	const re = new RegExp(
		`(?:export\\s+)?(?:async\\s+)?function\\s+${s}\\b` +
			`|(?:export\\s+)?const\\s+${s}\\b` +
			`|(?:export\\s+)?class\\s+${s}\\b` +
			`|(?:export\\s+)?let\\s+${s}\\b` +
			`|(?:export\\s+)?type\\s+${s}\\b`,
	);
	return re.test(scanned.noComment);
}

/** Resolve `.`/`..` segment runs (POSIX form); a `..` escaping the root returns null. */
export function canonicalizeCitationPath(file: string): string | null {
	const parts = file.replaceAll('\\', '/').split('/');
	const out: string[] = [];
	for (const part of parts) {
		if (part === '' || part === '.') continue;
		if (part === '..') {
			if (out.length > 0) {
				out.pop();
				continue;
			}
			return null;
		}
		out.push(part);
	}
	return out.join('/');
}

export function citationAllowed(file: string): boolean {
	const f = canonicalizeCitationPath(file);
	if (f === null) return false;
	const lower = f.toLowerCase();
	if (!f.startsWith('src/')) return false;
	if (lower.endsWith('.test.ts') || lower.endsWith('.test.tsx')) return false;
	if (lower === SCHEMA_FILE) return false;
	if (lower === DECLARATION_FILE) return false;
	return true;
}

function isDoctorCitation(citation: string): boolean {
	const idx = citation.lastIndexOf(':');
	const file = idx === -1 ? citation : citation.slice(0, idx);
	const canon = canonicalizeCitationPath(file);
	return canon !== null && canon.toLowerCase() === DOCTOR_FILE;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------
export type Declaration = { consumers?: unknown; inert?: unknown };

export interface CollectOptions {
	/** top-level schema keys (from PluginConfigSchema.shape) */
	schemaKeys: string[];
	/** key -> declaration from CONFIG_CONSUMERS */
	declarations: Record<string, Declaration>;
	tree: SourceTree;
}

export function collectFindings(opts: CollectOptions): ConsumptionFinding[] {
	const findings: ConsumptionFinding[] = [];
	const declared = new Set(Object.keys(opts.declarations));
	for (const key of opts.schemaKeys) {
		if (!declared.has(key)) {
			findings.push({
				kind: 'undeclared-key',
				key,
				detail: `no CONFIG_CONSUMERS entry (add consumers citations or an inert declaration)`,
			});
		}
	}
	for (const [key, rawDecl] of Object.entries(opts.declarations)) {
		if (!opts.schemaKeys.includes(key)) continue; // extraneous keys fail typecheck, not this gate
		const hasConsumers = rawDecl.consumers !== undefined;
		const hasInert = rawDecl.inert !== undefined;
		if (hasConsumers && hasInert) {
			findings.push({ kind: 'dual-shape', key, detail: 'declaration carries both consumers and inert' });
			continue;
		}
		if (hasInert) {
			if (typeof rawDecl.inert !== 'string' || rawDecl.inert.trim() === '') {
				findings.push({ kind: 'empty-inert-reason', key, detail: 'inert declaration requires a non-empty reason' });
			}
			continue;
		}
		const consumers = rawDecl.consumers;
		if (!Array.isArray(consumers) || consumers.length === 0) {
			findings.push({ kind: 'empty-consumers', key, detail: 'consumers must be a non-empty citation list (or declare inert)' });
			continue;
		}
		let sawNonDoctor = false;
		for (const cite of consumers) {
			if (typeof cite !== 'string') {
				findings.push({ kind: 'stale-citation', key, citation: String(cite), detail: 'citation must be a path:symbol string' });
				continue;
			}
			const colon = cite.lastIndexOf(':');
			if (colon === -1) {
				findings.push({ kind: 'stale-citation', key, citation: cite, detail: 'citation must be path:symbol' });
				continue;
			}
			const rawFile = cite.slice(0, colon);
			const symbol = cite.slice(colon + 1);
			const canonical = canonicalizeCitationPath(rawFile);
			if (canonical === null) {
				findings.push({ kind: 'path-not-allowed', key, citation: cite, detail: `path escapes the repository root` });
				continue;
			}
			const file = canonical;
			const citeCanon = `${file}:${symbol}`;
			if (SEAM_SYMBOLS.has(symbol)) {
				findings.push({ kind: 'seam-symbol', key, citation: citeCanon, detail: `DI/test seam symbols are not consumers` });
				continue;
			}
			if (!citationAllowed(rawFile)) {
				findings.push({
					kind: 'path-not-allowed',
					key,
					citation: citeCanon,
					detail: `citations must live in non-test src/** and never in ${SCHEMA_FILE} or ${DECLARATION_FILE} (schema/declaration-definition is not consumption)`,
				});
				continue;
			}
			// Placement is a property of where the citation LIVES, not whether it is
			// fresh — set it before the freshness checks so a stale non-doctor
			// citation reports only [stale-citation], never a misleading
			// [doctor-file-only] on top.
			if (!isDoctorCitation(citeCanon)) sawNonDoctor = true;
			if (!opts.tree.files.has(file)) {
				findings.push({ kind: 'missing-file', key, citation: citeCanon, detail: `cited file does not exist` });
				continue;
			}
			const raw = opts.tree.readFile(file);
			if (raw === null) {
				findings.push({ kind: 'missing-file', key, citation: citeCanon, detail: `cited file is unreadable` });
				continue;
			}
			const noKeep = scanSource(raw, '');
			if (!symbolDeclared(symbol, noKeep)) {
				findings.push({ kind: 'symbol-missing', key, citation: citeCanon, detail: `symbol is not declared in the cited file` });
				continue;
			}
			const keep = scanSource(raw, key);
			if (!keyReferenced(key, noKeep, keep)) {
				findings.push({ kind: 'stale-citation', key, citation: citeCanon, detail: `cited file does not reference the key (stale citation)` });
			}
		}
		if (!sawNonDoctor && !DOCTOR_FILE_EXEMPT.has(key)) {
			findings.push({
				kind: 'doctor-file-only',
				key,
				detail: `every citation lives in ${DOCTOR_FILE}, which references every key via validateConfigKey — a real consumer outside it (or an inert declaration, or a DOCTOR_FILE_EXEMPT entry with justification) is required`,
			});
		}
	}
	return findings;
}

export function formatFindings(findings: ConsumptionFinding[]): string {
	if (findings.length === 0) return 'check-config-consumption: OK — every declared consumer verified.';
	const lines = findings.map(
		(f) =>
			`check-config-consumption: [${f.kind}] ${f.key}${f.citation ? ` ${f.citation}` : ''} — ${f.detail}`,
	);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Real-tree main
// ---------------------------------------------------------------------------
function walkSrc(root: string): SourceTree {
	const files = new Set<string>();
	const readCache = new Map<string, string | null>();
	const walk = (dir: string) => {
		let dirents;
		try {
			dirents = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of dirents) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) {
				files.add(path.relative(root, p).replaceAll('\\', '/'));
			}
		}
	};
	walk(path.join(root, 'src'));
	return {
		files,
		readFile: (rel: string) => {
			if (readCache.has(rel)) return readCache.get(rel) ?? null;
			let content: string | null = null;
			try {
				content = readFileSync(path.join(root, rel), 'utf8');
			} catch {
				content = null;
			}
			readCache.set(rel, content);
			return content;
		},
	};
}

function resolveEnforce(raw: string | undefined): boolean {
	if (raw === undefined) return true;
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

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	let root = path.resolve(import.meta.dir, '..');
	while (args.length > 0) {
		const a = args.shift() as string;
		if (a === '--root') {
			root = path.resolve(args.shift() as string);
		}
	}
	const schemaUrl = pathToFileURL(path.join(root, 'src/config/schema.ts')).href;
	const consumersUrl = pathToFileURL(path.join(root, 'src/config/consumers.ts')).href;
	if (!existsSync(path.join(root, 'src/config/consumers.ts'))) {
		console.error('check-config-consumption: src/config/consumers.ts not found under the given root');
		return 1;
	}
	const schemaMod = (await import(schemaUrl)) as { PluginConfigSchema: { shape: Record<string, unknown> } };
	const consumersMod = (await import(consumersUrl)) as {
		CONFIG_CONSUMERS: Record<string, Declaration>;
	};
	const schemaKeys = Object.keys(schemaMod.PluginConfigSchema.shape);
	const findings = collectFindings({
		schemaKeys,
		declarations: consumersMod.CONFIG_CONSUMERS,
		tree: walkSrc(root),
	});
	if (findings.length > 0) {
		console.error(formatFindings(findings));
		if (!resolveEnforce(process.env.CONFIG_CONSUMPTION_ENFORCE)) {
			console.error('CONFIG_CONSUMPTION_ENFORCE is off — soft-warn (non-blocking).');
			return 0;
		}
		return 1;
	}
	console.log(formatFindings(findings));
	console.log(`check-config-consumption: ${schemaKeys.length} keys verified.`);
	return 0;
}

if (import.meta.main) {
	process.exit(await main());
}
