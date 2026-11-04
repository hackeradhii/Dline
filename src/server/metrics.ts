import { MetricsEventSchema, type MetricsEvent, type MetricsOf, type MetricsPath, type MetricsSide } from '../contracts/metrics';
import { parseMessage } from '../contracts/parse';
import { METRICS } from '../shared/config';
import { formatBytes, formatDuration, formatMs, formatSpeed, plural } from '../shared/format';
import { fromOurOrigin } from './origin';

/**
 * `POST /api/metrics`: a device's performance report, validated and written to the Worker's log
 * (Workers Logs: one readable `message` plus the fields, so the dashboard can filter on them).
 * Nothing is stored, and nothing but the validated report is logged.
 */
export async function handleMetrics(request: Request, env: Env, log: (line: object) => void = console.log): Promise<Response> {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  // Only the app itself reports: browsers always send Origin on a POST.
  if (!fromOurOrigin(request, { required: true })) return new Response('Forbidden origin', { status: 403 });
  const { success } = await env.METRICS_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
  if (!success) return new Response('Too many reports', { status: 429 });

  const body = await request.text();
  const event = body.length <= METRICS.maxBodyBytes ? parseMessage(MetricsEventSchema, body) : null;
  if (!event) return new Response('Bad report', { status: 400 });
  log({ message: describeMetrics(event), metrics: event });
  return new Response(null, { status: 204 });
}

const DESCRIBE: { [T in MetricsEvent['t']]: (event: MetricsOf<T>) => string } = {
  connect: (e) =>
    e.outcome === 'connected'
      ? join(`connect: connected in ${formatDuration(e.ms)}`, path(e.path), ping(e.rttMs))
      : join(`connect: FAILED after ${formatDuration(e.ms)}`, `causes ${e.causes?.join(', ') || 'unknown'}`, profile('local', e.local), profile('remote', e.remote)),
  transfer: (e) =>
    join(
      `transfer ${e.direction} ${e.status}${e.error ? ` (${e.error})` : ''}: ${formatBytes(e.bytes)} of ${formatBytes(e.size)} in ${formatDuration(e.ms)} at ${formatSpeed(e.bps)}`,
      plural(e.lanes, 'lane'),
      path(e.path),
      ping(e.rttMs),
      `call ${e.call ? 'on' : 'off'}`,
      `pacing ${e.pacing}`,
    ),
  session: (e) =>
    join(
      `session: ended (${e.end}) after ${formatDuration(e.ms)}`,
      side('up', e.up),
      side('down', e.down),
      `call ${e.callMs ? formatDuration(e.callMs) : 'none'}`,
      plural(e.recoveries, 'recovery', 'recoveries'),
      `up to ${plural(e.maxLanes, 'lane')}`,
      path(e.path),
    ),
};

/** The log line's readable summary, e.g. "transfer out done: 74.7 MB of 74.7 MB in 1m 30s at 848 KB/s · 16 lanes · …". */
export function describeMetrics(event: MetricsEvent): string {
  return (DESCRIBE[event.t] as (e: MetricsEvent) => string)(event);
}

const join = (...parts: Array<string | null>): string => parts.filter(Boolean).join(' · ');
const ping = (rttMs: number | undefined): string | null => (rttMs === undefined ? null : `ping ${formatMs(rttMs)}`);
const path = (p: MetricsPath | undefined): string | null => (p ? `${p.kind} ${p.family} (${p.local} ↔ ${p.remote})` : null);
const side = (name: string, s: MetricsSide): string =>
  `${name} ${formatBytes(s.bytes)} in ${plural(s.files, 'file')}${s.failed ? ` (${s.failed} failed)` : ''}, avg ${formatSpeed(s.avgBps)}, peak ${formatSpeed(s.peakBps)}`;
const profile = (name: string, p: MetricsOf<'connect'>['local']): string | null =>
  p ? `${name} udp ${p.udp ? 'yes' : 'no'}, IPv4 ${p.ipv4}, IPv6 ${p.ipv6 ? 'yes' : 'no'}${p.relayOnly ? ', relay only' : ''}` : null;
