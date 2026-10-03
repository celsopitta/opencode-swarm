/**
 * Integration: a bash call that is an exact copy of the plugin's own sandbox
 * wrapper is unwrapped to its inner command at the top of the guardrails
 * before-hook, so every check sees the inner command and the sandbox wraps it
 * once. A bwrap command of any other shape is still refused when it would be
 * nested.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as guardrailsInternals } from '../../../src/hooks/guardrails';
import type { SandboxPolicyOptions } from '../../../src/sandbox/executor';
import { BubblewrapSandboxExecutor } from '../../../src/sandbox/linux/bubblewrap-executor';
import { ensureAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const originalGetSandboxExecutor = guardrailsInternals.getSandboxExecutor;
const originalAssessSandboxEnforcement =
	guardrailsInternals.assessSandboxEnforcement;

const { createGuardrailsHooks } = await import('../../../src/hooks/guardrails');
const { resetSwarmState, swarmState } = await import('../../../src/state');

const SESSION = 'unwrap-session';
let directory: string;
let cleanup: () => void;
let wrappedInputs: string[];

function config(enabled = true) {
	return {
		enabled,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		shell_audit_log: false,
		profiles: undefined,
	};
}

/** The exact string the real executor would produce for `command`. */
function realWrap(command: string): string {
	const executor = new BubblewrapSandboxExecutor([]);
	(executor as unknown as { _available: boolean })._available = true;
	return executor.wrapCommand(
		command,
		[path.join(directory, 'tests')],
		undefined,
		undefined,
		{ network_mode: 'off', readonly_roots: [directory] },
	);
}

describe('guardrails: a copied sandbox wrapper is unwrapped before any check', () => {
	beforeEach(() => {
		wrappedInputs = [];
		guardrailsInternals.getSandboxExecutor = async () => ({
			isAvailable: () => true,
			mechanism: 'bubblewrap',
			wrapCommand: (
				command: string,
				_scope: string[],
				_tmp?: string,
				_env?: Record<string, string | null>,
				_policy?: SandboxPolicyOptions,
			) => {
				wrappedInputs.push(command);
				return `SANDBOXED(${command})`;
			},
			getEnvOverrides: () => ({}),
		});
		guardrailsInternals.assessSandboxEnforcement = async () =>
			({
				satisfied: true,
				capability: {
					identity: 'linux:bubblewrap:test',
					mechanism: 'bubblewrap',
				},
				cacheKey: 'linux:bubblewrap:test',
			}) as Awaited<ReturnType<typeof originalAssessSandboxEnforcement>>;
		resetSwarmState();
		const created = createSafeTestDir('sandbox-unwrap-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(directory, 'tests'), { recursive: true });
		ensureAgentSession(SESSION, 'coder', directory);
		swarmState.activeAgent.set(SESSION, 'coder');
		installActiveScopeBinding({
			directory,
			childSessionId: SESSION,
			taskId: '1.1',
			files: ['tests/'],
			parentSessionId: 'unwrap-parent',
			dispatchCallId: 'wrapper-1',
		});
	});
	afterEach(() => {
		guardrailsInternals.getSandboxExecutor = originalGetSandboxExecutor;
		guardrailsInternals.assessSandboxEnforcement =
			originalAssessSandboxEnforcement;
		resetSwarmState();
		cleanup();
	});

	it('a copied wrapper runs as its inner command, wrapped exactly once', async () => {
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: realWrap('node tests/t.test.js') };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: SESSION, callID: 'unwrap-1' },
			{ args },
		);
		expect(wrappedInputs).toEqual(['node tests/t.test.js']);
		expect(args.command).toBe('SANDBOXED(node tests/t.test.js)');
	});

	it('a wrapper copied twice is peeled to the inner command', async () => {
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: realWrap(realWrap('ls tests')) };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: SESSION, callID: 'unwrap-2' },
			{ args },
		);
		expect(wrappedInputs).toEqual(['ls tests']);
	});

	it('the write-scope check runs on the inner command: an out-of-scope write inside a copied wrapper is blocked', async () => {
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: realWrap('echo x > outside.txt') };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: SESSION, callID: 'unwrap-3' },
				{ args },
			),
		).rejects.toThrow(/WRITE BLOCKED: SCOPE_VIOLATION:.*outside\.txt/);
		expect(wrappedInputs).toEqual([]);
	});

	it('a bwrap command that is not the plugin shape is still refused when it would be nested', async () => {
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: '/usr/bin/bwrap --ro-bind /usr /usr -- ls -la' };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: SESSION, callID: 'unwrap-4' },
				{ args },
			),
		).rejects.toThrow(/already invokes bwrap/);
		expect(wrappedInputs).toEqual([]);
	});

	it('a destructive command inside a copied wrapper is blocked by the destructive-command check', async () => {
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: realWrap('rm -rf /') };
		await expect(
			hooks.toolBefore(
				{ tool: 'bash', sessionID: SESSION, callID: 'unwrap-rm' },
				{ args },
			),
		).rejects.toThrow();
		expect(wrappedInputs).toEqual([]);
	});

	it('a role the sandbox does not wrap runs the inner command plain', async () => {
		const hooks = createGuardrailsHooks(directory, config());
		ensureAgentSession('unwrap-architect', 'architect', directory);
		swarmState.activeAgent.set('unwrap-architect', 'architect');
		const args = { command: realWrap('ls tests') };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: 'unwrap-architect', callID: 'unwrap-arch' },
			{ args },
		);
		expect(args.command).toBe('ls tests');
		expect(wrappedInputs).toEqual([]);
	});

	it('with guardrails disabled the plugin rewrites nothing', async () => {
		const hooks = createGuardrailsHooks(directory, config(false));
		const copied = realWrap('ls tests');
		const args = { command: copied };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: SESSION, callID: 'unwrap-disabled' },
			{ args },
		);
		expect(args.command).toBe(copied);
	});

	it('a non-shell tool is never touched, even if an argument looks like a wrapper', async () => {
		const hooks = createGuardrailsHooks(directory, config());
		const copied = realWrap('ls tests');
		const args = { command: copied, filePath: 'tests/a.txt' };
		await hooks.toolBefore(
			{ tool: 'read', sessionID: SESSION, callID: 'unwrap-read' },
			{ args },
		);
		expect(args.command).toBe(copied);
	});

	it.each([
		'Bash',
		'SHELL',
		'opencode:bash',
		'opencode.bash',
		'x.shell',
	])('a tool named %s (not exactly bash/shell, so never checked or wrapped) is not unwrapped', async (tool) => {
		const hooks = createGuardrailsHooks(directory, config());
		const copied = realWrap('echo hi > /etc/zzz');
		const args = { command: copied };
		await hooks.toolBefore(
			{ tool, sessionID: SESSION, callID: `unwrap-name-${tool}` },
			{ args },
		);
		expect(args.command).toBe(copied);
		expect(wrappedInputs).toEqual([]);
	});

	it('an ordinary command is untouched by the unwrap step', async () => {
		const hooks = createGuardrailsHooks(directory, config());
		const args = { command: 'ls tests' };
		await hooks.toolBefore(
			{ tool: 'bash', sessionID: SESSION, callID: 'unwrap-5' },
			{ args },
		);
		expect(wrappedInputs).toEqual(['ls tests']);
	});
});
