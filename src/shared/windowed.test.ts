import { describe, expect, it } from 'vitest';
import { Windowed } from './windowed';

describe('Windowed', () => {
  it('reports the smallest value in the window, or null when it is empty', () => {
    const min = new Windowed('min', 60_000, 6);
    expect(min.value(0)).toBeNull();
    min.add(30, 1_000);
    min.add(20, 12_000);
    min.add(25, 13_000); // Same bucket as the 20: the 20 stays.
    expect(min.value(13_000)).toBe(20);
  });

  it('keeps a value for at least the window minus one bucket, and never longer than the window', () => {
    const min = new Windowed('min', 60_000, 6); // 10 s buckets.
    min.add(5, 9_999);
    min.add(9, 15_000);
    expect(min.value(59_999)).toBe(5); // 50 s after it was added.
    expect(min.value(60_000)).toBe(9); // Its bucket aged out.
    expect(min.value(75_000)).toBeNull();
  });

  it('tracks the largest value as well', () => {
    const max = new Windowed('max', 5_000, 5); // 1 s buckets.
    max.add(3, 0);
    max.add(7, 1_500);
    max.add(4, 2_000);
    expect(max.value(2_000)).toBe(7);
    expect(max.value(6_000)).toBe(4);
  });

  it('and the total, which ages out the same way', () => {
    const sum = new Windowed('sum', 5_000, 5); // 1 s buckets.
    sum.add(3, 0);
    sum.add(7, 1_500);
    sum.add(4, 1_900); // Same bucket as the 7.
    expect(sum.value(1_900)).toBe(14);
    expect(sum.value(5_000)).toBe(11); // The 3's bucket aged out.
  });

  it('starts over on reset', () => {
    const min = new Windowed('min', 60_000, 6);
    min.add(1, 0);
    min.reset();
    expect(min.value(0)).toBeNull();
    min.add(8, 10);
    expect(min.value(10)).toBe(8);
  });
});
