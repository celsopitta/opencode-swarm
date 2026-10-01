/**
 * Skill files must survive the host `read` tool.
 *
 * Agents load `file:` skill references with the host `read` tool (see the
 * SKILL LOADING / SKILLS HANDLING prompt blocks). That tool cuts every line
 * longer than 2,000 characters and appends `... (line truncated to 2000
 * chars)` with no way to continue the line, so an over-long line silently
 * loses instructions. Every skill markdown file in the native skill trees must
 * therefore keep each line within the cap.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Resolved from this file, not the cwd, so the guard cannot pass vacuously
// when the tests are launched from another directory.
const ROOT = join(import.meta.dir, '..', '..', '..');

/** Host `read` per-line cap (opencode read tool, characters). */
const HOST_READ_MAX_LINE_CHARS = 2000;

const SKILL_TREES = ['.opencode/skills', '.claude/skills', '.agents/skills'];

function collectMarkdown(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) found.push(...collectMarkdown(full));
		else if (entry.endsWith('.md')) found.push(full);
	}
	return found;
}

describe('skill files stay within the host read line cap', () => {
	test('the canonical skill tree is present (the guard is not vacuous)', () => {
		expect(existsSync(join(ROOT, '.opencode', 'skills'))).toBe(true);
	});

	for (const tree of SKILL_TREES) {
		test(`${tree}: no markdown line exceeds ${HOST_READ_MAX_LINE_CHARS} characters`, () => {
			const files = collectMarkdown(join(ROOT, tree));
			// A tree that exists must actually be scanned; an empty scan would
			// make this guard pass vacuously.
			if (existsSync(join(ROOT, tree))) {
				expect(files.length).toBeGreaterThan(0);
			}
			const offenders: string[] = [];
			for (const file of files) {
				const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
				lines.forEach((line, index) => {
					if (line.length > HOST_READ_MAX_LINE_CHARS) {
						offenders.push(
							`${relative(ROOT, file)}:${index + 1} (${line.length} chars)`,
						);
					}
				});
			}
			expect(offenders).toEqual([]);
		});
	}
});
