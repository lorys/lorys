// Pure air hockey simulation in a normalised W × H field. No DOM.
// Host defends the bottom goal, guest defends the top goal.

export const W = 1;
export const H = 1.6;
export const PUCK_R = 0.04;
export const MALLET_R = 0.065;
export const GOAL_W = 0.36;
export const WIN_SCORE = 7;

const MAX_PUCK_SPEED = 3; // units per second
const MAX_MALLET_SPEED = 5;
const FRICTION = 0.3; // fraction of speed lost per second
const WALL_BOUNCE = 0.9;
const HIT_BOUNCE = 0.9;
const SUBSTEPS = 4; // keeps fast pucks and mallets from tunnelling
const SERVE_DELAY = 1; // seconds

export function createGame() {
  const game = {
    puck: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
    host: mallet(H - 0.2),
    guest: mallet(0.2),
    score: { host: 0, guest: 0 },
    phase: 'serve',
    serveIn: 0,
    winner: null,
  };
  resetGame(game);
  return game;
}

function mallet(y) {
  return { x: W / 2, y, vx: 0, vy: 0, tx: W / 2, ty: y };
}

export function resetGame(game) {
  game.score.host = 0;
  game.score.guest = 0;
  game.winner = null;
  serve(game, Math.random() < 0.5 ? 'host' : 'guest');
}

// Each mallet stays inside its own half.
export function clampMallet(who, x, y) {
  const top = who === 'host' ? H / 2 + MALLET_R : MALLET_R;
  const bottom = who === 'host' ? H - MALLET_R : H / 2 - MALLET_R;
  return [
    Math.max(MALLET_R, Math.min(W - MALLET_R, x)),
    Math.max(top, Math.min(bottom, y)),
  ];
}

// Sets where the mallet should go; step() moves it there at a capped speed,
// so a jumpy network input still turns into a smooth, finite-speed hit.
export function setMallet(game, who, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  [game[who].tx, game[who].ty] = clampMallet(who, x, y);
}

export function step(game, dt) {
  if (game.phase === 'over') return;
  const h = dt / SUBSTEPS;
  for (let i = 0; i < SUBSTEPS && game.phase !== 'over'; i++) {
    moveMallet(game.host, h);
    moveMallet(game.guest, h);
    if (game.phase === 'serve') {
      game.serveIn -= h;
      if (game.serveIn <= 0) game.phase = 'play';
      continue;
    }
    movePuck(game, h);
  }
}

function moveMallet(m, dt) {
  const dx = m.tx - m.x;
  const dy = m.ty - m.y;
  const dist = Math.hypot(dx, dy);
  const reach = MAX_MALLET_SPEED * dt;
  const k = dist > reach ? reach / dist : 1;
  m.vx = (dx * k) / dt;
  m.vy = (dy * k) / dt;
  m.x += dx * k;
  m.y += dy * k;
}

function movePuck(game, dt) {
  const p = game.puck;
  const drag = Math.exp(-FRICTION * dt);
  p.vx *= drag;
  p.vy *= drag;
  p.x += p.vx * dt;
  p.y += p.vy * dt;

  hit(p, game.host);
  hit(p, game.guest);

  if (p.x < PUCK_R) {
    p.x = PUCK_R;
    p.vx = Math.abs(p.vx) * WALL_BOUNCE;
  } else if (p.x > W - PUCK_R) {
    p.x = W - PUCK_R;
    p.vx = -Math.abs(p.vx) * WALL_BOUNCE;
  }

  // The end walls are open across the goal mouth.
  const inMouth = Math.abs(p.x - W / 2) < GOAL_W / 2;
  if (inMouth) {
    if (p.y < 0) return point(game, 'host');
    if (p.y > H) return point(game, 'guest');
  } else if (p.y < PUCK_R) {
    p.y = PUCK_R;
    p.vy = Math.abs(p.vy) * WALL_BOUNCE;
  } else if (p.y > H - PUCK_R) {
    p.y = H - PUCK_R;
    p.vy = -Math.abs(p.vy) * WALL_BOUNCE;
  }
}

// The mallet is treated as infinitely heavy: the puck bounces off it and
// picks up the mallet's velocity.
function hit(p, m) {
  const dx = p.x - m.x;
  const dy = p.y - m.y;
  const dist = Math.hypot(dx, dy);
  const min = PUCK_R + MALLET_R;
  if (dist >= min) return;
  const [nx, ny] = dist > 1e-9 ? [dx / dist, dy / dist] : [0, m.y > H / 2 ? -1 : 1];
  p.x = m.x + nx * min;
  p.y = m.y + ny * min;
  const vn = (p.vx - m.vx) * nx + (p.vy - m.vy) * ny;
  if (vn < 0) {
    p.vx -= (1 + HIT_BOUNCE) * vn * nx;
    p.vy -= (1 + HIT_BOUNCE) * vn * ny;
  }
  const speed = Math.hypot(p.vx, p.vy);
  if (speed > MAX_PUCK_SPEED) {
    p.vx *= MAX_PUCK_SPEED / speed;
    p.vy *= MAX_PUCK_SPEED / speed;
  }
}

function point(game, scorer) {
  game.score[scorer] += 1;
  if (game.score[scorer] >= WIN_SCORE) {
    game.phase = 'over';
    game.winner = scorer;
    return;
  }
  // The player who conceded gets the puck.
  serve(game, scorer === 'host' ? 'guest' : 'host');
}

function serve(game, to) {
  const y = to === 'host' ? H * 0.75 : H * 0.25;
  Object.assign(game.puck, { x: W / 2, y, vx: 0, vy: 0 });
  game.phase = 'serve';
  game.serveIn = SERVE_DELAY;
}
