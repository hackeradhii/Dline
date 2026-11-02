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
