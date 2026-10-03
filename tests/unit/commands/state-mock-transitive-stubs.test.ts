/**
 * Drift pin for the state-mock transitive stubs (review PRR-020): the inert
 * stub object hardcodes constants that mirror real src/state exports; this
 * test fails when the real constants change and the stubs drift.
 */

import { describe, expect, test } from 'bun:test';
import {
	MAX_TRACKED_DISPATCH_PARENTS,
	PENDING_DISPATCH_AUTHORIZATION_TTL_MS,
} from '../../../src/state.js';
import { STATE_MOCK_TRANSITIVE_STUBS } from './state-mock-transitive-stubs.js';

describe('state mock transitive stubs', () => {
	test('#3036 dispatch-lineage stub constants mirror the real state exports', () => {
		expect(STATE_MOCK_TRANSITIVE_STUBS.MAX_TRACKED_DISPATCH_PARENTS).toBe(
			MAX_TRACKED_DISPATCH_PARENTS,
		);
		expect(
			STATE_MOCK_TRANSITIVE_STUBS.PENDING_DISPATCH_AUTHORIZATION_TTL_MS,
		).toBe(PENDING_DISPATCH_AUTHORIZATION_TTL_MS);
	});
});
