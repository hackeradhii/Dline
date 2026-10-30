/** Reads the first `a=<name>:value` attribute from an SDP (session or media level). */
export function sdpAttribute(sdp: string, name: string): string | undefined {
  const prefix = `a=${name}:`;
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return undefined;
}

/** The DTLS certificate fingerprint as `{ algorithm, hex }`, e.g. sha-256 + "6F:4E:…". */
export function sdpFingerprint(sdp: string): { algorithm: string; hex: string } | null {
  const [algorithm, hex] = sdpAttribute(sdp, 'fingerprint')?.split(/\s+/) ?? [];
  return algorithm && hex ? { algorithm: algorithm.toLowerCase(), hex: hex.toUpperCase() } : null;
}
