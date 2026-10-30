import * as v from 'valibot';
import { LaneSignalSchema } from './lanes';
import { nonNegativeInt } from './parse';
import { SignalSchema } from './signaling';
import { TransferControlSchema } from './transfer';

/**
 * Messages on the `ctrl` data channel once peers are connected.
 * Unknown types are rejected by the schema and ignored, so newer versions can add messages safely.
 */
export const ControlSchema = v.union([
  SignalSchema,
  LaneSignalSchema,
  TransferControlSchema,
  v.variant('t', [
    v.object({ t: v.literal('ping'), ts: nonNegativeInt }),
    v.object({ t: v.literal('pong'), ts: nonNegativeInt }),
    v.object({ t: v.literal('ring') }),
    v.object({ t: v.literal('accept') }),
    v.object({ t: v.literal('decline') }),
    v.object({ t: v.literal('hangup') }),
    v.object({ t: v.literal('media'), audio: v.boolean(), video: v.boolean() }),
  ]),
]);
export type ControlMessage = v.InferOutput<typeof ControlSchema>;
export type ControlType = ControlMessage['t'];
export type ControlOf<T extends ControlType> = Extract<ControlMessage, { t: T }>;
