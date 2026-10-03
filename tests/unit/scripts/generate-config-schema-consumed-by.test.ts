import { describe, expect, it } from 'bun:test';
import { buildConfigDocsSection } from '../../../scripts/generate-config-schema';

describe('generate-config-schema — Consumed by column (issue #2904 AC4)', () => {
	const section = buildConfigDocsSection();

	it('emits the five-column header inside the marker block', () => {
		expect(section).toContain(
			'| Key | Type | Default | Description | Consumed by |',
		);
		expect(section).toContain(
			'| --- | ---- | ------- | ----------- | ----------- |',
		);
	});

	it('marks the inert key row with (inert)', () => {
		const row = section
			.split('\n')
			.find((l) => l.startsWith('| `parallelization` |'));
		expect(row).toBeDefined();
		expect(row).toContain('(inert)');
	});

	it('renders a citation cell for a consumed key (first citation + count marker)', () => {
		const row = section
			.split('\n')
			.find((l) => l.startsWith('| `turbo_mode` |'));
		expect(row).toBeDefined();
		expect(row).toContain('src/state.ts:resolveInitialTurboMode');
	});

	it('renders the doctor-owned exemption keys with their doctor citations', () => {
		const dollarSchema = section
			.split('\n')
			.find((l) => l.startsWith('| `$schema` |'));
		expect(dollarSchema).toBeDefined();
		expect(dollarSchema).toContain(
			'src/services/config-doctor.ts:validateConfigKey',
		);
	});

	it('contains no literal pipe hazard in citation cells (paths and symbols are pipe-free)', () => {
		for (const line of section.split('\n')) {
			if (!line.startsWith('| `')) continue;
			// Key | Type | Default | Description | Consumed by  → 5 cells + edges
			expect(line.split(' | ').length).toBe(5);
		}
	});
});
