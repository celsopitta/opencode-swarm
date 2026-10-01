# syntax_check: parse .tsx with the tsx grammar — no more false syntax errors on valid JSX (issue #3013)

## What

- `syntax_check` resolved its tree-sitter grammar **profile-first**: `getProfileForFile()` → `profile.treeSitter.grammarId`. Because the `typescript` profile claims `.tsx`, every `.tsx` file parsed with `tree-sitter-typescript.wasm`, which has no JSX production — valid JSX parsed into ERROR/MISSING nodes and the gate failed files that `tsc` and `vite build` accepted (11 consecutive false rejections in the reporting session). The correct `tree-sitter-tsx.wasm` was vendored and mapped in `LANGUAGE_WASM_MAP` all along but unreachable.
- New exported pure helper `resolveGrammarIdForFile(filePath)` in `src/tools/syntax-check.ts`: when the fine-grained parser registry (`src/lang/registry.ts`) assigns an extension a different parser id than the owning profile's grammarId, the registry id wins for PARSING; profiles stay authoritative for dispatch, detection, and reporting labels. This mirrors the existing repo-graph precedent (`JS_FAMILY_EXTENSION_TO_LANGUAGE` consulted before the profile-derived map).
- `checkOneFile` now resolves its grammar through the helper. Behavioral delta is exactly: `.tsx` → `tsx` grammar (the fix); `.c`/`.h` → registry id `c` (same `tree-sitter-cpp.wasm` as the cpp profile grammar — parse-identical); everything else unchanged, including the `languages` filter and `language` labels (`typescript` for `.tsx`).
  The `languages` filter matches profile ids, so `languages: ['tsx']` still excludes `.tsx` files — use `['typescript']`.
- New suite `tests/unit/tools/syntax-check-tsx-grammar.test.ts` (real WASM grammars, no mocks): valid/broken `.tsx` behavior, `.ts` and label parity, per-branch helper pins, a grammar-identity proof through the wired path (the pinned fixture — TS return annotation + JSX — errors under both the typescript and javascript grammars, so a clean pass can only come from the tsx grammar), the `languages:['typescript']` filter pin, a live divergence census, and a defect-class guardrail scan that fails on any NEW grammar-loading site until it is consciously allowlisted with its recognized divergence-handling idiom (the syntax-check entry is order-sensitive and bites on call-site regressions; the other five entries document each site's idiom).
- `docs/adding-a-language.md`: one sentence stating that on registry/profile id divergence, parse identity follows the fine-grained registry id.

## Why

Issue #3013: `syntax_check` was the #2 gate-rejection source in a reporting session, all 11 rejections on `.tsx` files that compiled cleanly — blocking Stage A on React/TSX projects and driving the coder into unnecessary repair loops. `syntax_check.ts` was the sole shadowing site: repo-graph already overrode `.tsx`→tsx, and ast-diff/placeholder-scan resolve through the fine-grained registry.

## Verification

- Pre-fix replay at base 7da78668b (frozen acceptance check C1): `CHECK-RESULT tsx-valid FAIL ok=false errors=2 first=2:16 Missing '>'`; post-fix: `CHECK-RESULT tsx-valid PASS ok=true errors=0 language=typescript`. True positives preserved (`const x = = 5;` in `.tsx` still fails), `.ts` dispatch and `typescript` labeling unchanged, `.tsx`-only projects still detect the TypeScript profile, and the profile-registry parity suite stays green untouched.
- Grammar-level isolation: the reporter's fixture yields 2 error nodes under `loadGrammar('typescript')`, 2 under `loadGrammar('javascript')`, and 0 under `loadGrammar('tsx')`.
- Impacted direct-importer suites all green: syntax-check (.test/.profile/.profile-adversarial/.adversarial), gates-config-wiring, lang/profile-registry-parity, mcp/offline-wiring-2499, integration/gate-workflow, plus the new suite (10/10).
