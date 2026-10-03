/**
 * Issue #2586 AC10 — multi-swarm matrix cell consuming issue #2680's contract
 * ("validate final enabled swarm model selections and fallbacks during
 * preflight") ON the PR-review lane dispatch path.
 *
 * Surface disclosure (adaptation per the cell brief): the #2680 gate fixture
 * (tests/unit/hooks/delegation-gate-agent-model-preflight-2680.test.ts) drives
 * the delegation gate hook's toolBefore on the controller's Task dispatch —
 * that is the surface where the lane-agent model admission contract lives
 * (src/hooks/delegation-gate.ts swarm-agent preflight, wired for `Task`).
 * This fixture simulates that Task-shaped dispatch (createDelegationGateHook +
 * toolBefore) with PR-review lane roles, PR-review lane ids from the
 * canonical base-dimension contract, and lane-prompt shapes from the
 * dispatch-lanes lane schema, so it exercises the same real admission
 * contract a Task-carried lane dispatch would hit. Production note: read-only
 * PR-review lane agents (explorer/reviewer/critic — the lane role set in
 * src/tools/dispatch-lanes.ts) are dispatched by the controller via
 * `dispatch_lanes_async`, whose internal child sessions ride host
 * session.create/promptAsync and never pass tool.execute.before — the
 * dispatch-time model admission for that path is a disclosed gap; the
 * init-time runModelPreflight covers the same enabled prefixed selections at
 * warning level, and only a Task-carried dispatch (e.g. the reviewer/test
 * re-entry carve-out) reaches the hook exercised here. No preflight logic is
 * recreated here.
 *
 * Legs:
 * - RESOLVED: both swarms' prefixed PR-review lane agents whose final
 *   effective model resolves proceed (the #2680 proceed typed outcome).
 * - UNRESOLVED: a PR-review reviewer lane dispatch on a ghost model denies
 *   with the distinct SWARM_AGENT_MODEL_UNRESOLVED class.
 * - Critic lane: a prefixed PR-review critic lane on a ghost model keeps the
 *   PLAN_CRITIC_MODEL_UNRESOLVED identity.
 * - FAIL-OPEN: an unreachable catalog never denies a lane dispatch.
 * - MISSING SELECTION: an enabled registered lane role with a blank final
 *   selection in ONE swarm denies with SWARM_AGENT_MODEL_MISSING_SELECTION
 *   while the SAME role in the other swarm (valid selection) proceeds —
 *   per-swarm override granularity under prefixed resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { getAgentConfigs } from '../../../src/agents';
import { PR_REVIEW_BASE_DIMENSION_IDS } from '../../../src/background/pr-review-contract';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import { invalidateProviderCatalogCache } from '../../../src/services/model-preflight';
import { resetSwarmState, swarmState } from '../../../src/state';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function catalogClient(
	providers: { id: string; models: string[] }[],
	fail = false,
): OpencodeClient {
	return {
		provider: {
			list: async () => {
				if (fail) throw new Error('catalog unreachable');
				return {
					data: {
						all: providers.map((provider) => ({
							id: provider.id,
							name: provider.id,
							models: Object.fromEntries(
								provider.models.map((model) => [model, { id: model }]),
							),
						})),
					},
				};
			},
		},
	} as unknown as OpencodeClient;
}

const OPENCODE_CATALOG = catalogClient([
	{
		id: 'opencode',
		models: [
			'big-pickle',
			'nemotron-3-ultra-free',
			'mimo-v2.6-flash-free',
			'minimax-m2.5-free',
			'gpt-5-nano',
		],
	},
]);

const baseConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
	hooks: { delegation_gate: true },
	worktree: { policy: 'disabled' },
} as unknown as PluginConfig;

// Two enabled swarms with prefixed PR-review lane agents. The canonical
// base-dimension lane ids anchor the prompts to the real PR-review contract.
const BASE_LANE = PR_REVIEW_BASE_DIMENSION_IDS[0]!;
const OTHER_BASE_LANE = PR_REVIEW_BASE_DIMENSION_IDS[3]!;

function lanePrompt(workflowLane: string): string {
	// Same lane-prompt shape the dispatch-lanes lane schema renders
	// (see tests/unit/pr-review/r01-entry-binding-registered.test.ts).
	return `Review ${workflowLane} on the exact bound diff.`;
}

const twoSwarmPrReviewConfig = {
	...baseConfig,
	swarms: {
		local: {
			name: 'Local',
			agents: {
				explorer: { model: 'opencode/big-pickle' },
				reviewer: { model: 'ghost/broken-reviewer' },
			},
		},
		mega: {
			name: 'Mega',
			agents: {
				explorer: { model: 'opencode/minimax-m2.5-free' },
				critic: { model: 'ghost/broken-critic' },
			},
		},
	},
} as unknown as PluginConfig;

describe('issue #2586 — multi-swarm PR-review lane dispatch consumes the #2680 model preflight', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		tempDir = canonicalMkdtemp('multiswarm-preflight-2586-');
	});

	afterEach(() => {
		resetSwarmState();
		invalidateProviderCatalogCache();
		safeRmRecursive(tempDir);
	});

	test('[AC10] resolvable prefixed lane models in both swarms proceed on the PR-review base-lane dispatch path', async () => {
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(twoSwarmPrReviewConfig, tempDir);
		// Multi-swarm sanity (AGENTS.md #11 regression class): BOTH swarms'
		// prefixed lane agents exist and stay subagents — losing prefixed
		// registration would silently skip this cell's preflight entirely.
		for (const name of [
			'local_explorer',
			'local_reviewer',
			'mega_explorer',
			'mega_critic',
		]) {
			expect(registeredAgents[name]).toBeDefined();
			expect((registeredAgents[name] as { mode?: unknown }).mode).toBe(
				'subagent',
			);
		}
		const hook = createDelegationGateHook(
			twoSwarmPrReviewConfig,
			tempDir,
			registeredAgents,
		);
		// First swarm's lane agent…
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'lane-call-local' },
				{
					args: {
						subagent_type: 'local_explorer',
						prompt: lanePrompt(BASE_LANE),
					},
				},
			),
		).resolves.toBeUndefined();
		// …and the second swarm's, on a different base dimension.
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'lane-call-mega' },
				{
					args: {
						subagent_type: 'mega_explorer',
						prompt: lanePrompt(OTHER_BASE_LANE),
					},
				},
			),
		).resolves.toBeUndefined();
	});

	test('[AC10] a PR-review reviewer lane dispatch with an unresolvable prefixed model denies with SWARM_AGENT_MODEL_UNRESOLVED', async () => {
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(twoSwarmPrReviewConfig, tempDir);
		const hook = createDelegationGateHook(
			twoSwarmPrReviewConfig,
			tempDir,
			registeredAgents,
		);
		const outcome = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'reviewer-call-1' },
			{
				args: {
					subagent_type: 'local_reviewer',
					prompt: lanePrompt(BASE_LANE),
				},
			},
		);
		await expect(outcome).rejects.toThrow('SWARM_AGENT_MODEL_UNRESOLVED');
		await expect(outcome).rejects.toThrow('local_reviewer');
		await expect(outcome).rejects.toThrow('ghost/broken-reviewer');
		await expect(outcome).rejects.toThrow('swarm override wins');
		// The model-preflight denial fires BEFORE the reviewer ACCEPTANCE gate,
		// so the typed class must lead the message (preflight precedence on the
		// lane dispatch path).
		const caught = await outcome.catch((rejection: unknown) => rejection);
		if (!(caught instanceof Error)) {
			throw new Error('expected toolBefore to reject with an Error');
		}
		expect(caught.message.startsWith('SWARM_AGENT_MODEL_UNRESOLVED')).toBe(
			true,
		);
	});

	test('[AC10] a prefixed PR-review critic lane keeps the PLAN_CRITIC_MODEL_UNRESOLVED identity', async () => {
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(twoSwarmPrReviewConfig, tempDir);
		const hook = createDelegationGateHook(
			twoSwarmPrReviewConfig,
			tempDir,
			registeredAgents,
		);
		const caught = await hook
			.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'critic-call-1' },
				{
					args: {
						subagent_type: 'mega_critic',
						// closeout-critic is the PR-review critic lane (challenge the
						// closeout evidence on the bound diff).
						prompt:
							'Challenge the closeout-critic lane evidence, omissions, and severity on the exact bound diff.',
					},
				},
			)
			.catch((rejection: unknown) => rejection);
		if (!(caught instanceof Error)) {
			throw new Error('expected toolBefore to reject with an Error');
		}
		expect(caught.message.startsWith('PLAN_CRITIC_MODEL_UNRESOLVED')).toBe(
			true,
		);
		expect(caught.message).toContain('mega_critic');
		expect(caught.message).toContain('ghost/broken-critic');
		// The critic denial must NOT carry the non-critic class name.
		expect(caught.message).not.toContain('SWARM_AGENT_MODEL_UNRESOLVED');
	});

	test('[AC10] an unreachable catalog fails open — a lane dispatch is never denied by catalog unavailability alone', async () => {
		// A read-only lane role whose model sits on the ghost provider: with the
		// catalog DOWN the preflight resolves 'unknown' and the dispatch
		// proceeds — a catalog warning alone is never dispatch-failure
		// evidence (mirror of the #2680 gate fixture's fail-open control).
		const ghostLaneConfig = {
			...baseConfig,
			swarms: {
				local: {
					name: 'Local',
					agents: { explorer: { model: 'ghost/broken-model' } },
				},
				mega: {
					name: 'Mega',
					agents: { explorer: { model: 'opencode/big-pickle' } },
				},
			},
		} as unknown as PluginConfig;
		swarmState.opencodeClient = catalogClient([], true);
		const registeredAgents = getAgentConfigs(ghostLaneConfig, tempDir);
		const hook = createDelegationGateHook(
			ghostLaneConfig,
			tempDir,
			registeredAgents,
		);
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'lane-call-ghost' },
				{
					args: {
						subagent_type: 'local_explorer',
						prompt: lanePrompt(BASE_LANE),
					},
				},
			),
		).resolves.toBeUndefined();
	});

	test('[AC10] a blank final selection in one swarm denies MISSING_SELECTION while the same role in the other swarm proceeds', async () => {
		// Per-swarm override granularity: local's explorer override is blank
		// (enabled, registered, NO final selection) while mega's resolves —
		// prefixed resolution must keep the two swarms' selections distinct.
		const blankLocalConfig = {
			...baseConfig,
			swarms: {
				local: {
					name: 'Local',
					agents: { explorer: { model: '   ' } },
				},
				mega: {
					name: 'Mega',
					agents: { explorer: { model: 'opencode/big-pickle' } },
				},
			},
		} as unknown as PluginConfig;
		swarmState.opencodeClient = OPENCODE_CATALOG;
		const registeredAgents = getAgentConfigs(blankLocalConfig, tempDir);
		const hook = createDelegationGateHook(
			blankLocalConfig,
			tempDir,
			registeredAgents,
		);
		const denied = hook.toolBefore(
			{ tool: 'Task', sessionID: 'architect-1', callID: 'blank-local-1' },
			{
				args: {
					subagent_type: 'local_explorer',
					prompt: lanePrompt(BASE_LANE),
				},
			},
		);
		await expect(denied).rejects.toThrow('SWARM_AGENT_MODEL_MISSING_SELECTION');
		await expect(denied).rejects.toThrow('local_explorer');
		// The same role name under the other swarm stays dispatchable.
		await expect(
			hook.toolBefore(
				{ tool: 'Task', sessionID: 'architect-1', callID: 'blank-mega-1' },
				{
					args: {
						subagent_type: 'mega_explorer',
						prompt: lanePrompt(OTHER_BASE_LANE),
					},
				},
			),
		).resolves.toBeUndefined();
	});
});
