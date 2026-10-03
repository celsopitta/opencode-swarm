/**
 * v2 event subscription pump (issue #3004 / #2910).
 *
 * Consumes the v2 host's event stream (async iterable from
 * `ctx.event.subscribe()`) and maps host events onto the plugin's existing v1
 * event handler. The pump runs detached; the returned stop function breaks
 * iteration (called by the v2 cleanup).
 *
 * Event-name map (full table in docs/host/v2-hook-inventory.md row 14):
 *
 *   v2 event                → v1 handler input
 *   ------------------------+-------------------------------------------
 *   session.idle            → { type: 'session.idle', properties }
 *   session.status.updated  → { type: 'session.idle', properties } (state watch)
 *   session.status          → { type: 'session.status', properties } (type-preserving; #3022)
 *   session.text.delta      → { type: 'message.part.updated', properties }
 *   session.text.ended      → { type: 'message.updated', properties }
 *   session.tool.called     → { type: 'message.part.updated', properties }
 *   session.tool.success    → { type: 'message.updated', properties }
 *   session.tool.failed     → { type: 'message.updated', properties }
 *   session.execution.failed → { type: 'session.error', properties }
 *   session.error           → { type: 'session.error', properties } (SDK dialect; #3022)
 *   session.deleted / session.created → same-name v1 types
 *
 * Payload dialect (#3022 D3 live capture): plugin-stream envelopes carry the
 * payload under `data` (live 2.0.21 emits `session.execution.failed` with
 * `data:{sessionID, error:{...}}`); the @opencode-ai/sdk SSE/REST dialect
 * carries it under `properties` with the error event named `session.error`.
 * Both names and both payload keys are accepted.
 *
 * Unmapped event types are counted in a bounded debug log, never silently
 * assumed. This module is named deferred-/startDeferred- per the C6 await
 * convention (its awaits live in deferred-named helpers).
 */

import { recordSessionChatAgent } from '../../models/task-model-routing';
import { log } from '../../utils';
import { withTimeout } from '../../utils/timeout';
import type { V1HooksSubset, V2EventEnvelope, V2PluginContext } from './types';

const V2_EVENT_BATCH_TIMEOUT_MS = 60_000;
const UNMAPPED_LOG_LIMIT = 20;

interface MappedEvent {
	type: string;
	properties: Record<string, unknown>;
}

/** Map a v2 event envelope onto the v1 handler input (or undefined). */
export function mapV2EventToV1(
	envelope: V2EventEnvelope,
): MappedEvent | undefined {
	const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
	if (type === undefined) return undefined;
	// #3022: live plugin-stream envelopes carry the payload under `data`; the
	// SDK SSE/REST dialect carries it under `properties`. Accept both.
	const data =
		(envelope as { data?: Record<string, unknown> }).data ??
		(envelope as { properties?: Record<string, unknown> }).properties ??
		{};
	const sessionID =
		typeof data.sessionID === 'string' ? data.sessionID : undefined;
	switch (type) {
		case 'session.idle':
		case 'session.status.updated':
			return {
				type: 'session.idle',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.status':
			// #3022 plan-critic blocker 1: type-preserving. The v1 handler's
			// terminalization predicate filters `session.status` on
			// status === 'idle' or status.type === 'idle'|'error'
			// (src/index.ts isTerminalSessionEvent), so live `busy`/`retry`
			// transitions can never terminalize a running session the way a
			// premature `session.idle` mapping would.
			return {
				type: 'session.status',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.error':
		case 'session.execution.failed':
			// v1 consumers key on 'session.error' (the src/index.ts session.error
			// branch: model-fallback advance, pr-workflow auto-wake). Live hosts
			// emit 'session.execution.failed' (D3 capture); the SDK dialect
			// names it 'session.error' — both map here.
			return {
				type: 'session.error',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.deleted':
			// v1 terminal cleanup (delegation-gate sessionEnded, owner cleanup,
			// pr-workflow gate terminalization) keys on 'session.deleted'.
			return {
				type: 'session.deleted',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.created':
			// v1 pr-workflow session resolver keys on 'session.created'.
			return {
				type: 'session.created',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.text.delta':
		case 'session.tool.called':
		case 'session.tool.input.delta':
			return {
				type: 'message.part.updated',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.text.ended':
		case 'session.tool.success':
		case 'session.tool.failed':
			return {
				type: 'message.updated',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		default:
			return undefined;
	}
}

/** Dispatch one mapped event through the v1 handler (deferred-named). */
async function deferredDispatch(
	hooks: V1HooksSubset,
	mapped: MappedEvent,
): Promise<void> {
	const handler = hooks.event;
	if (typeof handler !== 'function') return;
	await withTimeout(
		Promise.resolve(
			handler({ event: { type: mapped.type, properties: mapped.properties } }),
		),
		V2_EVENT_BATCH_TIMEOUT_MS,
		new Error('[opencode-swarm] v2: event dispatch exceeded budget'),
	).catch((err: unknown) => {
		log('v2 event dispatch failed (non-fatal)', {
			type: mapped.type,
			error: err instanceof Error ? err.message : String(err),
		});
	});
}

/**
 * Seed v1 session identity from identity-bearing v2 envelopes (issue #3022 D1).
 *
 * Live capture (d3/run2.log): `session.created` and `session.agent.selected`
 * carry `data.agent`. This runs PUMP-SIDE (not as mapper case labels — those
 * names are in neither the SDK union nor the mapper's legacy allowlist, and
 * Branch B of the v1 session.error arm resolves identity through
 * `recordSessionChatAgent`'s map, the same bounded store the v1 chat boundary
 * writes). Fail-open by construction: non-string fields are ignored.
 */
export function seedSessionIdentityFromEnvelope(
	envelope: V2EventEnvelope,
): void {
	const type = typeof envelope?.type === 'string' ? envelope.type : undefined;
	if (type !== 'session.created' && type !== 'session.agent.selected') return;
	const payload =
		(envelope as { data?: Record<string, unknown> }).data ??
		(envelope as { properties?: Record<string, unknown> }).properties ??
		{};
	const sessionID =
		typeof payload.sessionID === 'string' ? payload.sessionID : undefined;
	const agent = typeof payload.agent === 'string' ? payload.agent : undefined;
	if (sessionID && agent) recordSessionChatAgent(sessionID, agent);
}

/** Start the detached event pump. Returns a stop function. Named per the C6
 * convention (deferred).
 */
export function startDeferredEventPump(
	ctx: V2PluginContext,
	hooks: V1HooksSubset,
): () => void {
	let stopped = false;
	const unmappedSeen = new Set<string>();
	void (async () => {
		try {
			const subscribe = ctx?.event?.subscribe;
			if (typeof subscribe !== 'function') {
				log(
					'v2 event subscribe surface absent; event pump idle (non-fatal)',
					{},
				);
				return;
			}
			const iterable = await withTimeout(
				Promise.resolve(subscribe()),
				V2_EVENT_BATCH_TIMEOUT_MS,
				new Error('[opencode-swarm] v2: event subscribe exceeded budget'),
			);
			if (
				!iterable ||
				typeof (iterable as AsyncIterable<V2EventEnvelope>)[
					Symbol.asyncIterator
				] !== 'function'
			) {
				log(
					'v2 event subscribe returned a non-iterable; event pump idle (non-fatal)',
					{},
				);
				return;
			}
			for await (const envelope of iterable as AsyncIterable<V2EventEnvelope>) {
				if (stopped) break;
				seedSessionIdentityFromEnvelope(envelope);
				const mapped = mapV2EventToV1(envelope);
				if (mapped === undefined) {
					const t =
						typeof envelope?.type === 'string' ? envelope.type : '(no type)';
					if (!unmappedSeen.has(t) && unmappedSeen.size < UNMAPPED_LOG_LIMIT) {
						unmappedSeen.add(t);
						log('v2 event type not mapped (ignored)', { type: t });
					}
					continue;
				}
				await deferredDispatch(hooks, mapped);
			}
		} catch (err) {
			if (!stopped) {
				log('v2 event pump stopped on error (non-fatal)', {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	})();
	return () => {
		stopped = true;
	};
}
