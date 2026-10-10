# Pong over WebRTC — Design

**Date:** 2026-10-10
**Status:** Approved in chat, pending spec review

## Goal

Two players, each on their own Android phone running Chrome, play one shared
game of Pong over the same local network. No game server, no app install.

### Background

The original ask was a phone-to-phone Pong game over Web Bluetooth. Chrome's
Web Bluetooth API is client-only (it cannot advertise or act as a GATT server),
so two Chrome tabs cannot connect to each other over Bluetooth. The chosen
alternative is a direct WebRTC connection between the two phones, paired by
scanning QR codes.

## Constraints

- Runs in Chrome on Android. Desktop Chrome must also work, for development.
- No signaling server and no third-party services at runtime.
- Both phones must be on the same Wi-Fi network or on one phone's hotspot. No
  STUN or TURN servers are used.
- The page must be served over HTTPS, because camera access requires a secure
  context.
- Static files only: no build step, no runtime npm dependencies.
- No automated tests (explicit user decision).

## Hosting

- The game lives in `pong/` in this repo and is deployable to any static host,
  such as GitHub Pages.
- For local use, serve it over HTTPS with a self-signed certificate, for example
  `npx http-server pong -S -C cert.pem -K key.pem`. The README documents how to
  generate the certificate.
- The only third-party code is a vendored, MIT-licensed QR code generator in
  `pong/vendor/qrcode.js`.

## Pairing flow

1. **Host** taps *Create game*. The page creates an `RTCPeerConnection` and a
   data channel, then creates an offer and waits for ICE gathering to finish
   (non-trickle, with a ~3 s safety timeout). It then displays the packed offer
   as a QR code.
2. **Guest** taps *Join game* and scans the host's QR code. The page applies the
   offer, creates an answer, waits for ICE gathering, and displays the packed
   answer as a QR code.
3. **Host** taps *Scan reply* and scans the guest's QR code. The page applies
   the answer, the data channel opens, and both phones move to the game screen.

### Packing

- The local description `{type, sdp}` is serialised to JSON, then compressed
  with `CompressionStream('deflate-raw')`, then encoded as base64url.
  Unpacking runs the same steps in reverse with `DecompressionStream`.
- The expected size is about 400–600 characters, which gives a QR code that
  phones scan comfortably.

### Scanning

- Scanning uses the native `BarcodeDetector({formats: ['qr_code']})` on a
  rear-camera `getUserMedia` video stream, polled about 10 times per second.
  Once the user grants camera permission, Chrome exposes real host IPs in ICE
  candidates instead of mDNS `.local` names, which makes connecting on a LAN
  more reliable.
- **Fallback:** every QR screen also shows the packed text with a *Copy*
  button, and every scan screen has a *Paste* text box. This covers desktop
  Chrome (where `BarcodeDetector` may be missing) and testing with two tabs.

## Game

- Portrait layout with paddles at the top and bottom. Each player sees their own
  paddle at the bottom: the guest's view is flipped vertically when rendering.
- **Controls:** dragging a finger anywhere on the screen moves your paddle
  horizontally, following the finger's x position. On desktop, the mouse does
  the same.
- **Rules:**
  - The ball speeds up slightly on every paddle hit.
  - The bounce angle depends on where the ball hits the paddle.
  - The first player to 7 points wins. The result screen shows the winner and a
    *Rematch* button. A rematch starts once both players have tapped it.
- All coordinates use a normalised field of 1 × 1.6 units. Each phone scales
  this to its own canvas size, so different screen sizes work.

### Authority and networking

- **The host is authoritative.** It runs the simulation at a fixed 60 Hz step
  and sends a state snapshot every second tick (30 Hz). Each snapshot holds the
  ball position, both paddle positions, the score, the game phase, both players' rematch flags,
  and a sequence number.
- **The guest** sends only its paddle x position, at most 30 times per second
  and only when it changes. It moves its own paddle immediately on input and
  renders the ball and the host's paddle by interpolating between the last two
  snapshots.
- **Data channel:** `{ordered: false, maxRetransmits: 0}`. Messages are compact
  JSON with a short `t` (type) field:
  - `s`: state snapshot
  - `p`: paddle position
  - `r`: rematch request
- **Disconnects:** if `connectionState` becomes `failed`/`disconnected`/`closed`,
  or the data channel closes, both sides show "Connection lost" with a *Back to
  menu* button.

## Files

```
pong/
  index.html       screens: menu, host-pairing, guest-pairing, game, result
  style.css
  js/main.js       screen switching and wiring between modules
  js/game.js       pure simulation (step, collisions, scoring); no DOM
  js/net.js        RTCPeerConnection setup, pack/unpack, message send/receive
  js/qr.js         render QR (vendored lib) and scan QR (BarcodeDetector)
  vendor/qrcode.js
  README.md        how to serve over HTTPS and play
```

The code uses ES modules loaded with `<script type="module">`.

## Verification

There are no automated tests. Verification is manual:

1. Two desktop Chrome tabs paired with the copy/paste fallback, playing a full
   game to 7 points and a rematch.
2. The user plays on two Android phones on the same Wi-Fi, pairing by QR scan.
   This step can only be done by the user.

## Out of scope

- Playing across different networks (this would need STUN/TURN).
- Bluetooth.
- Sound, AI opponent, spectators, reconnecting after a drop.
