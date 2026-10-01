/**
 * Tests for skills propagation to subagents.
 *
 * Verifies that:
 * 1. Architect prompt includes a SKILLS PROPAGATION section
 * 2. Architect's DELEGATION FORMAT includes a SKILLS field
 * 3. Subagent prompts (coder, reviewer, test_engineer, sme) include SKILLS
 *    field in their INPUT FORMAT and SKILLS HANDLING instructions
 */

import { describe, expect, it } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import { createCoderAgent } from '../../../src/agents/coder';
import { createDesignerAgent } from '../../../src/agents/designer';
import { createDocsAgent } from '../../../src/agents/docs';
import { createReviewerAgent } from '../../../src/agents/reviewer';
import { createSMEAgent } from '../../../src/agents/sme';
import { createTestEngineerAgent } from '../../../src/agents/test-engineer';
import { AGENT_TOOL_MAP } from '../../../src/config/constants';

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

	describe('Coder Prompt — SKILLS field in INPUT FORMAT', () => {
		const prompt = createCoderAgent('test-model').config.prompt!;

		it('INPUT FORMAT contains SKILLS field', () => {
			const inputSection = prompt.slice(prompt.indexOf('INPUT FORMAT'));
			expect(inputSection).toContain('SKILLS:');
			expect(inputSection).toContain('file: references');
		});

		it('contains SKILLS HANDLING instructions', () => {
			expect(prompt).toContain('SKILLS HANDLING');
		});

		it('SKILLS HANDLING instructs to load file-based skills before writing code', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain(
				'read the skill names/descriptions first',
			);
			expect(skillsHandling).toContain(
				'load every referenced skill that applies',
			);
			expect(skillsHandling).toContain('use the search tool');
			expect(skillsHandling).toContain('before writing any code');
		});

		it('SKILLS HANDLING explains that skills supplement and extend default behavior', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('supplement and extend');
		});

		it('SKILLS HANDLING checks for total === 0 on search result', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('total === 0');
		});

		it('SKILLS HANDLING checks for truncated on search result', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('truncated');
		});

		it('SKILLS HANDLING fails loudly when a referenced skill cannot be loaded', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('SKILL_LOAD_FAILED');
		});
	});

	describe('Reviewer Prompt — SKILLS field in INPUT FORMAT', () => {
		const prompt = createReviewerAgent('test-model').config.prompt!;

		it('INPUT FORMAT contains SKILLS field', () => {
			const inputSection = prompt.slice(prompt.indexOf('## INPUT FORMAT'));
			expect(inputSection).toContain('SKILLS:');
			expect(inputSection).toContain('file: references');
		});

		it('contains SKILLS HANDLING instructions', () => {
			expect(prompt).toContain('SKILLS HANDLING');
		});

		it('SKILLS HANDLING instructs to load file-based skills before review', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain(
				'read the skill names/descriptions first',
			);
			expect(skillsHandling).toContain(
				'load every referenced skill that applies',
			);
			expect(skillsHandling).toContain('use the search tool');
			expect(skillsHandling).toContain('before beginning');
		});

		it('SKILLS HANDLING states violations should be flagged', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('Flag any violation');
		});

		it('SKILLS HANDLING fails loudly when a referenced skill cannot be loaded', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('SKILL_LOAD_FAILED');
		});

		it('SKILLS HANDLING checks for total === 0 on search result', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('total === 0');
		});

		it('SKILLS HANDLING checks for truncated on search result', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('truncated');
		});

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

	describe('Test Engineer Prompt — SKILLS field in INPUT FORMAT', () => {
		const prompt = createTestEngineerAgent('test-model').config.prompt!;

		it('INPUT FORMAT contains SKILLS field', () => {
			const inputSection = prompt.slice(prompt.indexOf('INPUT FORMAT'));
			expect(inputSection).toContain('SKILLS:');
			expect(inputSection).toContain('file: references');
		});

		it('contains SKILLS HANDLING instructions', () => {
			expect(prompt).toContain('SKILLS HANDLING');
		});

		it('SKILLS HANDLING instructs to load file-based skills before writing tests', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain(
				'read the skill names/descriptions first',
			);
			expect(skillsHandling).toContain(
				'load every referenced skill that applies',
			);
			expect(skillsHandling).toContain('use the search tool');
			expect(skillsHandling).toContain('before writing any test code');
		});

		it('SKILLS HANDLING explains skills override default framework choices', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain(
				'override your default framework choices',
			);
		});

		it('SKILLS HANDLING fails loudly when a referenced skill cannot be loaded', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('SKILL_LOAD_FAILED');
		});

		it('SKILLS HANDLING checks for truncated on search result', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('truncated');
		});
	});

	describe('SME Prompt — SKILLS field in INPUT FORMAT', () => {
		const prompt = createSMEAgent('test-model').config.prompt!;

		it('INPUT FORMAT contains SKILLS field', () => {
			const inputSection = prompt.slice(prompt.indexOf('## INPUT FORMAT'));
			expect(inputSection).toContain('SKILLS:');
			expect(inputSection).toContain('file: references');
		});

		it('contains SKILLS HANDLING instructions', () => {
			expect(prompt).toContain('SKILLS HANDLING');
		});

		it('SKILLS HANDLING instructs to load file-based skills before recommendation', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain(
				'read the skill names/descriptions first',
			);
			expect(skillsHandling).toContain(
				'load every referenced skill that applies',
			);
			expect(skillsHandling).toContain('use the search tool');
			expect(skillsHandling).toContain('before formulating');
		});

		it('SKILLS HANDLING fails loudly when a referenced skill cannot be loaded', () => {
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('SKILL_LOAD_FAILED');
		});
	});

	describe('Docs Prompt — SKILLS field in INPUT FORMAT', () => {
		const prompt = createDocsAgent('test-model').config.prompt!;

		it('INPUT FORMAT contains SKILLS field', () => {
			const inputSection = prompt.slice(prompt.indexOf('INPUT FORMAT'));
			expect(inputSection).toContain('SKILLS:');
			expect(inputSection).toContain('file: references');
		});

		it('contains SKILLS HANDLING instructions', () => {
			expect(prompt).toContain('SKILLS HANDLING');
			expect(prompt).toContain('use the search tool');
			expect(prompt).toContain('SKILL_LOAD_FAILED');
		});
	});

	describe('Designer Prompt — SKILLS field in INPUT FORMAT', () => {
		const prompt = createDesignerAgent('test-model').config.prompt!;

		it('INPUT FORMAT contains SKILLS field', () => {
			const inputSection = prompt.slice(prompt.indexOf('INPUT FORMAT'));
			expect(inputSection).toContain('SKILLS:');
			expect(inputSection).toContain('file: references');
		});

		it('contains SKILLS HANDLING instructions', () => {
			expect(prompt).toContain('SKILLS HANDLING');
			expect(prompt).toContain('use the search tool');
			expect(prompt).toContain('SKILL_LOAD_FAILED');
		});
	});

	describe('All 6 agent SKILLS HANDLING blocks check total === 0', () => {
		it('coder SKILLS HANDLING contains total === 0', () => {
			const prompt = createCoderAgent('test-model').config.prompt!;
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('total === 0');
		});

		it('reviewer SKILLS HANDLING contains total === 0', () => {
			const prompt = createReviewerAgent('test-model').config.prompt!;
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('total === 0');
		});

		it('test_engineer SKILLS HANDLING contains total === 0', () => {
			const prompt = createTestEngineerAgent('test-model').config.prompt!;
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('total === 0');
		});

		it('sme SKILLS HANDLING contains total === 0', () => {
			const prompt = createSMEAgent('test-model').config.prompt!;
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('total === 0');
		});

		it('docs SKILLS HANDLING contains total === 0', () => {
			const prompt = createDocsAgent('test-model').config.prompt!;
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('total === 0');
		});

		it('designer SKILLS HANDLING contains total === 0', () => {
			const prompt = createDesignerAgent('test-model').config.prompt!;
			const skillsHandling = prompt.slice(prompt.indexOf('SKILLS HANDLING'));
			expect(skillsHandling).toContain('total === 0');
		});
	});

	describe('Skill-loading agents have a tool capable of reading file-based skills', () => {
		it('architect and every skill-loading agent include search', () => {
			expect(AGENT_TOOL_MAP.architect).toContain('search');
			expect(AGENT_TOOL_MAP.coder).toContain('search');
			expect(AGENT_TOOL_MAP.reviewer).toContain('search');
			expect(AGENT_TOOL_MAP.test_engineer).toContain('search');
			expect(AGENT_TOOL_MAP.sme).toContain('search');
			expect(AGENT_TOOL_MAP.docs).toContain('search');
			expect(AGENT_TOOL_MAP.designer).toContain('search');
		});
	});

	describe('[SUMMARY Sx] retrieval branch in skill-loading protocol', () => {
		// Distinctive once-per-branch phrase; kept backtick-free so the assertion
		// matches the rendered prompt regardless of the source's escaped-backtick
		// convention.
		const marker = 'the skill content was stored for retrieval, not lost';
		const entries: Array<[string, () => string]> = [
			['architect', () => createArchitectAgent('test-model').config.prompt!],
			['coder', () => createCoderAgent('test-model').config.prompt!],
			['reviewer', () => createReviewerAgent('test-model').config.prompt!],
			[
				'test_engineer',
				() => createTestEngineerAgent('test-model').config.prompt!,
			],
			['sme', () => createSMEAgent('test-model').config.prompt!],
			[
				'docs (standard)',
				() =>
					createDocsAgent('test-model', undefined, undefined, 'standard').config
						.prompt!,
			],
			[
				'docs (design_docs)',
				() =>
					createDocsAgent('test-model', undefined, undefined, 'design_docs')
						.config.prompt!,
			],
			['designer', () => createDesignerAgent('test-model').config.prompt!],
		];

		for (const [label, getPrompt] of entries) {
			it(`${label} skill-loading block carries the [SUMMARY Sx] branch`, () => {
				const prompt = getPrompt();
				// The branch lives in the SKILL LOADING / SKILLS HANDLING block.
				const headerIdx = ['SKILL LOADING', 'SKILLS HANDLING']
					.map((h) => prompt.indexOf(h))
					.filter((i) => i >= 0)
					.sort((a, b) => a - b)[0];
				expect(headerIdx).toBeGreaterThanOrEqual(0);
				expect(prompt.indexOf(marker)).toBeGreaterThan(headerIdx);
				// The branch acknowledges the partial-footer state.
				expect(prompt).toContain('partial');
				expect(prompt).toContain(
					'the stored content is all that is recoverable',
				);
				// The branch names the retrieval paths.
				expect(prompt).toContain('retrieve_summary');
				expect(prompt).toContain('/swarm retrieve');
				expect(prompt).toContain('direct read of the source file');
			});
		}

		it('reviewer carries the branch exactly once (primary block only)', () => {
			expect(
				createReviewerAgent('test-model').config.prompt!.split(marker).length -
					1,
			).toBe(1);
		});

		it('docs carries the branch in BOTH blocks (one per role)', () => {
			const standard = createDocsAgent(
				'test-model',
				undefined,
				undefined,
				'standard',
			).config.prompt!;
			const design = createDocsAgent(
				'test-model',
				undefined,
				undefined,
				'design_docs',
			).config.prompt!;
			expect(standard.split(marker).length - 1).toBe(1);
			expect(design.split(marker).length - 1).toBe(1);
		});
	});
});
