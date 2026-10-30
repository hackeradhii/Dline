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
  /** Call-aware pacing (AIMD): back off when video suffers, ramp up when it doesn't. */
  minFileBytesPerSecond: 256 * 1024,
  backoffFactor: 0.7,
  rampFactor: 1.5,
  lossPercentLimit: 5,
  unlimitedAboveBytesPerSecond: 64 * 1024 * 1024,
  /** RTT above base × factor + slack means queues are building. */
  rttGrowthFactor: 1.5,
  rttSlackMs: 40,
  opfsDirectory: 'dline-incoming',
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
