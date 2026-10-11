import { searchMovies } from './search.js';
import { createPlayer } from './player.js';

const IMG = 'https://image.tmdb.org/t/p';
const $ = (id) => document.getElementById(id);

const SAVE_INTERVAL_MS = 10_000;

let movies = [];
// movieId → { position, duration, updatedAt }, from the user's account.
let progress = {};

// ---------- API ----------

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ---------- Views ----------

function showLogin() {
  $('browse-view').hidden = true;
  $('login-view').hidden = false;
  $('login-form').username.focus();
}

async function showBrowse(username) {
  $('login-view').hidden = true;
  $('browse-view').hidden = false;
  $('username').textContent = username;
  [{ movies }, progress] = await Promise.all([api('/api/movies'), api('/api/progress')]);
  renderHome();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $('login-error').hidden = true;
  try {
    const { username } = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    form.reset();
    await showBrowse(username);
  } catch (err) {
    $('login-error').textContent = err.message;
    $('login-error').hidden = false;
  }
});

$('logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  movies = [];
  progress = {};
  showLogin();
});

// ---------- Catalogue ----------

function yearOf(movie) {
  return movie.year ? String(movie.year) : '';
}

function formatRuntime(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
}

function formatRemaining(entry) {
  const minutes = Math.max(1, Math.round((entry.duration - entry.position) / 60));
  return `Il reste ${formatRuntime(minutes)}`;
}

function progressPercent(entry) {
  return `${Math.min(100, (entry.position / entry.duration) * 100)}%`;
}

function buildCategories() {
  const categories = [];
  const started = movies
    .filter((m) => progress[m.id])
    .sort((a, b) => progress[b.id].updatedAt.localeCompare(progress[a.id].updatedAt));
  if (started.length) categories.push({ name: 'Reprendre la lecture', movies: started });

  const recent = [...movies].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, 20);
  if (recent.length) categories.push({ name: 'Ajoutés récemment', movies: recent });

  const topRated = movies
    .filter((m) => (m.voteAverage ?? 0) >= 7)
    .sort((a, b) => b.voteAverage - a.voteAverage)
    .slice(0, 20);
  if (topRated.length >= 3) categories.push({ name: 'Les mieux notés', movies: topRated });

  const byGenre = new Map();
  for (const movie of movies) {
    for (const genre of movie.genres) {
      if (!byGenre.has(genre)) byGenre.set(genre, []);
      byGenre.get(genre).push(movie);
    }
  }
  const genres = [...byGenre.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'fr'));
  for (const [name, list] of genres) {
    categories.push({ name, movies: list.sort((a, b) => (b.voteAverage ?? 0) - (a.voteAverage ?? 0)) });
  }

  const unmatched = movies.filter((m) => !m.genres.length);
  if (unmatched.length) categories.push({ name: 'Autres', movies: unmatched });
  return categories;
}

function createCard(movie, { backdrop = false } = {}) {
  const card = $('card-template').content.firstElementChild.cloneNode(true);
  const img = card.querySelector('img');
  const fallback = card.querySelector('.card__fallback');
  const imagePath = backdrop ? movie.backdropPath : movie.posterPath;
  card.title = movie.title;
  fallback.textContent = movie.title;
  if (imagePath) {
    img.src = `${IMG}/${backdrop ? 'w500' : 'w342'}${imagePath}`;
    img.alt = movie.title;
    img.addEventListener('error', () => img.remove());
  } else {
    img.remove();
  }
  const entry = progress[movie.id];
  if (entry) {
    const bar = card.querySelector('.card__progress');
    bar.hidden = false;
    bar.firstElementChild.style.width = progressPercent(entry);
    card.title = `${movie.title} — ${formatRemaining(entry)}`;
  }
  card.addEventListener('click', () => openModal(movie));
  return card;
}

function renderHero() {
  const hero = $('hero');
  hero.replaceChildren();
  const candidates = movies.filter((m) => m.backdropPath && m.overview);
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  if (!pick) {
    hero.hidden = true;
    return;
  }
  hero.hidden = false;
  hero.style.backgroundImage = `url(${IMG}/original${pick.backdropPath})`;

  const content = document.createElement('div');
  content.className = 'hero__content';
  const title = document.createElement('h1');
  title.textContent = pick.title;
  const overview = document.createElement('p');
  overview.textContent = pick.overview;
  const actions = document.createElement('div');
  actions.className = 'hero__actions';
  const play = document.createElement('button');
  play.className = 'btn btn--play';
  play.textContent = progress[pick.id] ? '▶ Reprendre' : '▶ Lecture';
  play.addEventListener('click', () => playMovie(pick));
  const info = document.createElement('button');
  info.className = 'btn btn--secondary';
  info.textContent = 'ⓘ Plus d’infos';
  info.addEventListener('click', () => openModal(pick));
  actions.append(play, info);
  content.append(title, overview, actions);
  hero.append(content);
}

function renderRows() {
  const rows = $('rows');
  rows.replaceChildren();
  for (const category of buildCategories()) {
    const row = document.createElement('div');
    row.className = 'row';
    const title = document.createElement('h2');
    title.textContent = category.name;
    const track = document.createElement('div');
    track.className = 'row__track';
    track.append(...category.movies.map((m) => createCard(m)));
    row.append(title, track);
    rows.append(row);
  }
}

function renderHome() {
  const isEmpty = movies.length === 0;
  $('empty').hidden = !isEmpty;
  $('empty').textContent = 'Aucun film pour le moment. Ajoutez des fichiers dans MOVIES_PATH : ils apparaîtront ici après le scan.';
  $('search-results').hidden = true;
  $('rows').hidden = false;
  renderHero();
  renderRows();
}

// ---------- Search ----------

let searchTimer;
$('search-input').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderSearch(event.target.value), 150);
});

function renderSearch(query) {
  if (!query.trim()) {
    renderHome();
    return;
  }
  const results = searchMovies(movies, query);
  $('hero').hidden = true;
  $('rows').hidden = true;
  $('empty').hidden = true;
  $('search-results').hidden = false;
  $('search-title').textContent = results.length
    ? `Résultats pour « ${query.trim()} »`
    : `Aucun résultat pour « ${query.trim()} »`;
  $('search-grid').replaceChildren(...results.map((m) => createCard(m)));
}

$('home-link').addEventListener('click', (event) => {
  event.preventDefault();
  $('search-input').value = '';
  renderHome();
  window.scrollTo({ top: 0 });
});

window.addEventListener('scroll', () => {
  $('topbar').classList.toggle('topbar--solid', window.scrollY > 40);
});

// ---------- Modal ----------

let modalMovie = null;

function openModal(movie) {
  modalMovie = movie;
  $('modal-hero').style.backgroundImage = movie.backdropPath ? `url(${IMG}/w1280${movie.backdropPath})` : '';
  $('modal-title').textContent = movie.title;
  const meta = [
    movie.voteAverage ? `★ ${movie.voteAverage.toFixed(1)}` : '',
    yearOf(movie),
    formatRuntime(movie.runtime),
    movie.genres.join(', '),
  ].filter(Boolean);
  $('modal-meta').textContent = meta.join(' · ');
  $('modal-tagline').textContent = movie.tagline;
  $('modal-overview').textContent = movie.overview || 'Aucun résumé disponible.';

  // Started movies offer to resume or to start over.
  const entry = progress[movie.id];
  $('modal-play').textContent = entry ? '▶ Reprendre' : '▶ Lecture';
  $('modal-restart').hidden = !entry;
  $('modal-progress').hidden = !entry;
  if (entry) {
    $('modal-progress-bar').style.width = progressPercent(entry);
    $('modal-remaining').textContent = formatRemaining(entry);
  }

  const credits = $('modal-credits');
  credits.replaceChildren();
  const addCredit = (label, value) => {
    if (!value) return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    credits.append(dt, dd);
  };
  addCredit('Réalisation', movie.director);
  addCredit('Distribution', movie.cast.join(', '));
  if (movie.originalTitle && movie.originalTitle !== movie.title) addCredit('Titre original', movie.originalTitle);
  addCredit('Fichier', movie.file);

  $('modal').hidden = false;
  document.body.classList.add('no-scroll');
}

function closeModal() {
  $('modal').hidden = true;
  document.body.classList.remove('no-scroll');
}

$('modal').addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeModal();
});
$('modal-play').addEventListener('click', () => {
  closeModal();
  playMovie(modalMovie);
});
$('modal-restart').addEventListener('click', () => {
  closeModal();
  playMovie(modalMovie, { restart: true });
});

// ---------- Downloads ----------

const DOWNLOADS_POLL_MS = 1000;
// downloadId → <li>, plus the empty "draft" row at the bottom that takes a new link.
const downloadRows = new Map();
let draftRow = null;
let downloadsTimer = null;

function formatBytes(bytes) {
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1000;
    i++;
  }
  return `${bytes.toLocaleString('fr-FR', { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

function setDownloadStatus(row, text, { percent = null, state = '' } = {}) {
  row.className = `download${state ? ` download--${state}` : ''}`;
  row.querySelector('.download__status').hidden = false;
  row.querySelector('.download__text').textContent = text;
  row.querySelector('.download__bar > span').style.width = `${percent ?? 0}%`;
}

function renderDownload(row, download) {
  const input = row.querySelector('.download__url');
  input.value = download.url;
  input.readOnly = true;
  input.title = download.filename ?? download.url;
  const remove = row.querySelector('.download__remove');
  remove.hidden = false;
  remove.setAttribute('aria-label', download.status === 'downloading' ? 'Annuler' : 'Retirer de la liste');
  remove.title = remove.getAttribute('aria-label');

  if (download.status === 'downloading') {
    if (download.total) {
      const percent = Math.min(100, (download.received / download.total) * 100);
      setDownloadStatus(row, `${Math.floor(percent)} % · ${formatBytes(download.received)} / ${formatBytes(download.total)}`, { percent });
    } else {
      setDownloadStatus(row, download.received ? formatBytes(download.received) : 'Connexion…', { state: 'indeterminate' });
    }
  } else if (download.status === 'done') {
    setDownloadStatus(row, `Terminé · ${download.filename}`, { percent: 100, state: 'done' });
  } else if (download.status === 'cancelled') {
    setDownloadStatus(row, 'Annulé', { state: 'error' });
  } else {
    setDownloadStatus(row, `Échec : ${download.error}`, { state: 'error' });
  }
}

function createDownloadRow() {
  const row = $('download-template').content.firstElementChild.cloneNode(true);
  row.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (row === draftRow) startDownload(row);
  });
  row.querySelector('.download__remove').addEventListener('click', async () => {
    const id = row.dataset.id;
    try {
      await api(`/api/downloads/${id}`, { method: 'DELETE' });
    } catch {}
    await refreshDownloads();
  });
  return row;
}

function addDraftRow() {
  draftRow = createDownloadRow();
  $('downloads-list').append(draftRow);
  return draftRow;
}

async function startDownload(row) {
  const input = row.querySelector('.download__url');
  const url = input.value.trim();
  if (!url) return;
  input.readOnly = true;
  try {
    const download = await api('/api/downloads', { method: 'POST', body: JSON.stringify({ url }) });
    row.dataset.id = download.id;
    downloadRows.set(download.id, row);
    renderDownload(row, download);
    addDraftRow().querySelector('input').focus();
  } catch (err) {
    input.readOnly = false;
    setDownloadStatus(row, err.message, { state: 'error' });
    input.focus();
  }
}

async function refreshDownloads() {
  let list;
  try {
    list = await api('/api/downloads');
  } catch {
    return;
  }
  const seen = new Set();
  for (const download of list) {
    seen.add(download.id);
    let row = downloadRows.get(download.id);
    if (!row) {
      // Started before the modal was opened (or from another tab).
      row = createDownloadRow();
      row.dataset.id = download.id;
      downloadRows.set(download.id, row);
      $('downloads-list').insertBefore(row, draftRow);
    }
    renderDownload(row, download);
  }
  for (const [id, row] of downloadRows) {
    if (seen.has(id)) continue;
    row.remove();
    downloadRows.delete(id);
  }
}

function openDownloads() {
  if (!draftRow) addDraftRow();
  $('downloads').hidden = false;
  document.body.classList.add('no-scroll');
  draftRow.querySelector('input').focus();
  refreshDownloads();
  clearInterval(downloadsTimer);
  downloadsTimer = setInterval(refreshDownloads, DOWNLOADS_POLL_MS);
}

function closeDownloads() {
  clearInterval(downloadsTimer);
  downloadsTimer = null;
  $('downloads').hidden = true;
  document.body.classList.remove('no-scroll');
}

$('downloads').addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeDownloads();
});

// ---------- Player ----------

const player = createPlayer({ onBack: () => closePlayer() });
const { video } = player;
let playing = null;
let saveTimer = null;

/** Persist the current position in the user's account. */
function saveProgress({ keepalive = false } = {}) {
  if (!playing || !video.duration || !Number.isFinite(video.duration) || video.currentTime < 1) return Promise.resolve();
  const movie = playing;
  const body = JSON.stringify({ position: video.currentTime, duration: video.duration });
  // keepalive lets the request finish when the tab is being closed.
  return fetch(`/api/progress/${movie.id}`, { method: 'PUT', body, keepalive, headers: { 'content-type': 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      if (data.progress) progress[movie.id] = data.progress;
      else delete progress[movie.id];
    })
    .catch(() => {});
}

function startAutoSave() {
  clearInterval(saveTimer);
  saveTimer = setInterval(saveProgress, SAVE_INTERVAL_MS);
}

function stopAutoSave() {
  clearInterval(saveTimer);
  saveTimer = null;
}

async function playMovie(movie, { restart = false } = {}) {
  playing = movie;
  let startAt = 0;
  if (restart) {
    delete progress[movie.id];
    api(`/api/progress/${movie.id}`, { method: 'DELETE' }).catch(() => {});
  } else if (progress[movie.id]) {
    startAt = progress[movie.id].position;
  }
  document.body.classList.add('no-scroll');
  player.open(movie, { startAt });
}

function closePlayer() {
  if (!playing) return;
  stopAutoSave();
  const saved = saveProgress();
  playing = null;
  player.close();
  document.body.classList.remove('no-scroll');
  // Refresh progress bars and the "Reprendre la lecture" row once the last save landed.
  saved.then(() => {
    if ($('search-input').value.trim()) renderSearch($('search-input').value);
    else renderRows();
  });
}

video.addEventListener('playing', startAutoSave);
video.addEventListener('pause', () => {
  stopAutoSave();
  saveProgress();
});
video.addEventListener('ended', () => {
  stopAutoSave();
  if (!playing) return;
  delete progress[playing.id];
  api(`/api/progress/${playing.id}`, { method: 'DELETE' }).catch(() => {});
  // Back to the catalogue once the movie is over, like Netflix.
  closePlayer();
});
window.addEventListener('pagehide', () => saveProgress({ keepalive: true }));

document.addEventListener('keydown', (event) => {
  console.log("Debug key", event);
  if (player.handleKey(event)) return;
  if (event.key === 'Enter') {
    // Enter anywhere on the catalogue (but not while typing or on a focused button) opens downloads.
    const busy = !$('player').hidden || !$('modal').hidden || !$('downloads').hidden || $('browse-view').hidden;
    console.log({busy}, event.target.closest('input, textarea, select, button, a'));
    if (busy || event.target.closest('input, textarea, select, button, a')) return;
    event.preventDefault();
    console.log("opendownloads");
    openDownloads();
    return;
  }
  if (event.key !== 'Escape') return;
  if (!$('player').hidden) closePlayer();
  else if (!$('modal').hidden) closeModal();
  else if (!$('downloads').hidden) closeDownloads();
});

// ---------- Boot ----------

try {
  const { username } = await api('/api/me');
  await showBrowse(username);
} catch (err) {
  if (err.status === 401) showLogin();
  else throw err;
}
