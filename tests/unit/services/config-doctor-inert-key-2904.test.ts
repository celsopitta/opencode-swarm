import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type PluginConfig,
	PluginConfigSchema,
} from '../../../src/config/schema';
import { runConfigDoctor } from '../../../src/services/config-doctor';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Isolate the raw collectors from this machine's real user config (the raw
// collectors read ~/.config/opencode/opencode-swarm.json when XDG_CONFIG_HOME is
// unset — see the #2102 raw-collector contract).
const PREV_XDG = process.env.XDG_CONFIG_HOME;
// Create the .config segment inside the temp root (getConfigPaths asserts the
// .config substring — the C10 precedent). canonicalMkdtemp satisfies FR-011.
const XDG_BASE = canonicalMkdtemp('2904-doctor-xdg-');
const XDG_ROOT = path.join(XDG_BASE, '.config');
fs.mkdirSync(XDG_ROOT, { recursive: true });

beforeEach(() => {
	process.env.XDG_CONFIG_HOME = XDG_ROOT;
});

afterAll(() => {
	if (PREV_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = PREV_XDG;
	fs.rmSync(XDG_BASE, { recursive: true, force: true });
});

function tempProject(): string {
	return canonicalMkdtemp('2904-doctor-proj-');
}

function writeProjectConfig(dir: string, raw: Record<string, unknown>): void {
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(raw),
		'utf8',
	);
}

function defaults(): PluginConfig {
	return PluginConfigSchema.parse({});
}

describe('config doctor — inert-config-key advisory (issue #2904 AC3)', () => {
	it('warns when the raw config sets a key declared inert (parallelization)', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, { parallelization: { enabled: true } });
			const result = runConfigDoctor(defaults(), dir);
			const finding = result.findings.find((f) => f.id === 'inert-config-key');
			expect(finding).toBeDefined();
			expect(finding?.severity).toBe('warn');
			expect(finding?.path).toBe('parallelization');
			expect(finding?.description.length).toBeGreaterThan(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does NOT warn for a consumed key the user sets (turbo_mode)', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, { turbo_mode: true });
			const result = runConfigDoctor(defaults(), dir);
			expect(result.findings.some((f) => f.id === 'inert-config-key')).toBe(
				false,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does NOT warn when the inert key is absent (schema defaults never fire it)', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, { todo_gate: { mode: 'advisory' } });
			const result = runConfigDoctor(defaults(), dir);
			expect(result.findings.some((f) => f.id === 'inert-config-key')).toBe(
				false,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does NOT warn on an empty/default-only config directory', () => {
		const dir = tempProject();
		try {
			const result = runConfigDoctor(defaults(), dir);
			expect(result.findings.some((f) => f.id === 'inert-config-key')).toBe(
				false,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('the advisory is non-auto-fixable', () => {
		const dir = tempProject();
		try {
			writeProjectConfig(dir, { parallelization: { enabled: true } });
			const result = runConfigDoctor(defaults(), dir);
			const finding = result.findings.find((f) => f.id === 'inert-config-key');
			expect(finding?.autoFixable).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('reports an inert key set in BOTH user and project configs exactly once (F-004b dedupe)', () => {
		const dir = tempProject();
		const userConfigDir = path.join(XDG_ROOT, 'opencode');
		try {
			// User config (via XDG_CONFIG_HOME) and project config both set the
			// inert key — one dedupe set across both files reports it once.
			fs.mkdirSync(userConfigDir, { recursive: true });
			fs.writeFileSync(
				path.join(userConfigDir, 'opencode-swarm.json'),
				JSON.stringify({ parallelization: { enabled: true } }),
				'utf8',
			);
			writeProjectConfig(dir, { parallelization: { enabled: true } });
			const result = runConfigDoctor(defaults(), dir);
			const inert = result.findings.filter((f) => f.id === 'inert-config-key');
			expect(inert.length).toBe(1);
			expect(inert[0]?.path).toBe('parallelization');
		} finally {
			fs.rmSync(userConfigDir, { recursive: true, force: true });
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
