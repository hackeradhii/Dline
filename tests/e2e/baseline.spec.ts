import { test } from '@playwright/test';

/** Raw RTCDataChannel loopback throughput on this machine: the ceiling Dline's transfer can reach. */
test('raw data channel baseline (localhost)', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    const ch = a.createDataChannel('bench', { ordered: true });
    ch.binaryType = 'arraybuffer';
    const total = 32 * 1024 * 1024;
    const received = new Promise<number>((resolve) => {
      b.ondatachannel = ({ channel }) => {
        let got = 0;
        const t0 = performance.now();
        channel.onmessage = (e) => {
          got += (e.data as ArrayBuffer).byteLength;
          if (got >= total) resolve(performance.now() - t0);
        };
      };
    });
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription!);
    await new Promise((r) => (ch.onopen = r));
    const chunk = new Uint8Array(64 * 1024);
    ch.bufferedAmountLowThreshold = 1024 * 1024;
    for (let sent = 0; sent < total; sent += chunk.byteLength) {
      if (ch.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => (ch.onbufferedamountlow = r));
      ch.send(chunk);
    }
    const ms = await received;
    return { ms, maxMessageSize: a.sctp?.maxMessageSize };
  });
  console.log(`raw 32 MB: ${(result.ms / 1000).toFixed(1)} s (${(32 / (result.ms / 1000)).toFixed(1)} MB/s), sctp max message ${result.maxMessageSize}`);
});
