import { describe, expect, it, vi } from 'vitest';
import type { ControlMessage, ControlOf, ControlType } from '../../../contracts/control';
import type { ControlChannel } from '../../../contracts/ports';
import { CONNECTION } from '../../../shared/config';
import { FakeClock, FakeVisibility } from '../../../shared/testing/fake-clock';
import { VisibleTimer } from '../../../shared/timer';
import { Heartbeat } from './heartbeat';
import { Watchdog } from './watchdog';

describe('VisibleTimer', () => {
  it('does not count time while the page is hidden (user is in WhatsApp)', () => {
    const clock = new FakeClock();
    const visibility = new FakeVisibility();
    const fired = vi.fn();
    new VisibleTimer(10_000, fired, clock, visibility);
    clock.advance(4_000);
    visibility.set(false);
    clock.advance(60_000);
    expect(fired).not.toHaveBeenCalled();
    visibility.set(true);
    clock.advance(5_999);
    expect(fired).not.toHaveBeenCalled();
    clock.advance(1);
    expect(fired).toHaveBeenCalledOnce();
  });
});

describe('Watchdog', () => {
  it('restarts ICE after 5 s disconnected and declares loss at 15 s', () => {
    const clock = new FakeClock();
    const actions = { restart: vi.fn(), lost: vi.fn() };
    const dog = new Watchdog(actions, clock);
    dog.onState('disconnected');
    clock.advance(CONNECTION.restartAfterMs);
    expect(actions.restart).toHaveBeenCalledOnce();
    clock.advance(CONNECTION.lostAfterMs - CONNECTION.restartAfterMs);
    expect(actions.lost).toHaveBeenCalledOnce();
  });

  it('cancels everything when the path recovers', () => {
    const clock = new FakeClock();
    const actions = { restart: vi.fn(), lost: vi.fn() };
    const dog = new Watchdog(actions, clock);
    dog.onState('disconnected');
    clock.advance(2_000);
    dog.onState('connected');
    clock.advance(60_000);
    expect(actions.restart).not.toHaveBeenCalled();
    expect(actions.lost).not.toHaveBeenCalled();
  });

  it('restarts immediately on failed', () => {
    const actions = { restart: vi.fn(), lost: vi.fn() };
    new Watchdog(actions, new FakeClock()).onState('failed');
    expect(actions.restart).toHaveBeenCalledOnce();
  });
});

/** In-memory pair of control channels wired to each other. */
function controlPair(): [ControlChannel, ControlChannel] {
  const make = () => {
    const handlers = new Map<ControlType, Set<(m: ControlMessage) => void>>();
    const ch = {
      peer: null as null | { deliver(m: ControlMessage): void },
      isOpen: true,
      send: (m: ControlMessage) => (ch.peer?.deliver(m), true),
      on<T extends ControlType>(type: T, handler: (m: ControlOf<T>) => void) {
        const set = handlers.get(type) ?? new Set();
        set.add(handler as (m: ControlMessage) => void);
        handlers.set(type, set);
        return () => set.delete(handler as (m: ControlMessage) => void);
      },
      deliver: (m: ControlMessage) => handlers.get(m.t)?.forEach((h) => h(m)),
    };
    return ch;
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe('Heartbeat', () => {
  it('measures RTT and reports an unresponsive peer after 12 s of silence', () => {
    const clock = new FakeClock();
    const [a, b] = controlPair();
    const beatA = new Heartbeat(a, clock);
    const beatB = new Heartbeat(b, clock);
    const rtts: number[] = [];
    const responsive: boolean[] = [];
    beatA.events.on('rtt', (r) => rtts.push(r));
    beatA.events.on('responsive', (r) => responsive.push(r));

    clock.advance(CONNECTION.heartbeatIntervalMs);
    expect(rtts).toEqual([0]);

    beatB.stop();
    (b as { send: unknown }).send = () => false; // Peer goes silent.
    clock.advance(CONNECTION.heartbeatTimeoutMs + CONNECTION.heartbeatIntervalMs);
    expect(responsive).toEqual([false]);
    beatA.stop();
  });
});
