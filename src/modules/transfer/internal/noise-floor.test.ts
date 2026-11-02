import { describe, expect, it } from 'vitest';
import { FLOW } from '../../../shared/config';
import { NoiseFloor } from './noise-floor';

describe('NoiseFloor', () => {
  it('is 0 until there are enough clean samples to tell', () => {
    const noise = new NoiseFloor();
    for (let i = 1; i < FLOW.noiseMinSamples; i++) noise.add(20, i * 1000);
    expect(noise.value(FLOW.noiseMinSamples * 1000)).toBe(0);
    noise.add(20, FLOW.noiseMinSamples * 1000);
    expect(noise.value(FLOW.noiseMinSamples * 1000)).toBe(20);
  });

  it('is a high percentile of the clean samples, so one stall does not set it', () => {
    const noise = new NoiseFloor();
    for (let i = 0; i < 20; i++) noise.add(i === 7 ? 900 : i, i * 100); // 0-19 ms, and one 900 ms stall.
    expect(noise.value(2_000)).toBe(18);
  });

  it('forgets samples older than its window, and starts over on reset', () => {
    const noise = new NoiseFloor();
    for (let i = 0; i < FLOW.noiseMinSamples; i++) noise.add(30, i);
    expect(noise.value(FLOW.noiseMinSamples)).toBe(30);
    expect(noise.value(FLOW.noiseWindowMs + FLOW.noiseMinSamples)).toBe(0);
    for (let i = 0; i < FLOW.noiseMinSamples; i++) noise.add(30, i);
    noise.reset();
    expect(noise.value(FLOW.noiseMinSamples)).toBe(0);
  });
});
