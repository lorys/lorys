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
