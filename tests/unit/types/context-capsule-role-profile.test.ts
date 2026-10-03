/**
 * RoleProfile type-safety tests extracted from context-capsule.test.ts
 * (FR-006: the parent file is grandfathered over-cap and must not grow).
 * Covers the required include_decisions field added for #3016.
 */

import { describe, expect, test } from 'bun:test';
import type { RoleProfile } from '../../../src/types/context-capsule';

describe('RoleProfile interface', () => {
	test('accepts valid RoleProfile with all required fields', () => {
		const profile: RoleProfile = {
			role: 'coder',
			strategy: 'scoped_files',
			max_files: 10,
			include_rejection: false,
			include_coverage: false,
			include_claims: false,
			include_decisions: false,
		};

		expect(profile.role).toBe('coder');
		expect(profile.strategy).toBe('scoped_files');
		expect(profile.max_files).toBe(10);
		expect(profile.include_rejection).toBe(false);
		expect(profile.include_coverage).toBe(false);
		expect(profile.include_claims).toBe(false);
		expect(profile.include_decisions).toBe(false);
	});

	test('accepts RoleProfile with all optional fields populated', () => {
		const profile: RoleProfile = {
			role: 'test_engineer',
			strategy: 'scoped_files_plus_rejection',
			max_files: 20,
			include_rejection: true,
			include_coverage: true,
			include_claims: true,
			include_decisions: false,
		};

		expect(profile.role).toBe('test_engineer');
		expect(profile.strategy).toBe('scoped_files_plus_rejection');
		expect(profile.max_files).toBe(20);
		expect(profile.include_rejection).toBe(true);
		expect(profile.include_coverage).toBe(true);
		expect(profile.include_claims).toBe(true);
	});

	test('rejects RoleProfile missing required fields', () => {
		// @ts-expect-error - role is required
		const missingRole: RoleProfile = {
			strategy: 'test',
			max_files: 10,
			include_rejection: false,
			include_coverage: false,
			include_claims: false,
			include_decisions: false,
		};

		// @ts-expect-error - strategy is required
		const missingStrategy: RoleProfile = {
			role: 'coder',
			max_files: 10,
			include_rejection: false,
			include_coverage: false,
			include_claims: false,
			include_decisions: false,
		};

		// @ts-expect-error - max_files is required
		const missingMaxFiles: RoleProfile = {
			role: 'coder',
			strategy: 'test',
			include_rejection: false,
			include_coverage: false,
			include_claims: false,
			include_decisions: false,
		};

		// @ts-expect-error - include_rejection is required
		const missingIncludeRejection: RoleProfile = {
			role: 'coder',
			strategy: 'test',
			max_files: 10,
			include_coverage: false,
			include_claims: false,
			include_decisions: false,
		};

		// @ts-expect-error - include_coverage is required
		const missingIncludeCoverage: RoleProfile = {
			role: 'coder',
			strategy: 'test',
			max_files: 10,
			include_rejection: false,
			include_claims: false,
			include_decisions: false,
		};

		// @ts-expect-error - include_claims is required
		const missingIncludeClaims: RoleProfile = {
			role: 'coder',
			strategy: 'test',
			max_files: 10,
			include_rejection: false,
			include_coverage: false,
			include_decisions: false,
		};

		// @ts-expect-error - include_decisions is required (#3016)
		const missingIncludeDecisions: RoleProfile = {
			role: 'coder',
			strategy: 'test',
			max_files: 10,
			include_rejection: false,
			include_coverage: false,
			include_claims: false,
		};
	});

	test('rejects extra fields not in interface', () => {
		// @ts-expect-error - Extra field 'extraField' should be rejected
		const polluted: RoleProfile = {
			role: 'coder',
			strategy: 'test',
			max_files: 10,
			include_rejection: false,
			include_coverage: false,
			include_claims: false,
			include_decisions: false,
			extraField: 'should not be allowed',
		};
	});
});
