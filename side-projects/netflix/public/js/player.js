// Netflix-style controls on top of a bare <video>: auto-hiding chrome, scrubber, volume,
// casting, fullscreen, keyboard shortcuts and subtitles rendered by hand (so they can be styled
// and move up when the controls are visible).

const $ = (id) => document.getElementById(id);

const IDLE_MS = 3000;
const PAUSED_INFO_MS = 6000;
const SEEK_STEP = 10;
const SUBS_PREF_KEY = 'cineflix.subtitles';
const VOLUME_PREF_KEY = 'cineflix.volume';
// "Épisode suivant" shows up at 90% of the episode; the next one starts at 99%.
const NEXT_SHOW_AT = 0.9;
const NEXT_PLAY_AT = 0.99;
const CAST_RETRY_MS = 30_000;

/**
 * Progress of the "Épisode suivant" countdown: null before 90% of the video, then from 0 (at 90%)
 * to 1 (at 99%, when the next episode starts).
 */
export function nextCountdown(position, duration) {
  if (!Number.isFinite(duration) || !duration) return null;
  const ratio = position / duration;
  if (ratio < NEXT_SHOW_AT) return null;
  return Math.min(1, (ratio - NEXT_SHOW_AT) / (NEXT_PLAY_AT - NEXT_SHOW_AT));
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function setIcon(button, name) {
  button.querySelector('use').setAttribute('href', `#i-${name}`);
}

export function createPlayer({ onBack }) {
  const root = $('player');
  const video = $('video');
  const subsLayer = $('player-subs');
  const scrubber = $('scrubber');
  const playBtn = $('pbtn-play');
  const muteBtn = $('pbtn-mute');
  const fullscreenBtn = $('pbtn-fullscreen');
  const volume = $('volume');

  let movie = null;
  let idleTimer = null;
  let pausedInfoTimer = null;
  let toastTimer = null;
  let scrubbing = false;
  let activeTrack = null;
  // Bumped on every open/close so late subtitle-list responses for a previous movie are ignored.
  let session = 0;
  // { label, onPlay } of the episode offered at the end of this one.
  let next = null;
  // Where to start once the current source has loaded its metadata (resume point, or position before a source switch).
  let resumeAt = 0;

  // ---------- Chrome visibility ----------

  const openMenus = () => root.querySelectorAll('.popover:not([hidden]):not(.popover--volume)');

  function showChrome() {
    root.classList.add('player--active');
    root.classList.remove('player--show-info');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(hideChrome, IDLE_MS);
  }

  // Last pointer used: a finger leaves :hover stuck on whatever it tapped, so only a mouse counts.
  let usingMouse = true;

  function hideChrome() {
    const hovered = usingMouse && root.querySelector('.player__bottom:hover');
    if (video.paused || scrubbing || openMenus().length || hovered) {
      idleTimer = setTimeout(hideChrome, IDLE_MS);
      return;
    }
    root.classList.remove('player--active');
  }

  root.addEventListener('pointerdown', (event) => {
    usingMouse = event.pointerType === 'mouse';
  });
  root.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') showChrome();
  });
  // Touch pointers "leave" at the end of every tap, so only a mouse leaving hides the controls.
  root.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && !video.paused) root.classList.remove('player--active');
  });

  // Mouse: clicking the picture toggles play. Touch: a tap anywhere outside the controls shows or
  // hides them, and a double-tap on the left/right third seeks, like the Netflix apps.
  let lastTap = 0;
  let closedMenuOnPress = false;
  const INTERACTIVE = 'button, input, .scrubber, .popover';
  root.addEventListener('pointerup', (event) => {
    if (closedMenuOnPress || event.target.closest(INTERACTIVE) || !$('player-error').hidden) return;
    if (event.pointerType === 'mouse') {
      if (event.target !== video || event.button !== 0) return;
      togglePlay();
      flash(video.paused ? 'pause' : 'play');
      return;
    }
    const now = Date.now();
    const third = event.clientX / root.clientWidth;
    if (now - lastTap < 300 && (third < 1 / 3 || third > 2 / 3)) {
      seekBy(third < 1 / 3 ? -SEEK_STEP : SEEK_STEP);
      lastTap = 0;
      return;
    }
    lastTap = now;
    if (root.classList.contains('player--active') && !video.paused) {
      clearTimeout(idleTimer);
      root.classList.remove('player--active');
    } else {
      showChrome();
    }
  });
  video.addEventListener('dblclick', (event) => {
    event.preventDefault();
    if (usingMouse) toggleFullscreen();
  });

  // ---------- Feedback ----------

  function flash(icon) {
    const el = $('player-flash');
    setIcon(el, icon);
    el.classList.remove('player__flash--on');
    void el.offsetWidth; // restart the animation
    el.classList.add('player__flash--on');
  }

  function toast(text) {
    const el = $('player-toast');
    el.textContent = text;
    el.classList.add('player__toast--on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('player__toast--on'), 1500);
  }

  // ---------- Playback ----------

  video.addEventListener('loadedmetadata', () => {
    if (resumeAt) video.currentTime = resumeAt;
    resumeAt = 0;
  });

  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function seekTo(time) {
    if (!Number.isFinite(video.duration)) return;
    video.currentTime = Math.max(0, Math.min(video.duration - 0.5, time));
    renderTime();
  }

  function seekBy(delta) {
    seekTo(video.currentTime + delta);
    flash(delta < 0 ? 'rewind' : 'forward');
    showChrome();
  }

  const playBtns = [playBtn, $('pbtn-play-center')];
  for (const button of playBtns) button.addEventListener('click', togglePlay);
  for (const button of root.querySelectorAll('[data-seek]')) {
    button.addEventListener('click', () => seekBy(Number(button.dataset.seek)));
  }

  function renderPlayState(playing) {
    for (const button of playBtns) {
      setIcon(button, playing ? 'pause' : 'play');
      button.setAttribute('aria-label', playing ? 'Pause' : 'Lecture');
    }
  }

  video.addEventListener('play', () => {
    renderPlayState(true);
    root.classList.remove('player--paused', 'player--show-info');
    clearTimeout(pausedInfoTimer);
    showChrome();
  });
  video.addEventListener('pause', () => {
    if (!movie) return;
    renderPlayState(false);
    root.classList.add('player--paused', 'player--active');
    clearTimeout(pausedInfoTimer);
    // Left paused for a while: dim the picture and remind what is playing.
    pausedInfoTimer = setTimeout(() => {
      if (video.paused && !scrubbing && !openMenus().length) root.classList.add('player--show-info');
    }, PAUSED_INFO_MS);
  });

  const setLoading = (on) => {
    $('player-spinner').hidden = !on;
  };
  video.addEventListener('waiting', () => setLoading(true));
  video.addEventListener('seeking', () => setLoading(true));
  for (const name of ['playing', 'seeked', 'canplay', 'pause']) video.addEventListener(name, () => setLoading(false));

  video.addEventListener('error', () => {
    if (!movie) return;
    setLoading(false);
    $('player-error').hidden = false;
    root.classList.add('player--active');
  });

  // ---------- Scrubber ----------

  function renderTime() {
    const duration = video.duration;
    if (!Number.isFinite(duration) || !duration) return;
    const ratio = video.currentTime / duration;
    if (!scrubbing) {
      $('scrubber-played').style.width = `${ratio * 100}%`;
      $('scrubber-thumb').style.left = `${ratio * 100}%`;
    }
    $('player-remaining').textContent = formatTime(duration - video.currentTime);
    scrubber.setAttribute('aria-valuemax', Math.round(duration));
    scrubber.setAttribute('aria-valuenow', Math.round(video.currentTime));
    scrubber.setAttribute('aria-valuetext', `${formatTime(video.currentTime)} sur ${formatTime(duration)}`);
  }

  function renderBuffered() {
    const { buffered, currentTime, duration } = video;
    if (!duration) return;
    // The buffered range around the playhead is the one worth showing.
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime + 1 && buffered.end(i) >= currentTime) {
        $('scrubber-buffered').style.width = `${(buffered.end(i) / duration) * 100}%`;
        return;
      }
    }
  }

  video.addEventListener('timeupdate', renderTime);
  video.addEventListener('durationchange', renderTime);
  video.addEventListener('progress', renderBuffered);

  function ratioAt(event) {
    const rect = scrubber.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  function previewAt(ratio) {
    const tooltip = $('scrubber-tooltip');
    tooltip.textContent = formatTime(ratio * (video.duration || 0));
    tooltip.style.left = `${ratio * 100}%`;
  }

  scrubber.addEventListener('pointermove', (event) => {
    const ratio = ratioAt(event);
    previewAt(ratio);
    if (scrubbing) {
      $('scrubber-played').style.width = `${ratio * 100}%`;
      $('scrubber-thumb').style.left = `${ratio * 100}%`;
    }
  });
  scrubber.addEventListener('pointerdown', (event) => {
    if (!Number.isFinite(video.duration)) return;
    scrubbing = true;
    scrubber.setPointerCapture(event.pointerId);
    root.classList.add('player--scrubbing');
    const ratio = ratioAt(event);
    previewAt(ratio);
    $('scrubber-played').style.width = `${ratio * 100}%`;
    $('scrubber-thumb').style.left = `${ratio * 100}%`;
  });
  const endScrub = (event) => {
    if (!scrubbing) return;
    scrubbing = false;
    root.classList.remove('player--scrubbing');
    seekTo(ratioAt(event) * video.duration);
    showChrome();
  };
  scrubber.addEventListener('pointerup', endScrub);
  scrubber.addEventListener('pointercancel', () => {
    scrubbing = false;
    root.classList.remove('player--scrubbing');
    renderTime();
  });

  // ---------- Volume ----------

  function renderVolume() {
    const level = video.muted ? 0 : video.volume;
    setIcon(muteBtn, level === 0 ? 'volume-off' : level < 0.5 ? 'volume-low' : 'volume-high');
    muteBtn.setAttribute('aria-label', level === 0 ? 'Rétablir le son' : 'Couper le son');
    volume.value = level;
    volume.style.setProperty('--level', `${level * 100}%`);
  }

  function setVolume(level) {
    video.volume = Math.max(0, Math.min(1, level));
    video.muted = video.volume === 0;
    localStorage.setItem(VOLUME_PREF_KEY, String(video.volume));
  }

  muteBtn.addEventListener('click', () => {
    if (video.muted && video.volume === 0) setVolume(0.5);
    else video.muted = !video.muted;
  });
  volume.addEventListener('input', () => setVolume(Number(volume.value)));
  video.addEventListener('volumechange', renderVolume);

  const savedVolume = Number(localStorage.getItem(VOLUME_PREF_KEY));
  if (localStorage.getItem(VOLUME_PREF_KEY) !== null && Number.isFinite(savedVolume)) video.volume = savedVolume;
  renderVolume();

  // ---------- Menus (audio & subtitles) ----------

  function closeMenus() {
    for (const menu of openMenus()) {
      menu.hidden = true;
      menu.previousElementSibling.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleMenu(button, menu) {
    const open = menu.hidden;
    closeMenus();
    menu.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) menu.querySelector('[aria-checked="true"]')?.focus();
    showChrome();
  }

  $('pbtn-subs').addEventListener('click', () => {
    renderAudioMenu();
    toggleMenu($('pbtn-subs'), $('subs-menu'));
  });
  document.addEventListener('pointerdown', (event) => {
    closedMenuOnPress = false;
    if (event.target.closest('.popover-anchor') || !openMenus().length) return;
    // A click outside an open menu only closes it.
    closedMenuOnPress = true;
    closeMenus();
  });

  function menuItem(label, checked, onSelect) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitemradio');
    button.setAttribute('aria-checked', String(checked));
    button.innerHTML = '<svg aria-hidden="true"><use href="#i-check" /></svg>';
    button.append(label);
    button.addEventListener('click', onSelect);
    li.append(button);
    return li;
  }

  // Only Safari exposes the audio tracks of a file; other browsers play the default one.
  function renderAudioMenu() {
    const tracks = video.audioTracks;
    const col = $('audio-col');
    col.hidden = !tracks || tracks.length < 2;
    if (col.hidden) return;
    const items = [];
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const label = track.label || (track.language ? new Intl.DisplayNames('fr', { type: 'language' }).of(track.language) : `Piste ${i + 1}`);
      items.push(
        menuItem(label, track.enabled, () => {
          for (let j = 0; j < tracks.length; j++) tracks[j].enabled = j === i;
          renderAudioMenu();
        }),
      );
    }
    $('audio-list').replaceChildren(...items);
  }

  // ---------- Cast ----------

  // Chrome casts through the Remote Playback API (Google Cast), Safari through AirPlay. The button
  // only shows up when the browser supports one of them and a screen is reachable. The receiver
  // fetches the video itself, without our cookie: clicking the button asks the server for a stream
  // URL that carries a cast link for this movie, and the video switches to it before the picker opens.
  const castBtn = $('pbtn-cast');
  const airPlay = Boolean(window.WebKitPlaybackTargetAvailabilityEvent);
  const googleCast = !airPlay && Boolean(video.remote);
  // { movieId, url, at } of the cast link the video currently plays from.
  let castSource = null;

  const isCasting = () =>
    airPlay ? Boolean(video.webkitCurrentPlaybackTargetIsWireless) : googleCast && video.remote.state !== 'disconnected';

  function renderCast() {
    const connected = isCasting();
    setIcon(castBtn, connected ? 'cast-connected' : 'cast');
    castBtn.setAttribute('aria-label', connected ? 'Diffusion en cours sur un autre écran' : 'Caster sur un autre écran');
    castBtn.title = castBtn.getAttribute('aria-label');
    castBtn.setAttribute('aria-pressed', String(connected));
  }

  /** Asks the server for a new cast link and plays from it, at the same position. */
  async function useCastSource() {
    const movieId = movie.id;
    const current = session;
    const res = await fetch(`/api/movies/${encodeURIComponent(movieId)}/cast`, { method: 'POST' });
    if (!res.ok) throw new Error('cast link refused');
    const { url } = await res.json();
    if (current !== session) return false; // another movie was opened meanwhile
    castSource = { movieId, url, at: Date.now() };
    if (video.readyState >= 1) resumeAt = video.currentTime;
    const playing = !video.paused;
    video.src = url;
    if (playing) video.play().catch(() => {});
    return true;
  }

  // Safari only opens the AirPlay picker during a click; if the request took too long, the link is
  // ready and the next click opens the picker straight away.
  const stillInClick = () => navigator.userActivation?.isActive ?? true;
  const askToClickAgain = () => toast('Appuyez à nouveau sur l’icône pour choisir l’écran');

  async function onCastClick() {
    if (isCasting()) {
      // Already on a screen: the picker lets the user stop or switch screens with the same link.
      if (airPlay) video.webkitShowPlaybackTargetPicker();
      else video.remote.prompt().catch(() => {});
      return;
    }
    // A fresh link per click; the one just made is only reused for the "click again" case.
    const ready = castSource?.movieId === movie.id && Date.now() - castSource.at < CAST_RETRY_MS;
    if (!ready) {
      try {
        if (!(await useCastSource())) return;
      } catch {
        toast('Impossible de préparer la diffusion');
        return;
      }
      if (!stillInClick()) return askToClickAgain();
    }
    if (airPlay) {
      video.webkitShowPlaybackTargetPicker();
      return;
    }
    video.remote.prompt().catch((error) => {
      if (error.name === 'NotAllowedError' || error.name === 'InvalidAccessError') askToClickAgain();
      else if (error.name !== 'AbortError') toast('Aucun écran disponible pour la diffusion');
    });
  }

  if (airPlay) {
    video.addEventListener('webkitplaybacktargetavailabilitychanged', (event) => {
      castBtn.hidden = event.availability !== 'available';
    });
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', renderCast);
  } else if (googleCast) {
    video.remote
      .watchAvailability((available) => {
        castBtn.hidden = !available;
      })
      // Watching can be refused (e.g. power saving): still offer the button, the picker says if no screen is found.
      .catch(() => {
        castBtn.hidden = false;
      });
    for (const name of ['connecting', 'connect', 'disconnect']) video.remote.addEventListener(name, renderCast);
  }
  if (airPlay || googleCast) castBtn.addEventListener('click', onCastClick);
  renderCast();

  // ---------- Subtitles ----------

  function trackPreference() {
    return localStorage.getItem(SUBS_PREF_KEY) || 'off';
  }

  function renderCues() {
    const cues = activeTrack?.activeCues;
    if (!cues?.length) {
      subsLayer.replaceChildren();
      return;
    }
    const lines = [];
    for (const cue of cues) {
      const line = document.createElement('span');
      line.className = 'player__cue';
      // getCueAsHTML only builds the safe WebVTT subset (b, i, u, ruby…), never raw HTML.
      line.append(cue.getCueAsHTML());
      lines.push(line);
    }
    subsLayer.replaceChildren(...lines);
  }

  function selectSubtitles(trackEl, { remember = true } = {}) {
    for (const el of video.querySelectorAll('track')) {
      el.track.removeEventListener('cuechange', renderCues);
      if (el !== trackEl) el.track.mode = 'disabled';
    }
    activeTrack = trackEl?.track ?? null;
    if (activeTrack) {
      // "hidden" loads the cues and fires cuechange without the browser drawing them.
      activeTrack.mode = 'hidden';
      activeTrack.addEventListener('cuechange', renderCues);
    }
    renderCues();
    if (remember) localStorage.setItem(SUBS_PREF_KEY, trackEl ? trackEl.srclang || trackEl.label : 'off');
    renderSubsMenu();
  }

  function renderSubsMenu() {
    const tracks = [...video.querySelectorAll('track')];
    const items = [menuItem('Désactivés', !activeTrack, () => selectSubtitles(null))];
    for (const el of tracks) {
      items.push(menuItem(el.label, el.track === activeTrack, () => selectSubtitles(el)));
    }
    $('subs-list').replaceChildren(...items);
  }

  async function loadSubtitles(movieId, current) {
    let list = [];
    try {
      const res = await fetch(`/api/movies/${movieId}/subtitles`);
      if (res.ok) list = await res.json();
    } catch {}
    if (current !== session) return;
    for (const sub of list) {
      const el = document.createElement('track');
      el.kind = 'subtitles';
      el.label = sub.label;
      if (sub.lang) el.srclang = sub.lang;
      el.src = `/api/movies/${movieId}/subtitles/${sub.id}`;
      el.dataset.forced = String(sub.forced);
      el.addEventListener('error', () => {
        if (el.track === activeTrack) toast(`Impossible de charger les sous-titres « ${sub.label} »`);
      });
      video.append(el);
    }
    const pref = trackPreference();
    const tracks = [...video.querySelectorAll('track')];
    const preferred =
      pref === 'off'
        ? null
        : tracks.find((t) => (t.srclang || t.label) === pref && t.dataset.forced !== 'true') ??
          tracks.find((t) => (t.srclang || t.label) === pref);
    selectSubtitles(preferred ?? null, { remember: false });
  }

  // ---------- Fullscreen ----------

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else video.webkitEnterFullscreen?.(); // iPhone: only the <video> itself can go fullscreen
  }

  fullscreenBtn.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement === root;
    setIcon(fullscreenBtn, on ? 'fullscreen-exit' : 'fullscreen');
    fullscreenBtn.setAttribute('aria-label', on ? 'Quitter le plein écran' : 'Plein écran');
  });

  for (const button of root.querySelectorAll('[data-player-back]')) button.addEventListener('click', onBack);

  // ---------- Next episode ----------

  const nextBtn = $('player-next');

  function hideNext() {
    nextBtn.hidden = true;
    $('player-next-bar').style.width = '0';
  }

  function playNext() {
    const target = next;
    next = null;
    hideNext();
    target?.onPlay();
  }

  // Shown from 90% of the video; its bar follows the playback (so it waits while paused) and the
  // next episode starts at 99%. Seeking back before 90% hides it.
  function renderNext() {
    const countdown = next ? nextCountdown(video.currentTime, video.duration) : null;
    if (countdown === null) {
      hideNext();
      return;
    }
    if (countdown >= 1) {
      playNext();
      return;
    }
    $('player-next-label').textContent = next.label;
    nextBtn.hidden = false;
    $('player-next-bar').style.width = `${countdown * 100}%`;
  }

  nextBtn.addEventListener('click', playNext);
  video.addEventListener('timeupdate', renderNext);

  // ---------- Keyboard ----------

  /** Returns true when the key was handled by the player. */
  function handleKey(event) {
    if (root.hidden || event.ctrlKey || event.metaKey || event.altKey) return false;
    const inMenu = event.target.closest?.('.popover');
    switch (event.key) {
      case ' ':
      case 'k':
        if (event.target.closest?.('button') && event.key === ' ') return false; // let Space press the focused button
        togglePlay();
        flash(video.paused ? 'pause' : 'play');
        break;
      case 'ArrowLeft':
        if (inMenu) return false;
        seekBy(-SEEK_STEP);
        break;
      case 'ArrowRight':
        if (inMenu) return false;
        seekBy(SEEK_STEP);
        break;
      case 'ArrowUp':
        if (inMenu || event.target === volume) return false;
        setVolume((video.muted ? 0 : video.volume) + 0.1);
        toast(`Volume ${Math.round(video.volume * 100)} %`);
        break;
      case 'ArrowDown':
        if (inMenu || event.target === volume) return false;
        setVolume((video.muted ? 0 : video.volume) - 0.1);
        toast(video.volume ? `Volume ${Math.round(video.volume * 100)} %` : 'Son coupé');
        break;
      case 'm':
        video.muted = !video.muted;
        toast(video.muted ? 'Son coupé' : 'Son rétabli');
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 'Escape':
        if (openMenus().length) {
          closeMenus();
          break;
        }
        return false;
      default:
        return false;
    }
    event.preventDefault();
    showChrome();
    return true;
  }

  // ---------- Open / close ----------

  function open(nextMovie, { startAt = 0, title = nextMovie.title, next: upNext = null } = {}) {
    movie = nextMovie;
    next = upNext;
    hideNext();
    session++;
    for (const el of video.querySelectorAll('track')) el.remove();
    activeTrack = null;
    subsLayer.replaceChildren();
    $('player-error').hidden = true;
    $('player-title').textContent = title;
    $('player-paused-title').textContent = title;
    $('player-paused-meta').textContent = [movie.year, movie.genres?.slice(0, 2).join(', ')].filter(Boolean).join(' · ');
    $('player-paused-overview').textContent = movie.overview || '';
    $('player-remaining').textContent = '';
    $('scrubber-played').style.width = '0';
    $('scrubber-buffered').style.width = '0';
    $('scrubber-thumb').style.left = '0';
    renderSubsMenu();
    closeMenus();

    resumeAt = startAt;
    castSource = null;
    // Opening another movie while on a screen: it needs its own cast link, the old one is cancelled.
    const casting = isCasting();
    video.src = `/api/movies/${movie.id}/stream`;
    if (casting) useCastSource().catch(() => toast('Impossible de préparer la diffusion'));
    loadSubtitles(movie.id, session);
    root.hidden = false;
    setLoading(true);
    showChrome();
    video.play().catch(() => {});
  }

  function close() {
    session++;
    movie = null;
    next = null;
    hideNext();
    clearTimeout(idleTimer);
    clearTimeout(pausedInfoTimer);
    closeMenus();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    video.pause();
    castSource = null;
    video.removeAttribute('src');
    for (const el of video.querySelectorAll('track')) el.remove();
    activeTrack = null;
    video.load();
    root.hidden = true;
    root.classList.remove('player--paused', 'player--show-info', 'player--active');
    setLoading(false);
  }

  return { open, close, handleKey, video };
}
