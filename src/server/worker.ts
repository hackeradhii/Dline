import { METRICS_PATH } from '../contracts/metrics';
import { normalizeRoomCode, ROOM_SOCKET_PATH } from '../contracts/room';
import { handleMetrics } from './metrics';
import { fromOurOrigin } from './origin';

export { RendezvousRoom } from './rendezvous/room';

/**
 * The whole backend: static files are served by the assets layer; only `/ws/<code>` (forwarded to
 * that room's Durable Object) and `/api/metrics` (performance reports, logged) reach this code.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === METRICS_PATH) return handleMetrics(request, env);
    if (!url.pathname.startsWith(ROOM_SOCKET_PATH)) return env.ASSETS.fetch(request);

    const code = normalizeRoomCode(url.pathname.slice(ROOM_SOCKET_PATH.length));
    if (!code) return new Response('Invalid room code', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    // Block cross-site WebSocket hijacking: browsers always send Origin on WebSocket requests.
    if (!fromOurOrigin(request, { required: false })) return new Response('Forbidden origin', { status: 403 });

    return env.ROOMS.getByName(code).fetch(request);
  },
} satisfies ExportedHandler<Env>;
