# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Anyone with a phone, tablet or laptop browser who wants a quick, private exchange with one other person on a different network, without an account or an app. Phones and laptops matter equally, in any mix.

- Friends and family on different networks (for example home Wi-Fi in Kochi and Jio 5G in Bengaluru): a video call, and photos and videos at full quality instead of chat-app compression.
- Privacy-minded people who don't want their media stored on a company's servers.
- Creators and freelancers handing a client a large video file, who need it fast and provably intact.
- The person judging the P2P challenge Dline was built for, who needs visible proof that the connection really is direct.

## Product Purpose

Dline connects exactly two devices directly (peer to peer) for a camera video call and for sending photos, videos and any other file. A server only helps the two devices find each other; calls and files never pass through it. Success means the two people connect in seconds, see exactly how they are connected, and files arrive fast and verified.

## Positioning

The line between two devices is the product: nothing in the middle. Dline always shows which path is in use (direct on the same network, direct over the internet, or relayed and therefore not peer to peer), proves it ("0 bytes through any relay"), and explains in plain words why a direct path failed when it does.

## Operating Context

- Pairing: one person starts a line and shares a 6-character room code, a QR code or a link through their own chat app; the other opens it. A serverless mode pairs with two links instead.
- Both tabs must stay open; browsers pause background tabs. Each code works once, for one person, for 10 minutes.
- A call and file transfers run at the same time. Files are split into blocks, each SHA-256 checked, and carried over several parallel direct connections ("lanes").
- A pre-flight network check rates the network Good, Risky or Blocked before pairing.

## Capabilities and Constraints

- One-to-one only: no group calls, accounts, contacts, history or message storage.
- TURN relay is opt-in, off by default, configured by the user, and always labelled "Relayed, not peer to peer".
- Nothing is stored after the tab closes except the user's own relay settings.
- Received files can be previewed (images, videos), saved or shared; runnable file types get a warning.
- A connection that can't recover within 15 s shows "Connection lost"; received files are currently discarded at that point (a known open decision).
- A 4-word safety code, derived from both devices' encryption fingerprints, lets the two people check nobody is in between.
- Works from 360 px phone width to desktop; latest two versions of Chrome, Safari (iOS 16.4+), Firefox and Edge; installable as a PWA.

## Brand Commitments

The name "Dline". Plain, direct, honest copy: say what is happening and what to do, never hype. The connection type must always be visible.

## Evidence on Hand

Measured transfer speeds and the test matrix live in README.md. There are no testimonials, user counts or press; do not invent any.

## Product Principles

- Show the truth about the connection at all times; never let a relayed connection look direct.
- Two people, one line: everything on screen is about you, them, and what is passing between you.
- Fast to connect, fast to send; the UI never makes either feel slower than it is.
- When something fails, name the cause and the next step in plain language.

## Accessibility & Inclusion

Visible keyboard focus, reduced motion respected, readable contrast in light and dark, usable one-handed on a phone.
