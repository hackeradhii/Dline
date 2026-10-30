# Dline TRD

Oct 29, 2026 · @adhi

> **Revision 3 (Oct 30, 2026): faster files. Overrides the "Files" bullet of Revision 2 and the file transfer section below.**
> - **Why one connection was slow:** a single SCTP association sends one congestion window per round trip and halves it on every loss, so on a 100 ms path with 0.1 % loss it tops out near 0.45 MB/s however fast the link is.
> - **Lanes:** files now travel over up to 16 parallel direct connections. Lane 0 is a negotiated channel on the main connection; the others are extra `RTCPeerConnection`s negotiated in-band over `ctrl`, STUN only (never TURN). Their number comes from the lowest round trip seen: 3 extra when near (≤ 20 ms), 15 when far.
> - **Protocol 2:** 128 KB blocks, each with its own SHA-256 (WebCrypto, no worker or wasm), sent to whichever lane has room, written by offset in any order, acknowledged per block over `ctrl`. Offers go out with the first block (no ready round trip). Lost lanes give their blocks back; overdue blocks are sent again on another lane (quickly at the end of a batch).
> - **Result (emulated paths, see README):** 5–8.5× faster on a mobile-like path, 8.5–15× on long paths, 2× through the LAN proxy, and the same ~23 MB/s on localhost (first file of a session 13.6 MB/s, was 7–9).
> - **Tests:** 71 unit and Worker tests, 8 two-browser Playwright tests, plus `tests/bench` (network emulator) for speed.

> **Revision 2 (Oct 29, 2026): as built. These override the text below where they conflict.** Full detail in `README.md` and `.claude/skills/dline-realtime/SKILL.md`.
> - **Stack:** Svelte 5 + Vite + TypeScript + Tailwind v4 PWA (not a single HTML file). One Cloudflare Worker serves the assets and hosts the `RendezvousRoom` Durable Object (WebSocket hibernation). It is a modular monolith whose boundaries are enforced by dependency-cruiser.
> - **Signaling:** rendezvous WebSocket with trickle ICE by default. It relays only schema-validated SDP/ICE/bye messages up to 16 KB, keeps reconnect tokens for ICE restarts, and expires rooms after 10 minutes unpaired or 5 minutes empty. The link mode remains, but the payload is a **compact binary SDP** (≈200 characters, prefix `c`) with deflate/plain fallbacks (`z`/`p`).
> - **IPv6 correction:** without camera permission, Chrome hides *all* host candidates (IPv6 included) behind mDNS. Cross-network IPv6 therefore arrives as srflx/prflx; the path badge handles `prflx` and hidden addresses.
> - **Video:** one audio and one video transceiver, reused across calls (`replaceTrack` + direction), never `removeTrack`. "Camera off" stops the camera (the light goes off). Only the caller creates transceivers, so there is no offer glare.
> - **Files:** each `f:<id>` channel carries its own protocol (meta → chunks → end with SHA-256; ack/got/cancel back), so it can't race `ctrl`. Hashing is streaming SHA-256 (hash-wasm in a Worker, never the whole file in RAM). Files over 64 MB go to OPFS. Backpressure is 4 MB / 1 MB.
> - **Pacing during calls:** AIMD on RTT growth and packet loss. The browser's bandwidth estimate and `qualityLimitationReason` were tried and rejected: both throttled files to 64 KB/s at call start in testing.
> - **Reliability:** a visibility-aware connect timeout; `disconnected` for 5 s triggers an ICE restart (via rendezvous if `ctrl` is down), and 15 s means lost.
> - **Tests:** 47 unit and Worker tests (Vitest + workerd) and 7 two-browser Playwright tests, run against both the dev and production builds.

## Purpose and scope

Dline is built as one static HTML page using the browser's built-in WebRTC APIs, with pairing done through two links and no backend of our own. This document describes how; the product requirements are in Dline PRD.

**In scope:** link-based signaling, NAT traversal with STUN, an optional TURN fallback, the control protocol, the video call, file transfer, reliability handling, security, compatibility, hosting and testing.

**Out of scope:** group calls, media servers, accounts, server-side storage and native apps.

## Architecture overview

Two browser tabs hold one `RTCPeerConnection` each and talk directly; the only outside parts are the static host that serves the page, public STUN servers, the users' chat app for the two links, and an optional TURN relay.

&#91;embedded content: system architecture · 2 devices, 3 helpers\]

The static host serves `index.html` once and never sees calls or links. STUN only answers address lookups. The chat app carries the two links and is then out of the loop. TURN, when switched on, sees only encrypted packets.

## Technology stack and browser APIs

Everything runs in plain HTML, CSS and JavaScript with no framework and no build step, so the whole app is one file of roughly 1,000 to 1,500 lines.

| Layer | Choice | Why |
| --- | --- | --- |
| Camera and mic | `navigator.mediaDevices.getUserMedia` | Built in; returns a `MediaStream` |
| Peer connection | `RTCPeerConnection` | ICE, DTLS encryption and SRTP media in one object |
| Data | `RTCDataChannel` (SCTP over DTLS) | Reliable, ordered channel for control messages and files |
| Link compression | `CompressionStream('deflate-raw')` + base64url | Built in; shrinks the handshake to fit a chat message |
| Same-browser handoff | `BroadcastChannel` | Passes a reply link opened in a new tab to the original tab |
| Hashing | `crypto.subtle.digest('SHA-256')` | Built in file integrity check |
| Large file saving | File System Access API, fallback to Blob | Writes straight to disk on desktop Chromium |
| Sharing links | `navigator.share`, fallback `navigator.clipboard` | Opens WhatsApp or Instagram directly on phones |
| Screen awake | `navigator.wakeLock` | Stops the phone sleeping during a call or transfer |
| STUN | `stun.l.google.com:19302`, `stun.cloudflare.com:3478` | Free public servers; two for redundancy |
| TURN (optional) | User-supplied, e.g. Cloudflare Realtime TURN | Fallback only; off by default |
| Hosting | GitHub Pages, Netlify or Cloudflare Pages | Free static HTTPS, which the camera requires |

No third-party JavaScript libraries are required. PeerJS, simple-peer and Trystero were considered and rejected for version 1: the native APIs are small enough to use directly, and hiding them would weaken the submission.

## Signaling via links

The WebRTC offer and answer travel inside the URL fragment of two links, so no signaling server exists. The fragment (after `#`) is never sent to the hosting server, so the static host never sees the handshake.

**Payload**

```json
{ "v": 1, "t": "o", "s": "k3f9x2", "sdp": "v=0\r\no=- ..." }
```

- `v`: format version, so older links can be rejected cleanly.
- `t`: `o` for offer, `a` for answer.
- `s`: session ID, 6 random characters made by the host; the answer must carry the same value.
- `sdp`: the session description after ICE gathering, so all candidates are inside it.

**Encoding**

1. Strip lines not needed: TCP candidates and any candidates after the gathering timeout.
2. JSON-encode, compress with `CompressionStream('deflate-raw')`, then base64url-encode.
3. Prefix with `z` (compressed) or `p` (plain fallback for browsers without `CompressionStream`).

The first offer is data-channel only (no audio or video), which keeps it to about 600 to 1,200 bytes of SDP and roughly 500 to 900 characters after compression. Video is added later over the data channel (see Video call design).

**Link format**

- Invite: `https://<host>/#o.<code>`
- Reply: `https://<host>/#a.<code>`

On load and on `hashchange`, the page reads the fragment, then clears it with `history.replaceState` so a refresh doesn't replay it.

**Waiting for candidates.** Links cannot trickle candidates, so the page waits for `iceGatheringState === 'complete'`, capped at 4 seconds, then builds the link from whatever was gathered.

**Delivering the reply to the host.** The host's `RTCPeerConnection` lives in the tab that made the invite, but tapping the reply link in WhatsApp may open a new tab. Three paths, tried in order:

1. Same tab: if the user pastes the link into the original tab's address bar, `hashchange` fires and the answer is applied.
2. New tab, same browser: the new tab posts `{kind: 'answer', code}` on a `BroadcastChannel`. The original tab checks the session ID, applies it and replies `{kind: 'ack'}`. The new tab then says "Connected in your other tab, switch back to it."
3. No acknowledgement within 1.5 s: the new tab tells the user to copy the link and paste it into the box in the original tab.

**Validation.** Reject a code that fails to decode, has the wrong version, the wrong type, or a session ID that doesn't match the current invite, with a message saying which.

## Connection setup and NAT traversal

ICE finds a direct path using STUN-discovered public addresses and IPv6; TURN is used only when the user has configured it and no direct path works.

**Configuration**

```js
const pc = new RTCPeerConnection({
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
    ...(turn ? [{ urls: turn.urls, username: turn.username, credential: turn.credential }] : [])
  ],
  iceTransportPolicy: 'all'
});
```

**Setup sequence**

1. Host: create the peer connection, create data channel `ctrl` (ordered, reliable), `createOffer`, `setLocalDescription`, wait for gathering, build the invite link.
2. Guest: decode, create the peer connection, `setRemoteDescription(offer)`, `createAnswer`, `setLocalDescription`, wait for gathering, build the reply link. Listen for `ondatachannel`.
3. Host: decode the reply, check the session ID, `setRemoteDescription(answer)`.
4. ICE checks run; when `ctrl` opens, both sides switch to the room screen.

**Candidate types**

| Type | What it is | Typical case |
| --- | --- | --- |
| host | The device's own address, hidden behind a random `.local` name | Both on the same Wi-Fi |
| srflx | Public address learned from STUN | Different networks, hole punching works |
| host (IPv6) | Globally routable IPv6 address | Jio or Airtel mobile; often direct with no NAT |
| relay | Address on a TURN server | Strict or symmetric NAT on both sides |

**IPv6.** Never disable it. On Indian mobile networks it is often the only direct path.

**TURN.** Off by default. The Advanced panel takes a URL, username and credential, saved to `localStorage` (wrapped in try/catch). It must be set before creating or opening an invite. With TURN on, the browser still prefers direct paths and uses the relay only when they fail. Short-lived credentials from a provider such as Cloudflare are recommended; long-lived keys must never be embedded in the page.

**Timeouts.** If `ctrl` hasn't opened 20 seconds after the answer is applied, show "Couldn't connect directly" with the likely cause and the TURN option.

## Control channel protocol

After pairing, the `ctrl` data channel becomes the signaling channel: every control message is one JSON object with a type field `t`. File bytes never go on `ctrl`; each file gets its own channel so control messages are never stuck behind a large transfer.

| `t` | Direction | Fields | Purpose |
| --- | --- | --- | --- |
| `sdp` | either | `d` (description) | Renegotiation offer or answer, e.g. adding video |
| `ice` | either | `c` (candidate) | Trickled candidate after pairing |
| `ping` | either | `ts` | Heartbeat every 4 s |
| `pong` | either | `ts` | Heartbeat reply; sender computes round-trip time |
| `ring` | caller → callee | none | Start a video call |
| `accept` | callee → caller | none | Call accepted |
| `decline` | callee → caller | none | Call declined |
| `hangup` | either | none | End the call |
| `meta` | sender → receiver | `id`, `name`, `size`, `type`, `hash` | Announce a file before its bytes |
| `ack` | receiver → sender | `id`, `bytes` | Progress, every 512 KB |
| `got` | receiver → sender | `id`, `ok` | File complete; `ok` = hash matched |
| `cancel` | either | `id` | Stop a transfer |
| `resume` | receiver → sender | `id`, `from` | Restart from byte offset (P2) |

Unknown types are ignored, so newer versions can add messages without breaking older ones. Incoming fields are validated: names are treated as text only, and sizes must be non-negative integers.

## Video call design

Video is added to the existing connection on demand, negotiated over `ctrl` using MDN's Perfect Negotiation pattern; the guest is the polite peer and the host the impolite one.

**Call flow**

1. Caller taps "Video call": gets camera and mic, shows a muted local preview, sends `ring`.
2. Callee sees Accept and Decline. On Accept: gets camera and mic, `addTrack` for each, sends `accept`.
3. Caller on `accept`: `addTrack` for each of its tracks.
4. Each `addTrack` fires `negotiationneeded`; the handler sends a new offer as `sdp` over `ctrl`. If both offer at once, the polite side rolls back and answers.
5. `ontrack` sets the remote `<video>` source and calls `play()`, which works because both users tapped a button.

**Negotiation handler**

```js
pc.onnegotiationneeded = async () => {
  if (!ctrlOpen()) return;            // ignore during link pairing
  makingOffer = true;
  try { await pc.setLocalDescription(); send({ t: 'sdp', d: pc.localDescription }); }
  finally { makingOffer = false; }
};
async function onSdp(d) {
  const collision = d.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
  ignoreOffer = !polite && collision;
  if (ignoreOffer) return;
  await pc.setRemoteDescription(d);
  if (d.type === 'offer') { await pc.setLocalDescription(); send({ t: 'sdp', d: pc.localDescription }); }
}
```

**Media constraints**

```js
{ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
```

If no camera is available, fall back to audio only and say so.

**Codecs and quality.** Browser defaults (VP8 or H.264, both mandatory in every browser) are used. WebRTC's congestion control adapts bitrate, resolution and frame rate to the network automatically, so no manual bitrate cap is set in version 1.

**Controls**

| Control | Implementation |
| --- | --- |
| Mute mic | `audioTrack.enabled = false` (no renegotiation) |
| Camera off | `videoTrack.enabled = false` (sends black frames) |
| Flip camera | Stop the old video track first (required on iOS), get the other `facingMode`, then `sender.replaceTrack(newTrack)` |
| End call | Send `hangup`, stop local tracks, `removeTrack` each sender, clear video elements |

**iOS requirements.** Every `<video>` has `playsinline` and `autoplay`; the local preview is also `muted`. Calls start from a tap.

## File transfer design

Each file is sent on its own reliable, ordered data channel in chunks of up to 64 KB, paced by backpressure, and verified with SHA-256 on arrival.

**Sender**

1. Generate a file ID; compute SHA-256 of the file (files up to 300 MB; larger files are hashed per 8 MB block).
2. Send `meta` on `ctrl`.
3. Open data channel `f:<id>` with `ordered: true`, `binaryType = 'arraybuffer'`.
4. Read the file in 1 MB blocks with `file.slice().arrayBuffer()`, send each block as chunks of `min(64 KB, pc.sctp.maxMessageSize)`.
5. Pause when `bufferedAmount` exceeds 1 MB; resume on `bufferedamountlow` (threshold 256 KB).
6. Keep the channel open until the receiver sends `got`, then close it.

```js
const CHUNK = Math.min(64 * 1024, pc.sctp?.maxMessageSize || 16 * 1024);
const HIGH = 1024 * 1024, LOW = 256 * 1024, BLOCK = 1024 * 1024;
ch.bufferedAmountLowThreshold = LOW;
for (let off = 0; off < file.size; off += BLOCK) {
  const buf = await file.slice(off, off + BLOCK).arrayBuffer();
  for (let i = 0; i < buf.byteLength; i += CHUNK) {
    if (ch.bufferedAmount > HIGH) await once(ch, 'bufferedamountlow');
    ch.send(buf.slice(i, i + CHUNK));
  }
}
```

**Receiver**

1. `ondatachannel` with label `f:<id>`: create or look up the transfer entry. The channel can open before `meta` arrives, since the two channels aren't ordered against each other, so bytes are kept until `meta` lands.
2. Append chunks; send `ack` every 512 KB so the sender's progress shows delivered bytes, not just queued bytes.
3. When received bytes equal `size`: build the file, check SHA-256, send `got` with `ok`.
4. Show an image or video preview and a Save button. A hash mismatch shows "File damaged, ask them to resend".

**Large files.** Under 300 MB, chunks are collected in memory and joined into a `Blob`. Above that, on browsers with the File System Access API, the receiver chooses a save location first and chunks are written straight to disk. Elsewhere, files are stored in the browser's private file system (OPFS) as they arrive. A 0-byte file completes on `meta`.

**Progress.** Per file: percentage, MB/s averaged over the last 3 s, and time left. A send queue runs files one after another so each gets full bandwidth.

**Resume (P2).** The receiver records the last confirmed offset. After reconnecting, it sends `resume` and the sender continues from that offset.

## Reliability: connection states, heartbeat, recovery

The app watches `connectionState`, runs its own heartbeat, and recovers from a dead path with a fresh invite, because once the path is gone there is no channel left to signal over.

| `connectionState` | User sees | App does |
| --- | --- | --- |
| new, connecting | "Connecting…" | Starts the 20 s connect timer |
| connected | "Connected" + path badge | Starts heartbeat and stats polling; requests wake lock |
| disconnected | "Unstable, trying to recover" | Waits up to 10 s; ICE often recovers on its own |
| failed | "Connection lost" + cause + "Create new invite" | Stops tracks and timers; keeps finished files on screen |
| closed | "Ended" | Cleans up |

**Heartbeat.** `ping` every 4 s on `ctrl`. No message from the peer for 12 s shows "Not responding"; the round-trip time is shown in the status bar. The heartbeat also keeps NAT mappings alive (mobile carrier UDP timeouts are around 65 s).

**Path badge.** Every 3 s, `getStats()` finds the selected candidate pair (`transport.selectedCandidatePairId`, or `selected` on Firefox) and shows:

- "Direct · same network" when both candidates are host.
- "Direct · internet · IPv4 or IPv6" when srflx or IPv6 host is used.
- "Relayed" when either is relay.

**ICE restart.** When the state is `disconnected` but `ctrl` still delivers messages, the host calls `pc.restartIce()` and the new offer goes over `ctrl`. When the network changed completely (for example, Wi-Fi to mobile), no channel survives, so the user creates a new invite; the old session's finished files stay visible.

**Page lifecycle.** Warn on `beforeunload` while connected. Re-request the wake lock on `visibilitychange`.

## Security and privacy

All media and data are encrypted end to end by WebRTC (DTLS-SRTP and DTLS), and there is no unencrypted mode; the main risk is someone tampering with the links.

| Risk | Mitigation |
| --- | --- |
| Someone swaps a link in transit and sits in the middle | Links travel over the users' own end-to-end encrypted chat apps. Optional: show a 4-word safety code derived from both DTLS fingerprints for users to compare aloud |
| A leaked invite is used by a stranger | Each invite pairs once and only while the host tab is open; a second answer is rejected |
| A TURN relay reads traffic | It can't: the relay only forwards encrypted packets |
| Each side sees the other's public IP | Inherent to P2P; disclosed in the UI. Relay-only mode (`iceTransportPolicy: 'relay'`) hides it but is no longer direct |
| Malicious file names or types | Names rendered as text only; files never opened automatically; previews only for `image/*` and `video/*` |
| Huge or endless transfers | Receiver sees the name and size from `meta` first; transfers can be cancelled |
| TURN credentials exposed | Never hard-coded; user-entered, stored only on their device; short-lived credentials recommended |
| Handshake leaked to the host | Data lives in the URL fragment, which browsers don't send to the server |

The page loads no third-party scripts or analytics. Only fonts may come from Google Fonts, and the page works with system fonts if they fail.

## Browser compatibility and hosting

The app targets current Chrome, Safari, Firefox and Edge, and must be served over HTTPS because browsers only allow camera access on secure pages.

| Browser | Status | Notes |
| --- | --- | --- |
| Chrome (Android, desktop) | Full | Reference platform |
| Safari (iOS 16.4+, macOS) | Full | Needs `playsinline`; stop old camera track before flipping; host candidates hidden until camera permission |
| Firefox | Full | Larger data channel messages allowed; chunk size still capped at 64 KB for compatibility |
| Edge | Full | Same engine as Chrome |
| Instagram / Facebook in-app browser | Limited | Camera may be blocked; page detects it and asks the user to open Chrome or Safari |
| WhatsApp link opening | Full | Usually opens the system browser |
| Browsers without `CompressionStream` | Works | Falls back to uncompressed links (about 30 to 40% longer) |
| Browsers without File System Access API | Works | Large files buffered in OPFS instead of streamed to a chosen folder |

**Hosting.** Deploy the single `index.html` to GitHub Pages, Netlify or Cloudflare Pages (all free, all HTTPS). For local development, `http://localhost` counts as secure. No server-side code, environment variables or database.

**Feature checks at startup.** If `RTCPeerConnection` or `getUserMedia` is missing, show a clear "This browser can't make calls" message instead of failing silently.

## Testing plan and network test matrix

Automated tests cover the logic; real phones on real Indian networks prove the P2P claim, and the results table goes in the submission README.

**Automated**

- Unit: link encode/decode round trip, session ID check, chunking arithmetic, hash comparison.
- Browser (Playwright, two pages, Chrome flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`): pair via links, start and accept a call, check both remote videos have frames, send a 50 MB file, check the hash matches.

**Manual network matrix** (fill in during testing)

| # | Device A network | Device B network | Path expected | Path seen | Connect time | Throughput |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Home Wi-Fi | Same Wi-Fi | Direct, same network |  |  |  |
| 2 | Home Wi-Fi | Jio 5G | Direct, likely IPv6 |  |  |  |
| 3 | Jio 5G | Airtel 4G/5G | Direct, likely IPv6 |  |  |  |
| 4 | Airtel | Vi | Unknown |  |  |  |
| 5 | Mobile hotspot | IPv4-only broadband | May fail without TURN |  |  |  |
| 6 | Any | Any, TURN forced | Relayed |  |  |  |
| 7 | Wi-Fi, switched to mobile mid-call | Any | Lost, then new invite |  |  |  |

**Tools.** `chrome://webrtc-internals` and Firefox `about:webrtc` for candidate pairs, bitrate and packet loss; the WebRTC samples Trickle ICE page to see which candidates a network gives; DevTools Network tab to confirm no media goes to any server.

**Devices.** At least one Android phone (Chrome), one iPhone (Safari) and one laptop.

## Risks, mitigations and future work

The biggest risk is a demo on a network pair that can't connect directly; testing the matrix early and having TURN ready removes it.

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Symmetric NAT on both sides blocks the connection | Medium on IPv4 mobile | High | Prefer IPv6; optional TURN; clear failure message |
| Links too long or mangled by a chat app | Low | High | Data-channel-only first offer; compression; test pasting in WhatsApp and Instagram |
| Reply link opens in a different browser than the host | Medium | Medium | Paste box in the host tab; clear instructions |
| iOS Safari camera or autoplay quirks | Medium | Medium | `playsinline`, tap-to-start, test on a real iPhone |
| Tab crashes on large files | Medium | High | Backpressure, block reads, streaming to disk above 300 MB |
| Public STUN server unavailable | Low | Medium | Two providers configured |
| Network switch mid-call | Medium | Medium | Fast detection and one-tap new invite |

**Future work**

- Room-name pairing through Trystero (public Nostr or MQTT relays) to skip the reply link.
- QR code option for devices in the same room.
- Transfer resume after reconnecting (F16).
- Safety code from DTLS fingerprints.
- Text chat over `ctrl`.
- Screen sharing with `getDisplayMedia`.
- Small groups (3 to 4 people) as a mesh; larger groups would need a media server.
