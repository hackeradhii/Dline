import { describe, expect, it } from 'vitest';
import { fromOurOrigin } from './origin';

const request = (origin?: string) => new Request('https://dline.test/api/metrics', { headers: origin === undefined ? {} : { Origin: origin } });

describe('fromOurOrigin', () => {
  it('accepts this site and refuses others, including malformed and opaque origins', () => {
    expect(fromOurOrigin(request('https://dline.test'), { required: true })).toBe(true);
    for (const origin of ['https://evil.test', 'null', 'not a url']) expect(fromOurOrigin(request(origin), { required: false })).toBe(false);
  });

  it('a request without Origin passes only when one is not required', () => {
    expect(fromOurOrigin(request(), { required: false })).toBe(true);
    expect(fromOurOrigin(request(), { required: true })).toBe(false);
  });
});
