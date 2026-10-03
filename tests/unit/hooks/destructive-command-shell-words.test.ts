/**
 * `dcStripOneWrapper` used to strip only optional DOUBLE quotes around a
 * `bash -c` script, so a single-quoted payload (`bash -c 'rm -rf /'`) stayed
 * quoted text that no destructive or write matcher inspected. The script and
 * `eval` arguments are now unquoted the way the shell does (`dcShellWords`).
 */

import { describe, expect, test } from 'bun:test';
import {
	dcFirstShellWord,
	dcNormalizeCommand,
	dcShellWords,
	dcSplitSegments,
	dcStripOneWrapper,
	dcUnwrapWrappers,
} from '../../../src/hooks/guardrails/destructive-command';

describe('dcShellWords', () => {
	test.each([
		["'a b' c", ['a b', 'c']],
		["'it'\\''s'", ["it's"]],
		['"a \\"q\\" $x \\\\ \\n"', ['a "q" $x \\ \\n']],
		['a\\ b c', ['a b', 'c']],
		['\'a\'"b"c', ['abc']],
		['  spaced\tout  ', ['spaced', 'out']],
	])('%s', (input, expected) => {
		expect(dcShellWords(input)).toEqual(expected);
	});

	test('an unterminated quote is null', () => {
		expect(dcShellWords("'open")).toBeNull();
		expect(dcShellWords('"open')).toBeNull();
	});
});

describe('dcStripOneWrapper: shell -c and eval payloads are unquoted', () => {
	test.each([
		["bash -c 'rm -rf /'", 'rm -rf /'],
		['bash -c "rm -rf /"', 'rm -rf /'],
		["sh -c 'mv .swarm/file /tmp/'", 'mv .swarm/file /tmp/'],
		["bash -c 'echo it'\\''s > /etc/passwd'", "echo it's > /etc/passwd"],
		[
			"bash -c 'diff <(rm -rf /) b.txt' arg0 arg1",
			'diff <(rm -rf /) b.txt arg0 arg1',
		],
		// Redirects on the wrapper apply to the unwrapped command.
		["bash -c 'true' > /etc/passwd", 'true > /etc/passwd'],
		['bash -c "echo x" 2> /etc/passwd', 'echo x 2> /etc/passwd'],
		["sh -c 'cat' < in.txt >> /etc/hosts", 'cat < in.txt >> /etc/hosts'],
		// More wrapper spellings.
		["bash -lc 'rm -rf /'", 'rm -rf /'],
		["sh -ec 'rm -rf /'", 'rm -rf /'],
		["bash --norc -c 'rm -rf /'", 'rm -rf /'],
		["bash -c -- 'rm -rf /'", 'rm -rf /'],
		["/bin/bash -c 'rm -rf /'", 'rm -rf /'],
		['bash -c r"m -rf /"', 'rm -rf /'],
		['bash -c rm\\ -rf\\ /', 'rm -rf /'],
		["command bash -c 'ls'", "bash -c 'ls'"],
		["exec bash -c 'ls'", "bash -c 'ls'"],
		["zsh -c 'ls'", 'ls'],
		['bash -c ls -la', 'ls -la'],
		["eval 'rm -rf /'", 'rm -rf /'],
		["eval 'echo' 'x' > /etc/passwd", 'echo x > /etc/passwd'],
	])('%s', (input, expected) => {
		expect(dcStripOneWrapper(input)).toBe(expected);
	});

	test('nested single- and double-quoted wrappers unwrap to the innermost command', () => {
		expect(dcUnwrapWrappers(`bash -c 'bash -c "rm -rf /"'`)).toBe('rm -rf /');
	});

	test('dcFirstShellWord returns the unquoted first word and where it ends', () => {
		expect(dcFirstShellWord("'a b'c rest")).toEqual({ word: 'a bc', end: 6 });
		expect(dcFirstShellWord('   ')).toBeNull();
	});

	test('dcSplitSegments honors backslash escapes only in POSIX mode', () => {
		const posix = { posixEscapes: true };
		expect(
			dcSplitSegments("bash -c 'echo it'\\''s; echo x > /etc/passwd'", posix),
		).toEqual(["bash -c 'echo it'\\''s; echo x > /etc/passwd'"]);
		expect(dcSplitSegments('echo "a\\""; rm -rf /', posix)).toEqual([
			'echo "a\\""',
			'rm -rf /',
		]);
		// Default (PowerShell/cmd-safe): a backslash is a path separator, so a
		// quoted path ending in `\` does not swallow the next command.
		expect(
			dcSplitSegments(
				'Get-ChildItem "C:\\temp\\"; Remove-Item -Recurse -Force C:\\',
			),
		).toEqual([
			'Get-ChildItem "C:\\temp\\"',
			'Remove-Item -Recurse -Force C:\\',
		]);
		expect(dcSplitSegments('dir C:\\temp\\;rd /s /q C:\\')).toEqual([
			'dir C:\\temp\\',
			'rd /s /q C:\\',
		]);
	});

	test('dcNormalizeCommand keeps an escaped quote before a closing quote', () => {
		expect(dcNormalizeCommand('echo "a\\""; rm -rf /')).toBe(
			'echo "a\\""; rm -rf /',
		);
		expect(dcNormalizeCommand('r""m -rf /')).toBe('rm -rf /');
	});

	test.each([
		["bash -c -e 'rm -rf /'", 'rm -rf /'],
		["bash -c -x -- 'rm -rf /'", 'rm -rf /'],
		["/opt/bin/bash -c 'rm -rf /'", 'rm -rf /'],
		["exec -a foo bash -c 'ls'", "bash -c 'ls'"],
		["command -p bash -c 'ls'", "bash -c 'ls'"],
	])('more wrapper forms: %s', (input, expected) => {
		expect(dcStripOneWrapper(input)).toBe(expected);
	});

	test('malformed quoting keeps the raw text so matchers still see it', () => {
		expect(dcStripOneWrapper("bash -c 'rm -rf /")).toBe("'rm -rf /");
	});
});
