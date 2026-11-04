import { describe, expect, it } from 'vitest';
import { describeDevice } from './environment';

describe('describeDevice', () => {
  it.each([
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36', 'Android Chrome 156'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1', 'iOS Safari 26.6'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/156.0 Mobile/15E148 Safari/604.1', 'iOS Chrome 156'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0', 'Windows Edge 156'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0 Mobile Safari/537.36', 'Android Samsung Internet 28'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0', 'macOS Firefox 150'],
    ['curl/8.0', 'Other browser'],
  ])('%s → %s', (ua, label) => expect(describeDevice(ua)).toBe(label));
});
