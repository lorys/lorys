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
      // Also resend if the host's snapshot disagrees: a dropped last update would
      // otherwise leave the host with a stale paddle until the guest moves again.
      const hostDisagrees = latest && Math.abs(latest.g - round(myX)) > 1e-4;
      if ((myX !== sentX || hostDisagrees) && now - sentAt >= SNAPSHOT_MS) {
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
