# Shell commands with process substitution are analyzed instead of blocked

## What changed

The POSIX shell write detector (`src/hooks/shell-write-detect.ts`) now handles
process substitution, `<(cmd)` and `>(cmd)`, which `bash-parser` cannot parse:

- `extractProcessSubstitutions` replaces each top-level, unquoted substitution
  with a placeholder path (`/dev/fd/swarm-procsub-N`, standing in for the
  `/dev/fd/N` path bash itself substitutes) and returns the inner commands. The
  placeholder is a sink, like `/dev/null`: data written to it goes to the inner
  command, never to a file.
- `detectPosixWrites` parses the placeholder form and analyzes every inner
  command recursively (up to eight levels), so writes inside a substitution are
  detected and checked like any other write.
- `resolveWriteTargets` resolves inner writes against the working directory.
  When the outer command may change directory (`cd`, `pushd` or `popd`
  anywhere, including quoted or escaped forms such as `"cd"`, `\cd` or
  `builtin cd`), a relative write inside a substitution is left unresolved and
  the guardrail refuses it, because the directory it runs in is not tracked.
- The destructive-command check in `src/hooks/guardrails/tool-before.ts` also
  inspects the commands inside substitutions (`collectProcessSubstitutionBodies`),
  searching every wrapped and unwrapped form of the command until nothing new
  appears, so `diff <(rm -rf /) b`, `bash -c 'diff <(rm -rf /) b'` and
  `diff <(bash -c 'cat <(rm -rf /)') x` are all refused as destructive.
- Shell wrappers are unquoted the way the shell does. `dcStripOneWrapper`
  (`src/hooks/guardrails/destructive-command.ts`) used to strip only optional
  double quotes around a `bash -c` / `sh -c` script, so a single-quoted payload
  stayed quoted text that no matcher inspected. A new `dcShellWords` removes
  single quotes (including `'\''`), double quotes with their escapes, and
  backslash escapes. The script is the unquoted first word after `-c`, and the
  raw text after it is kept, so a redirect on the wrapper
  (`bash -c 'true' > /etc/passwd`) applies to the unwrapped command and
  positional parameters become extra arguments (a write that targets one is
  refused as dynamic, see below). Accepted spellings:
  an absolute interpreter path (`/bin/bash`), short option clusters containing
  `c` (`-lc`, `-xc`, `-ec`), flag-only options before it (`--norc -c`), `--`
  after it, option words between `-c` and the script (`bash -c -e '...'`),
  interpreters at any absolute path, and the `command` (`-p`/`-v`/`-V`) and
  `exec` (`-c`/`-l`/`-a NAME`) prefixes. `eval` joins its unquoted arguments.
  This unwrap is used by both the destructive-command check and the
  write-scope check. Forms with an option argument before `-c`
  (`bash -o pipefail -c '...'`) are not unwrapped; they stay classified as
  inline interpreter code and are refused.
- The write-scope check uses the writes of the raw command AND of its
  unwrapped form; previously the unwrapped form replaced the raw one, so a
  write the unwrap loses went unchecked (`eval 'echo x #' > /etc/passwd` was
  allowed: once unwrapped, the redirect lands in a comment). Only the raw
  "inline shell code" marker that the unwrap replaces (shell `-c`, `eval`) is
  dropped from the raw writes, and the shell `-c` marker is kept when the
  script is itself an expansion (`bash -c "$CMD"`), which is refused.
- `dcSplitSegments` takes a `posixEscapes` option that honors backslash escapes
  outside single quotes (`'it'\''s; ...'` and `"a\""; ...` split as bash
  splits them); it is off by default, so for PowerShell and cmd a backslash
  remains a path separator. The destructive-command check inspects segments
  split both ways, because the executing shell is not always known (Git Bash on
  Windows): `echo "a\""; rm -rf /` and `Get-ChildItem "C:\temp\"; Remove-Item
  -Recurse -Force C:\` are both refused on every host. The write-scope check
  splits with escapes for the `bash` tool on a non-Windows host and without
  them elsewhere. `dcNormalizeCommand` no longer collapses an escaped quote
  followed by a quote (`\""`), which used to leave an unclosed quote hiding the
  next command.
- Positional and special shell parameters (`$0`-`$9`, `$@`, `$*`, `$#`, ...) in
  a write target are treated as dynamic, so `bash -c 'echo x > "$0"' /etc/passwd`
  is refused instead of being resolved to a literal file name.
- Anything that cannot be delimited with certainty (unbalanced parentheses or
  quotes, or `<(`/`>(` glued to a word, a digit, or another redirect such as
  `2>(` or `<<(`) is left as is and is still rejected as unparseable. Quoted
  text is never treated as a substitution.

## Why

Every command using process substitution was rejected with `BLOCKED: bash
write detection failed to parse command — rejecting for safety`, including
read-only ones that agents use routinely, such as
`diff <(git show HEAD~1:file) <(cat file)`. A reviewer lost a turn to exactly
that and fell back to a less reliable comparison.

The change also closes two gaps. First, single-quoted shell wrappers hid
their payload from every check: for the architect, which runs unsandboxed,
`bash -c 'rm -rf /'` and `bash -c 'echo x > /etc/passwd'` were allowed while
the double-quoted forms were blocked. An adversarial test in
`tests/unit/hooks/guardrails-swarm-path-evasion.adversarial.test.ts` had
documented `sh -c 'mv .swarm/file /tmp/'` as a known bypass; it is now blocked
and the test asserts that. Second, when parsing failed, a regex fallback looked only
inside `>(...)`, and if it found a write there it cleared the parse error, so
the rest of the command went unanalyzed:
`echo x > /etc/passwd; tee >(cat > ok.txt)` reported only `ok.txt` and was
allowed for the architect. A command that cannot be parsed now always stays a
parse error, and the outer command of a substitution is always analyzed.

## Migration

None.
