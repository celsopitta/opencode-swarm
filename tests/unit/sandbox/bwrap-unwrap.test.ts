/**
 * The host stores the sandbox-wrapped bash command as the agent's own tool
 * input, so agents copy `/usr/bin/bwrap ... -- bash -c '<cmd>'` into later
 * calls. `unwrapGeneratedBubblewrapCommand` must be the exact inverse of
 * `BubblewrapSandboxExecutor.wrapCommand` for every shape it emits, and must
 * refuse (return null) anything that is not exactly such a shape.
 */

import { describe, expect, test } from 'bun:test';
import {
	BubblewrapSandboxExecutor,
	unwrapGeneratedBubblewrapCommand,
} from '../../../src/sandbox/linux/bubblewrap-executor';

function wrap(
	command: string,
	opts: {
		scope?: string[];
		env?: Record<string, string | null>;
		network?: 'off' | 'on';
		readonlyRoots?: string[];
	} = {},
): string {
	const executor = new BubblewrapSandboxExecutor([]);
	(executor as unknown as { _available: boolean })._available = true;
	return executor.wrapCommand(
		command,
		opts.scope ?? ['/ws/tests/t.js'],
		undefined,
		opts.env,
		{ network_mode: opts.network ?? 'off', readonly_roots: opts.readonlyRoots },
	);
}

const COMMANDS = [
	'pwd && ls -la',
	'echo \'single quoted\' && grep -n "double" file.txt',
	'node tests/integration.test.js; echo "EXIT_CODE=$?"',
	"sed -i 's/a/b/' it's-a-file.js",
	'for f in tests/*.js; do node "$f" >/dev/null 2>&1 && echo ok; done',
	'cat <<EOF > out.txt\nline one\nline two\nEOF',
	'echo $(git rev-parse HEAD) `date` | tee log.txt',
	"printf '%s\\n' \"a b\" 'c'\"'\"'d'",
];

describe('unwrapGeneratedBubblewrapCommand: inverse of wrapCommand', () => {
	test.each(COMMANDS)('round-trips %s', (command) => {
		expect(unwrapGeneratedBubblewrapCommand(wrap(command))).toBe(command);
	});

	test('round-trips with network on, env overrides, read-only roots and several scope paths', () => {
		const command = "echo 'hi' > tests/a.js";
		const wrapped = wrap(command, {
			scope: ['/ws/tests/a.js', "/ws/it's dir/b.js"],
			env: { FOO: "va'lue with space", DROP: null },
			network: 'on',
			readonlyRoots: ['/ws'],
		});
		expect(wrapped).toContain('--setenv');
		expect(wrapped).toContain('--unsetenv');
		expect(unwrapGeneratedBubblewrapCommand(wrapped)).toBe(command);
	});

	test('peels a wrapper copied twice', () => {
		const command = 'ls js tests';
		expect(unwrapGeneratedBubblewrapCommand(wrap(wrap(command)))).toBe(command);
	});

	test('accepts tab separators between words', () => {
		const wrapped = wrap('ls').replace(/ /g, '\t');
		expect(unwrapGeneratedBubblewrapCommand(wrapped)).toBe('ls');
	});

	test('peels at most eight nested copies; a deeper stack stays a wrapper', () => {
		let eight = 'ls';
		for (let i = 0; i < 8; i++) eight = wrap(eight);
		expect(unwrapGeneratedBubblewrapCommand(eight)).toBe('ls');
		const nine = wrap(eight);
		const peeled = unwrapGeneratedBubblewrapCommand(nine);
		expect(peeled).not.toBe('ls');
		expect(peeled?.startsWith('/usr/bin/bwrap ')).toBe(true);
	});

	test('accepts the bare bwrap binary name the executor falls back to', () => {
		const wrapped = wrap('ls').replace(/^\/usr\/bin\/bwrap /, 'bwrap ');
		expect(unwrapGeneratedBubblewrapCommand(wrapped)).toBe('ls');
	});
});

describe('unwrapGeneratedBubblewrapCommand: anything else is not unwrapped', () => {
	const base = wrap('ls');
	test.each([
		['a plain command', 'ls -la'],
		[
			'bwrap from another path',
			base.replace('/usr/bin/bwrap', '/opt/bin/bwrap'),
		],
		[
			'an option the executor never emits',
			base.replace('--die-with-parent', '--bind-try /x /x --die-with-parent'),
		],
		['sh instead of bash', base.replace('-- bash -c', '-- sh -c')],
		['no -c', base.replace('-- bash -c ', '-- bash ')],
		['a trailing word after the inner command', `${base} extra`],
		['a command chained after the wrapper', `${base}; rm -rf /tmp/x`],
		['a redirect after the wrapper', `${base} > /tmp/out`],
		[
			'a double-quoted inner command',
			base.replace(/-- bash -c '.*'$/, '-- bash -c "ls"'),
		],
		[
			'a variable in the options',
			base.replace('--cap-drop ALL', '--cap-drop $X'),
		],
		['an option missing its argument', base.replace(/ --size \d+/, ' --size')],
		[
			'bwrap running a program directly',
			'/usr/bin/bwrap --ro-bind /usr /usr -- ls -la',
		],
		['an unterminated quote', "/usr/bin/bwrap --unshare-user -- bash -c 'ls"],
	])('%s', (_label, command) => {
		expect(unwrapGeneratedBubblewrapCommand(command)).toBeNull();
	});
});
