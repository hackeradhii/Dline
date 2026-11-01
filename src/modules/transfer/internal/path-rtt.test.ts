import { describe, expect, it } from 'vitest';
import { PathRtt } from './path-rtt';

describe('PathRtt', () => {
  it('the shorter of the probes’ base and ICE’s, whichever is known', () => {
    let probes: number | null = null;
    const rtt = new PathRtt({ baseRtt: () => probes });
    expect(rtt.shortest(0)).toBeNull();
    rtt.ice(30, 0);
    expect(rtt.shortest(0)).toBe(30);
    probes = 45; // A busy page delayed the probes.
    expect(rtt.shortest(0)).toBe(30);
    rtt.ice(60, 10);
    expect(rtt.shortest(10)).toBe(30); // The shortest ICE has seen, not the latest.
    probes = 8;
    expect(rtt.shortest(10)).toBe(8);
  });

  it('forgets ICE’s on reset (a new path)', () => {
    const rtt = new PathRtt({ baseRtt: () => null });
    rtt.ice(30, 0);
    rtt.reset();
    expect(rtt.shortest(0)).toBeNull();
  });
});
