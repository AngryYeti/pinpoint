// dashboard/dashboard.js
// Lists every comment, grouped by page, for one project at a time, and runs the exports.
// Reads chrome.storage.local directly; all WRITES go through the background service worker.

import { getAll, isDataChange } from '../lib/store.js';
import { toPDF, toCSV, toText, groupByPage, fileBaseName } from '../lib/export.js';

const $ = (id) => document.getElementById(id);
const PRIORITY_LABEL = { none: 'No priority', low: 'Low', medium: 'Medium', high: 'High' };
const FILTER_LABEL = { all: '', open: 'Open items only', done: 'Done items only' };

const params = new URLSearchParams(location.search);
const ui = {
  selected: params.get('project'),
  filter: 'all',
  editingId: null,
  renderQueued: false,
};
let data = { projects: {}, comments: [], shots: {} };
let usage = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

async function send(type, payload = {}) {
  try {
    return (await chrome.runtime.sendMessage({ type, ...payload })) || { ok: false };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

let toastTimer = 0;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

async function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

function currentProject() {
  return data.projects[ui.selected] || null;
}

function projectComments() {
  return data.comments.filter((c) => c.domain === ui.selected);
}

function filteredComments() {
  const all = projectComments();
  if (ui.filter === 'open') return all.filter((c) => c.status !== 'done');
  if (ui.filter === 'done') return all.filter((c) => c.status === 'done');
  return all;
}

// ---------------------------------------------------------------------------
// Loading + rendering
// ---------------------------------------------------------------------------

async function load() {
  [data, usage] = await Promise.all([getAll(), send('pp:getUsage')]);
  const domains = Object.keys(data.projects);
  if (!data.projects[ui.selected]) {
    // Default to the most recently updated project.
    ui.selected = domains.sort((a, b) => (data.projects[b].updatedAt || 0) - (data.projects[a].updatedAt || 0))[0] || null;
  }
  render();
}

function render() {
  // Don't yank the textarea away while someone is typing.
  if (ui.editingId) {
    ui.renderQueued = true;
    return;
  }
  ui.renderQueued = false;
  renderPicker();
  renderUsage();

  const project = currentProject();
  $('empty').hidden = Boolean(project);
  $('project').hidden = !project;
  if (!project) return;

  const nameInput = $('projectName');
  if (document.activeElement !== nameInput) nameInput.value = project.name;

  const all = projectComments();
  const done = all.filter((c) => c.status === 'done').length;
  const pages = groupByPage(all).length;
  $('projectMeta').textContent = `${project.domain} · ${all.length} comment${all.length === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'} · ${done} done`;

  const hasAny = all.length > 0;
  for (const id of ['exportPdf', 'exportCsv', 'copyText']) $(id).disabled = !hasAny;

  const container = $('pages');
  container.replaceChildren();
  const visible = filteredComments();
  if (!visible.length) {
    container.append(h('p', { class: 'none' }, hasAny ? 'Nothing matches this filter.' : 'This project has no comments yet.'));
    return;
  }
  for (const group of groupByPage(visible)) {
    container.append(
      h(
        'section',
        { class: 'page-group' },
        h('h2', {}, group.title),
        h('a', { class: 'page-url', href: group.url, target: '_blank', rel: 'noopener' }, group.url),
        group.comments.map(renderCard)
      )
    );
  }
}

function renderPicker() {
  const projects = Object.values(data.projects).sort((a, b) => a.name.localeCompare(b.name));
  $('projectPickerWrap').hidden = projects.length < 2;
  const select = $('projectSelect');
  select.replaceChildren(...projects.map((p) => h('option', { value: p.domain, selected: p.domain === ui.selected }, p.name)));
}

function renderUsage() {
  const el = $('usage');
  el.replaceChildren();
  if (!usage?.ok) return;
  if (usage.paid) {
    el.append(h('span', {}, '✨ PinPoint Pro: unlimited comments and projects'));
    return;
  }
  const { commentCount, projectCount, limits } = usage;
  const pct = Math.min(100, Math.round((commentCount / limits.comments) * 100));
  const full = commentCount >= limits.comments;
  const bar = h('span');
  bar.style.width = `${pct}%`;
  el.append(
    h('div', { class: `meter${full ? ' full' : ''}`, role: 'progressbar', 'aria-label': 'Free comments used', 'aria-valuemin': '0', 'aria-valuemax': String(limits.comments), 'aria-valuenow': String(commentCount) }, bar),
    h('span', {}, `${commentCount} of ${limits.comments} free comments · ${projectCount} of ${limits.projects} project`),
    h('button', { type: 'button', class: 'btn small', onclick: () => send('pp:openUpgrade') }, full ? 'Upgrade for more' : 'Upgrade')
  );
}

function renderCard(c) {
  const done = c.status === 'done';
  const shot = data.shots[c.id];
  const thumb = shot
    ? h(
        'button',
        { type: 'button', class: 'thumb', 'aria-label': `View screenshot for comment #${c.number}`, onclick: () => openLightbox(c, shot) },
        h('img', { src: shot.dataUrl, alt: '' })
      )
    : h('div', { class: 'thumb empty-thumb' }, 'No screenshot');

  const meta = h(
    'div',
    { class: 'card-meta' },
    h('span', { class: 'num', 'aria-label': `Comment ${c.number}` }, `#${c.number}`),
    c.priority !== 'none' ? h('span', { class: `badge ${c.priority}` }, PRIORITY_LABEL[c.priority]) : null,
    done ? h('span', { class: 'badge done' }, 'Done') : null,
    h('time', { datetime: new Date(c.createdAt).toISOString() }, new Date(c.createdAt).toLocaleString())
  );

  const body = h('div', { class: 'card-body' }, meta);

  if (ui.editingId === c.id) {
    body.append(renderEditor(c));
  } else {
    body.append(
      h('p', { class: 'note' }, c.note),
      h(
        'div',
        { class: 'card-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => setStatus(c, done ? 'open' : 'done') }, done ? 'Reopen' : '✓ Mark done'),
        h('button', { type: 'button', class: 'btn small', onclick: () => startEdit(c) }, 'Edit'),
        h('button', { type: 'button', class: 'btn small danger', onclick: () => removeComment(c) }, 'Delete')
      )
    );
  }
  return h('article', { class: `card${done ? ' is-done' : ''}`, id: `c-${c.id}`, 'aria-label': `Comment ${c.number}` }, thumb, body);
}

function renderEditor(c) {
  const noteId = `edit-${c.id}`;
  const prioId = `prio-${c.id}`;
  const textarea = h('textarea', { id: noteId, maxlength: '2000' });
  textarea.value = c.note;
  const select = h(
    'select',
    { id: prioId },
    ['none', 'low', 'medium', 'high'].map((p) => h('option', { value: p, selected: p === c.priority }, PRIORITY_LABEL[p]))
  );
  const save = async () => {
    const note = textarea.value.trim();
    if (!note) {
      toast('Please write a note.');
      textarea.focus();
      return;
    }
    const res = await send('pp:updateComment', { id: c.id, patch: { note, priority: select.value } });
    if (!res.ok) return toast(res.error || 'Could not save.');
    stopEdit(c.id);
    toast(`Comment #${c.number} updated`);
  };
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
    if (e.key === 'Escape') stopEdit(c.id);
  });
  return h(
    'div',
    { class: 'edit' },
    h('label', { class: 'sr', for: noteId }, `Edit note for comment ${c.number}`),
    textarea,
    h(
      'div',
      { class: 'edit-row' },
      h('label', { for: prioId }, 'Priority '),
      select,
      h('span', { style: 'flex:1' }),
      h('button', { type: 'button', class: 'btn small', onclick: () => stopEdit(c.id) }, 'Cancel'),
      h('button', { type: 'button', class: 'btn small primary', onclick: save }, 'Save')
    )
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function startEdit(c) {
  ui.editingId = null;
  render();
  ui.editingId = c.id;
  const card = $(`c-${c.id}`);
  card.replaceWith(renderCard(c));
  $(`edit-${c.id}`)?.focus();
}

function stopEdit(id) {
  ui.editingId = null;
  render();
  $(`c-${id}`)?.querySelector('.card-actions button')?.focus();
}

async function setStatus(c, status) {
  const res = await send('pp:updateComment', { id: c.id, patch: { status } });
  if (res.ok) toast(status === 'done' ? `#${c.number} marked done` : `#${c.number} reopened`);
}

async function removeComment(c) {
  if (!confirm(`Delete comment #${c.number}?\n\n"${c.note.slice(0, 120)}"\n\nThis can't be undone.`)) return;
  const res = await send('pp:deleteComment', { id: c.id });
  if (res.ok) toast(`Comment #${c.number} deleted`);
}

function openLightbox(c, shot) {
  $('lightboxTitle').textContent = `Comment #${c.number}: ${c.pageTitle}`;
  const img = $('lightboxImg');
  img.src = shot.dataUrl;
  img.alt = `Screenshot of the area for comment ${c.number}: ${c.note}`;
  $('lightbox').showModal();
}

function exportContext() {
  const project = currentProject();
  const comments = filteredComments();
  return { project, comments, filterLabel: FILTER_LABEL[ui.filter] };
}

$('exportPdf').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const { project, comments, filterLabel } = exportContext();
  if (!comments.length) return toast('Nothing to export with this filter.');
  if (!window.jspdf?.jsPDF) return toast('PDF library failed to load. Try reloading this window.');
  btn.disabled = true;
  btn.textContent = 'Building PDF…';
  try {
    // Yield so the button text updates before the (synchronous) PDF build.
    await new Promise((r) => setTimeout(r, 30));
    const blob = toPDF(project, comments, data.shots, { filterLabel });
    await download(blob, `${fileBaseName(project)}.pdf`);
    toast('PDF saved to your Downloads');
  } catch (err) {
    console.error(err);
    toast('Sorry, the PDF could not be created.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export PDF';
  }
});

$('exportCsv').addEventListener('click', async () => {
  const { project, comments } = exportContext();
  if (!comments.length) return toast('Nothing to export with this filter.');
  try {
    const blob = new Blob([toCSV(project, comments)], { type: 'text/csv;charset=utf-8' });
    await download(blob, `${fileBaseName(project)}.csv`);
    toast('CSV saved to your Downloads');
  } catch (err) {
    console.error(err);
    toast('Sorry, the CSV could not be saved.');
  }
});

$('copyText').addEventListener('click', async () => {
  const { project, comments, filterLabel } = exportContext();
  if (!comments.length) return toast('Nothing to copy with this filter.');
  try {
    await navigator.clipboard.writeText(toText(project, comments, { filterLabel }));
    toast(`Copied ${comments.length} comment${comments.length === 1 ? '' : 's'} to the clipboard`);
  } catch {
    toast('Could not access the clipboard.');
  }
});

$('projectName').addEventListener('change', async (e) => {
  const project = currentProject();
  if (!project) return;
  const res = await send('pp:renameProject', { domain: project.domain, name: e.target.value });
  if (res.ok) toast('Project name saved');
});
$('projectName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});

$('projectSelect').addEventListener('change', (e) => {
  ui.selected = e.target.value;
  ui.editingId = null;
  render();
});

for (const radio of document.querySelectorAll('input[name="filter"]')) {
  radio.addEventListener('change', (e) => {
    ui.filter = e.target.value;
    render();
  });
}

$('deleteProject').addEventListener('click', async () => {
  const project = currentProject();
  if (!project) return;
  const n = projectComments().length;
  if (!confirm(`Delete "${project.name}" and its ${n} comment${n === 1 ? '' : 's'}?\n\nTip: export a PDF first. This can't be undone.`)) return;
  const res = await send('pp:deleteProject', { domain: project.domain });
  if (res.ok) {
    ui.selected = null;
    toast('Project deleted');
  }
});

$('lightboxClose').addEventListener('click', () => $('lightbox').close());
$('lightbox').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close(); // click on the backdrop
});

// Live updates when comments are added from a page.
let reloadTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !isDataChange(changes)) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 100);
});

if (params.get('notice') === 'restricted') {
  const n = $('notice');
  n.hidden = false;
  n.textContent =
    "PinPoint can't run on that tab. Chrome blocks extensions on its own pages, the New Tab page and the Web Store. Open a regular website and click the PinPoint icon there.";
}

load();
