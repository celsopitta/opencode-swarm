/**
 * pr_workflow.enabled — the architect prompt and every agent's tool
 * allow-list with the PR workflows on (default) and off.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	createArchitectAgent,
	PR_WORKFLOW_MODE_SECTIONS,
} from '../../../src/agents/architect';
import { getAgentConfigs } from '../../../src/agents/index';
import {
	PR_REVIEW_CHILD_TOOL_NAMES,
	PR_WORKFLOW_TOOL_NAMES,
} from '../../../src/config/constants';
import { PluginConfigSchema } from '../../../src/config/schema';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { TOOL_METADATA } from '../../../src/tools/tool-metadata';

/** Builds the architect prompt; `undefined` omits the argument entirely. */
function architectPrompt(
	prWorkflowEnabled?: boolean,
	customPrompt?: string,
): string {
	const def = createArchitectAgent(
		'm',
		customPrompt,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		undefined,
		false,
		false,
		false,
		false,
		undefined,
		prWorkflowEnabled,
	);
	return def.config.prompt ?? '';
}

function modeHeaders(prompt: string): string[] {
	return prompt.match(/^### MODE: .*$/gm) ?? [];
}

/** Names on the architect's "YOUR TOOLS:" line. */
function yourTools(prompt: string): string[] {
	const line = prompt
		.split('\n')
		.find((l) => l.startsWith('YOUR TOOLS: Task (delegation), '));
	expect(line).toBeDefined();
	return (line ?? '')
		.slice('YOUR TOOLS: Task (delegation), '.length)
		.replace(/\.$/, '')
		.split(', ');
}

function deniedTools(permission: unknown): Set<string> {
	return new Set(
		Object.entries((permission ?? {}) as Record<string, unknown>)
			.filter(([, value]) => value === 'deny')
			.map(([name]) => name),
	);
}

describe('architect prompt', () => {
	const enabled = architectPrompt(true);
	const disabled = architectPrompt(false);

	test('is unchanged by default: omitting the flag equals enabling it', () => {
		expect(architectPrompt(undefined)).toBe(enabled);
		for (const mode of PR_WORKFLOW_MODE_SECTIONS) {
			expect(modeHeaders(enabled)).toContain(`### MODE: ${mode}`);
		}
		for (const tool of PR_WORKFLOW_TOOL_NAMES) {
			expect(yourTools(enabled)).toContain(tool);
		}
	});

	test('disabled: exactly the three PR mode sections are removed', () => {
		const removed = PR_WORKFLOW_MODE_SECTIONS.map(
			(mode) => `### MODE: ${mode}`,
		);

		expect(modeHeaders(disabled)).toEqual(
			modeHeaders(enabled).filter((header) => !removed.includes(header)),
		);
		expect(modeHeaders(enabled).length - modeHeaders(disabled).length).toBe(3);
	});

	test('disabled: the text around the removed sections is untouched', () => {
		// Everything from the section that follows the PR modes to the end.
		const after = '### MODE: ISSUE_INGEST';
		expect(disabled.slice(disabled.indexOf(after))).toBe(
			enabled.slice(enabled.indexOf(after)),
		);
		// Everything from the start of the workflow modes up to where the PR
		// modes begin (enabled) / where the next section begins (disabled).
		const start = '### MODE DETECTION (Priority Order)';
		expect(
			disabled.slice(disabled.indexOf(start), disabled.indexOf(after)),
		).toBe(
			enabled.slice(
				enabled.indexOf(start),
				enabled.indexOf('### MODE: PR_REVIEW'),
			),
		);
	});

	test('disabled: no PR-only tool is named anywhere in the prompt', () => {
		for (const tool of [
			...PR_WORKFLOW_TOOL_NAMES,
			...PR_REVIEW_CHILD_TOOL_NAMES,
		]) {
			expect(disabled.includes(tool), tool).toBe(false);
		}
	});

	test('disabled: every other tool is still listed', () => {
		const prOnly = new Set<string>(PR_WORKFLOW_TOOL_NAMES);

		expect(yourTools(disabled)).toEqual(
			yourTools(enabled).filter((tool) => !prOnly.has(tool)),
		);
		// General tools the PR workflows share with other modes stay, and so
		// does the checkout tool: its `restore` operation gives back a stash
		// AFTER a workflow has ended.
		for (const tool of [
			'dispatch_lanes_async',
			'collect_lane_results',
			'parse_lane_candidates',
			'gh_evidence',
			'prepare_pr_workflow_checkout',
		]) {
			expect(yourTools(disabled)).toContain(tool);
		}
	});
});

describe('architect prompt — custom prompts', () => {
	const WARNING = 'could not remove';
	const warned = () =>
		getDeferredWarnings().some((warning) => warning.includes(WARNING));

	afterEach(() => {
		clearDeferredWarnings();
	});

	test('a PR mode that is the LAST section is removed to the end of the prompt', () => {
		clearDeferredWarnings();
		const prompt = architectPrompt(
			false,
			'## WORKFLOW\n### MODE: PLAN\nplan body\n### MODE: PR_REVIEW\nreview body\nmore review',
		);

		expect(prompt).toContain('### MODE: PLAN\nplan body\n');
		expect(prompt).not.toContain('MODE: PR_REVIEW');
		expect(prompt).not.toContain('review body');
		expect(prompt).not.toContain('more review');
		expect(warned()).toBe(false);
	});

	test('regression: text the builder appends after a trailing PR section is kept', () => {
		// Previous code stripped after the planning-profile directive had been
		// appended to a custom prompt, so "remove to the end of the prompt"
		// deleted that directive together with the trailing PR section.
		const custom =
			'### MODE: PLAN\nplan body\n### MODE: PR_REVIEW\nreview body';
		const kept = architectPrompt(true, custom);
		const stripped = architectPrompt(false, custom);
		const appended = kept.slice(kept.indexOf(custom) + custom.length);

		expect(appended).toContain('PLANNING PROFILE');
		expect(stripped).toBe(`### MODE: PLAN\nplan body\n${appended}`);
	});

	test('a section ends at the next "## " heading, not only at the next mode', () => {
		const prompt = architectPrompt(
			false,
			'### MODE: CI_MONITOR\nmonitor body\n## FILES\nfiles body',
		);

		expect(prompt).not.toContain('monitor body');
		expect(prompt).toContain('## FILES\nfiles body');
	});

	test('CRLF line endings and a header suffix are handled', () => {
		const prompt = architectPrompt(
			false,
			'### MODE: PLAN\r\nplan body\r\n### MODE: PR_FEEDBACK (custom)\r\nfeedback body\r\n### MODE: EXECUTE\r\nexecute body',
		);

		expect(prompt).not.toContain('feedback body');
		expect(prompt).toContain(
			'### MODE: PLAN\r\nplan body\r\n### MODE: EXECUTE',
		);
	});

	test('a mode whose name only starts like a PR mode is left alone', () => {
		const prompt = architectPrompt(
			false,
			'### MODE: PR_REVIEW_NOTES\nnotes body\n### MODE: PLAN\nplan body',
		);

		expect(prompt).toContain('### MODE: PR_REVIEW_NOTES\nnotes body');
	});

	test('a PR mode under another heading level is not half-removed, and is reported', () => {
		clearDeferredWarnings();
		const custom =
			'### MODE: PLAN\nplan body\n#### MODE: PR_REVIEW\nreview body\n### MODE: EXECUTE\nexecute body';
		const prompt = architectPrompt(false, custom);

		expect(prompt).toContain(custom);
		expect(warned()).toBe(true);
	});

	test('no report while PR workflows are enabled, or when the default prompt is stripped', () => {
		clearDeferredWarnings();
		architectPrompt(true, '#### MODE: PR_REVIEW\nreview body');
		architectPrompt(false);

		expect(warned()).toBe(false);
	});
});

describe('agent tool allow-lists', () => {
	const prOnly = [...PR_WORKFLOW_TOOL_NAMES, ...PR_REVIEW_CHILD_TOOL_NAMES];

	test('enabled (default): the architect keeps every PR-workflow tool', () => {
		const agents = getAgentConfigs(PluginConfigSchema.parse({}));
		const denied = deniedTools(agents.architect.permission);

		for (const tool of PR_WORKFLOW_TOOL_NAMES) {
			expect(denied.has(tool), tool).toBe(false);
		}
	});

	test('disabled: every agent has every PR-only tool host-denied', () => {
		const agents = getAgentConfigs(
			PluginConfigSchema.parse({ pr_workflow: { enabled: false } }),
		);

		expect(Object.keys(agents).length).toBeGreaterThan(5);
		for (const [name, agent] of Object.entries(agents)) {
			const denied = deniedTools(agent.permission);
			for (const tool of prOnly) {
				expect(denied.has(tool), `${name}/${tool}`).toBe(true);
			}
		}
		// The checkout tool stays with the architect: `restore` must remain
		// callable after a workflow that was active before the switch.
		expect(
			deniedTools(agents.architect.permission).has(
				'prepare_pr_workflow_checkout',
			),
		).toBe(false);
	});

	test('disabled: every swarm in a multi-swarm config gets the same treatment', () => {
		const swarms = {
			local: { name: 'Local', agents: {} },
			mega: { name: 'Mega', agents: {} },
		};
		const enabled = getAgentConfigs(PluginConfigSchema.parse({ swarms }));
		const disabled = getAgentConfigs(
			PluginConfigSchema.parse({ swarms, pr_workflow: { enabled: false } }),
		);

		for (const architect of ['local_architect', 'mega_architect']) {
			expect(enabled[architect].prompt).toContain('### MODE: PR_REVIEW');
			expect(disabled[architect].prompt).not.toContain('### MODE: PR_REVIEW');
			expect(disabled[architect].prompt).not.toContain('### MODE: PR_FEEDBACK');
			expect(disabled[architect].prompt).not.toContain('### MODE: CI_MONITOR');
			for (const tool of PR_WORKFLOW_TOOL_NAMES) {
				expect(
					deniedTools(enabled[architect].permission).has(tool),
					`${architect}/${tool}`,
				).toBe(false);
			}
		}
		for (const [name, agent] of Object.entries(disabled)) {
			for (const tool of prOnly) {
				expect(deniedTools(agent.permission).has(tool), `${name}/${tool}`).toBe(
					true,
				);
			}
		}
	});

	test('disabled: a tool_filter override cannot re-grant a PR-only tool', () => {
		const agents = getAgentConfigs(
			PluginConfigSchema.parse({
				pr_workflow: { enabled: false },
				tool_filter: {
					overrides: {
						architect: ['complete_pr_workflow', 'diff'],
						reviewer: ['submit_pr_review_result', 'diff'],
					},
				},
			}),
		);

		expect(deniedTools(agents.architect.permission).has('diff')).toBe(false);
		expect(
			deniedTools(agents.architect.permission).has('complete_pr_workflow'),
		).toBe(true);
		expect(
			deniedTools(agents.reviewer.permission).has('submit_pr_review_result'),
		).toBe(true);
	});

	test('disabled: the tools the architect is told it has are exactly the ones it is allowed', () => {
		const agents = getAgentConfigs(
			PluginConfigSchema.parse({ pr_workflow: { enabled: false } }),
		);
		const denied = deniedTools(agents.architect.permission);
		const advertised = yourTools(agents.architect.prompt ?? '');

		expect(advertised.length).toBeGreaterThan(50);
		for (const tool of advertised) {
			expect(denied.has(tool), tool).toBe(false);
		}
		for (const tool of PR_WORKFLOW_TOOL_NAMES) {
			expect(advertised).not.toContain(tool);
		}
	});
});

describe('PR_WORKFLOW_TOOL_NAMES stays PR-only', () => {
	test('every listed tool is granted to the architect alone', () => {
		for (const tool of PR_WORKFLOW_TOOL_NAMES) {
			expect(TOOL_METADATA[tool].agents, tool).toEqual(['architect']);
		}
	});

	test('no skill outside the PR workflows mentions a listed tool', () => {
		// A tool that another mode's skill tells the architect to call is not
		// PR-only: disabling the PR workflows would break that mode. Every file
		// of every other skill is scanned, not just its SKILL.md.
		const skillsRoot = join(
			import.meta.dir,
			'..',
			'..',
			'..',
			'.opencode',
			'skills',
		);
		const prSkills = new Set([
			'swarm-pr-review',
			'swarm-pr-feedback',
			'swarm-ci-monitor',
		]);
		const filesUnder = (dir: string): string[] =>
			readdirSync(dir).flatMap((entry) => {
				const full = join(dir, entry);
				return statSync(full).isDirectory() ? filesUnder(full) : [full];
			});
		const skills = readdirSync(skillsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !prSkills.has(entry.name))
			.map((entry) => entry.name);
		const found: string[] = [];
		let scanned = 0;

		for (const skill of skills) {
			for (const file of filesUnder(join(skillsRoot, skill))) {
				scanned += 1;
				const body = readFileSync(file, 'utf-8');
				for (const tool of PR_WORKFLOW_TOOL_NAMES) {
					if (new RegExp(`\\b${tool}\\b`).test(body)) {
						found.push(`${file.slice(skillsRoot.length + 1)}:${tool}`);
					}
				}
			}
		}

		expect(skills.length).toBeGreaterThan(10);
		expect(scanned).toBeGreaterThan(skills.length);
		expect(found).toEqual([]);
	});
});
