import * as v from 'valibot';
import { shortText } from './parse';
import { ROOM } from '../shared/config';

/**
 * Signaling messages. The same schemas validate on the client and in the Worker (DRY).
 * The rendezvous server relays only these; it never sees media or files.
 */

export const SessionDescriptionSchema = v.object({
  type: v.picklist(['offer', 'answer', 'pranswer', 'rollback']),
  sdp: v.optional(shortText(ROOM.maxMessageBytes)),
});

export const IceCandidateSchema = v.object({
  candidate: shortText(1024),
  sdpMid: v.nullish(shortText(64)),
  sdpMLineIndex: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(64))),
  usernameFragment: v.nullish(shortText(256)),
});

/** Peer-to-peer signals: relayed verbatim by the server, also sent over `ctrl` once connected. */
export const SignalSchema = v.variant('t', [
  v.object({ t: v.literal('sdp'), d: SessionDescriptionSchema }),
  v.object({ t: v.literal('ice'), c: v.nullable(IceCandidateSchema) }),
  v.object({ t: v.literal('bye') }),
]);
export type Signal = v.InferOutput<typeof SignalSchema>;

export const ROLES = ['host', 'guest'] as const;
export type Role = (typeof ROLES)[number];

export const SERVER_ERRORS = ['room-full', 'no-room', 'bad-request', 'rate-limited', 'expired', 'replaced'] as const;
export type ServerErrorCode = (typeof SERVER_ERRORS)[number];

/** Messages the rendezvous server itself sends. */
export const ServerEventSchema = v.variant('t', [
  v.object({ t: v.literal('joined'), role: v.picklist(ROLES), token: shortText(64), peer: v.boolean() }),
  v.object({ t: v.literal('peer'), present: v.boolean() }),
  v.object({ t: v.literal('error'), code: v.picklist(SERVER_ERRORS) }),
]);
export type ServerEvent = v.InferOutput<typeof ServerEventSchema>;

/** Everything a client can receive on the rendezvous socket. */
export const InboundSchema = v.union([SignalSchema, ServerEventSchema]);
export type Inbound = v.InferOutput<typeof InboundSchema>;

/** Query parameters a client sends when opening the socket. */
export const JOIN_PARAMS = { create: 'create', token: 'token' } as const;
