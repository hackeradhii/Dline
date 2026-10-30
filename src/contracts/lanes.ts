import * as v from 'valibot';
import { nonNegativeInt } from './parse';
import { IceCandidateSchema, SessionDescriptionSchema } from './signaling';
import { LANES } from '../shared/config';

/**
 * Lanes: extra peer connections that carry file blocks in parallel. They are negotiated in-band,
 * over `ctrl`, so no server is involved. Each lane has its own SCTP congestion window: one
 * window per round trip is what caps a single connection on long or lossy paths.
 *
 * The host offers, the guest answers (no glare). Lane 0 is the main connection itself and needs no
 * signaling.
 */
const LaneNumber = v.pipe(nonNegativeInt, v.minValue(1), v.maxValue(LANES.maxNumber));

export const LaneSignalSchema = v.variant('t', [
  v.object({ t: v.literal('lane-sdp'), n: LaneNumber, d: SessionDescriptionSchema }),
  v.object({ t: v.literal('lane-ice'), n: LaneNumber, c: v.nullable(IceCandidateSchema) }),
  v.object({ t: v.literal('lane-close'), n: LaneNumber }),
]);
export type LaneSignal = v.InferOutput<typeof LaneSignalSchema>;
