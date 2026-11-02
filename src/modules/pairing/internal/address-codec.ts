import { fromHex, toHex } from '../../../shared/bytes';
import { bytesToIpv6, ipFamily, ipv6ToBytes } from '../../../shared/net';

/** Packs candidate addresses into as few bytes as possible: IPv4 → 4, IPv6 → 16, mDNS UUID → 16. */

export const AddressKind = { IPv4: 0, IPv6: 1, MdnsUuid: 2, Text: 3 } as const;
export type AddressKind = (typeof AddressKind)[keyof typeof AddressKind];
type BinaryKind = Exclude<AddressKind, typeof AddressKind.Text>;

const MDNS_UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

type PackedAddress = { kind: BinaryKind; bytes: Uint8Array } | { kind: typeof AddressKind.Text; text: string };

export function packAddress(address: string): PackedAddress {
  const family = ipFamily(address);
  if (family === 'IPv4') return { kind: AddressKind.IPv4, bytes: Uint8Array.from(address.split('.').map(Number)) };
  if (family === 'IPv6') {
    const bytes = ipv6ToBytes(address);
    if (bytes) return { kind: AddressKind.IPv6, bytes };
  }
  const uuid = MDNS_UUID.exec(address);
  if (uuid) return { kind: AddressKind.MdnsUuid, bytes: fromHex(uuid.slice(1).join('')) };
  return { kind: AddressKind.Text, text: address };
}

export function unpackAddress(kind: BinaryKind, bytes: Uint8Array): string {
  if (kind === AddressKind.IPv4) return [...bytes].join('.');
  if (kind === AddressKind.IPv6) return bytesToIpv6(bytes);
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
}

export const ADDRESS_BYTES: Record<BinaryKind, number> = {
  [AddressKind.IPv4]: 4,
  [AddressKind.IPv6]: 16,
  [AddressKind.MdnsUuid]: 16,
};
