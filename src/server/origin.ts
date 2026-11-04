/**
 * Whether a request comes from a page on this site: blocks cross-site WebSocket hijacking and
 * reports forged by other sites. Browsers send Origin on WebSocket upgrades and on POSTs; with
 * `required`, a request without one (not a browser page) is refused too. A malformed or opaque
 * ("null") Origin is never ours.
 */
export function fromOurOrigin(request: Request, { required }: { required: boolean }): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return !required;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}
