/**
 * Tests for skills propagation to subagents.
 *
 * Verifies that:
 * 1. Architect prompt includes a SKILLS PROPAGATION section
 * 2. Architect's DELEGATION FORMAT includes a SKILLS field
 * 3. Subagent prompts (coder, reviewer, test_engineer, sme) include SKILLS
 *    field in their INPUT FORMAT and SKILLS HANDLING instructions
 * 4. Every skill-loading block loads SKILL.md through the paged host read
 *    tool (never search) and keeps the [SUMMARY Sx] retrieval branch
 */

import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import { createCoderAgent } from '../../../src/agents/coder';
import { createDesignerAgent } from '../../../src/agents/designer';
import { createDocsAgent } from '../../../src/agents/docs';
import { createReviewerAgent } from '../../../src/agents/reviewer';
import { createSMEAgent } from '../../../src/agents/sme';
import { createTestEngineerAgent } from '../../../src/agents/test-engineer';
import {
	AGENT_TOOL_MAP,
	SUMMARIZER_EXEMPT_TOOL_NAMES,
} from '../../../src/config/constants';

describe('Skills Propagation to Subagents', () => {
	describe('Architect Prompt — SKILLS PROPAGATION section', () => {
		const prompt = createArchitectAgent('test-model').config.prompt!;

		it('contains SKILLS PROPAGATION section header', () => {
			expect(prompt).toContain('SKILLS PROPAGATION');
		});

		it('documents hook-managed skill discovery', () => {
			expect(prompt).toContain('Skills are auto-discovered and scored');
			expect(prompt).toContain('The hook auto-injects them');
		});

		it('uses the SKILLS field for top recommended skills', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('SKILLS:');
			expect(skillsSection).toContain('top recommended skills');
		});

		it('describes hook-managed routing configuration', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('.opencode/skill-routing.yaml');
			expect(skillsSection).toContain('delegation time');
		});

		it('mentions the receiving agent roles that use mandatory coding-task skills', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('test_engineer');
			expect(skillsSection).toContain('reviewer');
			expect(skillsSection).toContain('coder');
		});

		it('explains that skill references carry context descriptions', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('context descriptions');
			expect(skillsSection).toContain('file:path (-- description)');
		});

		it('prefers file references by default and keeps inline fallback for load failures', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('Prefer `file:` references');
			expect(skillsSection).toContain('SKILL_LOAD_FAILED');
			expect(skillsSection).toContain('full skill body pasted inline');
		});

		it('marks coding-task skills as source-repo examples gated on presence in the current project', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('writing-tests');
			expect(skillsSection).toContain('engineering-conventions');
			expect(skillsSection).toContain('when those skills are present');
			expect(skillsSection).toContain('current project');
			expect(skillsSection).toContain('SKILLS: none');
			// #2802: no unconditional "always provide <repo skill>" default.
			expect(skillsSection).not.toMatch(
				/always\s+provide[^\n]{0,120}(?:writing-tests|engineering-conventions)/i,
			);
		});

		it('requires descriptions next to file references for on-demand skill loading', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('brief context descriptions');
			expect(skillsSection).toContain('file:path (-- description)');
			expect(skillsSection).toContain('top recommended skills');
		});

		it('includes anti-rationalization rules against skipping skills', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('SKILL_LOAD_FAILED recovery');
			expect(skillsSection).toContain('Never re-use a file: reference');
		});

		it('explains that subagents run in isolated contexts without inherited skills', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('isolated contexts');
			expect(skillsSection).toContain('NOT automatically visible');
		});

		it('includes SKILL_LOAD_FAILED recovery instruction with do NOT retry', () => {
			const skillsSection = prompt.slice(prompt.indexOf('SKILLS PROPAGATION'));
			expect(skillsSection).toContain('SKILL_LOAD_FAILED recovery');
			expect(skillsSection).toContain('do NOT retry with the same reference');
		});
	});

	describe('Architect Prompt — DELEGATION FORMAT includes SKILLS field', () => {
		const prompt = createArchitectAgent('test-model').config.prompt!;

		it('delegation format template includes SKILLS field', () => {
			const delegationSection = prompt.slice(
				prompt.indexOf('## DELEGATION FORMAT'),
			);
			expect(delegationSection).toContain('SKILLS:');
		});

		it('delegation format defers to each receiving agent input schema', () => {
			const delegationSection = prompt.slice(
				prompt.indexOf('## DELEGATION FORMAT'),
			);
			expect(delegationSection).toContain(
				"follow the receiving agent's INPUT FORMAT exactly",
			);
			expect(delegationSection).toContain(
				'[agent-specific fields required by that agent',
			);
		});

		it('coder delegation example includes placeholder file-based SKILLS reference', () => {
			const coderExample = prompt.slice(
				prompt.indexOf('TASK: Add input validation to login'),
				prompt.indexOf('TASK: Review login validation'),
			);
			expect(coderExample).toContain(
				'SKILLS: file:.claude/skills/<project-skill>/SKILL.md',
			);
		});

		it('reviewer delegation example includes placeholder file-based SKILLS reference', () => {
			const reviewerExample = prompt.slice(
				prompt.indexOf('TASK: Review login validation'),
				prompt.indexOf('TASK: Generate and run login validation tests'),
			);
			expect(reviewerExample).toContain(
				'SKILLS_USED_BY_CODER: file:.claude/skills/<project-skill>/SKILL.md',
			);
			expect(reviewerExample).toContain(
				'SKILLS: file:.claude/skills/<project-skill>/SKILL.md',
			);
		});

		it('test_engineer delegation example includes placeholder file-based SKILLS reference', () => {
			const testEngineerExample = prompt.slice(
				prompt.indexOf('TASK: Generate and run login validation tests'),
				prompt.indexOf('TASK: Review plan for user authentication'),
			);
			expect(testEngineerExample).toContain(
				'SKILLS: file:.claude/skills/<project-skill>/SKILL.md',
			);
		});

		it('explorer delegation example uses SKILLS: none', () => {
			const explorerExample = prompt.slice(
				prompt.indexOf('TASK: Analyze codebase for auth'),
				prompt.indexOf('TASK: Review auth token patterns'),
			);
			expect(explorerExample).toContain('SKILLS: none');
		});

		it('SME delegation examples may use SKILLS: none when no repo skill applies', () => {
			const smeExample = prompt.slice(
				prompt.indexOf('TASK: Review auth token patterns'),
				prompt.indexOf('PRE-STEP (required):'),
			);
			expect(smeExample).toContain('SKILLS: none');
		});

		it('critic delegation example uses SKILLS: none', () => {
			const criticExample = prompt.slice(
				prompt.indexOf('TASK: Review plan for user authentication'),
				prompt.indexOf('TASK: Security-only review'),
			);
			expect(criticExample).toContain('SKILLS: none');
		});
	});

	// Every prompt variant that carries a skill-loading block.
	const docsPrompt = (role: 'standard' | 'design_docs') => () =>
		createDocsAgent('test-model', undefined, undefined, role).config.prompt!;
	const skillLoadingPrompts: Array<[string, () => string]> = [
		['architect', () => createArchitectAgent('test-model').config.prompt!],
		['coder', () => createCoderAgent('test-model').config.prompt!],
		['reviewer', () => createReviewerAgent('test-model').config.prompt!],
		[
			'test_engineer',
			() => createTestEngineerAgent('test-model').config.prompt!,
		],
		['sme', () => createSMEAgent('test-model').config.prompt!],
		['docs (standard)', docsPrompt('standard')],
		['docs (design_docs)', docsPrompt('design_docs')],
		['designer', () => createDesignerAgent('test-model').config.prompt!],
	];

	// The skill-loading block: from the first SKILL LOADING / SKILLS HANDLING
	// header to the blank line that closes that bullet list. Assertions are
	// anchored to it so wording elsewhere in the prompt cannot satisfy them.
	const skillBlock = (prompt: string): string => {
		const headerIdx = ['SKILL LOADING', 'SKILLS HANDLING']
			.map((h) => prompt.indexOf(h))
			.filter((i) => i >= 0)
			.sort((a, b) => a - b)[0];
		expect(headerIdx).toBeGreaterThanOrEqual(0);
		const end = prompt.indexOf('\n\n', headerIdx);
		return prompt.slice(headerIdx, end === -1 ? undefined : end);
	};

	// Per-subagent expectations. `phrases` are asserted against the text from
	// the SKILLS HANDLING header onward, in addition to the shared ones.
	const sharedHandlingPhrases = [
		'read the skill names/descriptions first',
		'load every referenced skill that applies',
		'with the read tool',
		'SKILL_LOAD_FAILED',
	];
	const subagents: Array<{
		label: string;
		getPrompt: () => string;
		inputHeader: string;
		phrases: string[];
	}> = [
		{
			label: 'Coder',
			getPrompt: () => createCoderAgent('test-model').config.prompt!,
			inputHeader: 'INPUT FORMAT',
			phrases: ['before writing any code', 'supplement and extend'],
		},
		{
			label: 'Reviewer',
			getPrompt: () => createReviewerAgent('test-model').config.prompt!,
			inputHeader: '## INPUT FORMAT',
			phrases: ['before beginning', 'Flag any violation'],
		},
		{
			label: 'Test Engineer',
			getPrompt: () => createTestEngineerAgent('test-model').config.prompt!,
			inputHeader: 'INPUT FORMAT',
			phrases: [
				'before writing any test code',
				'override your default framework choices',
			],
		},
		{
			label: 'SME',
			getPrompt: () => createSMEAgent('test-model').config.prompt!,
			inputHeader: '## INPUT FORMAT',
			phrases: ['before formulating'],
		},
		{
			label: 'Docs',
			getPrompt: () => createDocsAgent('test-model').config.prompt!,
			inputHeader: 'INPUT FORMAT',
			phrases: [],
		},
		{
			label: 'Designer',
			getPrompt: () => createDesignerAgent('test-model').config.prompt!,
			inputHeader: 'INPUT FORMAT',
			phrases: [],
		},
	];

	for (const { label, getPrompt, inputHeader, phrases } of subagents) {
		describe(`${label} Prompt — SKILLS field in INPUT FORMAT`, () => {
			const prompt = getPrompt();

			it('INPUT FORMAT contains SKILLS field', () => {
				const inputSection = prompt.slice(prompt.indexOf(inputHeader));
				expect(inputSection).toContain('SKILLS:');
				expect(inputSection).toContain('file: references');
			});

			it('contains SKILLS HANDLING instructions', () => {
				expect(prompt).toContain('SKILLS HANDLING');
			});

			for (const phrase of [...sharedHandlingPhrases, ...phrases]) {
				it(`SKILLS HANDLING contains "${phrase}"`, () => {
					const headerIdx = prompt.indexOf('SKILLS HANDLING');
					expect(headerIdx).toBeGreaterThanOrEqual(0);
					expect(prompt.slice(headerIdx)).toContain(phrase);
				});
			}
		});
	}

	describe('Reviewer Prompt — sections around SKILLS HANDLING are preserved', () => {
		const prompt = createReviewerAgent('test-model').config.prompt!;

		it('PROCESSING line is preserved after SKILLS HANDLING', () => {
			// PROCESSING was there before; must remain
			expect(prompt).toContain('PROCESSING: If GATES is provided');
			expect(prompt.indexOf('SKILLS HANDLING')).toBeLessThan(
				prompt.indexOf('PROCESSING: If GATES is provided'),
			);
		});

		it('OUTPUT FORMAT section is preserved', () => {
			expect(prompt).toContain('## OUTPUT FORMAT');
			expect(prompt).toContain('VERDICT: APPROVED | REJECTED');
		});
	});

	describe('Skill-loading protocol uses the paged read tool, not search', () => {
		for (const [label, getPrompt] of skillLoadingPrompts) {
			it(`${label} skill-loading block loads skills through read`, () => {
				const block = skillBlock(getPrompt());
				expect(block).toContain(
					label === 'architect' ? 'using the read tool' : 'with the read tool',
				);
				// Paging: the skill is loaded only once every page has been read.
				expect(block).toContain('Use offset=N to continue');
				expect(block).toContain('every page has been read');
				expect(block).toContain('SKILL_LOAD_FAILED');
				// The host read tool cuts lines over 2000 chars with no way to
				// continue them: the block must say how to get such a line in full.
				expect(block).toContain('(line truncated to 2000 chars)');
				expect(block).toContain('get the full line with the search tool');
				expect(block).toContain('max_lines: 10000');
				expect(block).toContain(
					'Do NOT load a whole skill through the search tool',
				);
				// The removed search-based protocol must not come back.
				expect(block).not.toContain('total === 0');
				expect(block).not.toContain('max_results');
				expect(block).not.toContain('query: .*');
			});
		}
	});

	describe('Skill-loading agents can use the tools the protocol names', () => {
		// Skills load through the host read tool, which must never be stubbed by the summarizer.
		it('SUMMARIZER_EXEMPT_TOOL_NAMES contains read', () => {
			expect(SUMMARIZER_EXEMPT_TOOL_NAMES).toContain('read');
		});

		// The protocol's over-long-line fallback is a single targeted search
		// call and its stub branch is retrieve_summary: every skill-loading role
		// must hold both plugin tools.
		it('architect and every skill-loading agent hold search and retrieve_summary', () => {
			for (const role of [
				'architect',
				'coder',
				'reviewer',
				'test_engineer',
				'sme',
				'docs',
				'docs_design',
				'designer',
			] as const) {
				expect(AGENT_TOOL_MAP[role]).toContain('search');
				expect(AGENT_TOOL_MAP[role]).toContain('retrieve_summary');
			}
		});

		// read is a host built-in outside AGENT_TOOL_MAP: it stays available
		// unless an agent factory switches it off, so no skill-loading factory
		// may do that.
		it('no skill-loading agent factory disables the host read tool', () => {
			const factories = [
				createArchitectAgent('test-model'),
				createCoderAgent('test-model'),
				createReviewerAgent('test-model'),
				createTestEngineerAgent('test-model'),
				createSMEAgent('test-model'),
				createDocsAgent('test-model', undefined, undefined, 'standard'),
				createDocsAgent('test-model', undefined, undefined, 'design_docs'),
				createDesignerAgent('test-model'),
			];
			for (const agent of factories) {
				const tools = (agent.config.tools ?? {}) as Record<string, boolean>;
				expect(tools.read).not.toBe(false);
			}
		});
	});

	describe('[SUMMARY Sx] retrieval branch in skill-loading protocol', () => {
		// Distinctive once-per-branch phrase; kept backtick-free so the assertion
		// matches the rendered prompt regardless of the source's escaped-backtick
		// convention.
		const marker = 'the output was stored, not lost';
		const countMarker = (prompt: string) => prompt.split(marker).length - 1;

		for (const [label, getPrompt] of skillLoadingPrompts) {
			it(`${label} skill-loading block carries the [SUMMARY Sx] branch`, () => {
				const prompt = getPrompt();
				const block = skillBlock(prompt);
				expect(block).toContain(marker);
				// The branch names the retrieval tool and forbids treating a stub
				// as a load failure.
				expect(block).toContain('retrieve_summary');
				expect(block).toContain('A stub alone is never a reason to report');
				// A partial stub holds less than the full output; the branch says so.
				expect(block).toContain('holds only the part the host returned');
				// The slash-command path is not offered to agents.
				expect(prompt).not.toContain('/swarm retrieve Sx');
			});
		}

		it('reviewer carries the branch exactly once (primary block only)', () => {
			expect(
				countMarker(createReviewerAgent('test-model').config.prompt!),
			).toBe(1);
		});

		it('docs carries the branch in BOTH blocks (one per role)', () => {
			expect(countMarker(docsPrompt('standard')())).toBe(1);
			expect(countMarker(docsPrompt('design_docs')())).toBe(1);
		});
	});
});
