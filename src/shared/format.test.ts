import { describe, expect, it } from 'vitest';
import { formatVideo, plural } from './format';

describe('plural', () => {
  it('words a count, with an irregular plural when given', () => {
    expect(plural(1, 'file')).toBe('1 file');
    expect(plural(0, 'file')).toBe('0 files');
    expect(plural(2, 'recovery', 'recoveries')).toBe('2 recoveries');
  });
});

describe('formatVideo', () => {
  it('shows size and frame rate, the codec only when given, and Off without frames', () => {
    expect(formatVideo({ width: 1280, height: 720, fps: 29.6 })).toBe('1280×720, 30 fps');
    expect(formatVideo({ width: 640, height: 360, fps: 30, codec: 'VP8' })).toBe('640×360, 30 fps, VP8');
    expect(formatVideo({ width: 640, height: 360, fps: 30, codec: null })).toBe('640×360, 30 fps, ?');
    expect(formatVideo({ width: null, height: null, fps: null })).toBe('Off');
    expect(formatVideo(null)).toBe('Off');
  });
});
