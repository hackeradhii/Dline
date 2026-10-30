import { normalizeRoomCode, ROOM_SOCKET_PATH } from '../contracts/room';

export { RendezvousRoom } from './rendezvous/room';

/**
 * The whole backend: static files are served by the assets layer; only `/ws/<code>` reaches this
 * code, and it is forwarded to that room's Durable Object.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(ROOM_SOCKET_PATH)) return env.ASSETS.fetch(request);

    const code = normalizeRoomCode(url.pathname.slice(ROOM_SOCKET_PATH.length));
    if (!code) return new Response('Invalid room code', { status: 400 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    // Block cross-site WebSocket hijacking: browsers always send Origin on WebSocket requests.
    const origin = request.headers.get('Origin');
    if (origin && new URL(origin).host !== url.host) return new Response('Forbidden origin', { status: 403 });

    return env.ROOMS.getByName(code).fetch(request);
  },
} satisfies ExportedHandler<Env>;
