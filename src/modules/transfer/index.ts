/** Public API of the transfer module. */
export { TransferManager, type TransferDeps } from './internal/manager';
export { AdaptiveRateLimit, type CongestionSample, type RatePolicy } from './internal/rate-policy';
export { PACING_MODES, type PacingMode } from './internal/pacing-selector';
export type { FlowSessionInputs, PacingStatus } from './internal/flow-session';
export type { FlowTrace } from './internal/flow-trace';
export type { TransferItem, TransferStatus, TransferDirection, TransferError } from './internal/record';
export { clearIncomingFiles, defaultSinkFactory, MemorySink, type SinkFactory } from './internal/sinks';
export { webCryptoHasher } from './internal/hasher';
