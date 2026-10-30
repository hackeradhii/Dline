# Dline PRD

Oct 29, 2026 · @adhi

> **Revision 2 (Oct 29, 2026), decisions taken during the build. These override the text below where they conflict.**
> - **Pairing is hybrid.** The default is a room code / QR / link through a tiny rendezvous server (a Cloudflare Durable Object) that swaps only the WebRTC handshake. That is the "server for hole punching" the challenge allows, and it never sees media or files. The two-link exchange stays as a no-server mode.
> - **Hosting:** one Cloudflare Worker serves the page and the rendezvous (modular monolith). There is still no media or file server and no accounts.
> - **Network switch:** the rendezvous carries an ICE restart, so a call can survive Wi-Fi → mobile. If it can't, the user sees "Connection lost" within 15 s.
> - **New requirements built:** pre-flight network check (Good / Risky / Blocked), a "no direct P2P path" screen that names the likely cause, a live connection panel with "0 bytes relayed" proof, and the DTLS safety code (raised from optional to P1).
> - **TURN** stays opt-in and is always labelled "Relayed, not peer-to-peer".
> - **Tablets and laptops** are first-class, not just phones; any mix of devices can pair.
> - See `README.md` for measured results and the open real-network test matrix.

## Overview

Dline is a single web page that lets two people on two different networks video-call each other and send photos and videos, with everything flowing directly between their devices. No account, no app install and no server stores or relays their media.

**The challenge it answers:** two devices on two networks; share images and videos and make a camera video call from a web page; entirely peer-to-peer, with a server allowed only for NAT hole punching; reliable and fast.

**The problem:** today's calling and sharing apps route media through company servers, need accounts, and compress files. People who want a quick, private, full-quality exchange with one other person have no simple browser option that works across networks.

**How pairing works:** Person A creates an invite link and sends it over any chat app (WhatsApp, Instagram, SMS). Person B opens it and gets a reply link to send back. Once A opens the reply, the two devices connect directly and the chat app is no longer involved.

## Goals and non-goals

**Goals**

1. Pair two devices on different networks using only links shared through an existing chat app.
2. Run a live one-to-one video call with camera and microphone.
3. Send images and videos in both directions at original quality, with a check that each file arrived intact.
4. Keep all media and files peer-to-peer; the only third-party server is a public STUN server used for hole punching.
5. Connect in under 10 seconds after the reply link is opened, on networks where a direct path exists.
6. Show the user clearly whether they are connected, how (direct or relayed), and what to do if it fails.

**Non-goals for version 1**

- Group calls with more than two people.
- Accounts, contact lists, call history or message storage.
- Text chat beyond what testing needs.
- Native mobile apps, background calls, or push notifications for incoming calls.
- Guaranteed connection on every network (see Known limitations).

## Target users and use cases

The primary user is anyone with a smartphone or laptop browser who wants a quick private exchange with one other person, without installing anything.

| User | Situation | What they need |
| --- | --- | --- |
| Friends and family | On different networks, e.g. home Wi-Fi in Kochi and Jio 5G in Bengaluru | Video call and full-quality photos without WhatsApp compression |
| Privacy-conscious users | Don't want media stored on a company's servers | Direct, encrypted transfer with nothing kept afterwards |
| Creators and freelancers | Need to hand a client a large video file | Fast transfer with a check that the file is not corrupted |
| Developers and reviewers | Evaluating the challenge submission | Clear proof of P2P (connection type shown) and honest limits |

**Key use cases**

1. A starts a video call with B in another city using only a WhatsApp chat to pair.
2. During or outside a call, A sends B a 200 MB phone video at original quality.
3. B sends several photos back to A in one go.
4. Either person sees that the connection dropped and can reconnect with a new link.

## User flow

Pairing takes two links through any chat app; after that, the devices talk directly.

&#91;embedded content: pairing flow · 2 links, 4 steps\]

**Screens**

1. **Home:** short explanation, "Create invite link" button, and a box to paste a link received.
2. **Waiting for reply (host):** the invite link with Copy and Share, a box to paste the reply link, and a note that this tab must stay open.
3. **Send reply (guest):** the reply link with Copy and Share, and "You'll connect as soon as they open it."
4. **Room (both):** status bar with connection path, video area (hidden until a call starts), call controls, "Send photos or videos" button and a list of transfers.
5. **Connection lost:** what happened, likely cause, and "Create new invite".

## Functional requirements

Priority: P0 = needed for the challenge, P1 = needed for "reliable and fast", P2 = nice to have.

| ID | Area | Requirement | Priority |
| --- | --- | --- | --- |
| F1 | Pairing | Host taps "Create invite" and gets a link they can copy or share through the phone's share sheet | P0 |
| F2 | Pairing | Opening the invite link creates a reply link automatically, with Copy and Share buttons | P0 |
| F3 | Pairing | Host can paste the reply link into the original tab to connect | P0 |
| F4 | Pairing | If the host opens the reply link in a new tab of the same browser, it is passed to the original tab automatically | P1 |
| F5 | Pairing | Links stay short enough to send in WhatsApp and Instagram (target under 1,000 characters) | P0 |
| F6 | Pairing | A reply link from a different invite is rejected with a clear message | P1 |
| F7 | Video call | Either person can start a video call; the other sees Accept and Decline | P0 |
| F8 | Video call | Both see the other's live video and hear audio; own preview shown small and muted | P0 |
| F9 | Video call | Mute mic, turn camera off, switch front/back camera, end call | P0 |
| F10 | Video call | Echo cancellation and noise suppression on by default | P0 |
| F11 | Sharing | Pick one or many images or videos and send them; works during a call | P0 |
| F12 | Sharing | Sender and receiver see progress, speed and time left per file | P1 |
| F13 | Sharing | Receiver sees a preview (image or playable video) and a Save button | P0 |
| F14 | Sharing | Each file is checked against a SHA-256 fingerprint; mismatches are flagged | P1 |
| F15 | Sharing | Files up to at least 1 GB transfer without crashing the tab | P1 |
| F16 | Sharing | An interrupted transfer resumes from where it stopped after reconnecting | P2 |
| F17 | Status | Show connection state: connecting, connected, unstable, failed | P0 |
| F18 | Status | Show the connection path: direct on the same network, direct over the internet (IPv4/IPv6), or relayed | P1 |
| F19 | Status | On failure, explain the likely cause and offer "Create new invite" | P0 |
| F20 | Settings | Optional TURN relay settings, off by default, saved on the device | P1 |
| F21 | Guidance | Detect Instagram/Facebook in-app browsers and tell the user to open the link in Chrome or Safari | P1 |
| F22 | Guidance | Warn before closing the tab while connected | P2 |

## Non-functional requirements

| Area | Requirement | Target |
| --- | --- | --- |
| Speed | Time from opening the reply link to connected | Under 10 s on a direct path |
| Speed | Video call latency, one way | Under 300 ms on a direct path within India |
| Speed | File transfer throughput | Limited by the sender's upload speed, not the app; at least 80% of available bandwidth |
| Speed | Video quality | Up to 720p at 30 fps, adapting down automatically on weak networks |
| Reliability | Detect a dead connection | Within 15 s |
| Reliability | Large files | 1 GB without the tab running out of memory |
| Reliability | Integrity | 100% of completed files verified by SHA-256 |
| Privacy | Media and files | Never pass through any server unless the user turns on TURN |
| Privacy | Encryption | All media and data encrypted in transit (WebRTC default, cannot be disabled) |
| Privacy | Storage | Nothing stored after the tab closes, except the user's own optional TURN settings |
| Compatibility | Browsers | Latest two versions of Chrome (Android, desktop), Safari (iOS 16.4+, macOS), Firefox, Edge |
| Compatibility | Screen sizes | Works from 360 px phone width to desktop |
| Hosting | Delivery | One static HTTPS page; no backend of our own |
| Accessibility | Controls | Keyboard usable, visible focus, labelled buttons, readable contrast in light and dark mode |

## Known limitations and constraints

The challenge is slightly impossible as written, so these limits are stated openly in the submission.

1. **Pairing needs a messenger.** The two devices must swap a handshake before they can talk. Dline uses the users' own chat app for this, so no server of ours is involved, but a two-step link exchange is unavoidable.
2. **Some networks block direct connections.** Industry estimates put about 20% of WebRTC sessions as needing a relay. Indian mobile IPv4 often sits behind strict carrier-grade NAT. IPv6, which most Jio and Airtel mobile users have, usually avoids this. The riskiest pairing is mobile data to an IPv4-only home broadband line. The fix is an optional TURN relay, off by default, which still keeps media encrypted.
3. **The host's tab must stay open.** The invite only works while the tab that created it is open, and each invite pairs once.
4. **Browsers pause background tabs.** A web page cannot keep a call or transfer running in the background like a native app.
5. **IP addresses are visible to the other person.** Each side sees the other's public IP, which is inherent to a direct connection. Turning on relay-only mode hides it but stops being P2P.
6. **One-to-one only.** Group calls would need a media server, which the challenge rules out.
7. **In-app browsers.** Instagram's built-in browser may block the camera; the user must open the link in Chrome or Safari.

## Success metrics and acceptance criteria

**Metrics** (measured during testing, shown in the submission)

| Metric | Target |
| --- | --- |
| Direct connection rate across the test matrix | At least 80% of network pairs without TURN |
| Time to connect after reply link opened | Median under 5 s, 95% under 10 s |
| Transfer throughput vs measured upload speed | At least 80% |
| Files verified intact | 100% |
| Calls lasting 10 minutes without dropping on a stable network | 100% |

**Acceptance criteria**

- [ ] A on home Wi-Fi and B on mobile data pair using only WhatsApp and connect directly.
- [ ] Both see and hear each other in a video call; mute, camera off, flip camera and end call all work.
- [ ] A sends B a photo and a 500 MB video; both arrive, preview, save and pass the SHA-256 check.
- [ ] B sends files to A at the same time as a call is running.
- [ ] The status bar shows whether the path is direct or relayed and IPv4 or IPv6.
- [ ] Turning off Wi-Fi mid-call shows "Connection lost" within 15 s and offers a new invite.
- [ ] Browser developer tools show no media or file traffic to any server other than STUN (TURN off).
- [ ] Works on Android Chrome and iOS Safari.

## Release plan and open questions

The build runs in four milestones, about 4 to 5 working days for a developer comfortable with JavaScript (estimate).

| Milestone | Scope | Requirements | Estimate |
| --- | --- | --- | --- |
| M1 Pairing | Invite and reply links, direct connection, status | F1 to F6, F17, F19 | 1 day |
| M2 Video call | Call, accept, controls | F7 to F10 | 1 day |
| M3 Sharing | Chunked transfer, progress, preview, SHA-256, large files | F11 to F15 | 1 to 1.5 days |
| M4 Hardening | Path display, TURN setting, in-app browser hint, network testing, README | F18, F20 to F22, test matrix | 1 to 1.5 days |
| Later | Resume, chat, QR code option | F16 | Optional |

**Open questions**

- [ ] Does the challenge setter accept an optional TURN relay as a fallback, or must the app fail rather than relay?
- [ ] Is the two-link exchange acceptable UX, or should a room-name mode (public Nostr/MQTT relays via Trystero) be added for automatic pairing?
- [ ] Which devices and carriers must the demo be shown on?
- [ ] Is there a maximum file size the reviewers will test?
- [x] Product name: settled as "Dline".
