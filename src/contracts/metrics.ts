import * as v from 'valibot';
import { nonNegativeInt, shortText } from './parse';
import { ROLES } from './signaling';
import { FINISHED_STATUSES, TRANSFER_DIRECTIONS } from './transfer';

/**
 * Performance reports a device sends to the Worker, which only logs them (Workers Logs). Numbers
 * and coarse labels only: never file names, contents, addresses or messages. One schema for the
 * client (types) and the Worker (validation), so nothing unvalidated is ever logged.
 */

export const METRICS_PATH = '/api/metrics';

const label = shortText(24);
const int = nonNegativeInt;

const PathSchema = v.object({
  kind: v.picklist(['lan', 'internet', 'relay']),
  family: v.picklist(['IPv4', 'IPv6', 'mdns', 'unknown']),
  /** Candidate types (host, srflx, prflx, relay) of this side and the other. */
  local: label,
  remote: label,
});

/** One side's network as its ICE candidates describe it (no addresses). */
const ProfileSchema = v.object({ udp: v.boolean(), ipv4: label, ipv6: v.boolean(), relayOnly: v.boolean() });

/** How a session ended: this side left or closed the tab, or the connection failed (`FailureReason`). */
export const SESSION_ENDS = ['left', 'closed', 'lost', 'peer-left', 'no-path'] as const;
export type SessionEnd = (typeof SESSION_ENDS)[number];

/** Fields every report carries. `session` is random per connection, so the two sides differ. */
const common = {
  session: v.pipe(v.string(), v.regex(/^[\w-]{8,24}$/)),
  role: v.picklist(ROLES),
  mode: v.picklist(['rendezvous', 'link']),
  /** Coarse device, e.g. "Android Chrome 156". */
  device: shortText(40),
  /** The app build, e.g. "2026-11-04 10:45" (optional: pages cached before it existed don't send it). */
  build: v.optional(shortText(24)),
};

/** What one direction of a session moved: totals, and its speed averaged over the time it was moving. */
const SideSchema = v.object({ bytes: int, files: int, failed: int, avgBps: int, peakBps: int });

const ConnectSchema = v.object({
  t: v.literal('connect'),
  ...common,
  outcome: v.picklist(['connected', 'failed']),
  /** From starting to connect (both peers present) to connected, or to giving up. */
  ms: int,
  path: v.optional(PathSchema),
  rttMs: v.optional(int),
  causes: v.optional(v.pipe(v.array(label), v.maxLength(8))),
  local: v.optional(ProfileSchema),
  remote: v.optional(ProfileSchema),
});

const TransferSchema = v.object({
  t: v.literal('transfer'),
  ...common,
  direction: v.picklist(TRANSFER_DIRECTIONS),
  status: v.picklist(FINISHED_STATUSES),
  error: v.optional(label),
  size: int,
  bytes: int,
  /** First byte to verified. */
  ms: int,
  /** Average bytes per second over `ms`. */
  bps: int,
  verified: v.boolean(),
  lanes: int,
  call: v.boolean(),
  pacing: label,
  path: v.optional(PathSchema),
  rttMs: v.optional(int),
});

const SessionSchema = v.object({
  t: v.literal('session'),
  ...common,
  end: v.picklist(SESSION_ENDS),
  ms: int,
  up: SideSchema,
  down: SideSchema,
  callMs: int,
  maxLanes: int,
  /** Times the connection became unstable and had to recover. */
  recoveries: int,
  path: v.optional(PathSchema),
});

export const MetricsEventSchema = v.variant('t', [ConnectSchema, TransferSchema, SessionSchema]);

export type MetricsEvent = v.InferOutput<typeof MetricsEventSchema>;
export type MetricsOf<T extends MetricsEvent['t']> = Extract<MetricsEvent, { t: T }>;
export type MetricsPath = v.InferOutput<typeof PathSchema>;
export type MetricsProfile = v.InferOutput<typeof ProfileSchema>;
export type MetricsSide = v.InferOutput<typeof SideSchema>;
/** The fields every report carries. */
export type MetricsCommon = Pick<MetricsEvent, keyof typeof common>;
