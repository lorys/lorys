# Pong over WebRTC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A two-player Pong game where each player uses their own Android phone in Chrome. The phones connect directly over WebRTC, paired by scanning QR codes.

**Architecture:** This is a static site with ES modules and no build step. `game.js` contains only the simulation. `net.js` wraps the RTCPeerConnection and packs connection descriptions into short strings. `qr.js` renders QR codes (vendored library) and scans them (`BarcodeDetector`). `main.js` drives the screens and the render loop. The host's phone is authoritative and sends snapshots at 30 Hz. The guest sends its paddle position and interpolates between snapshots.

**Tech Stack:** Vanilla JS (ES modules), Canvas 2D, WebRTC DataChannel, `CompressionStream`, `BarcodeDetector`, vendored `qrcode-generator@1.4.4` (MIT).

**Spec:** `docs/superpowers/specs/2026-10-10-pong-webrtc-design.md`

## Global Constraints

- Target Chrome on Android. Desktop Chrome must also work, for development.
- No signaling server and no third-party services at runtime. `iceServers: []` (no STUN/TURN).
- Both phones must be on the same Wi-Fi network or on one phone's hotspot.
- The page must be served over HTTPS (camera access needs a secure context). `localhost` counts as secure.
- Static files only: no build step and no runtime npm dependencies. The only third-party code is `pong/vendor/qrcode.js`.
- **No automated tests** (explicit user decision). Verification is manual or a throwaway `node -e` smoke check. Do not add test files.
- Field is 1 × 1.6 normalised units. First to 7 points wins. The host simulates at 60 Hz and sends snapshots at 30 Hz.
- The data channel uses `{ordered: false, maxRetransmits: 0}`. Messages are JSON with a `t` field: `s` (state snapshot), `p` (paddle position), `r` (rematch request).

## Review Focus

These are the failure modes most likely to bite a real player. Each one has a manual check in the task that owns the code:

1. **Phones on different networks:** the host must see "Couldn't connect…" after 15 s, not a spinner that never ends (Task 3, Task 5).
2. **Scanning the wrong QR code** (a random QR, or a code of the wrong type): show "That's not the right code" and keep scanning, with no crash (Task 5).
3. **Camera denied or `BarcodeDetector` missing:** the paste box still works and an explanatory note appears (Task 4, Task 5).
4. **A phone locks or switches app mid-game:** both phones end on the "Connection lost" screen; neither is left frozen (Task 5).
5. **A rematch request lost on the unreliable channel:** the guest keeps resending `r` every 100 ms until the phase leaves `over` (Task 5).

---

### Task 1: Scaffold the page, styles, vendored QR lib, README

**Files:**
- Create: `pong/index.html`
- Create: `pong/style.css`
- Create: `pong/vendor/qrcode.js` (copied from npm package)
- Create: `pong/README.md`
- Create: `pong/.gitignore`

**Interfaces:**
- Produces: these DOM ids and classes, used by `main.js` (Task 5):
  - Screens (`.screen`): `#menu`, `#host`, `#guest`, `#game`, `#lost`
  - Buttons: `#btn-create`, `#btn-join`, `#btn-scan-reply`, `#btn-rematch`
  - Any `[data-menu]` button reloads the page
  - Text: `#host-status`, `#guest-status`, `#result-title`, `#result-note`, `#lost-msg`
  - Containers: `#host-offer` / `#guest-answer` (`.code-box`, containing `.qr`, `textarea.code`, `button.copy`) and `#host-reply` / `#guest-scan` (`.scan-box`, containing `video`, `.scan-note`, `textarea.paste`, `button.use-paste`)
  - Game: `#canvas`, `#result` (overlay)
- Produces: a global `qrcode(typeNumber, errorCorrectionLevel)` from the classic script `vendor/qrcode.js`

- [ ] **Step 1: Vendor the QR library**

```bash
mkdir -p pong/vendor
cd "$(mktemp -d)" && npm pack qrcode-generator@1.4.4 --silent && tar xzf qrcode-generator-1.4.4.tgz
cp package/qrcode.js /Users/lorys/projects/lorys/side-projects/minigames/pong/vendor/qrcode.js
cd /Users/lorys/projects/lorys/side-projects/minigames
head -10 pong/vendor/qrcode.js   # expect the "Licensed under the MIT license" header
```

- [ ] **Step 2: Write `pong/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
  <meta name="theme-color" content="#0b0b10">
  <title>Pong</title>
  <link rel="stylesheet" href="style.css">
  <script src="vendor/qrcode.js"></script>
  <script type="module" src="js/main.js"></script>
</head>
<body>
  <section id="menu" class="screen">
    <h1>PONG</h1>
    <p class="hint">Two phones · same Wi-Fi</p>
    <button id="btn-create">Create game</button>
    <button id="btn-join" class="secondary">Join game</button>
  </section>

  <section id="host" class="screen" hidden>
    <p id="host-status" class="status"></p>
    <div id="host-offer" class="code-box">
      <div class="qr"></div>
      <textarea class="code" rows="3" readonly></textarea>
      <button class="copy secondary">Copy code</button>
      <button id="btn-scan-reply">Scan reply</button>
    </div>
    <div id="host-reply" class="scan-box" hidden>
      <video playsinline muted></video>
      <p class="scan-note"></p>
      <textarea class="paste" rows="3" placeholder="…or paste the code here"></textarea>
      <button class="use-paste secondary">Use pasted code</button>
    </div>
    <button data-menu class="link">Cancel</button>
  </section>

  <section id="guest" class="screen" hidden>
    <p id="guest-status" class="status">Scan the code on the host's phone.</p>
    <div id="guest-scan" class="scan-box">
      <video playsinline muted></video>
      <p class="scan-note"></p>
      <textarea class="paste" rows="3" placeholder="…or paste the code here"></textarea>
      <button class="use-paste secondary">Use pasted code</button>
    </div>
    <div id="guest-answer" class="code-box" hidden>
      <div class="qr"></div>
      <textarea class="code" rows="3" readonly></textarea>
      <button class="copy secondary">Copy code</button>
    </div>
    <button data-menu class="link">Cancel</button>
  </section>

  <section id="game" class="screen" hidden>
    <canvas id="canvas"></canvas>
    <div id="result" class="overlay" hidden>
      <h2 id="result-title"></h2>
      <p id="result-note" class="hint"></p>
      <button id="btn-rematch">Rematch</button>
      <button data-menu class="link">Menu</button>
    </div>
  </section>

  <section id="lost" class="screen" hidden>
    <h2>Connection lost</h2>
    <p id="lost-msg" class="hint"></p>
    <button data-menu>Back to menu</button>
  </section>
</body>
</html>
```

- [ ] **Step 3: Write `pong/style.css`**

```css
:root {
  color-scheme: dark;
  --bg: #0b0b10;
  --fg: #f2f2f2;
  --accent: #4ade80;
  --muted: #8a8a99;
  --line: #33333f;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }

html, body {
  margin: 0;
  height: 100%;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, sans-serif;
  overscroll-behavior: none;
}

.screen {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  text-align: center;
}

h1 { font-size: 64px; letter-spacing: 0.2em; margin: 0 0 8px; font-weight: 800; }
h2 { margin: 0; }

button {
  font: inherit;
  font-size: 18px;
  font-weight: 700;
  min-width: 220px;
  padding: 14px 28px;
  border: 0;
  border-radius: 12px;
  background: var(--accent);
  color: #06210f;
}
button.secondary { background: transparent; color: var(--fg); border: 2px solid var(--line); }
button.link { background: none; color: var(--muted); min-width: 0; font-weight: 400; font-size: 16px; }
button:disabled { opacity: 0.5; }

.hint, .scan-note { color: var(--muted); margin: 0; max-width: 340px; }
.status { margin: 0; max-width: 340px; }

.code-box, .scan-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 360px;
}

.qr, video {
  width: min(88vw, 360px);
  aspect-ratio: 1;
  border-radius: 12px;
}
.qr { background: #fff; overflow: hidden; }
.qr svg { display: block; width: 100%; height: 100%; }
video { object-fit: cover; background: #000; }

textarea {
  width: 100%;
  padding: 8px;
  font: 12px ui-monospace, monospace;
  background: #16161d;
  color: var(--fg);
  border: 1px solid var(--line);
  border-radius: 8px;
  resize: none;
}

#game {
  position: relative;
  height: 100dvh;
  padding: 0;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}
canvas { display: block; touch-action: none; }

.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: rgba(11, 11, 16, 0.82);
}
```

- [ ] **Step 4: Write `pong/.gitignore`**

```
*.pem
```

- [ ] **Step 5: Write `pong/README.md`**

````markdown
# Pong over WebRTC

Two-player Pong where each player uses their own phone. The phones connect
directly to each other over WebRTC, with no game server. You pair them by
scanning two QR codes.

## Requirements

- Two Android phones with Chrome, on the **same Wi-Fi** (or one phone's hotspot).
- The page must be served over **HTTPS**, because the camera only works on
  secure pages.

## Hosting

Any static host works, for example GitHub Pages: publish the `pong/` folder.

To run it locally over HTTPS on your LAN:

```bash
cd pong
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=pong"
npx http-server . -S -C cert.pem -K key.pem -p 8443
```

Open `https://<your-computer-ip>:8443` on both phones. Accept the certificate
warning (Advanced → Proceed).

## Playing

1. Phone A: **Create game**. A QR code appears.
2. Phone B: **Join game** and scan phone A's code. Phone B then shows its own code.
3. Phone A: **Scan reply** and scan phone B's code. The game starts.

Drag your finger to move your paddle (it's always at the bottom of your
screen). The first player to 7 points wins.

## Testing on a desktop

Run `npx http-server .` and open `http://localhost:8080` in **two separate
Chrome windows placed side by side**. Hidden tabs pause the game and end the
match. Use the code text boxes and *Copy* / *Use pasted code* instead of
scanning.
````

- [ ] **Step 6: Verify the page loads**

Run: `npx http-server pong -p 8080 -c-1` (background), then open `http://localhost:8080`.
Expected: the menu shows "PONG" and two buttons. The console shows one error about `js/main.js` failing to load, which is expected until Task 5. `typeof qrcode` in the console returns `"function"`.

- [ ] **Step 7: Commit**

```bash
git add pong/index.html pong/style.css pong/vendor/qrcode.js pong/README.md pong/.gitignore
git commit -m "pong: scaffold page, styles, vendored QR generator"
```

---

### Task 2: Game simulation (`game.js`)

**Files:**
- Create: `pong/js/game.js`

**Interfaces:**
- Produces:
  - Constants: `W = 1`, `H = 1.6`, `PADDLE_W`, `PADDLE_H`, `PADDLE_MARGIN`, `BALL_R`, `WIN_SCORE = 7`
  - `createGame(): Game`, where `Game = { ball: {x, y, vx, vy}, host: number, guest: number, score: {host, guest}, phase: 'serve'|'play'|'over', serveIn: number, serveDir: 1|-1, winner: 'host'|'guest'|null }`
  - `step(game, dt): void` advances the game by `dt` seconds
  - `setPaddle(game, 'host'|'guest', x): void` clamps x and ignores non-finite values
  - `clampPaddle(x): number`
  - `resetGame(game): void` zeroes the score and serves again
- World geometry: the host paddle sits at the **bottom** (`y ∈ [H-PADDLE_MARGIN-PADDLE_H, H-PADDLE_MARGIN]`) and the guest paddle at the **top** (`y ∈ [PADDLE_MARGIN, PADDLE_MARGIN+PADDLE_H]`). A positive `vy` moves toward the host.

- [ ] **Step 1: Write `pong/js/game.js`**

```js
// Pure Pong simulation in a normalised W × H field. No DOM.
// Host paddle sits at the bottom, guest paddle at the top.

export const W = 1;
export const H = 1.6;
export const PADDLE_W = 0.22;
export const PADDLE_H = 0.025;
export const PADDLE_MARGIN = 0.06;
export const BALL_R = 0.018;
export const WIN_SCORE = 7;

const START_SPEED = 0.7; // units per second
const SPEEDUP = 1.06; // per paddle hit
const MAX_SPEED = 1.8;
const MAX_BOUNCE = Math.PI / 3; // from vertical, at the paddle edge
const SERVE_ANGLE = Math.PI / 6;
const SERVE_DELAY = 1; // seconds

const HOST_TOP = H - PADDLE_MARGIN - PADDLE_H;
const GUEST_BOTTOM = PADDLE_MARGIN + PADDLE_H;

export function createGame() {
  const game = {
    ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
    host: W / 2,
    guest: W / 2,
    score: { host: 0, guest: 0 },
    phase: 'serve',
    serveIn: 0,
    serveDir: 1,
    winner: null,
  };
  resetGame(game);
  return game;
}

export function resetGame(game) {
  game.score.host = 0;
  game.score.guest = 0;
  game.winner = null;
  serve(game, Math.random() < 0.5 ? 1 : -1);
}

export function clampPaddle(x) {
  return Math.max(PADDLE_W / 2, Math.min(W - PADDLE_W / 2, x));
}

export function setPaddle(game, who, x) {
  if (Number.isFinite(x)) game[who] = clampPaddle(x);
}

export function step(game, dt) {
  if (game.phase === 'over') return;

  const b = game.ball;
  if (game.phase === 'serve') {
    game.serveIn -= dt;
    if (game.serveIn > 0) return;
    const angle = (Math.random() * 2 - 1) * SERVE_ANGLE;
    b.vx = START_SPEED * Math.sin(angle);
    b.vy = game.serveDir * START_SPEED * Math.cos(angle);
    game.phase = 'play';
    return;
  }

  const prevY = b.y;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  if (b.x < BALL_R) {
    b.x = BALL_R;
    b.vx = Math.abs(b.vx);
  } else if (b.x > W - BALL_R) {
    b.x = W - BALL_R;
    b.vx = -Math.abs(b.vx);
  }

  // Check face crossings (not overlap) so a fast ball can't tunnel through.
  if (b.vy > 0 && prevY + BALL_R <= HOST_TOP && b.y + BALL_R >= HOST_TOP && hits(b.x, game.host)) {
    bounce(b, game.host, -1, HOST_TOP - BALL_R);
  } else if (b.vy < 0 && prevY - BALL_R >= GUEST_BOTTOM && b.y - BALL_R <= GUEST_BOTTOM && hits(b.x, game.guest)) {
    bounce(b, game.guest, 1, GUEST_BOTTOM + BALL_R);
  }

  if (b.y - BALL_R > H) point(game, 'guest');
  else if (b.y + BALL_R < 0) point(game, 'host');
}

function hits(ballX, paddleX) {
  return Math.abs(ballX - paddleX) <= PADDLE_W / 2 + BALL_R;
}

// Bounce angle depends on where the ball meets the paddle.
function bounce(b, paddleX, dir, y) {
  const offset = Math.max(-1, Math.min(1, (b.x - paddleX) / (PADDLE_W / 2 + BALL_R)));
  const speed = Math.min(Math.hypot(b.vx, b.vy) * SPEEDUP, MAX_SPEED);
  const angle = offset * MAX_BOUNCE;
  b.vx = speed * Math.sin(angle);
  b.vy = dir * speed * Math.cos(angle);
  b.y = y;
}

function point(game, scorer) {
  game.score[scorer] += 1;
  if (game.score[scorer] >= WIN_SCORE) {
    game.phase = 'over';
    game.winner = scorer;
    return;
  }
  // Serve toward the player who conceded.
  serve(game, scorer === 'host' ? -1 : 1);
}

function serve(game, dir) {
  Object.assign(game.ball, { x: W / 2, y: H / 2, vx: 0, vy: 0 });
  game.phase = 'serve';
  game.serveIn = SERVE_DELAY;
  game.serveDir = dir;
}
```

- [ ] **Step 2: Smoke-check in Node (throwaway, not committed)**

Run:
```bash
node --input-type=module -e "
import { createGame, step, setPaddle } from './pong/js/game.js';
const g = createGame();
for (let i = 0; i < 60 * 600 && g.phase !== 'over'; i++) step(g, 1/60);
console.log('unattended:', g.phase, g.score);
const h = createGame();
for (let i = 0; i < 60 * 120; i++) { setPaddle(h, 'host', h.ball.x); setPaddle(h, 'guest', h.ball.x); step(h, 1/60); }
console.log('perfect paddles:', h.phase, h.score, 'speed', Math.hypot(h.ball.vx, h.ball.vy).toFixed(2));
setPaddle(h, 'host', NaN); setPaddle(h, 'guest', 5); console.log('clamp:', h.host, h.guest);
"
```
Expected:
- `unattended: over` with one side at 7. Nobody moves, so every serve scores.
- `perfect paddles: play { host: 0, guest: 0 } speed 1.80`. The paddles track the ball, so there's no score and the speed reaches the cap.
- `clamp:` the host value is unchanged (finite) and the guest value is `0.89`.

- [ ] **Step 3: Commit**

```bash
git add pong/js/game.js
git commit -m "pong: add game simulation"
```

---

### Task 3: Networking (`net.js`)

**Files:**
- Create: `pong/js/net.js`

**Interfaces:**
- Produces:
  - `pack(desc: {type, sdp}): Promise<string>` returns base64url of deflate-raw(JSON)
  - `unpack(code: string): Promise<{type: 'offer'|'answer', sdp: string}>` rejects on any malformed input
  - `host(): Promise<{ offer: string, accept(answerDesc): Promise<Connection> }>`. `accept` rejects with the "Couldn't connect…" error if the channel isn't open within 15 s.
  - `join(offerDesc): Promise<{ answer: string, connected: Promise<Connection> }>`
  - `Connection = { send(msg: object): void, close(): void, onmessage: (msg) => void | null, onclose: () => void | null }`. `onclose` fires at most once, and only after the connection has opened. Non-JSON messages are dropped.

- [ ] **Step 1: Write `pong/js/net.js`**

```js
// WebRTC peer connection with manual (QR / copy-paste) signaling.

const RTC_CONFIG = { iceServers: [] }; // same LAN only, no STUN/TURN
const CHANNEL_OPTIONS = { ordered: false, maxRetransmits: 0 };
const ICE_TIMEOUT_MS = 3000;
const CONNECT_TIMEOUT_MS = 15000;
const NO_CONNECT = "Couldn't connect. Make sure both phones are on the same Wi-Fi and try again.";

export async function host() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel('pong', CHANNEL_OPTIONS);
  await pc.setLocalDescription(await pc.createOffer());
  await iceGathered(pc);
  return {
    offer: await pack(pc.localDescription),
    async accept(answer) {
      await pc.setRemoteDescription(answer);
      return connection(pc, channel, CONNECT_TIMEOUT_MS);
    },
  };
}

export async function join(offer) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = new Promise((resolve) => (pc.ondatachannel = (e) => resolve(e.channel)));
  await pc.setRemoteDescription(offer);
  await pc.setLocalDescription(await pc.createAnswer());
  await iceGathered(pc);
  return {
    answer: await pack(pc.localDescription),
    connected: channel.then((ch) => connection(pc, ch, 0)),
  };
}

// Non-trickle ICE: the packed description must already contain every candidate.
function iceGathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    const timer = setTimeout(done, ICE_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

// Resolves once the channel opens; rejects if it fails first or the timeout (if any) hits.
function connection(pc, channel, timeoutMs) {
  return new Promise((resolve, reject) => {
    let open = false;
    let closed = false;
    const conn = {
      onmessage: null,
      onclose: null,
      send(msg) {
        if (channel.readyState === 'open') channel.send(JSON.stringify(msg));
      },
      close() {
        pc.close();
      },
    };
    const lost = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (open) {
        conn.onclose?.();
      } else {
        pc.close();
        reject(new Error(NO_CONNECT));
      }
    };
    const timer = timeoutMs ? setTimeout(lost, timeoutMs) : 0;
    const opened = () => {
      if (open || closed) return;
      open = true;
      clearTimeout(timer);
      resolve(conn);
    };
    channel.onopen = opened;
    channel.onclose = lost;
    channel.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      conn.onmessage?.(msg);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) lost();
    };
    if (channel.readyState === 'open') opened();
  });
}

export async function pack(desc) {
  const json = JSON.stringify({ type: desc.type, sdp: desc.sdp });
  const bytes = await transform(new TextEncoder().encode(json), new CompressionStream('deflate-raw'));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function unpack(code) {
  const b64 = code.trim().replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const json = new TextDecoder().decode(await transform(bytes, new DecompressionStream('deflate-raw')));
  const desc = JSON.parse(json);
  if ((desc.type !== 'offer' && desc.type !== 'answer') || typeof desc.sdp !== 'string') {
    throw new Error('Not a Pong code');
  }
  return desc;
}

async function transform(bytes, stream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
```

- [ ] **Step 2: Smoke-check pack/unpack in Node (throwaway, not committed)**

Node 18+ has `CompressionStream`, `Blob`, `Response`, `atob`/`btoa`.

Run:
```bash
node --input-type=module -e "
import { pack, unpack } from './pong/js/net.js';
const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n'.repeat(20);
const code = await pack({ type: 'offer', sdp });
console.log('len', code.length, /^[A-Za-z0-9_-]+$/.test(code));
console.log('roundtrip', (await unpack(code)).sdp === sdp);
for (const bad of ['hello', 'https://example.com', '']) console.log(bad || '(empty)', await unpack(bad).then(() => 'ACCEPTED', () => 'rejected'));
"
```
Expected: `len <n> true`, `roundtrip true`, and all three bad inputs print `rejected`.

- [ ] **Step 3: Commit**

```bash
git add pong/js/net.js
git commit -m "pong: add WebRTC connection with packed manual signaling"
```

---

### Task 4: QR render and scan (`qr.js`)

**Files:**
- Create: `pong/js/qr.js`

**Interfaces:**
- Consumes: the global `qrcode` from `vendor/qrcode.js` (Task 1)
- Produces:
  - `canScan: boolean`, true when `BarcodeDetector` and `getUserMedia` both exist
  - `renderQR(container: Element, text: string): void`
  - `startScan(video: HTMLVideoElement, onCode: (text) => void): Promise<stop: () => void>`. It keeps calling `onCode` with every detected value until `stop()` is called, and rejects if the camera can't be opened.
  - `primeCamera(): Promise<void>` requests camera permission and releases it immediately. It never rejects.

- [ ] **Step 1: Write `pong/js/qr.js`**

```js
// QR rendering (vendored qrcode-generator, global `qrcode`) and native scanning.

const SCAN_INTERVAL_MS = 100;

export const canScan = 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;

export function renderQR(container, text) {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}

export async function startScan(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || video.readyState < 2) return;
    busy = true;
    const codes = await detector.detect(video).catch(() => []);
    busy = false;
    if (codes.length) onCode(codes[0].rawValue);
  }, SCAN_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}

// With camera permission granted, Chrome puts real LAN IPs in ICE candidates
// instead of mDNS .local names, which some Android networks fail to resolve.
export async function primeCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    // Permission denied: pairing still works via mDNS or copy/paste.
  }
}
```

- [ ] **Step 2: Verify in the browser console**

With `npx http-server pong -p 8080 -c-1` running, open `http://localhost:8080`. In the console:
```js
const { renderQR, canScan } = await import('./js/qr.js');
const d = document.createElement('div'); d.className = 'qr'; document.body.prepend(d);
renderQR(d, 'x'.repeat(700)); canScan;
```
Expected: a white QR code appears at the top of the page, and `canScan` logs `true` or `false` depending on the browser. Scanning the QR with a phone's camera app shows the `xxx…` text. Reload the page to clean up.

Manual check (Review Focus 3): in Chrome, block camera access for `localhost` (site settings), then run `await (await import('./js/qr.js')).startScan(document.createElement('video'), console.log)`. It must reject, not hang.

- [ ] **Step 3: Commit**

```bash
git add pong/js/qr.js
git commit -m "pong: add QR rendering and BarcodeDetector scanning"
```

---

### Task 5: Screens, pairing flow, game loop, rendering (`main.js`)

**Files:**
- Create: `pong/js/main.js`

**Interfaces:**
- Consumes:
  - From `game.js`: `createGame`, `step`, `setPaddle`, `clampPaddle`, `resetGame`, `W`, `H`, `PADDLE_W`, `PADDLE_H`, `PADDLE_MARGIN`, `BALL_R`, `WIN_SCORE`
  - From `net.js`: `host`, `join`, `unpack`
  - From `qr.js`: `renderQR`, `startScan`, `primeCamera`, `canScan`
  - The DOM ids and classes from Task 1
- Wire messages:
  - Snapshot `{t:'s', n, b:[x,y], h, g, sc:[host,guest], ph, hr, gr}`. `n` is a sequence number, and `hr`/`gr` are the host's and guest's rematch requests.
  - Paddle `{t:'p', x}`
  - Rematch `{t:'r'}`

- [ ] **Step 1: Write `pong/js/main.js`**

```js
import {
  createGame, step, setPaddle, clampPaddle, resetGame,
  W, H, PADDLE_W, PADDLE_H, PADDLE_MARGIN, BALL_R, WIN_SCORE,
} from './game.js';
import { host, join, unpack } from './net.js';
import { renderQR, startScan, primeCamera, canScan } from './qr.js';

const DT = 1 / 60;
const SNAPSHOT_MS = 1000 / 30;
const REMATCH_RESEND_MS = 100;
const BG = '#0b0b10';
const FG = '#f2f2f2';
const ACCENT = '#4ade80';
const DIM = '#26262f';

const $ = (id) => document.getElementById(id);
const round = (v) => Math.round(v * 1e4) / 1e4;

function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
}

function fail(err) {
  console.error(err);
  $('lost-msg').textContent = err?.message || String(err);
  show('lost');
}

for (const b of document.querySelectorAll('[data-menu]')) b.onclick = () => location.reload();
$('btn-create').onclick = () => runHost().catch(fail);
$('btn-join').onclick = () => runGuest().catch(fail);

// ---------- pairing ----------

async function runHost() {
  show('host');
  const status = $('host-status');
  status.textContent = 'Preparing…';
  if (canScan) await primeCamera();
  const session = await host();
  showCode($('host-offer'), session.offer);
  status.textContent = 'Let your opponent scan this, then tap Scan reply.';
  await new Promise((resolve) => ($('btn-scan-reply').onclick = resolve));
  $('host-offer').hidden = true;
  $('host-reply').hidden = false;
  status.textContent = "Scan the code on your opponent's phone.";
  const answer = await readCode($('host-reply'), 'answer');
  $('host-reply').hidden = true;
  status.textContent = 'Connecting…';
  play(await session.accept(answer), true);
}

async function runGuest() {
  show('guest');
  const status = $('guest-status');
  const offer = await readCode($('guest-scan'), 'offer');
  $('guest-scan').hidden = true;
  status.textContent = 'Preparing reply…';
  const session = await join(offer);
  showCode($('guest-answer'), session.answer);
  $('guest-answer').hidden = false;
  status.textContent = 'Let the host scan this. The game starts automatically.';
  play(await session.connected, false);
}

function showCode(box, code) {
  renderQR(box.querySelector('.qr'), code);
  const text = box.querySelector('.code');
  text.value = code;
  box.querySelector('.copy').onclick = () =>
    navigator.clipboard.writeText(code).catch(() => text.select());
}

// Resolves with the decoded description once a valid code of `type` is scanned or pasted.
function readCode(box, type) {
  const video = box.querySelector('video');
  const note = box.querySelector('.scan-note');
  return new Promise((resolve) => {
    let stop = null;
    let busy = false;
    let done = false;
    async function tryCode(code) {
      if (done || busy) return;
      busy = true;
      const desc = await unpack(code).catch(() => null);
      busy = false;
      if (done) return;
      if (desc?.type !== type) {
        note.textContent = "That's not the right code — try again.";
        return;
      }
      done = true;
      stop?.();
      resolve(desc);
    }
    box.querySelector('.use-paste').onclick = () => tryCode(box.querySelector('.paste').value);
    const noCamera = (msg) => {
      video.hidden = true;
      note.textContent = msg;
    };
    if (!canScan) return noCamera("QR scanning isn't supported here — paste the code instead.");
    startScan(video, tryCode).then(
      (s) => (done ? s() : (stop = s)),
      () => noCamera('Camera unavailable — paste the code instead.'),
    );
  });
}

// ---------- game ----------

function play(conn, isHost) {
  show('game');
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const fit = () => {
    const scale = Math.min(innerWidth / W, innerHeight / H);
    canvas.style.width = `${W * scale}px`;
    canvas.style.height = `${H * scale}px`;
    canvas.width = Math.round(W * scale * devicePixelRatio);
    canvas.height = Math.round(H * scale * devicePixelRatio);
  };
  fit();
  addEventListener('resize', fit);

  let myX = W / 2;
  const onPointer = (e) => {
    const r = canvas.getBoundingClientRect();
    myX = clampPaddle(((e.clientX - r.left) / r.width) * W);
  };
  $('game').addEventListener('pointerdown', onPointer);
  $('game').addEventListener('pointermove', onPointer);

  let wantRematch = false;
  $('btn-rematch').onclick = () => (wantRematch = true);

  let ended = false;
  const end = (msg) => {
    if (ended) return;
    ended = true;
    conn.close();
    fail(new Error(msg));
  };
  conn.onclose = () => end('Your opponent left or the network dropped.');
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) end('The game stopped because the app went to the background.');
  });

  const side = isHost ? hostSide(conn) : guestSide(conn);
  const frame = (now) => {
    if (ended) return;
    const view = side.update(now, myX, wantRematch);
    if (view.ph !== 'over') wantRematch = false;
    draw(ctx, canvas, view, !isHost);
    showResult(view, isHost, wantRematch);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Host: authoritative simulation; sends a snapshot every second 60 Hz tick.
function hostSide(conn) {
  const game = createGame();
  let guestRematch = false;
  let acc = 0;
  let last = null;
  let ticks = 0;
  conn.onmessage = (m) => {
    if (m.t === 'p') setPaddle(game, 'guest', m.x);
    else if (m.t === 'r' && game.phase === 'over') guestRematch = true;
  };
  const snapshot = (hostRematch) => ({
    t: 's',
    n: ticks,
    b: [round(game.ball.x), round(game.ball.y)],
    h: round(game.host),
    g: round(game.guest),
    sc: [game.score.host, game.score.guest],
    ph: game.phase,
    hr: hostRematch,
    gr: guestRematch,
  });
  return {
    update(now, myX, wantRematch) {
      setPaddle(game, 'host', myX);
      if (game.phase === 'over' && wantRematch && guestRematch) {
        resetGame(game);
        guestRematch = false;
      }
      acc += Math.min(now - (last ?? now), 250) / 1000;
      last = now;
      while (acc >= DT) {
        step(game, DT);
        acc -= DT;
        if (++ticks % 2 === 0) conn.send(snapshot(wantRematch));
      }
      return snapshot(wantRematch);
    },
  };
}

// Guest: sends its paddle, renders interpolated host snapshots.
function guestSide(conn) {
  let prev = null;
  let latest = null;
  let latestAt = 0;
  let sentX = null;
  let sentAt = 0;
  let rematchAt = 0;
  conn.onmessage = (m) => {
    if (m.t !== 's' || (latest && m.n <= latest.n)) return;
    prev = latest;
    latest = m;
    latestAt = performance.now();
  };
  return {
    update(now, myX, wantRematch) {
      if (myX !== sentX && now - sentAt >= SNAPSHOT_MS) {
        conn.send({ t: 'p', x: round(myX) });
        sentX = myX;
        sentAt = now;
      }
      // The channel is unreliable, so keep asking until the host restarts.
      if (wantRematch && latest?.ph === 'over' && now - rematchAt >= REMATCH_RESEND_MS) {
        conn.send({ t: 'r' });
        rematchAt = now;
      }
      if (!latest) {
        return { b: [W / 2, H / 2], h: W / 2, g: myX, sc: [0, 0], ph: 'serve', hr: false, gr: false };
      }
      return { ...interpolate(prev, latest, (now - latestAt) / SNAPSHOT_MS), g: myX };
    },
  };
}

function interpolate(prev, latest, a) {
  if (!prev || prev.ph !== latest.ph) return latest;
  const t = Math.max(0, Math.min(1, a));
  const lerp = (p, q) => p + (q - p) * t;
  return {
    ...latest,
    b: [lerp(prev.b[0], latest.b[0]), lerp(prev.b[1], latest.b[1])],
    h: lerp(prev.h, latest.h),
  };
}

// `flip` mirrors vertically so each player sees their own paddle at the bottom.
function draw(ctx, canvas, v, flip) {
  const s = canvas.width / W;
  const Y = (y) => (flip ? H - y : y) * s;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = DIM;
  ctx.lineWidth = 0.006 * s;
  ctx.setLineDash([0.03 * s, 0.03 * s]);
  ctx.beginPath();
  ctx.moveTo(0, (H / 2) * s);
  ctx.lineTo(W * s, (H / 2) * s);
  ctx.stroke();
  ctx.setLineDash([]);

  const [mine, theirs] = flip ? [v.sc[1], v.sc[0]] : [v.sc[0], v.sc[1]];
  ctx.fillStyle = DIM;
  ctx.font = `700 ${0.22 * s}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(theirs, (W / 2) * s, H * 0.3 * s);
  ctx.fillText(mine, (W / 2) * s, H * 0.7 * s);

  const paddle = (x, top, color) => {
    ctx.fillStyle = color;
    ctx.fillRect((x - PADDLE_W / 2) * s, Math.min(Y(top), Y(top + PADDLE_H)), PADDLE_W * s, PADDLE_H * s);
  };
  paddle(v.h, H - PADDLE_MARGIN - PADDLE_H, flip ? FG : ACCENT);
  paddle(v.g, PADDLE_MARGIN, flip ? ACCENT : FG);

  if (v.ph !== 'over') {
    ctx.fillStyle = FG;
    ctx.beginPath();
    ctx.arc(v.b[0] * s, Y(v.b[1]), BALL_R * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

function showResult(v, isHost, wantRematch) {
  const over = v.ph === 'over';
  $('result').hidden = !over;
  if (!over) return;
  const [mine, theirs] = isHost ? [v.sc[0], v.sc[1]] : [v.sc[1], v.sc[0]];
  $('result-title').textContent = mine >= WIN_SCORE ? 'You win!' : 'You lose';
  const theyWant = isHost ? v.gr : v.hr;
  $('result-note').textContent = wantRematch
    ? 'Waiting for your opponent…'
    : theyWant
      ? 'Your opponent wants a rematch.'
      : `${mine} – ${theirs}`;
  $('btn-rematch').disabled = wantRematch;
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check pong/js/main.js && node --check pong/js/net.js && node --check pong/js/qr.js && node --check pong/js/game.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Full manual run with two desktop windows**

Start `npx http-server pong -p 8080 -c-1`. Open `http://localhost:8080` in two Chrome windows side by side.

1. Window A: **Create game**. Allow the camera if asked. A QR code and the code text appear.
2. Window B: **Join game**. Paste A's code and click *Use pasted code*. B's QR code and code text appear.
3. Window A: click **Scan reply**, paste B's code, and click *Use pasted code*. Both windows switch to the game.

Expected:
- Each window shows its own paddle in green at the bottom.
- Moving the mouse moves your paddle, and the other window shows it at the top.
- The ball serves after about 1 s and bounces off the walls and paddles. The angle changes with where the ball hits the paddle, and the ball speeds up.
- Both windows show the same scores, mirrored.
- At 7, one window says "You win!" and the other "You lose".
- Rematch: tap in B first, and A shows "Your opponent wants a rematch". Tap in A and both restart at 0–0. Repeat with A tapping first.

- [ ] **Step 4: Review Focus manual checks**

1. **Wrong code:** on the guest's paste screen, paste `hello` and then the host's own *answer*-type code from another session. Each time the note shows "That's not the right code — try again" and the screen stays put.
2. **No camera or detector:** on the guest's screen with camera access blocked, the video hides and shows "Camera unavailable — paste the code instead." Pasting still works.
3. **Background:** during a game, minimise window B. B shows the background message. Within a few seconds A shows "Your opponent left or the network dropped."
4. **Connect timeout:** in window A, create a game and then paste an answer code from a *different*, already-closed session. Within 15 s, A shows "Couldn't connect…".
5. **Rematch resend:** in DevTools for window B, run the game to 7 and tap Rematch, then tap Rematch in A. The game restarts. The resend loop in `guestSide` makes this work even if packets are dropped. Confirm in the code that `{t:'r'}` is sent while `latest.ph === 'over'`.

- [ ] **Step 5: Commit**

```bash
git add pong/js/main.js
git commit -m "pong: add screens, pairing flow, game loop and rendering"
```

---

### Task 6: Real-device check (user)

**Files:** none

- [ ] **Step 1: Serve over HTTPS on the LAN** (see `pong/README.md`). Alternatively, push and use GitHub Pages.
- [ ] **Step 2: The user plays on two Android phones** on the same Wi-Fi, pairing by QR scan both ways. Confirm the touch controls, the flipped view, smooth ball motion on the guest, rematch, and that locking one phone shows "Connection lost" on both.
- [ ] **Step 3: Fix anything found**, then commit with a message describing the fix.
