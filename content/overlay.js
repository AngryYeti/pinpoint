// content/overlay.js
// Injected into the current tab ONLY when the user clicks the PinPoint toolbar icon.
// Everything visible lives inside a closed Shadow DOM, so the host site's CSS can't
// break our UI and our CSS can't leak into the site.

(() => {
  'use strict';

  if (window.__pinpointFeedback) return;
  const instance = {};
  window.__pinpointFeedback = instance;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const PRIORITY_LABEL = { none: 'No priority', low: 'Low', medium: 'Medium', high: 'High' };
  const lifetime = new AbortController(); // aborting removes every DOM listener we added
  const on = (target, type, fn, opts = {}) =>
    target.addEventListener(type, fn, { ...opts, signal: lifetime.signal });

  const state = {
    commenting: true, // false = "paused": the page works normally, pins stay visible
    showDone: true,
    corner: 'right',
    comments: [],
    project: null,
    usage: null,
    pageKey: null,
    href: location.href,
    draft: null, // unsaved new comment
    panel: null, // { el, kind, id?, dirty() }
    busy: false,
    hoverEl: null,
  };

  // -------------------------------------------------------------------------
  // Messaging helpers
  // -------------------------------------------------------------------------

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      if (!extensionAlive()) return resolve({ ok: false, error: 'Extension was reloaded' });
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false });
        });
      } catch (err) {
        resolve({ ok: false, error: String(err) });
      }
    });
  }

  // -------------------------------------------------------------------------
  // DOM helpers (no innerHTML, so it also works on sites using Trusted Types)
  // -------------------------------------------------------------------------

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

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // -------------------------------------------------------------------------
  // Shadow DOM host
  // -------------------------------------------------------------------------

  const host = document.createElement('pinpoint-feedback');
  for (const [prop, value] of Object.entries({
    all: 'initial',
    position: 'fixed',
    inset: '0',
    'z-index': '2147483647',
    'pointer-events': 'none',
    display: 'block',
  })) {
    host.style.setProperty(prop, value, 'important');
  }
  const shadow = host.attachShadow({ mode: 'closed' });

  const STYLES = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .layer {
      position: fixed; inset: 0; pointer-events: none;
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #111827; -webkit-font-smoothing: antialiased; letter-spacing: normal; text-align: left;
    }
    button, input, textarea, select { font: inherit; color: inherit; letter-spacing: normal; }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

    /* Hover highlight */
    .hl {
      position: fixed; left: 0; top: 0; pointer-events: none;
      border: 2px solid #4f46e5; background: rgba(79, 70, 229, 0.08); border-radius: 3px;
      transition: transform 60ms ease-out, width 60ms ease-out, height 60ms ease-out;
    }
    .hl[hidden] { display: none; }
    .hl-label {
      position: absolute; left: -2px; top: -24px; max-width: 320px;
      background: #4f46e5; color: #fff; border-radius: 4px; padding: 3px 7px;
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .hl.label-below .hl-label { top: auto; bottom: -24px; }

    /* Pins */
    .pin {
      position: fixed; left: 0; top: 0; width: 28px; height: 28px; margin: 0; padding: 0;
      pointer-events: auto; border-radius: 50%; border: 2px solid #fff;
      background: #4f46e5; color: #fff; font-weight: 700; font-size: 12px; line-height: 24px;
      text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.35); transition: transform 0s, box-shadow 120ms;
    }
    .pin:hover { box-shadow: 0 0 0 4px rgba(79,70,229,.3), 0 2px 8px rgba(0,0,0,.35); }
    .pin.p-low { background: #2563eb; }
    .pin.p-medium { background: #d97706; }
    .pin.p-high { background: #dc2626; }
    .pin.done { background: #16a34a; opacity: .8; }
    .pin.approx { border-style: dashed; }
    .pin.draft { background: #4f46e5; animation: pp-pop 160ms ease-out; }
    .pin[hidden] { display: none; }
    @keyframes pp-pop { from { scale: .4; } to { scale: 1; } }

    /* Toolbar */
    .toolbar {
      position: fixed; bottom: 16px; right: 16px; pointer-events: auto;
      display: flex; align-items: center; gap: 4px; padding: 6px;
      background: #111827; color: #f9fafb; border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.3); max-width: calc(100vw - 32px); flex-wrap: wrap;
    }
    .toolbar.left { right: auto; left: 16px; }
    .tb-brand { display: flex; align-items: center; gap: 8px; padding: 0 8px 0 4px; font-size: 13px; white-space: nowrap; }
    .tb-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; flex: none; }
    .tb-dot.paused { background: #f59e0b; }
    .tb-count { background: #374151; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
    .tb-btn {
      border: 0; background: transparent; color: #f9fafb; border-radius: 8px;
      padding: 6px 10px; font-size: 13px; white-space: nowrap;
    }
    .tb-btn:hover { background: #374151; }
    .tb-btn[aria-pressed="true"] { background: #374151; }
    .tb-btn.icon { padding: 6px 9px; }
    .toolbar :focus-visible { outline-color: #a5b4fc; }

    /* Panels (note editor + upgrade prompt) */
    .panel {
      position: fixed; left: 12px; top: 12px; width: 330px; max-width: calc(100vw - 24px);
      max-height: calc(100vh - 24px); overflow: auto; pointer-events: auto;
      background: #fff; color: #111827; border-radius: 12px; padding: 14px;
      box-shadow: 0 16px 48px rgba(0,0,0,.28), 0 0 0 1px rgba(0,0,0,.06);
    }
    .panel.shake { animation: pp-shake 260ms; }
    @keyframes pp-shake { 25% { translate: -5px 0; } 75% { translate: 5px 0; } }
    .panel h2 { margin: 0 0 10px; font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .num { display: inline-grid; place-items: center; min-width: 24px; height: 24px; padding: 0 6px; border-radius: 999px; background: #4f46e5; color: #fff; font-size: 12px; }
    .panel label.field { display: block; font-size: 12.5px; font-weight: 600; margin-bottom: 4px; color: #374151; }
    .panel textarea {
      display: block; width: 100%; min-height: 92px; resize: vertical; margin: 0 0 12px;
      padding: 8px 10px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: #111827;
    }
    .panel textarea:focus-visible { outline: 2px solid #4f46e5; outline-offset: 0; border-color: #4f46e5; }
    fieldset { border: 0; margin: 0 0 12px; padding: 0; min-width: 0; }
    legend { font-size: 12.5px; font-weight: 600; color: #374151; padding: 0; margin-bottom: 4px; }
    .seg { display: flex; gap: 4px; }
    .seg label { flex: 1; position: relative; }
    .seg input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
    .seg span {
      display: block; text-align: center; padding: 5px 0; border: 1px solid #d1d5db; border-radius: 6px;
      font-size: 12.5px; background: #fff; color: #374151;
    }
    .seg input:checked + span { border-color: currentColor; font-weight: 700; background: #f5f5ff; }
    .seg input:checked + span.pr-none { color: #4338ca; }
    .seg input:checked + span.pr-low { color: #1d4ed8; background: #eff6ff; }
    .seg input:checked + span.pr-medium { color: #b45309; background: #fffbeb; }
    .seg input:checked + span.pr-high { color: #b91c1c; background: #fef2f2; }
    .seg input:focus-visible + span { outline: 2px solid #4f46e5; outline-offset: 1px; }
    .check { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 13px; }
    .check input { width: 16px; height: 16px; margin: 0; accent-color: #16a34a; }
    .meta { font-size: 12px; color: #6b7280; margin: -4px 0 12px; }
    .error { color: #b91c1c; font-size: 12.5px; margin: -4px 0 10px; }
    .error:empty { display: none; }
    .row { display: flex; gap: 8px; align-items: center; }
    .spacer { flex: 1; }
    .btn {
      border: 1px solid #d1d5db; background: #fff; color: #111827; border-radius: 8px;
      padding: 7px 12px; font-size: 13px; font-weight: 600; white-space: nowrap;
    }
    .btn:hover { background: #f3f4f6; }
    .btn.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    .btn.primary:hover { background: #4338ca; }
    .btn.danger { color: #b91c1c; border-color: transparent; padding-left: 4px; padding-right: 4px; }
    .btn.danger:hover { background: #fef2f2; }
    .btn[disabled] { opacity: .6; cursor: progress; }
    .hint { font-size: 11.5px; color: #6b7280; margin-top: 10px; }
    kbd { font: 11px ui-monospace, Menlo, monospace; border: 1px solid #d1d5db; border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: #f9fafb; }
    .upgrade p { margin: 0 0 12px; font-size: 13.5px; color: #374151; }
    .upgrade ul { margin: 0 0 14px; padding-left: 18px; font-size: 13px; color: #374151; }

    @media (prefers-reduced-motion: reduce) {
      .hl, .pin, .panel { transition: none !important; animation: none !important; }
    }
  `;

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLES);
    shadow.adoptedStyleSheets = [sheet]; // not blocked by the page's Content-Security-Policy
  } catch {
    shadow.append(h('style', { text: STYLES }));
  }

  const layer = h('div', { class: 'layer' });
  const hl = h('div', { class: 'hl', hidden: true }, h('div', { class: 'hl-label' }));
  const pinsBox = h('div', { class: 'pins' });
  const live = h('div', { class: 'sr', 'aria-live': 'polite', role: 'status' });
  const toolbar = buildToolbar();
  layer.append(hl, pinsBox, toolbar.el, live);
  shadow.append(layer);
  document.documentElement.appendChild(host);

  function announce(text) {
    live.textContent = '';
    setTimeout(() => (live.textContent = text), 30);
  }

  // -------------------------------------------------------------------------
  // Toolbar
  // -------------------------------------------------------------------------

  function buildToolbar() {
    const dot = h('span', { class: 'tb-dot', 'aria-hidden': 'true' });
    const status = h('span', { text: 'Click anything to comment' });
    const count = h('span', { class: 'tb-count', title: 'Comments on this page' }, '0');
    const pauseBtn = h('button', { class: 'tb-btn', type: 'button', 'aria-pressed': 'false', title: 'Pause to use the page normally (Esc)' }, 'Pause');
    const doneBtn = h('button', { class: 'tb-btn', type: 'button', 'aria-pressed': 'false' }, 'Hide done');
    const listBtn = h('button', { class: 'tb-btn', type: 'button', title: 'See every comment and export PDF / CSV' }, 'All comments');
    const moveBtn = h('button', { class: 'tb-btn icon', type: 'button', 'aria-label': 'Move toolbar to the other side', title: 'Move toolbar' }, '⇄');
    const exitBtn = h('button', { class: 'tb-btn icon', type: 'button', 'aria-label': 'Turn off PinPoint on this page', title: 'Turn off (click the PinPoint icon again to come back)' }, '✕');

    const el = h(
      'div',
      { class: 'toolbar', role: 'toolbar', 'aria-label': 'PinPoint Feedback' },
      h('div', { class: 'tb-brand' }, dot, h('strong', {}, 'PinPoint'), status, count),
      pauseBtn,
      doneBtn,
      listBtn,
      moveBtn,
      exitBtn
    );

    pauseBtn.addEventListener('click', () => setCommenting(!state.commenting));
    doneBtn.addEventListener('click', () => {
      state.showDone = !state.showDone;
      renderPins();
      renderToolbar();
    });
    listBtn.addEventListener('click', () => send('pp:openDashboard', { project: state.project?.domain }));
    moveBtn.addEventListener('click', () => {
      state.corner = state.corner === 'right' ? 'left' : 'right';
      el.classList.toggle('left', state.corner === 'left');
    });
    exitBtn.addEventListener('click', () => teardown());
    // Keep the site's keyboard shortcuts from reacting to our buttons.
    for (const t of ['keydown', 'keyup', 'keypress']) el.addEventListener(t, (e) => e.stopPropagation());

    return { el, dot, status, count, pauseBtn, doneBtn };
  }

  function renderToolbar() {
    const t = toolbar;
    const n = state.comments.length;
    const open = state.comments.filter((c) => c.status !== 'done').length;
    t.count.textContent = String(n);
    t.count.title = `${n} comment${n === 1 ? '' : 's'} on this page (${open} open)`;
    t.status.textContent = state.commenting ? 'Click anything to comment' : 'Paused, use the page normally';
    t.dot.classList.toggle('paused', !state.commenting);
    t.pauseBtn.textContent = state.commenting ? 'Pause' : 'Resume';
    t.pauseBtn.setAttribute('aria-pressed', String(!state.commenting));
    t.doneBtn.textContent = state.showDone ? 'Hide done' : 'Show done';
    t.doneBtn.setAttribute('aria-pressed', String(!state.showDone));
  }

  function setCommenting(value) {
    state.commenting = value;
    if (!value) hideHighlight();
    renderToolbar();
    announce(value ? 'Comment mode on. Click any element to leave a comment.' : 'Comment mode paused. The page works normally.');
  }

  // -------------------------------------------------------------------------
  // Hover highlight
  // -------------------------------------------------------------------------

  function describe(el) {
    let label = el.localName;
    if (el.id) label += `#${el.id}`;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) label += '.' + cls.join('.');
    return label;
  }

  function showHighlight(el) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return hideHighlight();
    hl.hidden = false;
    hl.style.transform = `translate(${r.left - 2}px, ${r.top - 2}px)`;
    hl.style.width = `${r.width + 4}px`;
    hl.style.height = `${r.height + 4}px`;
    hl.classList.toggle('label-below', r.top < 28);
    hl.firstChild.textContent = describe(el);
  }

  function hideHighlight() {
    hl.hidden = true;
    state.hoverEl = null;
  }

  // -------------------------------------------------------------------------
  // CSS selector for the clicked element
  // -------------------------------------------------------------------------

  function looksGenerated(id) {
    return /^[:\d]|\d{4,}|^(ember|react|radix|headlessui|mui|rc-|__next|tippy)/i.test(id);
  }

  function uniqueId(el) {
    if (!el.id || looksGenerated(el.id)) return false;
    try {
      return document.querySelectorAll('#' + CSS.escape(el.id)).length === 1;
    } catch {
      return false;
    }
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    if (el === document.documentElement) return 'html';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (uniqueId(node)) {
        parts.unshift('#' + CSS.escape(node.id));
        break;
      }
      let part = CSS.escape(node.localName);
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.localName === node.localName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function findElement(selector) {
    if (!selector) return null;
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Pins
  // -------------------------------------------------------------------------

  const pinEls = new Map(); // comment id (or 'draft') -> button
  const elementCache = new Map(); // comment id -> element

  /** Where a pin should be drawn right now, in viewport coordinates. */
  function pinPoint(comment) {
    let el = elementCache.get(comment.id);
    if (!el || !el.isConnected) {
      el = findElement(comment.selector);
      elementCache.set(comment.id, el);
    }
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width || r.height) {
        return { x: r.left + r.width * comment.pin.xRatio, y: r.top + r.height * comment.pin.yRatio, approx: false };
      }
    }
    // Element is gone or hidden: fall back to where it was on the page.
    return { x: comment.pin.pageX - window.scrollX, y: comment.pin.pageY - window.scrollY, approx: true };
  }

  function renderPins() {
    pinsBox.replaceChildren();
    pinEls.clear();
    for (const c of state.comments) {
      const done = c.status === 'done';
      const btn = h(
        'button',
        {
          type: 'button',
          class: `pin p-${c.priority || 'none'}${done ? ' done' : ''}`,
          'aria-label': `Comment ${c.number}: ${c.note}. ${PRIORITY_LABEL[c.priority] || ''}. ${done ? 'Done' : 'Open'}. Press to edit.`,
          title: `#${c.number} ${c.note}`,
          hidden: done && !state.showDone,
        },
        done ? '✓' : String(c.number)
      );
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditor(c, false);
      });
      pinsBox.append(btn);
      pinEls.set(c.id, btn);
    }
    if (state.draft) {
      const btn = h('button', { type: 'button', class: 'pin draft', 'aria-label': `New comment ${state.draft.number} (unsaved)`, tabindex: '-1' }, String(state.draft.number));
      pinsBox.append(btn);
      pinEls.set('draft', btn);
    }
    positionPins();
  }

  function positionPins() {
    for (const c of state.comments) {
      const btn = pinEls.get(c.id);
      if (!btn) continue;
      const p = pinPoint(c);
      btn.style.transform = `translate(${Math.round(p.x - 14)}px, ${Math.round(p.y - 14)}px)`;
      btn.classList.toggle('approx', p.approx);
    }
    const draftBtn = pinEls.get('draft');
    if (draftBtn && state.draft) {
      const p = draftPoint();
      draftBtn.style.transform = `translate(${Math.round(p.x - 14)}px, ${Math.round(p.y - 14)}px)`;
    }
  }

  function draftPoint() {
    const d = state.draft;
    if (d.el?.isConnected) {
      const r = d.el.getBoundingClientRect();
      return { x: r.left + r.width * d.pin.xRatio, y: r.top + r.height * d.pin.yRatio };
    }
    return { x: d.pin.pageX - window.scrollX, y: d.pin.pageY - window.scrollY };
  }

  let framePending = false;
  function schedulePosition() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      positionPins();
      if (state.hoverEl && !hl.hidden) showHighlight(state.hoverEl);
    });
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  async function refresh() {
    const res = await send('pp:getPage', { url: location.href });
    if (!res.ok) return;
    state.comments = res.comments;
    state.project = res.project;
    state.usage = res.usage;
    state.pageKey = res.pageKey;
    elementCache.clear();
    // If the comment being edited was deleted elsewhere (e.g. from the dashboard), close it.
    if (state.panel?.kind === 'editor' && state.panel.id && !state.comments.some((c) => c.id === state.panel.id)) {
      closePanel();
    }
    renderPins();
    renderToolbar();
  }

  let refreshTimer = 0;
  function onStorageChanged(changes, area) {
    if (area !== 'local') return;
    if (!Object.keys(changes).some((k) => k.startsWith('comment:') || k.startsWith('project:'))) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 120);
  }

  // -------------------------------------------------------------------------
  // Creating a comment
  // -------------------------------------------------------------------------

  async function selectElement(el, clientX, clientY) {
    if (state.busy) return;
    state.busy = true;
    try {
      const can = await send('pp:canAdd', { url: location.href });
      if (!can.ok) {
        if (can.reason) showUpgrade(can);
        else if (can.error) announce(`PinPoint error: ${can.error}`);
        return;
      }
      hideHighlight();

      const r = el.getBoundingClientRect();
      const pin = {
        xRatio: r.width ? clamp((clientX - r.left) / r.width, 0, 1) : 0.5,
        yRatio: r.height ? clamp((clientY - r.top) / r.height, 0, 1) : 0.5,
        pageX: clientX + window.scrollX,
        pageY: clientY + window.scrollY,
        viewportWidth: window.innerWidth,
      };
      const image = await captureArea(r, { x: clientX, y: clientY }, can.nextNumber);

      state.draft = { number: can.nextNumber, el, selector: cssPath(el), pin, image, note: '', priority: 'none' };
      renderPins();
      openEditor(state.draft, true);
    } finally {
      state.busy = false;
    }
  }

  /** Hides our UI, asks the background to screenshot + crop, then restores the UI. */
  async function captureArea(rect, click, number) {
    host.style.setProperty('visibility', 'hidden', 'important');
    try {
      await nextFrame();
      await nextFrame();
      await wait(40);
      const res = await send('pp:capture', {
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        click,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        number,
      });
      return res.ok ? res.image : null;
    } finally {
      host.style.setProperty('visibility', 'visible', 'important');
    }
  }

  // -------------------------------------------------------------------------
  // Panels
  // -------------------------------------------------------------------------

  function closePanel({ restoreFocus = true } = {}) {
    const panel = state.panel;
    if (!panel) return;
    panel.el.remove();
    state.panel = null;
    if (restoreFocus && panel.returnFocus?.isConnected) panel.returnFocus.focus({ preventScroll: true });
  }

  function discardDraft() {
    if (!state.draft) return;
    state.draft = null;
    renderPins();
  }

  function placePanel(panel, point) {
    const w = panel.offsetWidth;
    const ht = panel.offsetHeight;
    let x = point.x + 22;
    if (x + w > window.innerWidth - 12) x = point.x - w - 22;
    const left = clamp(x, 12, Math.max(12, window.innerWidth - w - 12));
    const top = clamp(point.y - 20, 12, Math.max(12, window.innerHeight - ht - 12));
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  /** Keyboard handling shared by all panels: focus trap, Esc, and isolation from site shortcuts. */
  function wirePanelKeys(panel, { onEscape, onSubmit }) {
    panel.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSubmit) {
        e.preventDefault();
        onSubmit();
      } else if (e.key === 'Tab') {
        const items = [...panel.querySelectorAll('button, textarea, input, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.disabled);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = shadow.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    for (const t of ['keyup', 'keypress']) panel.addEventListener(t, (e) => e.stopPropagation());
  }

  function openEditor(comment, isNew) {
    closePanel({ restoreFocus: false });
    if (!isNew) discardDraft();

    const titleId = 'pp-editor-title';
    const noteId = 'pp-note';
    const textarea = h('textarea', {
      id: noteId,
      maxlength: '2000',
      placeholder: 'e.g. Make this headline bigger and change the color to navy',
    });
    textarea.value = comment.note || '';

    const current = comment.priority || 'none';
    const radios = ['none', 'low', 'medium', 'high'].map((p) =>
      h(
        'label',
        {},
        h('input', { type: 'radio', name: 'pp-priority', value: p, checked: p === current }),
        h('span', { class: `pr-${p}` }, p === 'none' ? 'None' : PRIORITY_LABEL[p])
      )
    );
    const doneBox = isNew ? null : h('input', { type: 'checkbox', id: 'pp-done', checked: comment.status === 'done' });
    const error = h('div', { class: 'error', role: 'alert' });
    const saveBtn = h('button', { type: 'button', class: 'btn primary' }, isNew ? 'Save comment' : 'Save');
    const cancelBtn = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    const deleteBtn = isNew ? null : h('button', { type: 'button', class: 'btn danger' }, 'Delete');

    let metaText = '';
    if (isNew) {
      metaText = comment.image
        ? '📷 Screenshot of this area attached.'
        : 'No screenshot this time. Click the PinPoint icon again to re-enable screenshots.';
    } else {
      metaText = `Added ${new Date(comment.createdAt).toLocaleString()}`;
    }

    const panel = h(
      'div',
      { class: 'panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId },
      h('h2', { id: titleId }, h('span', { class: 'num' }, `#${comment.number}`), isNew ? 'New comment' : 'Edit comment'),
      h('label', { class: 'field', for: noteId }, 'What should change?'),
      textarea,
      h('fieldset', {}, h('legend', {}, 'Priority (optional)'), h('div', { class: 'seg' }, radios)),
      doneBox ? h('label', { class: 'check' }, doneBox, 'Mark as done') : null,
      h('p', { class: 'meta' }, metaText),
      error,
      h('div', { class: 'row' }, deleteBtn, h('span', { class: 'spacer' }), cancelBtn, saveBtn),
      h('div', { class: 'hint' }, h('kbd', {}, 'Ctrl'), ' + ', h('kbd', {}, 'Enter'), ' to save · ', h('kbd', {}, 'Esc'), ' to cancel')
    );

    const initial = JSON.stringify([textarea.value, current, doneBox?.checked]);
    const readPriority = () => panel.querySelector('input[name="pp-priority"]:checked')?.value || 'none';
    const dirty = () => JSON.stringify([textarea.value, readPriority(), doneBox?.checked]) !== initial;

    const cancel = () => {
      closePanel();
      if (isNew) {
        discardDraft();
        announce('Comment discarded.');
      }
    };

    const save = async () => {
      const note = textarea.value.trim();
      if (!note) {
        error.textContent = 'Please write a short note first.';
        textarea.focus();
        return;
      }
      saveBtn.disabled = true;
      error.textContent = '';
      let res;
      if (isNew) {
        res = await send('pp:addComment', {
          url: location.href,
          title: document.title,
          selector: comment.selector,
          pin: comment.pin,
          note,
          priority: readPriority(),
          image: comment.image,
        });
      } else {
        res = await send('pp:updateComment', {
          id: comment.id,
          patch: { note, priority: readPriority(), status: doneBox.checked ? 'done' : 'open' },
        });
      }
      saveBtn.disabled = false;
      if (!res.ok) {
        if (res.reason) {
          closePanel();
          discardDraft();
          showUpgrade(res);
        } else {
          error.textContent = res.error || 'Could not save. Please try again.';
        }
        return;
      }
      if (isNew) state.draft = null;
      closePanel();
      announce(`Comment ${res.comment.number} saved.`);
      await refresh();
    };

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', cancel);
    deleteBtn?.addEventListener('click', async () => {
      if (!window.confirm(`Delete comment #${comment.number}? This can't be undone.`)) return;
      const res = await send('pp:deleteComment', { id: comment.id });
      if (res.ok) {
        closePanel({ restoreFocus: false });
        announce(`Comment ${comment.number} deleted.`);
        await refresh();
      }
    });
    wirePanelKeys(panel, { onEscape: cancel, onSubmit: save });

    layer.append(panel);
    const returnFocus = isNew ? null : pinEls.get(comment.id);
    state.panel = { el: panel, kind: 'editor', id: isNew ? null : comment.id, dirty, isNew, returnFocus };
    placePanel(panel, isNew ? draftPoint() : pinPoint(comment));
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function showUpgrade(info) {
    closePanel({ restoreFocus: false });
    hideHighlight();
    const titleId = 'pp-upgrade-title';
    const limits = info.usage?.limits || { comments: 15, projects: 1 };
    const message =
      info.reason === 'projects'
        ? `The free version covers ${limits.projects} project (one website), and you're already using it for ${
            info.existingProjects?.[0] || 'another site'
          }. Delete that project from the comment list, or upgrade to give feedback on as many sites as you like.`
        : `You've used all ${limits.comments} free comments. Nice work! Upgrade to keep pinning, or mark items done and delete them to free up space.`;

    const upgradeBtn = h('button', { type: 'button', class: 'btn primary' }, 'Upgrade');
    const listBtn = h('button', { type: 'button', class: 'btn' }, 'Manage comments');
    const closeBtn = h('button', { type: 'button', class: 'btn' }, 'Close');
    const panel = h(
      'div',
      { class: 'panel upgrade', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId },
      h('h2', { id: titleId }, '✨ You reached the free limit'),
      h('p', {}, message),
      h('ul', {}, h('li', {}, 'Unlimited comments'), h('li', {}, 'Unlimited projects (one per client site)'), h('li', {}, 'Same private, no-account setup')),
      h('div', { class: 'row' }, closeBtn, h('span', { class: 'spacer' }), listBtn, upgradeBtn)
    );
    upgradeBtn.addEventListener('click', () => {
      send('pp:openUpgrade');
      closePanel();
    });
    listBtn.addEventListener('click', () => {
      send('pp:openDashboard', { project: state.project?.domain });
      closePanel();
    });
    closeBtn.addEventListener('click', () => closePanel());
    wirePanelKeys(panel, { onEscape: () => closePanel() });

    layer.append(panel);
    state.panel = { el: panel, kind: 'upgrade', dirty: () => false };
    panel.style.left = `${Math.max(12, (window.innerWidth - panel.offsetWidth) / 2)}px`;
    panel.style.top = `${Math.max(12, (window.innerHeight - panel.offsetHeight) / 2)}px`;
    upgradeBtn.focus({ preventScroll: true });
    announce('Free limit reached.');
  }

  // -------------------------------------------------------------------------
  // Page event interception (capture phase, so we see clicks before the site does)
  // -------------------------------------------------------------------------

  const isOurs = (e) => e.target === host;

  function onMouseMove(e) {
    if (!state.commenting || state.panel || state.busy || isOurs(e)) {
      if (!hl.hidden && (isOurs(e) || state.panel)) hideHighlight();
      return;
    }
    const el = e.target;
    if (!(el instanceof Element) || el === state.hoverEl) return;
    state.hoverEl = el;
    showHighlight(el);
  }

  function blockPageEvent(e) {
    if (!state.commenting || isOurs(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (!state.commenting || isOurs(e)) return;
    blockPageEvent(e);
    if (e.button !== 0 || state.busy) return;

    if (state.panel) {
      // Clicking the page while a note is open: keep unsaved text safe.
      if (state.panel.dirty()) {
        state.panel.el.classList.remove('shake');
        void state.panel.el.offsetWidth;
        state.panel.el.classList.add('shake');
        state.panel.el.querySelector('textarea')?.focus();
        return;
      }
      const wasDraft = state.panel.isNew;
      closePanel({ restoreFocus: false });
      if (wasDraft) discardDraft();
    }
    if (e.target instanceof Element) selectElement(e.target, e.clientX, e.clientY);
  }

  function onKeyDown(e) {
    if (isOurs(e) || e.key !== 'Escape') return;
    if (state.panel) {
      if (!state.panel.dirty()) {
        const wasDraft = state.panel.isNew;
        closePanel();
        if (wasDraft) discardDraft();
      }
      return;
    }
    if (state.commenting) setCommenting(false);
  }

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick']) {
    on(window, type, blockPageEvent, { capture: true });
  }
  on(window, 'click', onClick, { capture: true });
  on(window, 'mousemove', onMouseMove, { capture: true, passive: true });
  on(window, 'keydown', onKeyDown, { capture: true });
  on(window, 'scroll', schedulePosition, { capture: true, passive: true });
  on(window, 'resize', schedulePosition, { passive: true });

  // Periodic check: layout shifts, single-page-app navigation, and our host being removed.
  const ticker = setInterval(() => {
    if (!extensionAlive()) return teardown({ silent: true });
    if (!host.isConnected) document.documentElement.appendChild(host);
    if (location.href !== state.href) {
      state.href = location.href;
      if (!state.panel?.dirty()) {
        closePanel({ restoreFocus: false });
        discardDraft();
      }
      refresh();
    }
    positionPins();
  }, 1000);

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.type === 'pp:exit') {
      teardown();
      sendResponse({ ok: true });
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);

  // -------------------------------------------------------------------------
  // Turning off
  // -------------------------------------------------------------------------

  function teardown({ silent = false } = {}) {
    if (!silent && state.panel?.dirty() && !window.confirm('Discard your unsaved comment?')) return;
    lifetime.abort();
    clearInterval(ticker);
    clearTimeout(refreshTimer);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      /* extension context already gone */
    }
    host.remove();
    // Only clear the flag if this instance still owns it (a newer inject may have started).
    if (window.__pinpointFeedback === instance) window.__pinpointFeedback = false;
    if (!silent) send('pp:modeChanged', { on: false });
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  renderToolbar();
  send('pp:modeChanged', { on: true });
  refresh();
  announce('PinPoint comment mode on. Click any element to leave a comment. Press Escape to pause.');
})();
