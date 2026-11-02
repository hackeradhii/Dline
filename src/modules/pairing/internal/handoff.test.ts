import { describe, expect, it } from 'vitest';
import { LINK } from '../../../shared/config';
import { timed } from '../../../shared/testing/drive';
import { FakeClock } from '../../../shared/testing/fake-clock';
import { deliverReply, listenForReplies } from './handoff';

describe('same-browser handoff of a reply link', () => {
  it('the tab that made the invite applies the reply and acknowledges it', async () => {
    const applied: string[] = [];
    const stop = listenForReplies('s1', async (fragment) => (applied.push(fragment), true));
    try {
      expect(await deliverReply('s1', 'a.reply', new FakeClock())).toBe(true);
      expect(applied).toEqual(['a.reply']);
    } finally {
      stop();
    }
  });

  it('with no tab to take it, gives up after the ack timeout', async () => {
    const clock = new FakeClock();
    let delivered: boolean | null = null;
    const ms = await timed(clock, deliverReply('nobody', 'a.reply', clock).then((ok) => (delivered = ok)), { stepMs: 50 });
    expect(delivered).toBe(false);
    expect(ms).toBeGreaterThanOrEqual(LINK.handoffAckTimeoutMs);
    expect(ms).toBeLessThan(LINK.handoffAckTimeoutMs + 50);
  });
});
