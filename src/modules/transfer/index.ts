/** Public API of the transfer module. */
export { TransferManager } from './internal/manager';
export { AdaptiveRateLimit } from './internal/rate-policy';
export { PACING_MODES, type PacingMode } from './internal/pacing-selector';
export type { PacingStatus } from './internal/flow-session';
export type { TransferItem, TransferError } from './internal/record';
export { clearIncomingFiles } from './internal/sinks';
