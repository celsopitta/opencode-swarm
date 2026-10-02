/**
 * The reviewer and test_engineer prompts must tell the agent how to write the
 * structured verdict row in terms the gate tracker's parser actually enforces,
 * and the architect's delegation examples must ask for that row. The row
 * format itself is unchanged.
 */

import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import { createReviewerAgent } from '../../../src/agents/reviewer';
import { createTestEngineerAgent } from '../../../src/agents/test-engineer';
import { parsePerTaskVerdicts } from '../../../src/hooks/delegation-gate';

const CASES = [
	{
		name: 'test_engineer',
		marker: '[TESTED]',
		prompt: createTestEngineerAgent('test-model').config.prompt!,
		formats: [
			'[TESTED] | task-<taskId> | PASS | <brief summary>',
			'[TESTED] | task-<taskId> | FAIL | <brief summary>',
			'[TESTED] | task-<taskId> | SKIPPED | <reason>',
		],
	},
	{
		name: 'reviewer',
		marker: '[REVIEWED]',
		prompt: createReviewerAgent('test-model').config.prompt!,
		formats: [
			'[REVIEWED] | task-<taskId> | APPROVED | <brief summary>',
			'[REVIEWED] | task-<taskId> | REJECTED | <brief summary>',
			'[REVIEWED] | task-<taskId> | CONCERNS | <brief summary>',
		],
	},
];

function verdictSection(prompt: string): string {
	const start = prompt.indexOf('## STRUCTURED VERDICT LINE (MANDATORY)');
	expect(start).toBeGreaterThan(-1);
	const end = prompt.indexOf('Never omit this line.', start);
	expect(end).toBeGreaterThan(start);
	return prompt.slice(start, end);
}

describe('structured verdict row instructions', () => {
	for (const c of CASES) {
		it(`${c.name}: the row format is unchanged`, () => {
			const section = verdictSection(c.prompt);
			for (const format of c.formats) expect(section).toContain(format);
		});

		it(`${c.name}: states every rule for writing the row, and why it matters`, () => {
			const section = verdictSection(c.prompt);
			for (const sentence of [
				'the gate tracker reads it mechanically; a line it cannot read counts as no verdict and the task stays blocked',
				`Put each ${c.marker} line on a line of its own, starting at the very first character of that line.`,
				'Write it as plain text: no backticks, no bold or italics, no quotes, no list bullet.',
				`Put nothing else on that line: no text before ${c.marker} and nothing after the summary.`,
				'It is a separate line from the VERDICT: line at the top. Both are required; never join them on one line.',
			]) {
				expect(section).toContain(sentence);
			}
		});

		it(`${c.name}: every example row in the prompt is one the parser accepts`, () => {
			const section = verdictSection(c.prompt);
			const exampleRows = section
				.split('\n')
				.filter((line) => line.startsWith(`${c.marker} | task-2.`));
			expect(exampleRows.length).toBeGreaterThanOrEqual(3);
			for (const row of exampleRows) {
				expect(parsePerTaskVerdicts(row).verdicts.size).toBe(1);
			}
		});
	}

	it('a row that breaks the stated rules is not read by the parser; a row that follows them is', () => {
		const plain = '[TESTED] | task-1.1 | PASS | 20/20 tests passed';
		expect(parsePerTaskVerdicts(plain).verdicts.get('1.1')?.verdict).toBe(
			'PASS',
		);
		for (const unreadable of [
			`\`${plain}\``,
			`**${plain}**`,
			`- ${plain}`,
			`> ${plain}`,
			`**VERDICT: PASS [20/20]** — \`${plain}\``,
		]) {
			expect(parsePerTaskVerdicts(unreadable).verdicts.size).toBe(0);
		}
	});

	it('architect delegation examples ask test_engineer for the [TESTED] row', () => {
		// Only the two test_engineer examples carry it: the architect prompt
		// has a character budget, and the reviewer prompt states the row rule
		// itself.
		const prompt = createArchitectAgent('test-model').config.prompt!;
		const testOutputs = prompt
			.split('\n')
			.filter(
				(line) =>
					line.startsWith('OUTPUT: ') && line.includes('VERDICT: PASS/FAIL'),
			);
		expect(testOutputs).toHaveLength(2);
		for (const line of testOutputs) {
			expect(line.endsWith(' + [TESTED] row')).toBe(true);
		}
	});
});
