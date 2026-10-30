import type { BlockHasher } from '../../../contracts/ports';
import { toHex } from '../../../shared/bytes';

/**
 * SHA-256 per block through WebCrypto: native and hardware-accelerated, off the main thread, and
 * nothing to download or warm up (the first transfer of a session is as fast as the rest).
 */
export const webCryptoHasher: BlockHasher = {
  digest: async (data) => toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data))),
};
