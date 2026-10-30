import { TRANSFER } from '../../../shared/config';

/** Message size to send on a connection: the peer's SCTP max-message-size, capped (DRY for lanes and main). */
export function chunkSize(sctp: RTCSctpTransport | null | undefined, cap: number): number {
  const max = sctp?.maxMessageSize;
  return max && max > 0 ? Math.min(max, cap) : TRANSFER.fallbackChunkBytes;
}
