import { searchMovies } from './search.js';
import { createPlayer } from './player.js';
import { episodeLabel, nextEpisode, showEpisodes, showResumeTarget } from './episodes.js';

const IMG = 'https://image.tmdb.org/t/p';
const $ = (id) => document.getElementById(id);

const SAVE_INTERVAL_MS = 10_000;

let movies = [];
// showKey → TMDB data of a TV show; its episodes are in `movies`, with kind: 'episode'.
let shows = {};
// movieId → { position, duration, updatedAt }, from the user's account.
let progress = {};
// movieId → date it was last watched to the end.
let watched = {};

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
  [{ movies, shows }, progress, watched] = await Promise.all([api('/api/movies'), api('/api/progress'), api('/api/watched')]);
  renderHome();
  watchConversions();
  showDiskUsage();
  refreshWatching();
}

async function showDiskUsage() {
  try {
    const { usedPercent, available } = await api('/api/disk');
    const freeGb = (available / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
    $('disk-usage').textContent = `Espace utilisé sur /data : ${usedPercent} % · ${freeGb} Go libres`;
    $('disk-usage').hidden = false;
  } catch {
    $('disk-usage').hidden = true;
  }
}

// ---------- Who is watching right now ----------

const WATCHING_POLL_MS = 10_000;
let watchingTimer = null;

async function refreshWatching() {
  clearTimeout(watchingTimer);
  if ($('browse-view').hidden) return; // logged out
  try {
    renderWatching(await api('/api/watching'));
  } catch {
    renderWatching([]);
  }
  watchingTimer = setTimeout(refreshWatching, WATCHING_POLL_MS);
}

/** Updates the list in place, so only people who just started watching animate in. */
function renderWatching(list) {
  const items = list
    .map((entry) => ({ ...entry, movie: movies.find((m) => m.id === entry.movieId) }))
    .filter((entry) => entry.movie)
    .sort((a, b) => a.username.localeCompare(b.username));
  const ul = $('watching-list');
  const existing = new Map([...ul.children].map((li) => [li.dataset.key, li]));
  const keys = new Set();
  for (const entry of items) {
    const key = `${entry.username}:${entry.movieId}`;
    keys.add(key);
    const li = existing.get(key) ?? createWatcher(entry);
    li.dataset.key = key;
    li.querySelector('.watcher__progress span').style.width = progressPercent(entry);
    ul.append(li); // keeps the sort order
  }
  for (const [key, li] of existing) if (!keys.has(key)) li.remove();
  $('watching').hidden = !items.length;
}

function createWatcher({ username, movie }) {
  const show = isEpisode(movie) ? shows[movie.showKey] : null;
  const title = show ? show.title : movie.title;
  const li = document.createElement('li');
  li.className = 'watcher';
  li.innerHTML = `
    <button class="watcher__card" type="button">
      <span class="watcher__poster"><span class="watcher__bars" aria-hidden="true"><i></i><i></i><i></i></span></span>
      <span class="watcher__info">
        <span class="watcher__user"></span>
        <span class="watcher__movie"></span>
        <span class="watcher__progress"><span></span></span>
      </span>
    </button>`;
  const posterPath = show?.posterPath ?? movie.posterPath;
  if (posterPath) li.querySelector('.watcher__poster').style.backgroundImage = `url(${IMG}/w92${posterPath})`;
  li.querySelector('.watcher__user').textContent = username;
  li.querySelector('.watcher__movie').textContent = show ? `${title} · ${episodeLabel(movie)}` : title;
  li.querySelector('.watcher__card').title = `${username} regarde ${title}`;
  li.querySelector('.watcher__card').addEventListener('click', () => {
    const item = show ? libraryShows().find((s) => s.key === movie.showKey) : movie;
    if (item) openModal(item);
  });
  return li;
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
  shows = {};
  progress = {};
  watched = {};
  clearTimeout(conversionsTimer);
  clearTimeout(watchingTimer);
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

const isConverting = (movie) => ['queued', 'converting'].includes(movie.conversion?.status);
const isEpisode = (item) => item.kind === 'episode';
const isShow = (item) => item.kind === 'show';
const films = () => movies.filter((m) => !isEpisode(m));

/** One item per show with episodes on disk; `addedAt` is its latest episode's. */
function libraryShows() {
  return Object.values(shows)
    .map((show) => {
      const episodes = showEpisodes(movies, show.key);
      const addedAt = episodes.reduce((latest, e) => (e.addedAt > latest ? e.addedAt : latest), '');
      return { ...show, kind: 'show', id: `show:${show.key}`, episodes, addedAt };
    })
    .filter((show) => show.episodes.length);
}

const resumeTarget = (show) => showResumeTarget(show.episodes, progress, watched);

/** Progress shown for an item: the movie's, or the one of the show's episode in progress. */
function itemProgress(item) {
  if (!isShow(item)) return progress[item.id];
  const target = resumeTarget(item);
  return target.resume ? progress[target.episode.id] : undefined;
}

function playItem(item) {
  if (!isShow(item)) return playMovie(item);
  // After the last available episode, start the show over.
  playMovie(resumeTarget(item).episode ?? item.episodes[0]);
}

function conversionLabel(conversion) {
  if (conversion.status === 'queued') return 'En attente de conversion';
  if (conversion.status === 'converting') return `Conversion en cours (${conversion.percent} %)`;
  return 'Échec de la conversion';
}

function renderCardConversion(card, movie) {
  const overlay = card.querySelector('.card__conversion');
  const { conversion } = movie;
  overlay.hidden = !conversion;
  card.classList.toggle('card--failed', conversion?.status === 'failed');
  if (!conversion) return;
  overlay.querySelector('.card__conversion-text').textContent = conversionLabel(conversion);
  overlay.querySelector('.progress > span').style.width = `${conversion.percent}%`;
  card.title = `${movie.title} — ${conversionLabel(conversion)}`;
}

function buildCategories() {
  const categories = [];
  const list = films();
  const series = libraryShows();

  // Started movies and shows, most recently watched first.
  const started = [
    ...list.filter((m) => progress[m.id]).map((m) => ({ item: m, date: progress[m.id].updatedAt })),
    ...series
      .map((show) => ({ item: show, target: resumeTarget(show) }))
      .filter(({ target }) => target.episode && target.date)
      .map(({ item, target }) => ({ item, date: target.date })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  if (started.length) categories.push({ name: 'Reprendre la lecture', movies: started.map((s) => s.item) });

  const recent = [...list].sort((a, b) => b.addedAt.localeCompare(a.addedAt)).slice(0, 20);
  if (recent.length) categories.push({ name: 'Ajoutés récemment', movies: recent });

  const topRated = list
    .filter((m) => (m.voteAverage ?? 0) >= 7)
    .sort((a, b) => b.voteAverage - a.voteAverage)
    .slice(0, 20);
  if (topRated.length >= 3) categories.push({ name: 'Les mieux notés', movies: topRated });

  if (series.length) categories.push({ name: 'Séries', movies: series.sort((a, b) => b.addedAt.localeCompare(a.addedAt)) });

  const byGenre = new Map();
  for (const movie of list) {
    for (const genre of movie.genres) {
      if (!byGenre.has(genre)) byGenre.set(genre, []);
      byGenre.get(genre).push(movie);
    }
  }
  const genres = [...byGenre.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], 'fr'));
  for (const [name, items] of genres) {
    categories.push({ name, movies: items.sort((a, b) => (b.voteAverage ?? 0) - (a.voteAverage ?? 0)) });
  }

  const unmatched = list.filter((m) => !m.genres.length);
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
  const entry = itemProgress(movie);
  if (entry) {
    const bar = card.querySelector('.card__progress');
    bar.hidden = false;
    bar.firstElementChild.style.width = progressPercent(entry);
    card.title = `${movie.title} — ${formatRemaining(entry)}`;
  }
  card.dataset.id = movie.id;
  renderCardConversion(card, movie);
  card.addEventListener('click', () => openModal(movie));
  return card;
}

function renderHero() {
  const hero = $('hero');
  hero.replaceChildren();
  const candidates = [...films(), ...libraryShows().filter((s) => s.matched)].filter(
    (m) => m.backdropPath && m.overview && !isConverting(m),
  );
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
  play.textContent = itemProgress(pick) ? '▶ Reprendre' : '▶ Lecture';
  play.addEventListener('click', () => playItem(pick));
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
  rowResizeObserver.disconnect();
  rows.replaceChildren();
  for (const category of buildCategories()) {
    const row = document.createElement('div');
    row.className = 'row';
    const title = document.createElement('h2');
    title.textContent = category.name;
    const track = document.createElement('div');
    track.className = 'row__track';
    track.append(...category.movies.map((m) => createCard(m)));
    const viewport = document.createElement('div');
    viewport.className = 'row__viewport';
    viewport.append(track, rowArrow(track, -1), rowArrow(track, 1));
    row.append(title, viewport);
    rows.append(row);
    watchRowOverflow(track);
  }
}

// Mouse users get no scrollbar, so each row that overflows gets Netflix-style side arrows
// (hidden on touch screens by CSS, where swiping does the job).
function rowArrow(track, direction) {
  const button = document.createElement('button');
  button.className = `row__arrow row__arrow--${direction < 0 ? 'prev' : 'next'}`;
  button.setAttribute('aria-label', direction < 0 ? 'Précédent' : 'Suivant');
  button.tabIndex = -1;
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${direction < 0 ? 'M15.4 4.6 8 12l7.4 7.4 1.4-1.4-6-6 6-6z' : 'M8.6 4.6 16 12l-7.4 7.4-1.4-1.4 6-6-6-6z'}" /></svg>`;
  button.addEventListener('click', () => {
    // A page minus one card, so the last visible card stays as a landmark.
    const card = track.querySelector('.card')?.offsetWidth ?? 0;
    track.scrollBy({ left: direction * Math.max(card, track.clientWidth - card * 1.5), behavior: 'smooth' });
  });
  return button;
}

const rowResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) updateRowArrows(entry.target);
});

function updateRowArrows(track) {
  const viewport = track.parentElement;
  const max = track.scrollWidth - track.clientWidth;
  viewport.classList.toggle('row__viewport--can-prev', track.scrollLeft > 2);
  viewport.classList.toggle('row__viewport--can-next', track.scrollLeft < max - 2);
}

function watchRowOverflow(track) {
  track.addEventListener('scroll', () => updateRowArrows(track), { passive: true });
  rowResizeObserver.observe(track);
}

function renderHome() {
  const isEmpty = movies.length === 0;
  $('empty').hidden = !isEmpty;
  $('empty').textContent = 'Aucun film pour le moment. Ajoutez des fichiers dans MOVIES_PATH : ils apparaîtront ici après le scan.';
  $('search-results').hidden = true;
  $('add-movie-btn').hidden = true;
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
  const results = searchMovies([...films(), ...libraryShows()], query);
  $('hero').hidden = true;
  $('rows').hidden = true;
  $('empty').hidden = true;
  $('search-results').hidden = false;
  $('search-title').textContent = results.length
    ? `Résultats pour « ${query.trim()} »`
    : `Aucun résultat pour « ${query.trim()} »`;
  $('search-grid').replaceChildren(...results.map((m) => createCard(m)));
  $('add-movie-btn').hidden = false;
}

$('add-movie-btn').addEventListener('click', () => openAddMovie($('search-input').value.trim()));

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
// Season shown in the show modal.
let modalSeason = null;

function openModal(item) {
  if (isShow(item)) openShowModal(item);
  else openMovieModal(item);
  $('modal').hidden = false;
  document.body.classList.add('no-scroll');
}

function renderCredits(entries) {
  const credits = $('modal-credits');
  credits.replaceChildren();
  for (const [label, value] of entries) {
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    credits.append(dt, dd);
  }
}

function renderModalProgress(entry) {
  $('modal-progress').hidden = !entry;
  if (!entry) return;
  $('modal-progress-bar').style.width = progressPercent(entry);
  $('modal-remaining').textContent = formatRemaining(entry);
}

function openMovieModal(movie) {
  modalMovie = movie;
  $('modal-episodes').hidden = true;
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
  renderModalProgress(entry);
  renderModalConversion();

  renderCredits([
    ['Réalisation', movie.director],
    ['Distribution', movie.cast.join(', ')],
    ['Titre original', movie.originalTitle !== movie.title && movie.originalTitle],
    ['Fichier', movie.file],
  ]);
}

function openShowModal(show) {
  modalMovie = show;
  $('modal-hero').style.backgroundImage = show.backdropPath ? `url(${IMG}/w1280${show.backdropPath})` : '';
  $('modal-title').textContent = show.title;
  const seasons = [...new Set(show.episodes.map((e) => e.season))];
  $('modal-meta').textContent = [
    show.voteAverage ? `★ ${show.voteAverage.toFixed(1)}` : '',
    show.firstAirYear ? String(show.firstAirYear) : '',
    seasons.length > 1 ? `${seasons.length} saisons` : '1 saison',
    show.genres.join(', '),
  ]
    .filter(Boolean)
    .join(' · ');
  $('modal-tagline').textContent = '';
  $('modal-overview').textContent = show.overview || 'Aucun résumé disponible.';
  renderCredits([['Titre original', show.originalTitle !== show.title && show.originalTitle]]);

  $('modal-season').replaceChildren(...seasons.map((n) => new Option(`Saison ${n}`, String(n))));
  $('modal-episodes').hidden = false;
  renderShowModal();
  renderEpisodes((resumeTarget(show).episode ?? show.episodes[0]).season);
}

/** Play button and progress of the show modal: the episode "Lecture" would play. */
function renderShowModal() {
  const show = modalMovie;
  const target = resumeTarget(show);
  const episode = target.episode ?? show.episodes[0];
  const entry = target.resume ? progress[episode.id] : null;
  $('modal-play').textContent = `${entry ? '▶ Reprendre' : '▶ Lecture'} ${episodeLabel(episode)}`;
  $('modal-play').disabled = isConverting(episode);
  $('modal-restart').hidden = true;
  $('modal-conversion').hidden = true;
  renderModalProgress(entry);
}

function renderEpisodes(season) {
  modalSeason = season;
  $('modal-season').value = String(season);
  const episodes = modalMovie.episodes.filter((e) => e.season === season);
  $('modal-episode-list').replaceChildren(...episodes.map(createEpisodeRow));
}

function createEpisodeRow(episode) {
  const row = $('episode-template').content.firstElementChild.cloneNode(true);
  const button = row.querySelector('.episode');
  row.querySelector('.episode__number').textContent = episodeLabel(episode).split('É')[1];
  row.querySelector('.episode__title').textContent = episode.title;
  row.querySelector('.episode__runtime').textContent = formatRuntime(episode.runtime);
  row.querySelector('.episode__overview').textContent = episode.overview;

  const img = row.querySelector('img');
  if (episode.stillPath) {
    img.src = `${IMG}/w300${episode.stillPath}`;
    img.addEventListener('error', () => img.remove());
  } else {
    img.remove();
  }

  const entry = progress[episode.id];
  const bar = row.querySelector('.episode__progress');
  bar.hidden = !entry;
  if (entry) bar.firstElementChild.style.width = progressPercent(entry);

  const conversion = row.querySelector('.episode__conversion');
  conversion.hidden = !episode.conversion;
  if (episode.conversion) {
    conversion.textContent = episode.conversion.status === 'failed' && episode.conversion.error
      ? `${conversionLabel(episode.conversion)} : ${episode.conversion.error}`
      : conversionLabel(episode.conversion);
  }
  row.classList.toggle('episode--failed', episode.conversion?.status === 'failed');
  button.disabled = isConverting(episode);
  button.addEventListener('click', () => {
    closeModal();
    playMovie(episode);
  });
  return row;
}

$('modal-season').addEventListener('change', (event) => renderEpisodes(Number(event.target.value)));

function renderModalConversion() {
  const movie = modalMovie;
  const busy = isConverting(movie);
  const label = $('modal-conversion');
  $('modal-play').disabled = busy;
  $('modal-restart').disabled = busy;
  label.hidden = !movie.conversion;
  label.classList.toggle('modal__conversion--failed', movie.conversion?.status === 'failed');
  if (movie.conversion) {
    label.textContent = movie.conversion.status === 'failed' && movie.conversion.error
      ? `${conversionLabel(movie.conversion)} : ${movie.conversion.error}`
      : conversionLabel(movie.conversion);
  }
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
  playItem(modalMovie);
});
$('modal-restart').addEventListener('click', () => {
  closeModal();
  playMovie(modalMovie, { restart: true });
});

// ---------- Conversions ----------

// Fast while something converts; slow otherwise, to notice conversions queued after the page loaded.
const CONVERSIONS_POLL_MS = 3000;
const CONVERSIONS_IDLE_POLL_MS = 30_000;
let conversionsTimer = null;

function watchConversions() {
  clearTimeout(conversionsTimer);
  if ($('browse-view').hidden) return; // logged out
  const delay = movies.some(isConverting) ? CONVERSIONS_POLL_MS : CONVERSIONS_IDLE_POLL_MS;
  conversionsTimer = setTimeout(refreshConversions, delay);
}

async function refreshConversions() {
  try {
    const statuses = await api('/api/conversions');
    let finished = false;
    for (const movie of movies) {
      const next = statuses[movie.id];
      if (movie.conversion && !next) finished = true;
      if (next) movie.conversion = next;
      else delete movie.conversion;
    }
    if (finished) {
      // Converted movies now point to a new file: reload the catalogue.
      ({ movies, shows } = await api('/api/movies'));
      if ($('search-input').value.trim()) renderSearch($('search-input').value);
      else renderRows();
    } else {
      for (const card of document.querySelectorAll('.card[data-id]')) {
        const movie = movies.find((m) => m.id === card.dataset.id);
        if (movie) renderCardConversion(card, movie);
      }
    }
    if (!$('modal').hidden && modalMovie) {
      if (isShow(modalMovie)) {
        modalMovie = libraryShows().find((s) => s.id === modalMovie.id) ?? modalMovie;
        renderShowModal();
        renderEpisodes(modalSeason);
      } else {
        modalMovie = movies.find((m) => m.id === modalMovie.id) ?? modalMovie;
        renderModalConversion();
      }
    }
  } catch {
    // Network hiccup: try again on the next tick.
  }
  watchConversions();
}

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

// ---------- Add a movie, or a whole season of a series, by its exact name ----------

// Movies found by the server, waiting for the user to pick one: [{ token, movieName, imgUrl, size }].
let addMovieChoices = null;
// The picked movie, or the found season ({ token, movieName, imgUrl, season }), waiting for the user to confirm.
let addMovieFound = null;
// Bumped on every request and on close, so a late answer doesn't land in a closed or reset modal.
let addMovieRequest = 0;

// `slow` adds a discreet line telling that the answer can take a while.
function setAddMovieStatus(text, { error = false, slow = false } = {}) {
  const status = $('add-movie-status');
  status.hidden = !text;
  status.textContent = text;
  status.classList.toggle('add-movie__status--error', error);
  if (slow) {
    const hint = document.createElement('span');
    hint.className = 'add-movie__hint-slow';
    hint.textContent = 'Pour une série, cela peut prendre un peu plus de temps.';
    status.append(hint);
  }
}

const addingSerie = () => $('add-movie-form').kind.value === 'serie';

function applyAddMovieKind() {
  const serie = addingSerie();
  $('add-movie-title').textContent = serie ? 'Ajouter une série' : 'Ajouter un film';
  $('add-movie-hint').textContent = serie ? 'Tapez le nom exact de la série et la saison voulue.' : 'Tapez le nom exact du film.';
  $('add-movie-name').placeholder = serie ? 'Nom exact de la série' : 'Nom exact du film';
  $('add-movie-season').hidden = !serie;
  $('add-movie-season').disabled = !serie;
  $('add-movie-season-note').hidden = !serie;
}

$('add-movie-form').addEventListener('change', (event) => {
  if (event.target.name !== 'kind') return;
  applyAddMovieKind();
  setAddMovieStatus('');
  $('add-movie-name').focus();
});

function showAddMovieForm() {
  addMovieRequest++;
  addMovieChoices = null;
  addMovieFound = null;
  $('add-movie-form').hidden = false;
  $('add-movie-choices').hidden = true;
  $('add-movie-found').hidden = true;
  $('add-movie-send').disabled = false;
  setAddMovieStatus('');
  $('add-movie-name').focus();
}

function renderAddMovieChoice(movie) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'add-movie__choice';
  const poster = document.createElement('img');
  poster.className = 'add-movie__poster';
  poster.alt = `Affiche de ${movie.movieName}`;
  if (movie.imgUrl) poster.src = movie.imgUrl;
  const name = document.createElement('span');
  name.className = 'add-movie__choice-name';
  name.textContent = movie.movieName;
  button.append(poster, name);
  if (movie.size) {
    const size = document.createElement('span');
    size.className = 'add-movie__choice-size';
    size.textContent = movie.size;
    button.append(size);
  }
  button.addEventListener('click', () => showAddMovieConfirm(movie));
  li.append(button);
  return li;
}

function showAddMovieChoices() {
  addMovieFound = null;
  $('add-movie-list').replaceChildren(...addMovieChoices.map(renderAddMovieChoice));
  $('add-movie-form').hidden = true;
  $('add-movie-found').hidden = true;
  $('add-movie-choices').hidden = false;
  setAddMovieStatus('');
  $('add-movie-list').querySelector('button')?.focus();
}

function showAddMovieConfirm(movie) {
  addMovieFound = movie;
  $('add-movie-found-name').textContent = movie.movieName;
  $('add-movie-found-size').textContent = movie.size ? `Taille : ${movie.size}` : '';
  $('add-movie-poster').hidden = !movie.imgUrl;
  $('add-movie-poster').src = movie.imgUrl ?? '';
  $('add-movie-poster').alt = `Affiche de ${movie.movieName}`;
  $('add-movie-question').textContent = movie.season != null ? `Télécharger toute la saison ${movie.season} (tous ses épisodes) ?` : 'Télécharger ce film ?';
  $('add-movie-form').hidden = true;
  $('add-movie-choices').hidden = true;
  $('add-movie-found').hidden = false;
  $('add-movie-confirm').disabled = false;
  $('add-movie-back').disabled = false;
  setAddMovieStatus('');
  $('add-movie-confirm').focus();
}

function openAddMovie(name = '') {
  $('add-movie-name').value = name;
  $('add-movie-form').kind.value = 'movie';
  $('add-movie-season').value = '1';
  applyAddMovieKind();
  $('add-movie').hidden = false;
  document.body.classList.add('no-scroll');
  showAddMovieForm();
}

function closeAddMovie() {
  addMovieRequest++;
  addMovieChoices = null;
  addMovieFound = null;
  $('add-movie').hidden = true;
  document.body.classList.remove('no-scroll');
}

$('add-movie-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('add-movie-name').value.trim();
  if (!name) return;
  const request = ++addMovieRequest;
  $('add-movie-send').disabled = true;
  if (addingSerie()) {
    const season = Number($('add-movie-season').value);
    setAddMovieStatus('Recherche de la série…', { slow: true });
    try {
      const found = await api('/api/add-serie', { method: 'POST', body: JSON.stringify({ name, season }) });
      if (request !== addMovieRequest) return;
      addMovieChoices = null;
      showAddMovieConfirm({ token: found.token, movieName: found.serieName, imgUrl: found.imgUrl, season: found.season });
    } catch (err) {
      if (request !== addMovieRequest) return;
      $('add-movie-send').disabled = false;
      setAddMovieStatus(err.message, { error: true });
      $('add-movie-name').focus();
    }
    return;
  }
  setAddMovieStatus('Recherche du film…');
  try {
    const { movies } = await api('/api/add-movie', { method: 'POST', body: JSON.stringify({ name }) });
    if (request !== addMovieRequest) return;
    addMovieChoices = movies;
    showAddMovieChoices();
  } catch (err) {
    if (request !== addMovieRequest) return;
    $('add-movie-send').disabled = false;
    setAddMovieStatus(err.message, { error: true });
    $('add-movie-name').focus();
  }
});

$('add-movie-choices-back').addEventListener('click', showAddMovieForm);

// Back to the list, unless the server already forgot this search (after a failed confirmation).
$('add-movie-back').addEventListener('click', () => (addMovieChoices ? showAddMovieChoices() : showAddMovieForm()));

$('add-movie-confirm').addEventListener('click', async () => {
  if (!addMovieFound) return;
  const request = ++addMovieRequest;
  $('add-movie-confirm').disabled = true;
  $('add-movie-back').disabled = true;
  const serie = addMovieFound.season != null;
  if (serie) setAddMovieStatus('Récupération des épisodes de la saison…', { slow: true });
  else setAddMovieStatus('Préparation du téléchargement…');
  try {
    const result = await api(`/api/${serie ? 'add-serie' : 'add-movie'}/${addMovieFound.token}/download`, { method: 'POST' });
    if (request !== addMovieRequest) return;
    if (serie && result.failed.length) {
      // Some episodes couldn't start: say which before moving on, the others are already downloading.
      addMovieChoices = null;
      $('add-movie-back').disabled = false;
      const names = result.failed.map((f) => f.filename).join(', ');
      setAddMovieStatus(
        `${result.started.length} épisode(s) en téléchargement, ${result.failed.length} non lancé(s) (${result.failed[0].error}) : ${names}`,
        { error: true },
      );
      return;
    }
    // From here on it's a regular download: follow it in the downloads modal.
    closeAddMovie();
    openDownloads();
  } catch (err) {
    if (request !== addMovieRequest) return;
    // The server forgets the whole search once a movie is confirmed, so a retry starts over from the name.
    addMovieChoices = null;
    $('add-movie-back').disabled = false;
    setAddMovieStatus(err.message, { error: true });
  }
});

$('add-movie').addEventListener('click', (event) => {
  if (event.target.closest('[data-close]')) closeAddMovie();
});

// ---------- Player ----------

const player = createPlayer({ onBack: () => closePlayer() });
const { video } = player;
let playing = null;
// Episode offered by the "Épisode suivant" countdown, and played when this one ends.
let playingNext = null;
let saveTimer = null;

/** Persist the current position in the user's account. */
function saveProgress({ keepalive = false, finished = false } = {}) {
  if (!playing || !video.duration || !Number.isFinite(video.duration) || video.currentTime < 1) return Promise.resolve();
  const movie = playing;
  // `finished` (moving on to the next episode) records it as watched even before the credits end.
  const position = finished ? video.duration : video.currentTime;
  const body = JSON.stringify({ position, duration: video.duration });
  // keepalive lets the request finish when the tab is being closed.
  return fetch(`/api/progress/${movie.id}`, { method: 'PUT', body, keepalive, headers: { 'content-type': 'application/json' } })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data) return;
      if (data.progress) progress[movie.id] = data.progress;
      else delete progress[movie.id];
      if (data.watched) watched[movie.id] = data.watched;
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
  if (isConverting(movie)) return;
  playing = movie;
  let startAt = 0;
  if (restart) {
    delete progress[movie.id];
    api(`/api/progress/${movie.id}`, { method: 'DELETE' }).catch(() => {});
  } else if (progress[movie.id]) {
    startAt = progress[movie.id].position;
  }
  const next = isEpisode(movie) ? nextEpisode(showEpisodes(movies, movie.showKey), movie) : null;
  playingNext = next;
  document.body.classList.add('no-scroll');
  player.open(movie, {
    startAt,
    title: isEpisode(movie) ? `${shows[movie.showKey]?.title ?? ''} · ${episodeLabel(movie)} · ${movie.title}` : movie.title,
    next: next && { label: `${episodeLabel(next)} · ${next.title}`, onPlay: () => playNext(next) },
  });
}

/** Leave the current episode as watched and start the next one from the beginning. */
function playNext(next) {
  stopAutoSave();
  saveProgress({ finished: true });
  playMovie(next, { restart: true });
}

function closePlayer() {
  if (!playing) return;
  stopAutoSave();
  const saved = saveProgress();
  playing = null;
  playingNext = null;
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
  // Straight to the next episode, otherwise back to the catalogue, like Netflix. Either way the
  // last save lands at the very end, so the server records it as watched and clears its progress.
  if (playingNext) playNext(playingNext);
  else closePlayer();
});
window.addEventListener('pagehide', () => saveProgress({ keepalive: true }));

document.addEventListener('keydown', (event) => {
  if (player.handleKey(event)) return;
  if (event.key === 'Enter') {
    // Enter anywhere on the catalogue (but not while typing or on a focused button) opens downloads.
    const busy = !$('player').hidden || !$('modal').hidden || !$('downloads').hidden || !$('add-movie').hidden || $('browse-view').hidden;
    if (busy || event.target.closest('input, textarea, select, button, a')) return;
    event.preventDefault();
    openDownloads();
    return;
  }
  if (event.key !== 'Escape') return;
  if (!$('player').hidden) closePlayer();
  else if (!$('modal').hidden) closeModal();
  else if (!$('downloads').hidden) closeDownloads();
  else if (!$('add-movie').hidden) closeAddMovie();
});

// ---------- Boot ----------

try {
  const { username } = await api('/api/me');
  await showBrowse(username);
} catch (err) {
  if (err.status === 401) showLogin();
  else throw err;
}
