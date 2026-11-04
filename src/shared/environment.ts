/** Browser capability and context detection, kept in one place. */

interface Capabilities {
  webrtc: boolean;
  camera: boolean;
  opfs: boolean;
  share: boolean;
  wakeLock: boolean;
  broadcastChannel: boolean;
}

export function detectCapabilities(g: typeof globalThis = globalThis): Capabilities {
  const nav = g.navigator as Navigator | undefined;
  return {
    webrtc: typeof g.RTCPeerConnection === 'function',
    camera: typeof nav?.mediaDevices?.getUserMedia === 'function',
    opfs: typeof nav?.storage?.getDirectory === 'function',
    share: typeof nav?.share === 'function',
    wakeLock: !!nav && 'wakeLock' in nav,
    broadcastChannel: typeof g.BroadcastChannel === 'function',
  };
}

type InAppBrowser = 'instagram' | 'facebook' | 'other' | null;

/** In-app browsers often block the camera or WebRTC; the user must open the link in Chrome/Safari. */
export function detectInAppBrowser(userAgent: string): InAppBrowser {
  if (/Instagram/i.test(userAgent)) return 'instagram';
  if (/FBAN|FBAV|FB_IAB/i.test(userAgent)) return 'facebook';
  if (/Line\/|Snapchat|musical_ly|TikTok/i.test(userAgent)) return 'other';
  return null;
}

const OS_PATTERNS: Array<[RegExp, string]> = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Linux/, 'Linux'],
];

/** First match wins: Edge, Opera and Samsung say "Chrome" too, and every iOS browser says "Safari". */
const BROWSER_PATTERNS: Array<[RegExp, string]> = [
  [/EdgA?\/(\d+)|EdgiOS\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/Firefox\/(\d+)|FxiOS\/(\d+)/, 'Firefox'],
  [/CriOS\/(\d+)|Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+(?:\.\d+)?).*Safari/, 'Safari'],
];

/** A coarse device label for performance reports, e.g. "Android Chrome 156" or "iOS Safari 26.6". */
export function describeDevice(userAgent: string): string {
  const os = OS_PATTERNS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'Other';
  for (const [pattern, name] of BROWSER_PATTERNS) {
    const match = pattern.exec(userAgent);
    if (match) return `${os} ${name} ${match.slice(1).find(Boolean) ?? ''}`.trim();
  }
  return `${os} browser`;
}
