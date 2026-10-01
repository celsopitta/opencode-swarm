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
 *   session.text.delta      → { type: 'message.part.updated', properties }
 *   session.text.ended      → { type: 'message.updated', properties }
 *   session.tool.called     → { type: 'message.part.updated', properties }
 *   session.tool.success    → { type: 'message.updated', properties }
 *   session.tool.failed     → { type: 'message.updated', properties }
 *   session.execution.failed → { type: 'session.error', properties }
 *   session.deleted / session.created → same-name v1 types
 *
 * Unmapped event types are counted in a bounded debug log, never silently
 * assumed. This module is named deferred-/startDeferred- per the C6 await
 * convention (its awaits live in deferred-named helpers).
 */

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
	const data = (envelope as { data?: Record<string, unknown> }).data ?? {};
	const sessionID =
		typeof data.sessionID === 'string' ? data.sessionID : undefined;
	switch (type) {
		case 'session.idle':
		case 'session.status.updated':
			return {
				type: 'session.idle',
				properties: { ...(sessionID ? { sessionID } : {}), ...data },
			};
		case 'session.execution.failed':
			// v1 consumers key on 'session.error' (the src/index.ts session.error
			// branch: model-fallback advance, pr-workflow auto-wake).
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
 * Start the detached event pump. Returns a stop function. Named per the C6
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
