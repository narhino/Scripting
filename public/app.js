const STATUS = {
  new: { label: 'New', next: 'created', action: '🎙 Mark audio created', actionClass: 'audio' },
  created: { label: 'Audio created', next: 'uploaded', action: '🚀 Mark uploaded', actionClass: 'publish' },
  uploaded: { label: 'Uploaded', next: null },
};
const ORDER = ['new', 'created', 'uploaded'];
const WORDS_PER_MINUTE = 150;
const TITLE_LIMIT = 100;

const state = {
  view: 'todo',
  q: '',
  channel: '',
  todo: [],
  archive: [],
  meta: { counts: { new: 0, created: 0, uploaded: 0, todo: 0, unseen: 0 }, channels: [] },
  arrived: new Set(),
  openId: null,
  detail: null,
  tab: 'script',
  editing: false,
  dirty: false,
  stale: false,
  pk: null,
  draft: null,
};
let firstRoute = true;

/* ---------- helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const joined = (items, sep = ' · ') => items.filter(Boolean).flatMap((item, i) => (i ? [sep, item] : [item]));

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'X-Client': 'dashboard', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const issues = data.issues?.map((i) => `${i.path || 'input'}: ${i.message}`).join('; ');
    throw new Error(issues || data.error || `Request failed (${res.status})`);
  }
  return data;
}

const numberFmt = new Intl.NumberFormat();
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

function ago(iso) {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
  if (secs < 172800) return 'yesterday';
  if (secs < 7 * 86400) return `${Math.floor(secs / 86400)} days ago`;
  return dayFmt.format(new Date(iso));
}

function readTime(words) {
  const secs = (words / WORDS_PER_MINUTE) * 60;
  return secs < 90 ? `~${Math.max(1, Math.round(secs))} s` : `~${Math.round(secs / 60)} min`;
}

function clock(words) {
  const secs = Math.max(1, Math.round((words / WORDS_PER_MINUTE) * 60));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'script';
const parseList = (text) => text.split(',').map((t) => t.trim()).filter(Boolean);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function thumbImg(url, className = 'thumb', fallbackText = '') {
  const img = h('img', { class: className, src: url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  const fallback = () => h('div', { class: `${className} placeholder`, title: 'Image could not be loaded' },
    fallbackText ? h('span', { class: 'overlay-text', text: fallbackText }) : '🖼');
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

function toast(message, { action, kind = '', timeout = 5000 } = {}) {
  const el = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'msg', text: message }),
    action && h('button', { class: 'btn small', type: 'button', text: action.label, onclick: () => { el.remove(); action.run(); } }),
  );
  const stack = $('#toasts');
  stack.append(el);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => el.remove(), timeout);
}

const fail = (err) => toast(err.message || String(err), { kind: 'error', timeout: 8000 });

async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', { value: text, style: 'position:fixed;opacity:0' });
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(`📋 ${what}`, { timeout: 2000 });
}

function download(script) {
  const blob = new Blob([`${script.title}\n\n${script.body}\n`], { type: 'text/plain;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${slug(script.title)}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function setFavicon(unseen) {
  const dot = unseen ? '<circle cx="52" cy="12" r="11" fill="#ef4444" stroke="#fff" stroke-width="3"/>' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x2="1" y2="1">`
    + '<stop offset="0" stop-color="#f59e0b"/><stop offset=".6" stop-color="#ec4899"/><stop offset="1" stop-color="#8b5cf6"/>'
    + '</linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/>'
    + `<path d="M32 12l5 15 15 5-15 5-5 15-5-15-15-5 15-5z" fill="#fff"/>${dot}</svg>`;
  $('#favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ---------- data ---------- */

function listParams(view) {
  const params = new URLSearchParams({ view });
  if (state.q) params.set('q', state.q);
  if (state.channel) params.set('channel', state.channel);
  return params;
}

async function refresh() {
  const [todo, archive, meta] = await Promise.all([
    api(`/scripts?${listParams('todo')}`),
    api(`/scripts?${listParams('archive')}`),
    api('/meta'),
  ]);
  state.todo = todo.scripts;
  state.archive = archive.scripts;
  state.meta = meta;
  render();
}

async function loadDetail(id) {
  state.detail = await api(`/scripts/${id}`);
  state.stale = false;
  renderDrawer();
}

const findScript = (id) => [...state.todo, ...state.archive].find((s) => s.id === id) || (state.detail?.id === id ? state.detail : null);

async function changeStatus(id, status, { undoable = true } = {}) {
  const before = findScript(id);
  let videoUrl;
  if (status === 'uploaded') {
    videoUrl = await askVideoUrl(before?.video_url || '');
    if (videoUrl === null) return;
  }
  const script = await api(`/scripts/${id}/status`, { method: 'POST', body: { status, ...(videoUrl && { video_url: videoUrl }) } });
  const messages = {
    new: `↩ Back to New: “${script.title}”`,
    created: `🎙 Audio created: “${script.title}”`,
    uploaded: `🎉 Uploaded & archived: “${script.title}”`,
  };
  const prev = before?.status;
  toast(messages[status], undoable && prev && prev !== status
    ? { action: { label: 'Undo', run: () => changeStatus(id, prev, { undoable: false }).catch(fail) } }
    : {});
  await refresh();
  if (state.openId === id) await loadDetail(id);
}

function askVideoUrl(current) {
  const dialog = $('#upload-dialog');
  const form = $('#upload-form');
  form.reset();
  form.video_url.value = current;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? form.video_url.value.trim() : null), { once: true });
  });
}

/* ---------- list rendering ---------- */

function render() {
  const { counts, channels } = state.meta;
  $('#count-todo').textContent = counts.todo;
  $('#count-archive').textContent = counts.uploaded;
  document.title = counts.unseen ? `(${counts.unseen}) Script Desk` : 'Script Desk';
  setFavicon(counts.unseen > 0);

  $('#banner').hidden = counts.unseen === 0;
  $('#banner-text').textContent = `${plural(counts.unseen, 'new script')} waiting for you. They glow until you open them.`;

  const select = $('#channel');
  const options = ['', ...new Set([...channels, state.channel].filter(Boolean))];
  select.replaceChildren(...options.map((c) => h('option', { value: c, text: c || 'All channels' })));
  select.value = state.channel;
  select.hidden = channels.length === 0 && !state.channel;
  $('#channel-options').replaceChildren(...channels.map((c) => h('option', { value: c })));

  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === state.view;
    tab.classList.toggle('active', active);
    tab.toggleAttribute('aria-current', active);
  }
  $('#view-todo').hidden = state.view !== 'todo';
  $('#view-archive').hidden = state.view !== 'archive';
  renderTodo();
  renderArchive();
  state.arrived.clear();
}

function emptyState(title, text) {
  return h('div', { class: 'empty' }, h('strong', { text: title }), text);
}

function renderTodo() {
  const filtering = Boolean(state.q || state.channel);
  for (const status of ['new', 'created']) {
    const scripts = state.todo.filter((s) => s.status === status);
    $(`#count-${status}`).textContent = scripts.length;
    const lane = $(`#lane-${status}`);
    if (scripts.length) lane.replaceChildren(...scripts.map(card));
    else if (filtering) lane.replaceChildren(emptyState('No matches', 'Try another search or channel.'));
    else if (status === 'new') lane.replaceChildren(emptyState('All caught up ✨', 'New scripts from your agents land here.'));
    else lane.replaceChildren(emptyState('Nothing to publish', 'Scripts move here once their audio is created.'));
  }
}

function card(s) {
  const status = STATUS[s.status];
  const thumb = safeUrl(s.packaging?.thumbnail_urls?.[0]);
  const chosen = s.packaging?.chosen_title;
  const open = () => { location.hash = `#/script/${s.id}`; };
  const classes = ['card', `status-${s.status}`, !s.seen && 'unseen', state.arrived.has(s.id) && 'arrived'];

  return h('article', { class: classes.filter(Boolean).join(' '), onclick: open },
    !s.seen && h('span', { class: `ribbon${s.status === 'new' ? '' : ' revised'}`, text: s.status === 'new' ? '✦ NEW' : '✦ UPDATED' }),
    h('div', { class: 'card-top' },
      s.channel && h('span', { class: 'chip', text: s.channel }),
      s.source && h('span', { class: 'chip', text: `by ${s.source}` }),
      h('span', { class: 'when', title: fullFmt.format(new Date(s.created_at)), text: ago(s.created_at) }),
    ),
    h('div', { class: 'card-main' },
      h('div', { class: 'card-text' },
        h('h3', null, h('a', { class: 'card-link', href: `#/script/${s.id}`, text: s.title, onclick: (e) => e.stopPropagation() })),
        chosen && chosen !== s.title && h('p', { class: 'pkg-title' }, '🎬 ', h('b', { text: chosen })),
        h('p', { class: 'excerpt', text: s.excerpt }),
      ),
      thumb && thumbImg(thumb),
    ),
    h('div', { class: 'card-foot' },
      h('div', { class: 'meta' },
        h('span', { text: `${numberFmt.format(s.word_count)} words` }),
        h('span', { text: readTime(s.word_count) }),
        s.packaging
          ? h('span', { class: 'pkg-ok', text: '📦 Packaging ✓' })
          : h('span', { class: 'pkg-missing', text: '📦 No packaging' }),
      ),
      status.next && h('button', {
        class: `btn small ${status.actionClass}`,
        type: 'button',
        text: status.action,
        onclick: (e) => { e.stopPropagation(); changeStatus(s.id, status.next).catch(fail); },
      }),
    ),
  );
}

function renderArchive() {
  const list = $('#archive-list');
  if (!state.archive.length) {
    list.replaceChildren(state.q || state.channel
      ? emptyState('No matches', 'Try another search or channel.')
      : emptyState('Nothing published yet', 'Scripts you mark as uploaded leave the to-do list and are kept here.'));
    return;
  }
  const groups = new Map();
  for (const s of state.archive) {
    const key = monthFmt.format(new Date(s.uploaded_at || s.updated_at));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  list.replaceChildren(...[...groups].map(([month, scripts]) => h('section', { class: 'archive-group' },
    h('h2', null, month, h('span', { class: 'muted', text: `${scripts.length} uploaded` })),
    h('div', { class: 'archive-rows' }, scripts.map(archiveRow)),
  )));
}

function archiveRow(s) {
  const thumb = safeUrl(s.packaging?.thumbnail_urls?.[0]);
  const video = safeUrl(s.video_url);
  return h('div', { class: 'archive-row', onclick: () => { location.hash = `#/script/${s.id}`; } },
    thumb ? thumbImg(thumb) : h('div', { class: 'thumb placeholder', text: '🎬' }),
    h('div', null,
      h('h3', null, h('a', { class: 'card-link', href: `#/script/${s.id}`, text: s.packaging?.chosen_title || s.title, onclick: (e) => e.stopPropagation() })),
      s.packaging?.chosen_title && s.packaging.chosen_title !== s.title && h('p', { class: 'working-title', text: `Script: ${s.title}` }),
      h('div', { class: 'meta' }, joined([
        s.channel && h('span', { text: s.channel }),
        h('span', { text: `${numberFmt.format(s.word_count)} words` }),
        s.uploaded_at && h('span', { title: fullFmt.format(new Date(s.uploaded_at)), text: `uploaded ${dayFmt.format(new Date(s.uploaded_at))}` }),
      ])),
    ),
    h('div', { class: 'right' },
      video && h('a', { class: 'btn small ghost', href: video, target: '_blank', rel: 'noopener noreferrer', text: '▶ Watch', onclick: (e) => e.stopPropagation() }),
      h('span', { class: 'chip done-badge', text: '✓ Uploaded' }),
    ),
  );
}

/* ---------- drawer ---------- */

async function showDrawer(id) {
  const switching = state.openId !== id;
  state.openId = id;
  if (switching) {
    state.tab = 'script';
    state.editing = false;
    state.dirty = false;
    state.pk = null;
    state.draft = null;
  }
  try {
    await loadDetail(id);
  } catch (err) {
    fail(err);
    closeDrawer();
    return;
  }
  $('#drawer').hidden = false;
  $('#scrim').hidden = false;
  document.body.style.overflow = 'hidden';
  if (switching) $('#drawer .close')?.focus();
  if (!state.detail.seen) api(`/scripts/${id}/seen`, { method: 'POST' }).then(refresh).catch(fail);
}

function hideDrawer() {
  state.openId = null;
  state.detail = null;
  $('#drawer').hidden = true;
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
}

function closeDrawer() {
  if (state.dirty && !confirm('Discard your unsaved changes?')) return;
  state.dirty = false;
  location.hash = `#/${state.view}`;
}

function renderDrawer() {
  const s = state.detail;
  if (!s) return;
  const pkgDone = Boolean(s.packaging);
  const tabButton = (id, label) => h('button', {
    class: `drawer-tab${state.tab === id ? ' active' : ''}`,
    type: 'button',
    onclick: () => {
      if (state.tab === id) return;
      if (state.dirty && !confirm('Discard your unsaved changes?')) return;
      state.tab = id;
      state.editing = false;
      state.dirty = false;
      state.pk = null;
      state.draft = null;
      renderDrawer();
    },
  }, label);

  $('#drawer').replaceChildren(
    drawerHead(s),
    h('nav', { class: 'drawer-tabs' },
      tabButton('script', 'Script'),
      tabButton('packaging', ['Packaging ', pkgDone ? h('span', { class: 'tick', text: '✓' }) : '']),
      tabButton('activity', `Activity (${s.events.length})`),
    ),
    h('div', { class: 'drawer-body' },
      state.stale && h('div', { class: 'callout' },
        'This script was changed elsewhere while you were editing. ',
        h('button', { class: 'btn small', type: 'button', text: 'Load latest', onclick: () => { state.dirty = false; state.editing = false; state.pk = null; state.draft = null; loadDetail(s.id).catch(fail); } }),
      ),
      state.tab === 'script' && (state.editing ? scriptEditor(s) : scriptView(s)),
      state.tab === 'packaging' && packagingEditor(s),
      state.tab === 'activity' && activity(s),
    ),
    h('div', { class: 'drawer-foot' },
      h('span', { text: `#${s.id} · added ${fullFmt.format(new Date(s.created_at))}` }),
      h('button', {
        class: 'btn small danger',
        type: 'button',
        text: 'Delete',
        onclick: async () => {
          if (!confirm(`Delete “${s.title}” for good?`)) return;
          try {
            await api(`/scripts/${s.id}`, { method: 'DELETE' });
            state.dirty = false;
            toast('🗑 Script deleted');
            closeDrawer();
            await refresh();
          } catch (err) { fail(err); }
        },
      }),
    ),
  );
}

function drawerHead(s) {
  const current = ORDER.indexOf(s.status);
  const stamps = { new: s.created_at, created: s.audio_created_at, uploaded: s.uploaded_at };
  const sourceUrl = safeUrl(s.source_url);
  const videoUrl = safeUrl(s.video_url);

  const step = (status, i) => h('li', { class: `step s-${status}${i < current ? ' done' : ''}${i === current ? ' current' : ''}` },
    h('button', {
      type: 'button',
      'aria-current': i === current ? 'step' : null,
      title: i === current ? 'Current status' : `Set status to ${STATUS[status].label}`,
      onclick: () => { if (status !== s.status) changeStatus(s.id, status).catch(fail); },
    },
    `${i < current ? '✓ ' : ''}${STATUS[status].label}`,
    h('small', { text: stamps[status] ? fullFmt.format(new Date(stamps[status])) : '—' })),
  );

  let next;
  if (s.status === 'new') {
    next = h('button', { class: 'btn audio', type: 'button', text: '🎙 I created the audio', onclick: () => changeStatus(s.id, 'created').catch(fail) });
  } else if (s.status === 'created') {
    next = h('button', { class: 'btn publish', type: 'button', text: '🚀 Mark as uploaded', onclick: () => changeStatus(s.id, 'uploaded').catch(fail) });
  } else {
    next = [
      videoUrl && h('a', { class: 'btn', href: videoUrl, target: '_blank', rel: 'noopener noreferrer', text: '▶ Watch video ↗' }),
      h('button', { class: 'btn ghost', type: 'button', text: '↩ Back to to-do', onclick: () => changeStatus(s.id, 'created').catch(fail) }),
    ];
  }

  return h('div', { class: 'drawer-head' },
    h('div', { class: 'row' },
      h('span', { class: `status-pill ${s.status}`, text: STATUS[s.status].label }),
      s.channel && h('span', { class: 'chip', text: s.channel }),
      h('button', { class: 'btn icon ghost close', type: 'button', 'aria-label': 'Close', text: '✕', onclick: closeDrawer }),
    ),
    h('h2', { text: s.title }),
    h('div', { class: 'sub' }, joined([
      s.source && h('span', { text: `by ${s.source}` }),
      sourceUrl && h('a', { href: sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: 'conversation ↗' }),
      h('span', { title: fullFmt.format(new Date(s.created_at)), text: `received ${ago(s.created_at)}` }),
    ])),
    h('ol', { class: 'stepper', 'aria-label': 'Status' }, ORDER.map(step)),
    h('div', { class: 'next-action' }, next),
  );
}

function scriptView(s) {
  const words = s.word_count;
  return [
    h('div', { class: 'toolbar' },
      h('div', { class: 'meta' },
        h('span', { text: `${numberFmt.format(words)} words` }),
        h('span', { text: `${readTime(words)} narration` }),
        h('span', { text: `${numberFmt.format(s.body.length)} characters` }),
      ),
      h('button', { class: 'btn small', type: 'button', text: '📋 Copy script', onclick: () => copy(s.body, 'Script copied') }),
      h('button', { class: 'btn small', type: 'button', text: '⬇ .txt', title: 'Download as a text file', onclick: () => download(s) }),
      h('button', { class: 'btn small', type: 'button', text: '✎ Edit', onclick: () => { state.editing = true; renderDrawer(); } }),
    ),
    s.notes && h('div', { class: 'callout' }, h('b', { text: 'Notes' }), s.notes),
    s.tags.length > 0 && h('div', { class: 'toolbar' }, s.tags.map((t) => h('span', { class: 'chip', text: t }))),
    h('div', { class: 'script-text', text: s.body }),
  ];
}

function scriptEditor(s) {
  // The draft lives in state so a live refresh of the drawer never wipes what you typed.
  state.draft ??= {
    title: s.title, channel: s.channel, source: s.source, source_url: s.source_url,
    tags: s.tags.join(', '), notes: s.notes, body: s.body,
  };
  const draft = state.draft;
  const form = h('form', {
    class: 'script-edit',
    oninput: (e) => {
      if (e.target.name in draft) draft[e.target.name] = e.target.value;
      state.dirty = true;
    },
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        await api(`/scripts/${s.id}`, {
          method: 'PATCH',
          body: { ...draft, source_url: draft.source_url.trim(), tags: parseList(draft.tags) },
        });
        state.dirty = false;
        state.editing = false;
        state.draft = null;
        toast('✓ Script saved');
        await Promise.all([loadDetail(s.id), refresh()]);
      } catch (err) { fail(err); }
    },
  },
  h('label', { class: 'field' }, h('span', { text: 'Title' }), h('input', { name: 'title', value: draft.title, required: true, maxlength: 300 })),
  h('label', { class: 'field' }, h('span', { text: 'Channel' }), h('input', { name: 'channel', value: draft.channel, list: 'channel-options', maxlength: 100 })),
  h('label', { class: 'field' }, h('span', { text: 'Written by' }), h('input', { name: 'source', value: draft.source, maxlength: 200 })),
  h('label', { class: 'field' }, h('span', { text: 'Conversation link' }), h('input', { name: 'source_url', type: 'url', value: draft.source_url })),
  h('label', { class: 'field' }, h('span', { text: 'Labels (comma separated)' }), h('input', { name: 'tags', value: draft.tags })),
  h('label', { class: 'field' }, h('span', { text: 'Notes' }), h('textarea', { name: 'notes', rows: 3, value: draft.notes })),
  h('label', { class: 'field' }, h('span', { text: 'Script' }), h('textarea', { name: 'body', value: draft.body, required: true })),
  h('div', { class: 'sticky-save' },
    h('button', { class: 'btn ghost', type: 'button', text: 'Cancel', onclick: () => { if (!state.dirty || confirm('Discard your changes?')) { state.dirty = false; state.editing = false; state.draft = null; renderDrawer(); } } }),
    h('button', { class: 'btn primary', type: 'submit', text: 'Save script' }),
  ));
  return form;
}

function packagingEditor(s) {
  if (!state.pk) {
    const p = s.packaging || {};
    const titles = [...(p.titles || [])];
    state.pk = {
      titles: titles.length ? titles : [''],
      chosen: Math.max(0, titles.indexOf(p.chosen_title)),
      thumbnail_text: p.thumbnail_text || '',
      thumbnail_concept: p.thumbnail_concept || '',
      thumbnail_urls: (p.thumbnail_urls || []).join('\n'),
      description: p.description || '',
      video_tags: (p.video_tags || []).join(', '),
    };
  }
  const pk = state.pk;
  const touch = () => { state.dirty = true; };
  const rerender = () => renderDrawer();

  const preview = h('div', { class: 'yt-preview', 'aria-label': 'Preview' });
  const thumbGrid = h('div', { class: 'thumb-grid' });
  const urls = () => pk.thumbnail_urls.split('\n').map((u) => u.trim()).filter(Boolean);
  const updatePreview = () => {
    const img = urls().map(safeUrl).find(Boolean);
    const title = pk.titles[pk.chosen]?.trim() || s.title;
    preview.replaceChildren(
      h('div', { class: 'yt-thumb' },
        img ? thumbImg(img, 'yt-img', pk.thumbnail_text) : h('div', { class: 'overlay-text', text: pk.thumbnail_text || 'No thumbnail yet' }),
        h('span', { class: 'duration', text: clock(s.word_count) }),
      ),
      h('div', null,
        h('h4', { text: title }),
        h('p', { text: joined([s.channel || 'Your channel', 'preview']).join('') }),
        pk.thumbnail_text && h('p', { text: `Thumbnail text: “${pk.thumbnail_text}”` }),
      ),
    );
    thumbGrid.replaceChildren(...urls().map(safeUrl).filter(Boolean).map((u) => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, thumbImg(u, 'grid-img'))));
  };
  updatePreview();

  const titleRow = (title, i) => {
    const len = h('span', { class: `len${title.length > TITLE_LIMIT ? ' over' : ''}`, text: `${title.length}/${TITLE_LIMIT}` });
    return h('div', { class: 'title-option' },
      h('input', {
        type: 'radio', name: 'chosen', checked: i === pk.chosen, 'aria-label': `Use title option ${i + 1}`,
        onchange: () => { pk.chosen = i; touch(); updatePreview(); },
      }),
      h('input', {
        value: title, placeholder: `Title option ${i + 1}`, maxlength: 200,
        oninput: (e) => {
          pk.titles[i] = e.target.value;
          len.textContent = `${e.target.value.length}/${TITLE_LIMIT}`;
          len.classList.toggle('over', e.target.value.length > TITLE_LIMIT);
          touch();
          updatePreview();
        },
      }),
      len,
      h('button', {
        class: 'btn small ghost', type: 'button', text: '✕', 'aria-label': 'Remove option', disabled: pk.titles.length === 1,
        onclick: () => {
          pk.titles.splice(i, 1);
          if (pk.chosen >= i && pk.chosen > 0) pk.chosen -= 1;
          touch();
          rerender();
        },
      }),
    );
  };

  const field = (label, input) => h('label', { class: 'field' }, h('span', { text: label }), input);
  const bound = (tag, key, attrs = {}) => h(tag, { ...attrs, value: pk[key], oninput: (e) => { pk[key] = e.target.value; touch(); updatePreview(); } });

  const save = async () => {
    const titles = pk.titles.map((t) => t.trim()).filter(Boolean);
    const chosenTitle = pk.titles[pk.chosen]?.trim();
    try {
      await api(`/scripts/${s.id}/packaging`, {
        method: 'PUT',
        body: {
          titles,
          chosen_title: titles.includes(chosenTitle) ? chosenTitle : titles[0] || '',
          thumbnail_text: pk.thumbnail_text,
          thumbnail_concept: pk.thumbnail_concept,
          thumbnail_urls: urls(),
          description: pk.description,
          video_tags: parseList(pk.video_tags),
        },
      });
      state.dirty = false;
      state.pk = null;
      toast('📦 Packaging saved');
      await Promise.all([loadDetail(s.id), refresh()]);
    } catch (err) { fail(err); }
  };

  return [
    !s.packaging && h('div', { class: 'callout' },
      h('b', { text: 'No packaging yet' }),
      'Agents can attach it with the attach_packaging tool or PUT /api/scripts/', String(s.id), '/packaging, or fill it in here.'),
    preview,
    h('div', { class: 'section-title' }, 'Title options ', h('span', { class: 'muted', text: '· pick the one to use' })),
    pk.titles.map(titleRow),
    h('div', { class: 'toolbar' },
      h('button', { class: 'btn small', type: 'button', text: '+ Add title option', onclick: () => { pk.titles.push(''); touch(); rerender(); } }),
      h('button', { class: 'btn small ghost', type: 'button', text: '📋 Copy chosen title', onclick: () => copy(pk.titles[pk.chosen] || '', 'Title copied') }),
    ),
    h('div', { class: 'section-title', text: 'Thumbnail' }),
    thumbGrid,
    field('Image links (one per line)', bound('textarea', 'thumbnail_urls', { rows: 2, placeholder: 'https://…/thumbnail.png' })),
    field('Text on thumbnail', bound('input', 'thumbnail_text', { maxlength: 200 })),
    field('Concept', bound('textarea', 'thumbnail_concept', { rows: 3 })),
    h('div', { class: 'section-title', text: 'Description & tags' }),
    field('Description', h('div', { class: 'with-copy' },
      bound('textarea', 'description', { rows: 6 }),
      h('button', { class: 'btn small', type: 'button', text: 'Copy', onclick: () => copy(pk.description, 'Description copied') }),
    )),
    field('Tags (comma separated)', h('div', { class: 'with-copy' },
      bound('input', 'video_tags'),
      h('button', { class: 'btn small', type: 'button', text: 'Copy', onclick: () => copy(parseList(pk.video_tags).join(', '), 'Tags copied') }),
    )),
    h('div', { class: 'sticky-save' },
      h('button', { class: 'btn primary', type: 'button', text: 'Save packaging', onclick: save }),
    ),
  ];
}

const EVENT_ICONS = { received: '📥', revised: '🔁', status: '➡️', packaging: '📦', edited: '✎' };

function activity(s) {
  if (!s.events.length) return emptyState('No activity yet', '');
  return h('ul', { class: 'timeline' }, s.events.map((e) => h('li', null,
    h('span', { class: 'ico', 'aria-hidden': 'true', text: EVENT_ICONS[e.type] || '•' }),
    h('div', null,
      h('div', { class: 'what', text: e.detail }),
      h('div', { class: 'when', title: fullFmt.format(new Date(e.at)), text: joined([ago(e.at), e.actor && `by ${e.actor}`]).join('') }),
    ),
  )));
}

/* ---------- dialogs ---------- */

async function openConnect() {
  const body = $('#connect-body');
  body.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
  $('#connect-dialog').showModal();
  let guide;
  try {
    guide = await api('/agent-guide');
  } catch (err) {
    body.replaceChildren(h('p', { text: err.message }));
    return;
  }
  const key = guide.key_required ? 'YOUR_APP_KEY' : '';
  const code = (text) => h('div', { class: 'code' }, text, h('button', { class: 'btn small', type: 'button', text: 'Copy', onclick: () => copy(text) }));
  const curl = [
    `curl -X POST ${guide.api_url} \\`,
    key && `  -H "Authorization: Bearer ${key}" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"title":"Why Rome fell","body":"<full narration>","channel":"History","source":"history-writer",`,
    `       "packaging":{"titles":["Option A","Option B"],"thumbnail_text":"ROME BURNS","description":"..."}}'`,
  ].filter(Boolean).join('\n');
  const prompt = [
    'When you finish a script, upload it to my Script Desk:',
    `- with the Script Desk MCP tools: call upload_script, or`,
    `- over HTTP: POST JSON to ${guide.api_url}${key ? ` with header "Authorization: Bearer ${key}"` : ''}.`,
    'Fields: title, body (ONLY the narration text), channel, source (your name),',
    'packaging: 3-5 title options best first, thumbnail_text (max 4 words), thumbnail_concept, description, video_tags.',
    'If you revise a script later, upload it again with the same external_id.',
  ].join('\n');

  body.replaceChildren(...[
    h('h2', { text: 'Connect your agents' }),
    h('p', { class: 'muted', text: 'Anything that finishes a script can drop it here. It shows up instantly as NEW.' }),
    h('h3', { text: '1 · claude.ai chats: add as a custom connector' }),
    h('ol', null,
      h('li', { text: 'Settings → Connectors → Add custom connector.' }),
      h('li', { text: 'Paste this URL, then enable the connector in the chats that write scripts:' }),
    ),
    code(guide.mcp_url_with_key),
    h('p', { class: 'muted', text: `${guide.key_required ? 'Replace YOUR_APP_KEY with the APP_KEY you started the server with. ' : ''}claude.ai connects from the internet, so this only works once the app is deployed at a public HTTPS address.` }),
    h('h3', { text: '2 · Claude Code: add the MCP server' }),
    code(`claude mcp add --transport http script-desk ${guide.mcp_url}${key ? ` --header "Authorization: Bearer ${key}"` : ''}`),
    h('h3', { text: '3 · Any other agent or script: REST API' }),
    code(curl),
    h('h3', { text: 'Instruction to paste into your agents' }),
    code(prompt),
  ].filter(Boolean));
}

async function addScript(form) {
  const data = new FormData(form);
  try {
    const script = await api('/scripts', {
      method: 'POST',
      body: { title: data.get('title'), channel: data.get('channel') || undefined, body: data.get('body'), source: 'you' },
    });
    toast(`✓ Added “${script.title}”`);
    form.reset();
    await refresh();
  } catch (err) { fail(err); }
}

/* ---------- live updates ---------- */

let refreshTimer;
function onChange(change) {
  if (change.type === 'created' && !change.seen) {
    state.arrived.add(change.id);
    toast(`✦ New script: “${change.title}”`, {
      kind: 'new-script',
      timeout: 8000,
      action: { label: 'Open', run: () => { location.hash = `#/script/${change.id}`; } },
    });
    notify(change);
  }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), 150);
  if (state.openId === change.id && change.type !== 'seen') {
    if (change.type === 'deleted') {
      state.dirty = false;
      closeDrawer();
    } else if (state.dirty || state.editing) {
      state.stale = true;
      renderDrawer();
    } else {
      loadDetail(change.id).catch(() => {});
    }
  }
}

function connectEvents() {
  const events = new EventSource('/api/events');
  events.addEventListener('change', (e) => onChange(JSON.parse(e.data)));
}

const NOTIFY_KEY = 'script-desk:notify';
const notifySupported = 'Notification' in window;
function notifyEnabled() {
  try {
    return notifySupported && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === '1';
  } catch {
    return false;
  }
}
function syncNotifyButton() {
  const btn = $('#notify-btn');
  btn.hidden = !notifySupported;
  btn.classList.toggle('on', notifyEnabled());
  btn.title = notifyEnabled() ? 'Desktop alerts are on (click to turn off)' : 'Get a desktop alert when a new script arrives';
}
function notify(change) {
  if (!notifyEnabled() || !document.hidden) return;
  const n = new Notification('New script arrived ✦', { body: change.title, tag: `script-${change.id}` });
  n.onclick = () => { window.focus(); location.hash = `#/script/${change.id}`; };
}

/* ---------- routing & wiring ---------- */

async function route() {
  const hash = location.hash || '#/todo';
  const match = hash.match(/^#\/script\/(\d+)/);
  if (match) {
    const id = Number(match[1]);
    await showDrawer(id);
    // Opening a link straight to a published script: show it on top of the archive.
    if (firstRoute && state.detail?.status === 'uploaded') state.view = 'archive';
  } else {
    hideDrawer();
    state.view = hash.startsWith('#/archive') ? 'archive' : 'todo';
  }
  firstRoute = false;
  render();
}

function wire() {
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); refresh().catch(fail); }, 200);
  });
  $('#channel').addEventListener('change', (e) => { state.channel = e.target.value; refresh().catch(fail); });
  $('#mark-all-seen').addEventListener('click', () => api('/seen', { method: 'POST' }).then(refresh).catch(fail));
  $('#scrim').addEventListener('click', closeDrawer);
  $('#connect-btn').addEventListener('click', openConnect);
  $('#add-btn').addEventListener('click', () => { $('#add-dialog').returnValue = ''; $('#add-dialog').showModal(); });
  $('#add-dialog').addEventListener('close', () => { if ($('#add-dialog').returnValue === 'confirm') addScript($('#add-form')); });
  $('#notify-btn').addEventListener('click', async () => {
    try {
      if (notifyEnabled()) localStorage.setItem(NOTIFY_KEY, '0');
      else if ((await Notification.requestPermission()) === 'granted') {
        localStorage.setItem(NOTIFY_KEY, '1');
        toast('🔔 You’ll get a desktop alert when a script arrives while this tab is in the background.');
      } else toast('Desktop alerts are blocked in your browser settings.', { kind: 'error' });
    } catch { /* storage unavailable */ }
    syncNotifyButton();
  });
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select, [contenteditable]');
    if (e.key === '/' && !typing && !document.querySelector('dialog[open]')) {
      e.preventDefault();
      $('#search').focus();
    } else if (e.key === 'Escape' && state.openId && !document.querySelector('dialog[open]')) {
      closeDrawer();
    }
  });
  window.addEventListener('hashchange', () => route().catch(fail));
  // Keep the "x min ago" labels fresh.
  setInterval(() => { if (!state.openId) render(); }, 60_000);
}

wire();
syncNotifyButton();
refresh()
  .then(route)
  .then(connectEvents)
  .catch(fail);
