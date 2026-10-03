/**
 * Integration: commands using process substitution reach the guardrails as
 * real commands instead of being rejected as unparseable. Read-only uses run;
 * writes and destructive commands inside a substitution are checked like any
 * other; a write the outer command makes beside a substitution is checked.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('guardrails-process-substitution-');

function config(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

function run(sessionID: string, command: string) {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
	return hooks.toolBefore(
		{ tool: 'bash', sessionID, callID: `call-${sessionID}` },
		{ args: { command } },
	);
}

function coderWithScope(sessionID: string, files: string[]): void {
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionID,
		taskId: '1.1',
		files,
		dispatchCallId: `call-${sessionID}`,
	});
}

describe('guardrails: process substitution', () => {
	afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));
	beforeEach(() => {
		resetSwarmState();
	});

	it('a reviewer can run the read-only test-name comparison that used to be blocked', async () => {
		startAgentSession('ps-reviewer', 'reviewer');
		await expect(
			run(
				'ps-reviewer',
				'echo "=== removed ===" && diff <(git show HEAD~1:tests/unit/render.test.js | grep "^test(" | sed \'s/.*test(//\') <(grep "^test(" tests/unit/render.test.js | sed \'s/.*test(//\') | grep "^<" || echo "(none removed)"',
			),
		).resolves.toBeUndefined();
	});

	it('the architect can compare two command outputs', async () => {
		startAgentSession('ps-architect', 'architect');
		await expect(
			run('ps-architect', 'comm -23 <(sort a.txt) <(sort b.txt)'),
		).resolves.toBeUndefined();
	});

	it('a destructive command inside a substitution is blocked', async () => {
		startAgentSession('ps-destructive', 'architect');
		await expect(
			run('ps-destructive', 'diff <(rm -rf /) b.txt'),
		).rejects.toThrow(/filesystem root/);
	});

	it('a write the outer command makes beside a substitution is checked (root escape)', async () => {
		startAgentSession('ps-outer-write', 'architect');
		await expect(
			run('ps-outer-write', 'echo x > /etc/passwd; tee >(cat > ok.txt)'),
		).rejects.toThrow(
			/not authorised to write "\/etc\/passwd".*AUTHORITY_ROOT_ESCAPE/,
		);
	});

	it('a coder write inside a substitution is checked against the declared scope', async () => {
		coderWithScope('ps-coder-scope', ['src/']);
		await expect(
			run('ps-coder-scope', 'diff <(echo x > outside.txt) src/a.ts'),
		).rejects.toThrow(/WRITE BLOCKED: SCOPE_VIOLATION:.*outside\.txt/);
	});

	it('a coder write inside a substitution within scope is allowed', async () => {
		coderWithScope('ps-coder-inside', ['src/']);
		await expect(
			run('ps-coder-inside', 'diff <(echo x > src/a.ts) src/b.ts'),
		).resolves.toBeUndefined();
	});

	it('a relative write inside a substitution after a cd is refused as unresolvable', async () => {
		startAgentSession('ps-cd', 'architect');
		await expect(
			run('ps-cd', 'cd /etc && cat <(echo x > passwd)'),
		).rejects.toThrow(/BLOCKED/);
	});

	it.each([
		`bash -c 'diff <(rm -rf /) b.txt'`,
		`sh -c 'diff <(rm -rf /) b.txt'`,
		`bash -c "tee >(rm -rf /)"`,
		`eval 'diff <(rm -rf /) b'`,
		`diff <(bash -c 'cat <(rm -rf /)') x`,
		`bash -c 'bash -c "diff <(rm -rf /) y"'`,
	])('a destructive command inside a substitution inside a wrapper is blocked: %s', async (command) => {
		startAgentSession('ps-wrapped', 'architect');
		await expect(run('ps-wrapped', command)).rejects.toThrow(/filesystem root/);
	});

	it.each([
		`bash -c 'rm -rf /'`,
		`bash -c 'echo x > /etc/passwd'`,
	])('a single-quoted shell wrapper no longer hides its payload: %s', async (command) => {
		startAgentSession('ps-single-quoted', 'architect');
		await expect(run('ps-single-quoted', command)).rejects.toThrow(/BLOCKED/);
	});

	it.each([
		`bash -c 'true' > /etc/passwd`,
		`bash -c 'echo x' 2> /etc/passwd`,
		`sh -c 'cat' < in.txt >> /etc/hosts`,
	])('a redirect on the wrapper itself is checked: %s', async (command) => {
		startAgentSession('ps-wrapper-redirect', 'architect');
		await expect(run('ps-wrapper-redirect', command)).rejects.toThrow(
			/AUTHORITY_ROOT_ESCAPE/,
		);
	});

	it.each([
		`bash -lc 'rm -rf /'`,
		`sh -ec 'rm -rf /'`,
		`bash -c -- 'rm -rf /'`,
		`command bash -c 'rm -rf /'`,
		`exec bash -c 'rm -rf /'`,
		`/bin/bash -c 'rm -rf /'`,
		`bash -c r"m -rf /"`,
	])('other wrapper spellings no longer hide the payload: %s', async (command) => {
		startAgentSession('ps-wrapper-spelling', 'architect');
		await expect(run('ps-wrapper-spelling', command)).rejects.toThrow(
			/filesystem root/,
		);
	});

	it.each([
		`bash -c 'echo x #' > /etc/passwd`,
		`sh -c 'true # c' > /etc/passwd`,
		`eval 'echo x #' > /etc/passwd`,
		`bash -c -x 'echo x > /etc/passwd'`,
	])('a write the unwrap would lose is still checked from the raw command: %s', async (command) => {
		startAgentSession('ps-raw-union', 'architect');
		await expect(run('ps-raw-union', command)).rejects.toThrow(
			/AUTHORITY_ROOT_ESCAPE/,
		);
	});

	it.each([
		`echo "a\\""; rm -rf /`,
		`bash -c -e 'rm -rf /'`,
		`/opt/bin/bash -c 'rm -rf /'`,
		`exec -a foo bash -c 'rm -rf /'`,
		`command -p bash -c 'rm -rf /'`,
	])('a destructive command behind quoting or wrapper options is blocked: %s', async (command) => {
		startAgentSession('ps-wrapper-options', 'architect');
		await expect(run('ps-wrapper-options', command)).rejects.toThrow(
			/filesystem root/,
		);
	});

	it('a shell -c whose script is an expansion is refused', async () => {
		startAgentSession('ps-dynamic-script', 'architect');
		await expect(
			run('ps-dynamic-script', `CMD='echo x > /etc/passwd'; bash -c "$CMD"`),
		).rejects.toThrow(/BLOCKED/);
	});

	it('a write to a positional parameter is refused as a dynamic target', async () => {
		startAgentSession('ps-positional-write', 'architect');
		await expect(
			run('ps-positional-write', `bash -c 'echo x > "$0"' /etc/passwd`),
		).rejects.toThrow(/dynamic path target/);
	});

	it.each([
		`eval 'echo hi'`,
		`eval "$(ssh-agent -s)"`,
		`/bin/bash -c 'ls'`,
	])('a legitimate wrapped command still runs: %s', async (command) => {
		startAgentSession('ps-legit-wrapper', 'architect');
		await expect(run('ps-legit-wrapper', command)).resolves.toBeUndefined();
	});

	it.each([
		'Get-ChildItem "C:\\temp\\"; Remove-Item -Recurse -Force C:\\',
		'cmd /c dir "C:\\temp\\" & rd /s /q C:\\',
	])('a Windows command after a quoted path ending in a backslash is still inspected: %s', async (command) => {
		startAgentSession('ps-windows', 'architect');
		const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
		await expect(
			hooks.toolBefore(
				{ tool: 'shell', sessionID: 'ps-windows', callID: 'call-ps-windows' },
				{ args: { command } },
			),
		).rejects.toThrow(/filesystem root/);
	});

	it('positional parameters after a quoted script are not run as commands', async () => {
		startAgentSession('ps-positional', 'architect');
		await expect(
			run('ps-positional', `bash -c 'echo hi' 'rm -rf /'`),
		).resolves.toBeUndefined();
	});

	it('a read-only substitution inside a single-quoted wrapper still runs', async () => {
		startAgentSession('ps-wrapped-ok', 'architect');
		await expect(
			run('ps-wrapped-ok', `bash -c 'diff <(git show HEAD:a.js) a.js'`),
		).resolves.toBeUndefined();
	});

	it('an undelimitable substitution is still rejected as unparseable', async () => {
		startAgentSession('ps-unbalanced', 'architect');
		await expect(run('ps-unbalanced', 'cat <(ls')).rejects.toThrow(
			/failed to parse command/,
		);
	});
});
