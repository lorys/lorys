const STATUS_LABELS = { a_demarcher: 'À démarcher', en_cours: 'En cours', gagne: 'Gagné', perdu: 'Perdu' };
const CLOSED = new Set(['gagne', 'perdu']);

const state = {
  commercials: [],
  targets: [],
  tab: 'targets', // 'targets' ou l'id d'un commercial
  focusId: null, // cible affichée en haut de l'onglet commercial (sinon : la prochaine)
  targetsQuery: '',
  commercialQuery: '',
};

const $ = (selector) => document.querySelector(selector);

// --- Utilitaires ---

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && url !== '/api/login') {
    showLogin();
    throw new Error('Session expirée, reconnectez-vous.');
  }
  if (!res.ok) throw new Error(data.error || 'Une erreur est survenue.');
  return data;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function normalize(text) {
  return (text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function matches(target, query) {
  const q = normalize(query.trim());
  if (!q) return true;
  return normalize(`${target.name} ${target.address} ${commercialName(target.commercialId)}`).includes(q);
}

function commercialName(id) {
  return state.commercials.find((c) => c.id === id)?.name ?? '';
}

function itineraryUrl(target) {
  if (target.address) {
    const destination = `${target.name}, ${target.address}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
  }
  return target.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(target.name)}`;
}

// Ordre de passage : cibles ouvertes par date prévue (sans date à la fin), puis cibles closes.
function byNextDate(a, b) {
  const closed = CLOSED.has(a.status) - CLOSED.has(b.status);
  if (closed) return closed;
  if (!a.nextDate !== !b.nextDate) return a.nextDate ? -1 : 1;
  return (a.nextDate || '').localeCompare(b.nextDate || '') || a.name.localeCompare(b.name, 'fr');
}

function replaceTarget(target) {
  const i = state.targets.findIndex((t) => t.id === target.id);
  if (i === -1) state.targets.unshift(target);
  else state.targets[i] = target;
}

function showError(form, err) {
  const p = form.querySelector('.error');
  p.textContent = err ? err.message : '';
  p.hidden = !err;
}

// --- Authentification ---

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  $('#login-form').password.focus();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('#login-error');
  error.hidden = true;
  try {
    await api('POST', '/api/login', { password: form.password.value });
    form.reset();
    await start();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
});

async function start() {
  const [commercials, targets] = await Promise.all([api('GET', '/api/commercials'), api('GET', '/api/targets')]);
  state.commercials = commercials;
  state.targets = targets;
  $('#login').hidden = true;
  $('#app').hidden = false;
  readHash();
  render();
}

// --- Navigation ---

function readHash() {
  const id = location.hash.match(/^#c\/([a-f0-9]{24})$/)?.[1];
  state.tab = id && state.commercials.some((c) => c.id === id) ? id : 'targets';
}

function selectTab(tab) {
  state.tab = tab;
  state.focusId = null;
  state.commercialQuery = '';
  history.replaceState(null, '', tab === 'targets' ? '#' : `#c/${tab}`);
  render();
  window.scrollTo(0, 0);
}

function render() {
  renderTabs();
  const view = $('#view');
  view.replaceChildren(state.tab === 'targets' ? renderTargetsView() : renderCommercialView());
}

function renderTabs() {
  $('#tabs').replaceChildren(
    h('button', {
      type: 'button',
      class: state.tab === 'targets' ? 'tab active' : 'tab',
      onclick: () => selectTab('targets'),
    }, 'Cibles'),
    ...state.commercials.map((c) =>
      h('button', {
        type: 'button',
        class: state.tab === c.id ? 'tab active' : 'tab',
        onclick: () => selectTab(c.id),
      }, c.name),
    ),
    h('button', {
      type: 'button',
      class: 'tab add',
      title: 'Ajouter un commercial',
      onclick: () => openCommercialDialog(),
    }, '+'),
  );
}

// --- Onglet « Cibles » ---

function renderTargetsView() {
  const list = h('ul', { class: 'list' });
  const fill = () => {
    const items = state.targets.filter((t) => matches(t, state.targetsQuery));
    list.replaceChildren(
      ...items.map(targetRow),
      items.length ? null : h('li', { class: 'empty' }, state.targets.length ? 'Aucun résultat.' : 'Aucune cible pour le moment.'),
    );
  };
  fill();
  return h('div', {},
    h('div', { class: 'toolbar' },
      h('button', { type: 'button', class: 'primary', onclick: () => openTargetDialog() }, 'Ajouter'),
    ),
    h('input', {
      type: 'search',
      class: 'search',
      placeholder: 'Rechercher…',
      value: state.targetsQuery,
      oninput: (e) => {
        state.targetsQuery = e.target.value;
        fill();
      },
    }),
    list,
  );
}

function targetRow(target) {
  const overdue = target.nextDate && target.nextDate < today() && !CLOSED.has(target.status);
  return h('li', { class: 'row' },
    h('div', { class: 'row-main' },
      h('strong', {}, target.name),
      target.address ? h('span', { class: 'muted' }, target.address) : null,
      h('span', { class: 'meta' },
        h('span', {}, commercialName(target.commercialId) || 'Non assigné'),
        target.nextDate ? h('span', { class: overdue ? 'late' : '' }, `· ${formatDate(target.nextDate)}`) : null,
        h('span', { class: `badge ${target.status}` }, STATUS_LABELS[target.status]),
      ),
    ),
    h('button', {
      type: 'button',
      class: 'icon',
      title: 'Voir la fiche',
      'aria-label': 'Voir la fiche',
      onclick: () => openDetail(target.id),
    }, eyeIcon()),
  );
}

function eyeIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.innerHTML = '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>';
  return svg;
}

// --- Fiche d'une cible (réutilisée dans l'onglet commercial et la modale « œil ») ---

function targetCard(target, { title, onBack } = {}) {
  const overdue = target.nextDate && target.nextDate < today() && !CLOSED.has(target.status);
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, title ?? target.name),
      h('button', {
        type: 'button',
        class: 'icon',
        title: 'Modifier la cible',
        'aria-label': 'Modifier la cible',
        onclick: () => openTargetDialog(target),
      }, '⚙'),
    ),
    h('ul', { class: 'facts' },
      title ? h('li', {}, h('strong', {}, target.name)) : null,
      h('li', { class: 'with-action' },
        h('span', {}, target.address || h('span', { class: 'muted' }, 'Adresse inconnue')),
        h('a', { class: 'button', href: itineraryUrl(target), target: '_blank', rel: 'noopener' }, 'Itinéraire'),
      ),
      h('li', { class: 'muted' },
        `${commercialName(target.commercialId) || 'Non assigné'} · `,
        h('span', { class: `badge ${target.status}` }, STATUS_LABELS[target.status]),
        target.nextDate
          ? h('span', { class: overdue ? 'late' : '' }, ` · prévu le ${formatDate(target.nextDate)}`)
          : null,
      ),
    ),
    h('div', { class: 'card-head' },
      h('h3', {}, 'Historique'),
      h('button', {
        type: 'button',
        class: 'icon round',
        title: 'Ajouter une note',
        'aria-label': 'Ajouter une note',
        onclick: () => openNoteDialog(target),
      }, '+'),
    ),
    target.notes.length
      ? h('ul', { class: 'notes' }, target.notes.map((note) =>
        h('li', {},
          h('span', { class: 'note-text' }, note.text),
          h('span', { class: 'note-date' }, formatDate(note.date)),
          h('button', {
            type: 'button',
            class: 'icon small',
            title: 'Supprimer la note',
            'aria-label': 'Supprimer la note',
            onclick: () => deleteNote(target, note),
          }, '×'),
        )))
      : h('p', { class: 'muted' }, 'Aucun échange pour le moment.'),
    onBack ? h('button', { type: 'button', class: 'link', onclick: onBack }, '← Revenir à la prochaine cible') : null,
  );
}

let detailId = null;

function openDetail(id) {
  detailId = id;
  renderDetail();
  $('#detail-dialog').showModal();
}

function renderDetail() {
  const target = state.targets.find((t) => t.id === detailId);
  if (!target) return $('#detail-dialog').close();
  $('#detail-body').replaceChildren(targetCard(target));
}

$('#detail-dialog').addEventListener('close', () => {
  detailId = null;
});

// --- Onglet commercial ---

function renderCommercialView() {
  const commercial = state.commercials.find((c) => c.id === state.tab);
  const mine = state.targets.filter((t) => t.commercialId === commercial.id).sort(byNextDate);
  const open = mine.filter((t) => !CLOSED.has(t.status));
  const focused = mine.find((t) => t.id === state.focusId);
  const current = focused ?? open[0];

  const results = h('ul', { class: 'list' });
  const fillResults = () => {
    const q = state.commercialQuery.trim();
    const items = q ? mine.filter((t) => matches(t, q)) : [];
    results.replaceChildren(
      ...items.map((t) => prospectRow(t)),
      q && !items.length ? h('li', { class: 'empty' }, 'Aucun résultat.') : null,
    );
  };
  fillResults();

  const upcoming = open.filter((t) => t !== current);

  return h('div', {},
    current
      ? targetCard(current, {
        title: focused && focused !== open[0] ? 'Cible sélectionnée' : 'Prochaine cible',
        onBack: focused && focused !== open[0] ? () => focus(null) : null,
      })
      : h('section', { class: 'card' },
        h('h2', {}, 'Prochaine cible'),
        h('p', { class: 'muted' }, 'Aucune cible à démarcher.'),
      ),
    h('section', { class: 'card' },
      h('h2', {}, 'Prochains prospects'),
      upcoming.length
        ? h('ul', { class: 'list' }, upcoming.map((t) => prospectRow(t)))
        : h('p', { class: 'muted' }, 'Rien d\'autre de prévu.'),
    ),
    h('section', { class: 'card' },
      h('input', {
        type: 'search',
        class: 'search',
        placeholder: 'Rechercher…',
        value: state.commercialQuery,
        oninput: (e) => {
          state.commercialQuery = e.target.value;
          fillResults();
        },
      }),
      results,
    ),
    h('p', { class: 'footer-actions' },
      h('button', { type: 'button', class: 'link', onclick: () => openCommercialDialog(commercial) },
        `Renommer ou supprimer ${commercial.name}`),
    ),
  );
}

function prospectRow(target) {
  const overdue = target.nextDate && target.nextDate < today() && !CLOSED.has(target.status);
  return h('li', { class: 'row clickable', onclick: () => focus(target.id) },
    h('div', { class: 'row-main' },
      h('strong', {}, target.name),
      target.address ? h('span', { class: 'muted' }, target.address) : null,
    ),
    h('span', { class: 'row-side' },
      CLOSED.has(target.status)
        ? h('span', { class: `badge ${target.status}` }, STATUS_LABELS[target.status])
        : h('span', { class: overdue ? 'late' : 'muted' }, target.nextDate ? formatDate(target.nextDate) : 'Sans date'),
    ),
  );
}

function focus(id) {
  state.focusId = id;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Modale cible ---

let editingTarget = null;

function openTargetDialog(target = null) {
  editingTarget = target;
  const form = $('#target-form');
  form.reset();
  showError(form, null);
  form.commercialId.replaceChildren(
    h('option', { value: '' }, 'Non assigné'),
    ...state.commercials.map((c) => h('option', { value: c.id }, c.name)),
  );
  const defaultCommercial = state.tab !== 'targets' ? state.tab : '';
  form.name.value = target?.name ?? '';
  form.mapsUrl.value = target?.mapsUrl ?? '';
  form.address.value = target?.address ?? '';
  form.commercialId.value = target ? target.commercialId ?? '' : defaultCommercial;
  form.nextDate.value = target?.nextDate ?? '';
  form.status.value = target?.status ?? 'a_demarcher';
  $('#target-dialog-title').textContent = target ? 'Modifier la cible' : 'Nouvelle cible';
  $('#next-date-label').textContent = target ? 'Date prévue du prochain échange' : 'Date prévue du 1er échange';
  $('#status-field').hidden = !target;
  $('#target-delete').hidden = !target;
  $('#target-dialog').showModal();
}

$('#target-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = {
    name: form.name.value,
    mapsUrl: form.mapsUrl.value,
    address: form.address.value,
    commercialId: form.commercialId.value || null,
    nextDate: form.nextDate.value || null,
  };
  if (editingTarget) body.status = form.status.value;
  // Lien Maps modifié : on laisse le serveur recalculer l'adresse si elle n'a pas été touchée.
  if (editingTarget && body.mapsUrl !== editingTarget.mapsUrl && body.address === editingTarget.address) {
    body.address = '';
  }
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    const saved = editingTarget
      ? await api('PATCH', `/api/targets/${editingTarget.id}`, body)
      : await api('POST', '/api/targets', body);
    replaceTarget(saved);
    $('#target-dialog').close();
    render();
    if (detailId) renderDetail();
  } catch (err) {
    showError(form, err);
  } finally {
    submit.disabled = false;
  }
});

$('#target-delete').addEventListener('click', async () => {
  const target = editingTarget;
  if (!target || !confirm(`Supprimer « ${target.name} » et tout son historique ?`)) return;
  try {
    await api('DELETE', `/api/targets/${target.id}`);
    state.targets = state.targets.filter((t) => t.id !== target.id);
    if (state.focusId === target.id) state.focusId = null;
    $('#target-dialog').close();
    if (detailId === target.id) $('#detail-dialog').close();
    render();
  } catch (err) {
    showError($('#target-form'), err);
  }
});

// --- Modale note ---

let noteTarget = null;

function openNoteDialog(target) {
  noteTarget = target;
  const form = $('#note-form');
  form.reset();
  showError(form, null);
  form.date.value = today();
  form.nextDate.value = target.nextDate && target.nextDate > today() ? target.nextDate : '';
  $('#note-dialog').showModal();
  form.text.focus();
}

$('#note-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = { date: form.date.value, text: form.text.value, nextDate: form.nextDate.value || null };
  const submit = form.querySelector('[type=submit]');
  submit.disabled = true;
  try {
    replaceTarget(await api('POST', `/api/targets/${noteTarget.id}/notes`, body));
    $('#note-dialog').close();
    render();
    if (detailId) renderDetail();
  } catch (err) {
    showError(form, err);
  } finally {
    submit.disabled = false;
  }
});

async function deleteNote(target, note) {
  if (!confirm('Supprimer cette note ?')) return;
  try {
    replaceTarget(await api('DELETE', `/api/targets/${target.id}/notes/${note.id}`));
    render();
    if (detailId) renderDetail();
  } catch (err) {
    alert(err.message);
  }
}

// --- Modale commercial ---

let editingCommercial = null;

function openCommercialDialog(commercial = null) {
  editingCommercial = commercial;
  const form = $('#commercial-form');
  form.reset();
  showError(form, null);
  form.name.value = commercial?.name ?? '';
  $('#commercial-dialog-title').textContent = commercial ? 'Modifier le commercial' : 'Nouveau commercial';
  $('#commercial-delete').hidden = !commercial;
  $('#commercial-dialog').showModal();
}

$('#commercial-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    if (editingCommercial) {
      const saved = await api('PATCH', `/api/commercials/${editingCommercial.id}`, { name: form.name.value });
      state.commercials = state.commercials.map((c) => (c.id === saved.id ? saved : c));
      $('#commercial-dialog').close();
      render();
    } else {
      const saved = await api('POST', '/api/commercials', { name: form.name.value });
      state.commercials.push(saved);
      $('#commercial-dialog').close();
      selectTab(saved.id);
    }
  } catch (err) {
    showError(form, err);
  }
});

$('#commercial-delete').addEventListener('click', async () => {
  const commercial = editingCommercial;
  if (!commercial) return;
  if (!confirm(`Supprimer ${commercial.name} ? Ses cibles resteront, sans commercial assigné.`)) return;
  try {
    await api('DELETE', `/api/commercials/${commercial.id}`);
    state.commercials = state.commercials.filter((c) => c.id !== commercial.id);
    state.targets = state.targets.map((t) => (t.commercialId === commercial.id ? { ...t, commercialId: null } : t));
    $('#commercial-dialog').close();
    selectTab('targets');
  } catch (err) {
    showError($('#commercial-form'), err);
  }
});

// --- Modales : fermeture ---

document.querySelectorAll('dialog').forEach((dialog) => {
  dialog.querySelectorAll('[data-close]').forEach((button) =>
    button.addEventListener('click', () => dialog.close()));
  // Clic sur le fond : fermeture.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
});

// --- Démarrage ---

start().catch(() => showLogin());
