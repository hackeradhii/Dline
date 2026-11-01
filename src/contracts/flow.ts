import * as v from 'valibot';
import { LANES } from '../shared/config';
import { nonNegativeInt } from './parse';

/**
 * Dline Flow feedback (PLAN.md §5.1), JSON on `ctrl`. Every message is optional: an older peer's
 * schema rejects the unknown types, so it ignores them, never answers, and the sender keeps
 * today's pacing.
 *
 *   sender → receiver   flow-probe   sequence number, the sender's monotonic time
 *   receiver → sender   flow-echo    the probe back, with the receiver's monotonic time on arrival
 *                                    and the bulk bytes it has received on all lanes so far
 *                       flow-mark    drain marker `m` arrived on lane `n` (0 = the main bulk
 *                                    channel), so everything sent before it on that lane is in
 *
 * Times are monotonic milliseconds at 0.1 ms precision; the two clocks have an unknown offset.
 */
const Ms = v.pipe(v.number(), v.finite(), v.minValue(0));

export const FlowControlSchema = v.variant('t', [
  v.object({ t: v.literal('flow-probe'), s: nonNegativeInt, ts: Ms }),
  v.object({ t: v.literal('flow-echo'), s: nonNegativeInt, ts: Ms, ra: Ms, rb: nonNegativeInt }),
  v.object({ t: v.literal('flow-mark'), m: nonNegativeInt, n: v.pipe(nonNegativeInt, v.maxValue(LANES.maxNumber)) }),
]);

/** A monotonic time as it goes on the wire. */
export const wireMs = (ms: number): number => Math.round(ms * 10) / 10;
