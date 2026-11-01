import { describe, expect, it } from 'vitest';
import { FakeClock } from './testing/fake-clock';
import { Timeout } from './timer';

describe('Timeout', () => {
  it('fires once, after its delay, and is pending only until then', () => {
    const clock = new FakeClock();
    const timeout = new Timeout(clock);
    let fired = 0;
    timeout.set(() => fired++, 100);
    expect(timeout.pending).toBe(true);
    clock.advance(99);
    expect(fired).toBe(0);
    clock.advance(1);
    expect(fired).toBe(1);
    expect(timeout.pending).toBe(false);
    clock.advance(1_000);
    expect(fired).toBe(1);
  });

  it('set replaces the pending one, clear cancels it', () => {
    const clock = new FakeClock();
    const timeout = new Timeout(clock);
    const fired: string[] = [];
    timeout.set(() => fired.push('first'), 100);
    timeout.set(() => fired.push('second'), 50);
    clock.advance(200);
    expect(fired).toEqual(['second']);
    timeout.set(() => fired.push('third'), 50);
    timeout.clear();
    clock.advance(200);
    expect(fired).toEqual(['second']);
    expect(timeout.pending).toBe(false);
  });

  it('can be set again from its own callback', () => {
    const clock = new FakeClock();
    const timeout = new Timeout(clock);
    let fired = 0;
    const tick = () => {
      fired++;
      timeout.set(tick, 10);
    };
    timeout.set(tick, 10);
    clock.advance(35);
    expect(fired).toBe(3);
    expect(timeout.pending).toBe(true);
  });
});
