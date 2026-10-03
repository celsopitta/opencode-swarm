import { describe, expect, it } from 'bun:test';
import { CONFIG_CONSUMERS } from '../../../src/config/consumers';
import { PluginConfigSchema } from '../../../src/config/schema';

const SCHEMA_KEYS = Object.keys(PluginConfigSchema.shape).sort();

describe('CONFIG_CONSUMERS exhaustiveness (issue #2904 AC1)', () => {
	it('declares exactly the PluginConfigSchema top-level key set', () => {
		const declared = Object.keys(CONFIG_CONSUMERS).sort();
		expect(declared).toEqual(SCHEMA_KEYS);
	});

	it('every entry is either a non-empty consumers list or a non-empty inert reason', () => {
		for (const [key, declaration] of Object.entries(CONFIG_CONSUMERS)) {
			const hasConsumers = Array.isArray(declaration.consumers);
			const hasInert = typeof declaration.inert === 'string';
			if (hasInert) {
				expect(hasConsumers, `${key}: dual shape is rejected`).toBe(false);
				expect(
					declaration.inert.trim().length,
					`${key}: inert reason must be non-empty`,
				).toBeGreaterThan(0);
				continue;
			}
			expect(hasConsumers, `${key}: must declare consumers or inert`).toBe(
				true,
			);
			const consumers = declaration.consumers as string[];
			expect(
				consumers.length,
				`${key}: consumers must be non-empty`,
			).toBeGreaterThan(0);
			for (const cite of consumers) {
				expect(typeof cite, `${key}: citation must be a string`).toBe('string');
				expect(
					cite.lastIndexOf(':'),
					`${key}: citation must be path:symbol (${cite})`,
				).toBeGreaterThan(0);
			}
		}
	});

	it('cites only non-test src files outside schema.ts', () => {
		for (const [key, declaration] of Object.entries(CONFIG_CONSUMERS)) {
			if (!('consumers' in declaration)) continue;
			for (const cite of declaration.consumers) {
				const file = cite.slice(0, cite.lastIndexOf(':'));
				expect(
					file.startsWith('src/'),
					`${key}: citation outside src/ (${cite})`,
				).toBe(true);
				expect(
					file.endsWith('.test.ts'),
					`${key}: test-file citation (${cite})`,
				).toBe(false);
				expect(
					file,
					`${key}: schema.ts self-citation is not consumption (${cite})`,
				).not.toBe('src/config/schema.ts');
			}
		}
	});

	it('no citation names a DI/test seam symbol', () => {
		for (const [key, declaration] of Object.entries(CONFIG_CONSUMERS)) {
			if (!('consumers' in declaration)) continue;
			for (const cite of declaration.consumers) {
				const symbol = cite.slice(cite.lastIndexOf(':') + 1);
				expect(symbol, `${key}: seam citation (${cite})`).not.toBe(
					'_internals',
				);
				expect(symbol, `${key}: seam citation (${cite})`).not.toBe(
					'_test_exports',
				);
			}
		}
	});

	it('every non-exempt key has at least one citation outside config-doctor.ts', () => {
		const doctorOwned = new Set(['$schema', 'config_format_version']);
		for (const [key, declaration] of Object.entries(CONFIG_CONSUMERS)) {
			if (!('consumers' in declaration)) continue;
			if (doctorOwned.has(key)) continue;
			const nonDoctor = declaration.consumers.some(
				(cite) => !cite.startsWith('src/services/config-doctor.ts:'),
			);
			expect(
				nonDoctor,
				`${key}: doctor-file-only citations do not satisfy the ratchet`,
			).toBe(true);
		}
	});
});
