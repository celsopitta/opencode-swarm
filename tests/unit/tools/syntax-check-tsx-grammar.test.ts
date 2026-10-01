/**
 * Regression suite for #3013: syntax_check must parse `.tsx` with the tsx
 * tree-sitter grammar, not the typescript profile grammar (which has no JSX
 * production and reported false syntax errors on every valid JSX file).
 *
 * All behavioral tests run the real compute core with real WASM grammars —
 * no mock.module, no fake parsers. Grammar identity is proven by a
 * counterfactual: the pinned fixture errors under BOTH the typescript and the
 * javascript grammars, so a clean pass through the wired path can only come
 * from the tsx grammar.
 *
 * The fixture's `(): JSX.Element` return-type annotation is LOAD-BEARING: a
 * plain-JSX variant parses clean under tree-sitter-javascript, which would
 * weaken the identity proof to "not-typescript only". Do not simplify it.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getProfileForFile } from '../../../src/lang/detector';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';
import {
	getLanguageForExtension,
	listSupportedLanguages,
} from '../../../src/lang/registry';
import { loadGrammar } from '../../../src/lang/runtime';
import {
	computeSyntaxCheck,
	resolveGrammarIdForFile,
} from '../../../src/tools/syntax-check';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Byte-for-byte the frozen C1 fixture (repro/checks/tsx-valid.ts). */
const PINNED_TSX_FIXTURE =
	'export function ExportButton(): JSX.Element {\n' +
	'  return <button type="button">Export</button>;\n' +
	'}\n';

const TS_CONTROL = 'export const answer: number = 42;\n';
const BROKEN_TSX =
	'export function Broken() {\n  const x = = 5;\n  return x;\n}\n';
const VALID_C = 'int main(void) {\n  return 0;\n}\n';

const tmpRoots: string[] = [];

function makeProject(files: Record<string, string>): string {
	const root = canonicalMkdtemp('ocswarm-tsx-grammar-');
	tmpRoots.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, 'utf8');
	}
	return root;
}

function toChangedFiles(
	root: string,
): Array<{ path: string; additions: number }> {
	// Derive from the fixture map so the paths always match what was written.
	const rels: string[] = [];
	(function walk(dir: string, prefix: string) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory())
				walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
			else rels.push(`${prefix}${entry.name}`);
		}
	})(root, '');
	return rels.map((p) => ({ path: p, additions: 1 }));
}

/** Count ERROR/MISSING nodes in a raw tree-sitter tree (same walk as the tool). */
function countTreeErrors(tree: { rootNode: any }): number {
	let errors = 0;
	const stack: any[] = [tree.rootNode];
	while (stack.length > 0) {
		const node = stack.pop();
		if (node.type === 'ERROR' || node.isMissing) errors++;
		for (const child of node.children ?? []) stack.push(child);
	}
	return errors;
}

async function runCheck(root: string, languages?: string[]) {
	return computeSyntaxCheck(
		{ changed_files: toChangedFiles(root), mode: 'changed', languages },
		root,
		undefined,
		{ persistEvidence: false },
	);
}

afterEach(() => {
	while (tmpRoots.length > 0) {
		const root = tmpRoots.pop();
		if (root) fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('syntax_check tsx grammar dispatch (#3013)', () => {
	it('passes a valid .tsx file with zero errors and keeps the typescript label', async () => {
		const root = makeProject({
			'src/components/ExportButton.tsx': PINNED_TSX_FIXTURE,
		});
		const result = await runCheck(root);
		const file = result.files.find((f) => f.path.endsWith('ExportButton.tsx'));
		expect(file).toBeDefined();
		expect(file?.ok).toBe(true);
		expect(file?.errors).toHaveLength(0);
		expect(file?.language).toBe('typescript');
		expect(file?.skipped_reason).toBeUndefined();
	});

	// Scope note (PRR-004, review round 2): this and the mismatched-JSX test
	// below prove ERROR EXTRACTION works — both grammars reject broken files,
	// so they do not by themselves discriminate the tsx grammar. Grammar
	// identity is proven by the valid-JSX tests (test 1) and the
	// counterfactual in the wired-path test below.
	it('still fails a .tsx file with a real syntax error (no false negatives)', async () => {
		const root = makeProject({ 'Broken.tsx': BROKEN_TSX });
		const result = await runCheck(root);
		const file = result.files.find((f) => f.path === 'Broken.tsx');
		expect(file).toBeDefined();
		expect(file?.ok).toBe(false);
		expect(file!.errors.length).toBeGreaterThan(0);
	});

	it('still fails a .tsx file with mismatched JSX tags (representative real-world error)', async () => {
		const root = makeProject({
			'Mismatch.tsx':
				'export function Broken() {\n  return <div><span></div>;\n}\n',
		});
		const result = await runCheck(root);
		const file = result.files.find((f) => f.path === 'Mismatch.tsx');
		expect(file).toBeDefined();
		expect(file?.ok).toBe(false);
		expect(file!.errors.length).toBeGreaterThan(0);
	});

	it('keeps .ts dispatch and labeling unchanged', async () => {
		const root = makeProject({ 'Control.ts': TS_CONTROL });
		const result = await runCheck(root);
		const file = result.files.find((f) => f.path === 'Control.ts');
		expect(file?.ok).toBe(true);
		expect(file?.errors).toHaveLength(0);
		expect(file?.language).toBe('typescript');
	});

	it('resolveGrammarIdForFile pins every production branch', () => {
		expect(resolveGrammarIdForFile('a.tsx')).toBe('tsx');
		expect(resolveGrammarIdForFile('a.ts')).toBe('typescript');
		expect(resolveGrammarIdForFile('a.c')).toBe('c');
		expect(resolveGrammarIdForFile('a.unknownext')).toBeUndefined();
		// Registry-only extension (registry entry, no owning profile): the
		// override cannot fire, so the helper yields undefined and the caller
		// falls back to getParserForFile.
		expect(resolveGrammarIdForFile('a.css')).toBeUndefined();
		// Uppercase input: getProfileForFile is case-sensitive (misses), so the
		// override cannot fire even though the lowercased registry id would
		// match — the caller's getParserForFile fallback resolves it.
		expect(resolveGrammarIdForFile('A.TSX')).toBeUndefined();
		// Divergence precondition (the defect's trigger): the registries DO
		// disagree on .tsx. If this ever stops holding, the override died with it.
		expect(getLanguageForExtension('.tsx')?.id).toBe('tsx');
		expect(getProfileForFile('a.tsx')?.treeSitter.grammarId).toBe('typescript');
	});

	it('parses .c files under the registry id (same-wasm aliasing with the cpp profile)', async () => {
		const root = makeProject({ 'main.c': VALID_C });
		const result = await runCheck(root);
		const file = result.files.find((f) => f.path === 'main.c');
		expect(file?.ok).toBe(true);
		expect(file?.errors).toHaveLength(0);
		expect(file?.language).toBe('cpp');
	});

	it('proves the tsx grammar is the parser actually used, through the wired path', async () => {
		// (a) The pinned fixture — TS return annotation + JSX — passes through
		// the real compute core (the path the tool and MCP adapter share).
		const root = makeProject({ 'Widget.tsx': PINNED_TSX_FIXTURE });
		const result = await runCheck(root);
		const file = result.files.find((f) => f.path === 'Widget.tsx');
		expect(file?.ok).toBe(true);
		expect(file?.errors).toHaveLength(0);

		// (b) Counterfactual: both non-tsx candidate grammars REJECT the same
		// bytes, so the pass in (a) cannot come from either of them. Counts are
		// pinned (not just >0) so the PR/fragment narrative is tracked by code
		// (PRR-010). loadGrammar returns the shared parserCache instance, so the
		// parser is NEVER deleted here — only the per-parse tree is (PRR-001:
		// deleting a cached parser poisons the module-level cache for later
		// loadGrammar callers in the same process).
		for (const grammarId of ['typescript', 'javascript'] as const) {
			const parser = await loadGrammar(grammarId);
			const tree = parser.parse(PINNED_TSX_FIXTURE);
			const errors = tree ? countTreeErrors(tree) : 0;
			tree?.delete();
			expect(errors).toBe(2);
		}

		// (c) The resolution helper (unit pin from the branch test above).
		expect(resolveGrammarIdForFile('Widget.tsx')).toBe('tsx');
	});

	it('includes and passes .tsx under the languages filter (profile id dispatch)', async () => {
		const root = makeProject({ 'src/App.tsx': PINNED_TSX_FIXTURE });
		const included = await runCheck(root, ['typescript']);
		const file = included.files.find((f) => f.path.endsWith('App.tsx'));
		expect(file).toBeDefined();
		expect(file?.ok).toBe(true);
		expect(file?.language).toBe('typescript');

		// Negative twins (PRR-012): the filter matches PROFILE ids, so the
		// registry id 'tsx' does NOT match a .tsx file and unrelated ids
		// exclude it entirely.
		const byRegistryId = await runCheck(root, ['tsx']);
		expect(byRegistryId.files).toHaveLength(0);
		const byOther = await runCheck(root, ['python']);
		expect(byOther.files).toHaveLength(0);
	});

	it('divergence census: every registry/profile grammar divergence resolves to a loadable registry grammar', async () => {
		const divergent = new Set<string>();
		for (const def of listSupportedLanguages()) {
			for (const ext of def.extensions) {
				const profileGrammarId =
					LANGUAGE_REGISTRY.getByExtension(ext)?.treeSitter.grammarId;
				if (profileGrammarId && profileGrammarId !== def.id) divergent.add(ext);
			}
		}
		// Pin today's census. A new divergence is a deliberate contract change:
		// update this pin consciously and confirm loadGrammar coverage below.
		expect([...divergent].sort()).toEqual(['.c', '.h', '.tsx']);
		for (const ext of divergent) {
			const registryId = getLanguageForExtension(ext)?.id;
			expect(registryId).toBeDefined();
			expect(resolveGrammarIdForFile(`a${ext}`)).toBe(registryId);
			// loadGrammar returns the shared parserCache instance — never delete
			// it here (same cache-poisoning hazard as the counterfactual above).
			const parser = await loadGrammar(registryId!);
			expect(parser).toBeDefined();
		}
	});
});

/**
 * Defect-class guardrail (#3013, Phase 4.2): no production file may load a
 * tree-sitter grammar from the PROFILE registry's `treeSitter.grammarId`
 * without divergence handling. Any NEW grammar-loading site fails the scan
 * until it is consciously allowlisted, and removing or renaming a site's
 * required idiom token fails the scan at every allowlisted site. Scope
 * (implementation-review rounds 1-2): only the syntax-check entry is
 * order-sensitive — the lookbehind pins the resolver CALL, so keeping a dead
 * exported helper while reverting the call site fails (proven by the
 * mutation probe). The other five entries are token-presence checks: they
 * catch token removal/rename and force conscious allowlist edits, but NOT a
 * token-preserving reorder; behavioral coverage for that case varies by site
 * (repo-graph and symbol-graph have .tsx suite coverage; ast-diff's suite
 * has none, so its allowlist entry is its only guard).
 */
const PREDICATE_A = /loadGrammar[A-Za-z]*\s*\(|loadGrammar\s*[:}]/;
const PREDICATE_B = /treeSitter[?]?\.grammarId/;
const REQUIRED_IDIOM_ALLOWLIST: Record<string, RegExp> = {
	// The divergence-aware resolver must be CALLED, not merely exported: the
	// lookbehind skips the helper's own `function resolveGrammarIdForFile(`
	// definition line, so exporting it while reverting the call site still fails.
	'src/tools/syntax-check.ts': /(?<!function )resolveGrammarIdForFile\s*\(/,
	// Override-first JS-family map consulted before the profile-derived map.
	'src/tools/repo-graph/builder.ts': /JS_FAMILY_EXTENSION_TO_LANGUAGE/,
	// Fine-grained registry id, not the profile grammar.
	'src/diff/ast-diff.ts': /getLanguageForExtension/,
	// grammarId is a parameter sourced from repo-graph's override-aware getLanguage().
	'src/lang/symbol-graph.ts': /grammarId/,
	// The registry's own loader: loads by fine-grained definition id.
	'src/lang/registry.ts': /getParserForFile/,
	// loadGrammar definition site; ids arrive as parameters.
	'src/lang/runtime.ts': /export async function loadGrammar/,
};

/**
 * Test-only comment stripper for the required-idiom check (PRR-003): a
 * `// TODO: resolveGrammarIdForFile(`-style comment must not satisfy an
 * allowlisted idiom, so idiom matching runs on comment-stripped text. Block
 * comments (`/* ... *`+`/`) are blanked (newlines preserved), then each line
 * is truncated at the first `//`.
 *
 * Honesty note (fix-review round 1): this cannot create matches, and it is
 * fail-loud — a string literal containing a comment marker truncates the
 * line and can only cause a FALSE FAILURE. Two residual false-PASS channels
 * are accepted and documented rather than overclaimed away: (1) an idiom
 * token inside a STRING literal still satisfies the regex (closing it fully
 * would require real parsing); (2) the `://` URL guard keeps the whole line,
 * so a same-line trailing comment after a URL survives. Behavioral tests 1
 * and the wired-path counterfactual remain the authoritative backstop.
 * Predicates above still run on raw content so a new file trips the scan
 * even when it only MENTIONS a loader in a comment.
 */
function stripComments(content: string): string {
	const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, (m) =>
		m.replace(/[^\n]/g, ' '),
	);
	return withoutBlocks
		.split('\n')
		.map((line) => {
			const idx = line.indexOf('//');
			if (idx === -1) return line;
			if (idx > 0 && line[idx - 1] === ':') return line;
			return line.slice(0, idx);
		})
		.join('\n');
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) collectSourceFiles(full, acc);
		// Production scan only: co-located src/**/*.test.ts files are excluded
		// (PRR-002) — a future src-side test mentioning a loader belongs to the
		// test-infrastructure surface, not this production guardrail.
		else if (
			entry.isFile() &&
			entry.name.endsWith('.ts') &&
			!entry.name.endsWith('.test.ts')
		)
			acc.push(full);
	}
	return acc;
}

describe('grammar-dispatch guardrail scan (#3013 defect class)', () => {
	it('flags an unhandled profile-grammarId loader (synthetic instance)', () => {
		const synthetic = [
			'const profile = getProfileForFile(filePath);',
			'const grammarId = profile?.treeSitter?.grammarId;',
			'const parser = await loadGrammar(grammarId);',
		].join('\n');
		expect(PREDICATE_A.test(synthetic)).toBe(true);
		expect(PREDICATE_B.test(synthetic)).toBe(true);
		// And the recognized idiom (a CALL, not the definition) is absent.
		// Reuses the allowlist entry so the two stay in lockstep (PRR-012).
		expect(
			REQUIRED_IDIOM_ALLOWLIST['src/tools/syntax-check.ts'].test(synthetic),
		).toBe(false);
		// A comment mention never satisfies the idiom (PRR-003): the same text
		// with the call commented out must fail the required-idiom check on
		// comment-stripped content.
		const commented = `// TODO: resolveGrammarIdForFile(filePath);\nconst grammarId = profile?.treeSitter?.grammarId;\nconst parser = await loadGrammar(grammarId);`;
		expect(PREDICATE_A.test(commented)).toBe(true);
		expect(PREDICATE_B.test(commented)).toBe(true);
		expect(
			REQUIRED_IDIOM_ALLOWLIST['src/tools/syntax-check.ts'].test(
				stripComments(commented),
			),
		).toBe(false);
	});

	// The scan synchronously reads the whole src/ tree; give it an explicit
	// per-test timeout so a cold-cache developer run does not trip bun's 5s
	// default (R1, second-pass review; CI's runner already allows 120s).
	it('every production grammar-loader / profile-grammarId site follows its required idiom', () => {
		const srcRoot = path.resolve(import.meta.dir, '../../../src');
		const offenders: string[] = [];
		for (const file of collectSourceFiles(srcRoot)) {
			const rel = path.relative(srcRoot, file).replaceAll('\\', '/');
			const relFromRepo = `src/${rel}`;
			const content = fs.readFileSync(file, 'utf8');
			const matches = PREDICATE_A.test(content) || PREDICATE_B.test(content);
			if (!matches) continue;
			const required = REQUIRED_IDIOM_ALLOWLIST[relFromRepo];
			if (!required) {
				offenders.push(
					`${relFromRepo} touches tree-sitter grammar loading without an allowlist entry — route through resolveGrammarIdForFile, getParserForFile, or a parameterized grammarId with a divergence-aware source`,
				);
			} else if (!required.test(stripComments(content))) {
				offenders.push(
					`${relFromRepo} lost its recognized divergence-handling idiom (required pattern no longer present in non-comment code)`,
				);
			}
		}
		expect(offenders).toEqual([]);
	}, 30_000);
});
