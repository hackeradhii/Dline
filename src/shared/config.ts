/** Every tunable in one place (DRY). Units are in the names. */

export const STUN_URLS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] as const;

export const ROOM = {
  /** Unambiguous alphabet: no 0/O, 1/I/L, 5/S, 2/Z. */
  alphabet: 'ABCDEFGHJKMNPQRTUVWXY346789',
  length: 6,
  /** Room is deleted if nobody joins within this time. */
  unpairedTtlMs: 10 * 60_000,
  /** Room is deleted this long after the last socket leaves (allows reconnects). */
  idleTtlMs: 5 * 60_000,
  /** Hard cap on a room's lifetime. */
  maxLifetimeMs: 12 * 60 * 60_000,
  maxMessageBytes: 16 * 1024,
  /** Rate limit per socket. */
  maxMessagesPerWindow: 200,
  rateWindowMs: 10_000,
} as const;

export const SIGNALING = {
  reconnectBaseMs: 500,
  reconnectMaxMs: 8_000,
} as const;

export const LINK = {
  version: 1,
  /** Links can't trickle, so wait for gathering, capped. */
  gatherTimeoutMs: 3_000,
  sessionIdBytes: 4,
  handoffAckTimeoutMs: 1_500,
  handoffChannel: 'dline-handoff',
} as const;

export const CONNECTION = {
  /** Time allowed from "connecting" to an open control channel (paused while the page is hidden). */
  connectTimeoutMs: 20_000,
  /** `disconnected` this long → ICE restart. */
  restartAfterMs: 5_000,
  /** No recovery this long → "Connection lost" (PRD: within 15 s). */
  lostAfterMs: 15_000,
  heartbeatIntervalMs: 4_000,
  heartbeatTimeoutMs: 12_000,
} as const;

export const STATS = {
  intervalMs: 1_000,
} as const;

export const PREFLIGHT = {
  timeoutMs: 2_500,
} as const;

export const TRANSFER = {
  /** Message size cap on lane 0 (the main connection, shared with calls and control); also bounded by SCTP max-message-size. */
  chunkBytes: 64 * 1024,
  fallbackChunkBytes: 16 * 1024,
  /**
   * Files travel as blocks, each with its own SHA-256, spread over the lanes. Small enough that one
   * photo spans many lanes; large enough that headers and acks cost nothing.
   */
  blockBytes: 128 * 1024,
  /** Block sizes a peer may announce. */
  minBlockBytes: 16 * 1024,
  maxBlockBytes: 4 * 1024 * 1024,
  /**
   * Per-lane send buffer watermarks (data handed to the browser but not yet on the wire). Kept
   * shallow: a block given to a lane can't be taken back, so deep buffers let one slow lane hold the
   * end of a file hostage.
   */
  laneHighWaterBytes: 256 * 1024,
  laneLowWaterBytes: 128 * 1024,
  /**
   * A block unacknowledged for too long is sent again on another lane. Once every block is out (the
   * end of a batch) that's quick, since idle lanes are free and one slow lane would hold everything
   * up: after `endgame.factor` times the usual send-to-ack time, at least `endgame.minMs`. Before
   * that it is only a safety net (e.g. the receiver dropped a block it had no room for): copies of
   * merely slow blocks would compete with new ones.
   */
  resend: {
    endgame: { factor: 2, minMs: 250 },
    midway: { factor: 4, minMs: 4_000 },
  },
  /** Sent but not yet acknowledged, across all lanes: bounds memory on both sides. */
  maxInFlightBytes: 32 * 1024 * 1024,
  /**
   * Blocks read and hashed ahead of the lanes (2 MB). Reading and hashing each block takes a few ms,
   * so 4 ahead capped a fast local path at ~13 MB/s; 16 keeps up with ~25 MB/s.
   */
  readAheadBlocks: 16,
  /** Blocks that beat their file's offer (they travel on different channels) wait in at most this much memory. */
  earlyBlocksLimitBytes: 16 * 1024 * 1024,
  /** An outgoing file with nothing acknowledged for this long fails. */
  stallTimeoutMs: 30_000,
  stallCheckMs: 5_000,
  /** Files above this go to disk (OPFS) instead of RAM. */
  memoryLimitBytes: 64 * 1024 * 1024,
  maxFileBytes: 64 * 1024 * 1024 * 1024,
  maxNameLength: 255,
  speedWindowMs: 3_000,
  /** The speed meter keeps one sample per this interval; the newest is replaced until it is this far clear. */
  speedSampleGapMs: 100,
  /** Progress events for one file go out at most this often (and always at the end). */
  progressEmitMs: 150,
  /** Smoothing gain for a block's typical send-to-ack time, which sets when a copy is overdue. */
  ackTimeGain: 0.2,
  /** The block actuator's bucket: up to this much of the budget at once (today's pacing). */
  blockBurstMs: 100,
  /** Call-aware pacing (AIMD, the legacy policy): back off when video suffers, ramp up when it doesn't. */
  minFileBytesPerSecond: 256 * 1024,
  backoffFactor: 0.7,
  rampFactor: 1.5,
  lossPercentLimit: 5,
  /** RTT above base × factor + slack means queues are building. */
  rttGrowthFactor: 1.5,
  rttSlackMs: 40,
  opfsDirectory: 'dline-incoming',
} as const;

/**
 * Dline Flow (PLAN.md §5): the receiver measures, the sender paces the whole bundle of lanes to a
 * small queue, following SCReAM v2's "virtual L4S" (draft-ietf-ccwg-rfc8298bis-screamv2).
 * Rates are bytes/second unless the name says bits (Bps).
 */
export const FLOW = {
  /** Probe cadence while sending to a peer that answers (SCReAM v2 tested 40 ms feedback). */
  probeIntervalMs: 40,
  /** Discovery cadence: from the moment `ctrl` opens until the first echo, and while idle. */
  legacyProbeIntervalMs: 1_000,
  /** No echo this long after the first probe: an older peer (a later echo still upgrades). */
  capabilityTimeoutMs: 5_000,
  /** In flow mode, the first block waits at most this long for the peer's first echo. */
  capabilityHoldMs: 1_000,
  /** The responder answers at most one probe per this interval. */
  minEchoGapMs: 10,
  /**
   * A probe's echo still counts this long after it left. A full phone uplink buffer delays echoes
   * by seconds (the field's ping read 3.5 s); counting only the last 64 probes, 2.6 s at 40 ms, left
   * Flow with no feedback at all while that queue stood.
   */
  probeMaxAgeMs: 10_000,
  /** Queueing-delay targets: SCReAM's QDELAY_TARGET_LO/HI are 60/400 ms; 30 ms in a call (call first). */
  targetCallMs: 30,
  targetIdleMs: 60,
  targetMaxMs: 400,
  /** SCReAM VIRTUAL_RTT: the shortest round trip the control law assumes. */
  virtualRttMs: 25,
  /** Bounds on the time one sample stands for, so a burst of echoes or a long gap can't over- or under-step the control law. */
  stepMinMs: 5,
  stepMaxMs: 200,
  /**
   * The averaged queue rises with this gain and drops at once (SCReAM QDELAY_AVG_G is 1/4). Tuned
   * in simulation with `jitterSamples` and `growthNear`: the queue is seen a sample sooner, which
   * shrinks each overshoot (no-call queue p95 91 → 56 ms, recovery from a halved link 1.1 → 0.3 s).
   */
  qdGainUp: 0.5,
  /** Each queue reading is the least of the last few, so one late event-loop turn is ignored. */
  jitterSamples: 2,
  /** Smoothed round trip, TCP-style gain. */
  rttGain: 1 / 8,
  /** Base delays: windowed minimums over 60 s in 6 buckets (100 ppm of clock drift is < 6 ms). */
  baseWindowMs: 60_000,
  baseBuckets: 6,
  /** No clean base sample for this long while sending: validate the base with a drain. */
  baseValidateMs: 20_000,
  /** One absolute deadline for a whole drain; a failed one is retried after `drainRetryMs`. */
  drainMaxMs: 3_000,
  drainRetryMs: 5_000,
  /** Clean echoes a drain needs (each probe sent after every lane's marker was answered). */
  drainCleanSamples: 2,
  /** A probe sent when nothing had gone to a lane for this long saw an empty path. */
  idleCleanMs: 1_000,
  /** Entering control, and on the first mark after an unmarked sample: rate = factor × delivery. */
  entryFactor: 0.9,
  /** A queue deeper than `deepQueueTargets` × target cuts to `deepFactor` × delivery at once. */
  deepQueueTargets: 4,
  deepFactor: 0.25,
  /**
   * A transfer on a far path, while the bottleneck is unknown, starts here: just under the 9 Mbit/s
   * phone uplink, since unlimited, the lanes put seconds of data into its buffer before the first
   * mark could stop them. During a call, gently (§5.3 rule 1)...
   */
  startBytesPerSecond: 1024 * 1024,
  callStartBytesPerSecond: 256 * 1024,
  /**
   * ...and until the first congestion point, stays within this many times the most that arrived
   * over the last `startDeliveryWindowMs`, each reading over `recentDeliveryWindowMs` (BBR's
   * startup, bounded by its bottleneck-bandwidth filter). The most, not the latest: a lane stalled
   * behind one lost packet, or ramping up after sitting idle, briefly shows far less than the path
   * carries, and on the bench the latest reading held a far path at the start rate for a whole
   * transfer. At 2 × the start overshot more than it gained: it filled a 200 ms buffer for a second.
   */
  startDeliveryGain: 1.5,
  startDeliveryWindowMs: 1_000,
  startDeliveryBuckets: 5,
  recentDeliveryWindowMs: 200,
  /** Growth per round trip: careful near and above the last congestion point, quick far below it (SCReAM scl_t). */
  growthNear: 0.01,
  growthFar: 0.25,
  /** How far from the last congestion point growth turns quick: (span × distance)² reaches 1. */
  growthSpan: 8,
  /** Growth only while the pacer had to wait within this many round trips (it is using the rate). */
  usedWithinRtts: 2,
  minStepBytesPerSecond: 16 * 1024,
  /** The floor: files never stop completely. */
  minBytesPerSecond: 32 * 1024,
  /** At or above this, no limit at all. */
  unlimitedAboveBytesPerSecond: 64 * 1024 * 1024,
  /** Someone else's queue: above target this long while we are down to a quarter, the target grows. */
  externalQueueMs: 3_000,
  externalStarvedShare: 0.25,
  externalStep: 1.5,
  /** The grown target shrinks back by this factor per second once the queue is under half of it. */
  externalDecayPerSecond: 0.9,
  /** No echo for max(`feedbackGapRtts` × round trip, `feedbackTimeoutMs`): halve the rate. */
  feedbackGapRtts: 4,
  feedbackTimeoutMs: 500,
  /**
   * An echo this many probe intervals after the one before, while sending in a visible tab (in a
   * hidden one, where probes follow the echoes, a feedback gap): `ctrl` may have waited behind a
   * lost packet's retransmission. On the bench those waits were 250-700 ms, mostly under the
   * feedback gap, while echoes otherwise came every 40-60 ms.
   */
  heldGapProbes: 4,
  /** No echo for this long: the estimates are stale, start over. */
  resetAfterGapMs: 5_000,
  /** Delivery rate window, and how long files must have been sending before Flow takes control. */
  deliveryWindowMs: 500,
  /**
   * Bottleneck capacity: what it carried while it stayed busy (two probes in a row found a queue of
   * half the target), over that busy time, in the last `capacityWindowMs`; measured once it was
   * busy for `capacityBusyMs`, and trusted for `capacityMaxAgeMs` after.
   */
  capacityWindowMs: 5_000,
  capacityBuckets: 5,
  capacityBusyMs: 200,
  capacityMaxAgeMs: 30_000,
  /**
   * The call keeps headroom × the larger of its measured rate and its ceiling, at most
   * `maxReserveShare` of the bottleneck. The ceiling gets the headroom too: a video that backed off
   * needs room to come back, and with files filling the rest the link ran 97 % full on the bench.
   */
  mediaHeadroom: 1.25,
  videoReserveBps: 2_500_000,
  audioReserveBps: 64_000,
  maxReserveShare: 0.7,
  /**
   * Fine pacing: chunks of `chunkMs` of the rate, 1-16 KiB, from a bucket of `burstMs` of it, which
   * grows to 250 ms in hidden tabs. The bucket holds two chunks, so a timer that fires a few ms late
   * loses nothing: with chunks as big as the bucket, files got 83 % of their budget on the bench.
   */
  minPacedChunkBytes: 1024,
  pacedChunkBytes: 16 * 1024,
  chunkMs: 5,
  burstMs: 10,
  hiddenBurstMaxMs: 250,
  /** Decisions kept for "Save trace". */
  traceWindowMs: 120_000,
  /** The probe round trip is the ping shown while it is this fresh. */
  livePingMs: 2_000,
} as const;

/**
 * Lanes: extra peer connections that carry file blocks in parallel. One SCTP connection halves its
 * window on every loss and grows back by one packet per round trip, so on a long or lossy path it is
 * stuck far below the link speed. Measured through an emulated 100 ms / 0.1 % loss / 50 Mbit/s path:
 * 1 lane 0.45 MB/s, 8 lanes 3.9 MB/s, 16 lanes 5.7 MB/s (91 % of the link).
 */
export const LANES = {
  /**
   * Extra lanes by round-trip time, which is what caps one connection (it sends one window per
   * round trip). Near (same network): a few, for a fast start. Far: many, for loss and distance.
   * Chosen by measured RTT rather than by address, so a VPN or a distant "LAN" still gets enough.
   */
  extra: { near: 3, far: 15 },
  nearRttMs: 20,
  /** Highest lane number in a session (bounds how often dropped lanes are replaced). */
  maxNumber: 255,
  /** Negotiated id of the bulk channel on the main connection (lane 0), clear of auto-assigned ids. */
  mainChannelId: 64,
  /** Message size cap on extra lanes. */
  chunkBytes: 256 * 1024,
  openTimeoutMs: 15_000,
  /** A lane that loses its path (e.g. a network switch) is dropped after this long. */
  disconnectGraceMs: 4_000,
  /** Pause before replacing dropped lanes. */
  regrowAfterMs: 5_000,
} as const;

export const MEDIA = {
  video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
} as const;

export const STORAGE_KEYS = {
  turn: 'dline.turn.v1',
} as const;
