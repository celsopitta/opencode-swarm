/**
 * bash-parser cannot parse process substitution (`<(cmd)`, `>(cmd)`), so every
 * command using it used to be rejected as a parse error, including read-only
 * ones such as `diff <(git show HEAD~1:a.js) a.js`. Worse, a regex fallback
 * cleared the parse error whenever it found a write inside `>(...)`, so the
 * outer command went unanalyzed. Each substitution is now replaced by a sink
 * placeholder, the rest parses normally, and each inner command is analyzed
 * on its own; anything that cannot be delimited with certainty still fails
 * closed.
 */

import { describe, expect, test } from 'bun:test';
import {
	collectProcessSubstitutionBodies,
	detectPosixWrites,
	extractProcessSubstitutions,
	PROCESS_SUBSTITUTION_PLACEHOLDER_PREFIX,
	resolveWriteTargets,
} from '../../../src/hooks/shell-write-detect';

const P = PROCESS_SUBSTITUTION_PLACEHOLDER_PREFIX;
const WS = '/ws';

describe('extractProcessSubstitutions', () => {
	test('replaces each top-level substitution with a numbered placeholder', () => {
		expect(
			extractProcessSubstitutions('diff <(git show HEAD~1:a.js) <(cat a.js)'),
		).toEqual({
			command: `diff ${P}0 ${P}1`,
			substitutions: [
				{ kind: '<', body: 'git show HEAD~1:a.js', placeholder: `${P}0` },
				{ kind: '<', body: 'cat a.js', placeholder: `${P}1` },
			],
		});
	});

	test('handles a write substitution behind a redirect and an input redirect from one', () => {
		expect(extractProcessSubstitutions('echo hi > >(cat)')?.command).toBe(
			`echo hi > ${P}0`,
		);
		expect(extractProcessSubstitutions('cat < <(ls)')?.command).toBe(
			`cat < ${P}0`,
		);
	});

	test('keeps nested substitutions inside the outer body', () => {
		const extracted = extractProcessSubstitutions('diff <(cat <(ls)) b');
		expect(extracted?.substitutions.map((s) => s.body)).toEqual(['cat <(ls)']);
		expect(collectProcessSubstitutionBodies('diff <(cat <(ls)) b')).toEqual([
			'cat <(ls)',
			'ls',
		]);
	});

	test('a parenthesis or quote inside the body does not end it early', () => {
		const extracted = extractProcessSubstitutions(
			`diff <(grep "a)" x | sed 's/)/]/' | (cat)) y`,
		);
		expect(extracted?.substitutions[0]?.body).toBe(
			`grep "a)" x | sed 's/)/]/' | (cat)`,
		);
		expect(extracted?.command).toBe(`diff ${P}0 y`);
	});

	test.each([
		['single quotes', "echo '<(x)'"],
		['double quotes', 'echo "<(x) >(y)"'],
		['an escaped character', 'echo \\<(x)'],
	])('text in %s is not a substitution', (_label, command) => {
		const extracted = extractProcessSubstitutions(command);
		expect(extracted?.substitutions).toEqual([]);
		expect(extracted?.command).toBe(command);
	});

	test.each([
		['unbalanced parentheses', 'cat <(ls'],
		['an unterminated quote in the body', "cat <(echo 'x)"],
		['a here-doc operator before it', 'cat <<(ls)'],
		['a file descriptor glued to it', 'cmd 2>(cat)'],
		['a word glued to it', 'cat a<(ls)'],
	])('%s fails closed (null)', (_label, command) => {
		expect(extractProcessSubstitutions(command)).toBeNull();
	});
});

describe('detectPosixWrites with process substitution', () => {
	test.each([
		'diff <(git show HEAD~1:tests/unit/render.test.js | grep "^test(" | sed \'s/.*test(//\') <(grep "^test(" tests/unit/render.test.js | sed \'s/.*test(//\')',
		'comm -23 <(sort a.txt) <(sort b.txt)',
		'cat < <(ls)',
		'echo hi > >(cat)',
		'tee >(cat) < in.txt',
		'diff <(cat <(ls)) b.txt',
	])('a read-only use parses and reports no writes: %s', (command) => {
		const result = detectPosixWrites(command);
		expect(result.parseError).toBeUndefined();
		expect(result.writes).toEqual([]);
	});

	test('a write inside a substitution is detected', () => {
		expect(detectPosixWrites('diff <(echo x > f.txt) b.txt').writes).toEqual([
			{ category: 'redirect', operator: '>', path: 'f.txt' },
		]);
	});

	test('a write nested two levels deep is detected', () => {
		expect(detectPosixWrites('diff <(cat <(echo x > n.txt)) y').writes).toEqual(
			[{ category: 'redirect', operator: '>', path: 'n.txt' }],
		);
	});

	test('the outer command is analyzed too: a write beside a substitution is detected', () => {
		const result = detectPosixWrites(
			'echo x > /etc/passwd; tee >(cat > ok.txt)',
		);
		expect(result.parseError).toBeUndefined();
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: '>',
			path: '/etc/passwd',
		});
		expect(result.writes).toContainEqual({
			category: 'redirect',
			operator: '>',
			path: 'ok.txt',
		});
	});

	test('a command that still cannot be parsed stays a parse error even when the fallback sees a write', () => {
		const result = detectPosixWrites('tee >(cat > ok.txt) && echo (');
		expect(result.parseError).toBe(true);
	});

	test('an inner command that cannot be parsed makes the whole command a parse error', () => {
		expect(detectPosixWrites('diff <(echo ( ) b').parseError).toBe(true);
	});

	test('an undelimitable substitution is a parse error', () => {
		expect(detectPosixWrites('cat <(ls').parseError).toBe(true);
		expect(detectPosixWrites('cmd 2>(cat)').parseError).toBe(true);
	});

	test('nesting deeper than the bound is a parse error', () => {
		let command = 'ls';
		for (let i = 0; i < 9; i++) command = `cat <(${command})`;
		expect(detectPosixWrites(command).parseError).toBe(true);
	});
});

describe('resolveWriteTargets with process substitution', () => {
	function resolve(command: string): Array<string | null> {
		const writes = detectPosixWrites(command).writes;
		return resolveWriteTargets(command, writes, WS).map((r) => r.resolvedPath);
	}

	test('an inner relative write resolves against the cwd', () => {
		expect(resolve('diff <(echo x > f.txt) b.txt')).toEqual([`${WS}/f.txt`]);
	});

	test('an inner relative write is unresolved when the outer command changes directory', () => {
		expect(resolve('cd /etc && diff <(echo x > passwd) b.txt')).toEqual([null]);
	});

	test.each([
		'"cd" /etc && tee >(cat > rel.txt)',
		'\\cd /etc && tee >(cat > rel.txt)',
		'c""d /etc && tee >(cat > rel.txt)',
		'builtin cd /etc && tee >(cat > rel.txt)',
		'pushd /etc && tee >(cat > rel.txt)',
	])('a quoted, escaped or indirect directory change still leaves the inner relative write unresolved: %s', (command) => {
		expect(resolve(command)).toEqual([null]);
	});

	test('an inner absolute write still resolves when the outer command changes directory', () => {
		expect(resolve('cd /etc && diff <(echo x > /var/tmp/a.txt) b')).toEqual([
			'/var/tmp/a.txt',
		]);
	});

	test('an inner command that changes directory resolves its own write', () => {
		expect(resolve('diff <(cd sub && echo x > f.txt) b')).toEqual([
			`${WS}/sub/f.txt`,
		]);
	});

	test('outer writes keep full cwd tracking', () => {
		expect(resolve('cd out && echo x > o.txt; cat <(ls)')).toEqual([
			`${WS}/out/o.txt`,
		]);
	});
});
