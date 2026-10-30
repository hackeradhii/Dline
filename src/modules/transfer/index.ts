/** Public API of the transfer module. */
export { TransferManager, type TransferDeps } from './internal/manager';
export { AdaptiveRateLimit, type CongestionSample } from './internal/rate-policy';
export type { TransferItem, TransferStatus, TransferDirection } from './internal/record';
export { clearIncomingFiles, defaultSinkFactory, MemorySink, type SinkFactory } from './internal/sinks';
export { webCryptoHasher } from './internal/hasher';
