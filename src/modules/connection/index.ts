/** Public API of the connection module. Everything else in this folder is private. */
export {
  Connection,
  CONTROL_LABEL,
  browserPeerFactory,
  type ConnectionEvents,
  type ConnectionOptions,
  type ConnectionPhase,
  type FailureReason,
  type ManualExchange,
} from './internal/connection';
export { DataControlChannel } from './internal/control-channel';
export { LanePool, type LanePoolOptions } from './internal/lanes';
