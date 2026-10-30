---
name: dline-realtime
description: WebRTC, NAT traversal and real-time rules for the Dline codebase, plus its SOLID/DRY review checklist. Load before writing, changing or reviewing anything in src/modules (connection, pairing, call, transfer, diagnostics), src/server, or the e2e tests; and when debugging connection, call or file-transfer behaviour.
---

# Dline real-time engineering rules

Dline is a modular monolith: one Cloudflare Worker serves the Svelte app and hosts the rendezvous
Durable Object. Media and files only ever travel peer-to-peer. Read `README.md` → Architecture first.

## Non-negotiables

1. **Media and file bytes never touch a server.** The rendezvous relays only `contracts/signaling.ts`
   messages (SDP/ICE/bye, validated, ≤16 KB). TURN is opt-in and the UI must say "Relayed, not
   peer-to-peer" (`diagnostics/path.ts` is the only classifier).
2. **Never relay silently.** `iceTransportPolicy` stays `all`; TURN servers are only added by
   `settings/iceServersFor` when the user enabled them.
3. **Module boundaries** (`.dependency-cruiser.cjs`): import other modules only via `index.ts`;
   feature modules depend only on `connection`; `contracts/` and `shared/` import nothing above them;
   `src/modules` never imports Svelte. Run `npm run deps`.

## Connection facts that shaped the design (don't "fix" them away)

- **Perfect negotiation** (`connection/negotiator.ts`): guest is polite, host impolite. Signals are
  processed strictly in order (`SerialQueue`). `addIceCandidate` errors are ignored only while an
  offer is being ignored.
- **Signal routing** (`signal-router.ts`): `ctrl` data channel first, rendezvous socket second. ICE
  restarts after a network switch go over the rendezvous because `ctrl` is dead by then.
- **mDNS hides host candidates** (including IPv6) until camera permission is granted. Cross-network
  IPv6 therefore arrives as **srflx/prflx**, so at least one STUN server must answer over IPv6, and
  path classification must handle `prflx` and hidden (empty) addresses.
- **Phones background the browser** while the user is in WhatsApp. Connect timeouts use
  `VisibleTimer` (pauses while hidden). The link-mode guest has no timeout at all.
- **Recovery** (`watchdog.ts`): `disconnected` 5 s → ICE restart; 15 s → lost (PRD: ≤15 s).
  `failed` → immediate restart attempt.
- **Link mode** is a `ManualExchange`, not a `Signaler`: it can't trickle (Liskov), so it waits for
  gathering (≤3 s) and packs the SDP with `pairing/sdp-codec.ts` (~200 chars). Only data-channel-only
  SDPs are compacted; anything else falls back to deflated JSON.

## Calls

- One audio + one video transceiver per connection, **reused** across calls (`replaceTrack` +
  `direction`), never `removeTrack` (the SDP would grow every call).
- Only the **caller** creates transceivers; the callee attaches inside `ontrack`. Set both directions
  synchronously before any `await` so the answer already says `sendrecv`.
- Camera off = stop the track + `replaceTrack(null)` (the light goes off), then a `media` ctrl message.
- iOS: stop the old camera track before opening the other one; every `<video>` is `playsinline`.

## File transfer

- **One SCTP association is capped by its congestion window** (Chrome dcSCTP: ~1.2 KB MTU, loss
  halves the window, +1 MTU per round trip). On 100 ms RTT with 0.1 % loss that is ~0.45 MB/s no
  matter how fast the link is. Bigger buffers or chunks don't help; more associations do.
- **Lanes** (`connection/internal/lanes.ts`): lane 0 is a negotiated bulk channel (id 64) on the main
  connection; extra lanes are extra RTCPeerConnections negotiated in-band over `ctrl`
  (`lane-sdp`/`lane-ice`/`lane-close`), host offers, guest answers, **STUN only, never TURN**. Count
  comes from the **lowest** RTT seen (`LanePool.fit`): never from the address type (a VPN looks
  local) and never from a loaded RTT (queues inflate it, even on a LAN). Grow only when the main path
  is direct and connected. Lanes that fail or stay disconnected are dropped and replaced after a pause.
- **Protocol 2** (`contracts/transfer.ts`): files are cut into 128 KB blocks, each with its own
  SHA-256 (WebCrypto, no worker, no wasm) in a `blk` header followed by chunks on one lane. Blocks go
  to the emptiest lane and may arrive in any order; the receiver writes by offset and acks each block
  over `ctrl`. Offers are sent just before the first block (no ready round trip) and blocks that beat
  their offer are held (`EarlyBlocks`, bounded). A lost lane re-queues its in-flight blocks.
- Lane 0 shares its association with calls and `ctrl`: it carries blocks **only when no other lane
  exists**. Blocks queued there delay offers and acks behind them (seen: offers ~75 ms behind blocks
  on a LAN).
- Lane buffers stay shallow (256 KB / 128 KB): a block handed to a lane can't be taken back, so deep
  buffers let one lane in loss recovery hold the end of a file hostage.
- **Overdue blocks are re-sent on another lane** (`TRANSFER.resend`): fast at the end of a batch
  (2× the usual send-to-ack time), only as a safety net before that (4 s), because copies of merely
  slow blocks compete with new ones. The receiver keeps the first copy. Any receiver-side drop (e.g.
  `EarlyBlocks` full) therefore recovers instead of stalling until the watchdog.
- Never load a whole file into memory; the in-flight window bounds RAM.
- Receiver: RAM below 64 MB, OPFS above (`FileSink` strategies must pass the contract test). Clear
  OPFS on startup.
- **Call-aware pacing** is AIMD on RTT growth and loss (`rate-policy.ts`). Do not use
  `availableOutgoingBitrate` or `qualityLimitationReason === 'bandwidth'` to cap files: both describe
  the media's own ramp-up and starved files to 64 KB/s in testing.

## Testing

- Unit: `npm test` (Vitest; Worker tests run in workerd via `@cloudflare/vitest-plugin`).
- E2E: `npm run e2e` (two browser contexts, fake camera). `E2E_PREVIEW=1` runs against the production
  build. `tests/e2e/throughput.spec.ts` prints MB/s against the raw data-channel baseline.
- Fakes: `shared/testing/fake-clock.ts`, `shared/testing/fake-channels.ts` (channels with latency and
  `bufferedAmount`, fake lanes), `shared/testing/fake-peers.ts` (in-band lane negotiation).
- Speed: `tests/bench/` emulates real paths on Windows (Node UDP proxy with rate, queue, delay and
  loss; a page shim routes ICE through it). `BENCH=lan,mobile,far,clean npx playwright test -c
  playwright.bench.config.ts tests/bench/app.spec.ts --repeat-each 3`. It always runs the production
  build (the dev server reloads pages when files are saved, which ends sessions). Results vary run to
  run; compare medians, before and after any transfer change.

## Review checklist (run on every change)

- [ ] No media/file bytes on any server path; no silent relay.
- [ ] New ctrl message → schema in `contracts/`, handler registered with `control.on(type)`, no switch.
- [ ] Untrusted input (ctrl, file channel, rendezvous, links) parsed with `parseMessage`/valibot.
- [ ] Timers go through `Clock`/`VisibleTimer`; everything subscribed is disposed (`Disposer`).
- [ ] **S**: each class has one reason to change. **O**: extend via strategy/registry. **L**: new
  `Signaler`/`FileSink` passes the shared contract. **I**: depend on the smallest port in
  `contracts/ports.ts`. **D**: concrete wiring only in `app/state/session.svelte.ts`.
- [ ] **DRY**: tunables in `shared/config.ts`, copy in `app/copy.ts`, one formatter/classifier each.
  `npm run dup` must report 0 clones. Abstract on the third repeat, not before.
- [ ] `npm run check` and `npm run e2e` pass.
