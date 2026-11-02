import { LINK } from '../../../shared/config';
import type { Unsubscribe } from '../../../shared/emitter';
import { systemClock, Timeout, type Clock } from '../../../shared/timer';

/**
 * Same-browser handoff: a reply link opened from WhatsApp may land in a new tab, but the
 * RTCPeerConnection lives in the tab that made the invite. The new tab forwards the reply over a
 * BroadcastChannel; the original tab applies it and acknowledges.
 */

type HandoffMessage = { kind: 'answer'; session: string; fragment: string } | { kind: 'ack'; session: string };

/** Original tab: apply replies for `session` that arrive from other tabs. */
export function listenForReplies(session: string, apply: (fragment: string) => Promise<boolean>): Unsubscribe {
  if (typeof BroadcastChannel !== 'function') return () => undefined;
  const channel = new BroadcastChannel(LINK.handoffChannel);
  channel.onmessage = async ({ data }: MessageEvent<HandoffMessage>) => {
    if (data?.kind !== 'answer' || data.session !== session) return;
    if (await apply(data.fragment)) channel.postMessage({ kind: 'ack', session } satisfies HandoffMessage);
  };
  return () => channel.close();
}

/** New tab: hand the reply to the original tab. Resolves true if it was accepted there. */
export function deliverReply(session: string, fragment: string, clock: Clock = systemClock): Promise<boolean> {
  if (typeof BroadcastChannel !== 'function') return Promise.resolve(false);
  const channel = new BroadcastChannel(LINK.handoffChannel);
  return new Promise((resolve) => {
    const timer = new Timeout(clock);
    const finish = (ok: boolean): void => {
      timer.clear();
      channel.close();
      resolve(ok);
    };
    timer.set(() => finish(false), LINK.handoffAckTimeoutMs);
    channel.onmessage = ({ data }: MessageEvent<HandoffMessage>) => {
      if (data?.kind === 'ack' && data.session === session) finish(true);
    };
    channel.postMessage({ kind: 'answer', session, fragment } satisfies HandoffMessage);
  });
}
