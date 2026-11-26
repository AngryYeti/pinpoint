// background.js — the extension's service worker.
//
// Responsibilities:
//   * Toolbar icon click (or Alt+Shift+P): turn comment mode on/off in the CURRENT tab only.
//     Uses activeTab + scripting, so no broad host permissions are needed.
//   * Take screenshots (chrome.tabs.captureVisibleTab) and crop them.
//   * Be the single writer for chrome.storage.local (avoids race conditions).

import * as store from './lib/store.js';
import * as license from './lib/license.js';

const CONTENT_SCRIPT = 'content/overlay.js';
const DASHBOARD_PATH = 'dashboard/dashboard.html';
const BADGE_COLOR = '#4f46e5';

license.startLicenseBackground();

// ---------------------------------------------------------------------------
// Toolbar icon → toggle comment mode
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  toggleCommentMode(tab);
});

async function toggleCommentMode(tab) {
  if (!tab?.id) return;
  try {
    // Is the overlay already running in this tab?
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => Boolean(window.__pinpointFeedback),
    });
    if (probe?.result) {
      await chrome.tabs.sendMessage(tab.id, { type: 'pp:exit' });
    } else {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT] });
    }
  } catch (err) {
    // Chrome blocks extensions on chrome:// pages, the Web Store, the New Tab page, PDFs, etc.
    // Open the comment list instead so the click still does something useful.
    console.info('PinPoint: cannot run on this page:', err?.message);
    await openDashboard({ notice: 'restricted' });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A full page load removes the overlay, so clear the "ON" badge.
  if (changeInfo.status === 'loading') setBadge(tabId, false);
});

function setBadge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? 'ON' : '' }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Dashboard ("popup" window listing all comments)
// ---------------------------------------------------------------------------

async function openDashboard(params = {}) {
  const base = chrome.runtime.getURL(DASHBOARD_PATH);
  const query = new URLSearchParams(params).toString();
  const url = query ? `${base}?${query}` : base;

  // Re-use an already open dashboard instead of stacking windows.
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const existing = contexts.find((c) => c.documentUrl?.startsWith(base) && c.tabId >= 0);
    if (existing) {
      await chrome.tabs.update(existing.tabId, { active: true, url });
      await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
  } catch {
    /* fall through and open a new one */
  }
  await chrome.windows.create({ url, type: 'popup', width: 560, height: 780 });
}

// ---------------------------------------------------------------------------
// Screenshot capture + crop
// ---------------------------------------------------------------------------

const CROP = { pad: 32, minW: 360, minH: 200, maxW: 1000, maxH: 640, outMaxPx: 1100 };

function cropWindow(lo, hi, min, max, click, limit) {
  let start = lo - CROP.pad;
  let size = hi - lo + CROP.pad * 2;
  if (size < min) {
    start = (lo + hi) / 2 - min / 2; // small element → center on the element
    size = min;
  } else if (size > max) {
    start = click - max / 2; // huge element → center on where they clicked
    size = max;
  }
  size = Math.min(size, limit);
  start = Math.max(0, Math.min(start, limit - size));
  return { start, size };
}

async function captureAndCrop(tab, { rect, click, viewport, number }) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());

  // Screenshot pixels per CSS pixel (handles retina screens and browser zoom).
  const scale = bitmap.width / viewport.width;

  const x = cropWindow(rect.left, rect.right, CROP.minW, CROP.maxW, click.x, viewport.width);
  const y = cropWindow(rect.top, rect.bottom, CROP.minH, CROP.maxH, click.y, viewport.height);

  // Keep full sharpness, but never wider than outMaxPx pixels (keeps storage small).
  const outScale = Math.min(scale, CROP.outMaxPx / x.size);
  const outW = Math.max(1, Math.round(x.size * outScale));
  const outH = Math.max(1, Math.round(y.size * outScale));

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, x.start * scale, y.start * scale, x.size * scale, y.size * scale, 0, 0, outW, outH);

  // Outline the element and draw the numbered pin so the screenshot explains itself.
  const k = outW / x.size;
  ctx.strokeStyle = 'rgba(79, 70, 229, 0.9)';
  ctx.lineWidth = Math.max(2, 2 * k);
  ctx.strokeRect((rect.left - x.start) * k, (rect.top - y.start) * k, (rect.right - rect.left) * k, (rect.bottom - rect.top) * k);
  drawPin(ctx, (click.x - x.start) * k, (click.y - y.start) * k, number, Math.max(13, 13 * k));

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.78 });
  return { dataUrl: await blobToDataUrl(blob), width: outW, height: outH };
}

function drawPin(ctx, cx, cy, number, r) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = r * 0.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = BADGE_COLOR;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.lineWidth = r * 0.18;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  if (number != null) {
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.round(r * (String(number).length > 2 ? 0.8 : 1))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(number), cx, cy + r * 0.05);
  }
  ctx.restore();
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

// ---------------------------------------------------------------------------
// Message handlers (from the page overlay and the dashboard)
// ---------------------------------------------------------------------------

const MAX_NOTE = 2000;

function cleanText(value, max) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
}

async function usage() {
  const [data, lic] = await Promise.all([store.getAll({ includeShots: false }), license.getLicense()]);
  return { data, lic, usage: license.usageSummary(data, lic) };
}

const handlers = {
  /** Comments for one page (no screenshots — the overlay doesn't need them). */
  async 'pp:getPage'({ url }) {
    const { data, usage: u } = await usage();
    const pageKey = store.pageKeyOf(url);
    const domain = store.domainOf(url);
    return {
      ok: true,
      pageKey,
      project: data.projects[domain] || null,
      comments: data.comments.filter((c) => c.pageKey === pageKey),
      usage: u,
    };
  },

  async 'pp:canAdd'({ url }) {
    const { data, lic, usage: u } = await usage();
    const domain = store.domainOf(url);
    const check = license.checkCanAdd(data, domain, lic);
    return { ...check, nextNumber: data.projects[domain]?.nextNumber || 1, domain, usage: u, existingProjects: Object.values(data.projects).map((p) => p.name) };
  },

  async 'pp:capture'(msg, sender) {
    if (!sender.tab) return { ok: false, error: 'No tab' };
    try {
      const image = await captureAndCrop(sender.tab, msg);
      return { ok: true, image };
    } catch (err) {
      // Usually: the activeTab grant ended (page navigated). Saving still works without a picture.
      console.warn('PinPoint: screenshot failed:', err?.message);
      return { ok: false, error: String(err?.message || err) };
    }
  },

  'pp:addComment'(msg) {
    return store.serialize(async () => {
      const { data, lic, usage: u } = await usage();
      const domain = store.domainOf(msg.url);
      const check = license.checkCanAdd(data, domain, lic);
      if (!check.ok) return { ...check, usage: u };

      const note = cleanText(msg.note, MAX_NOTE);
      if (!note) return { ok: false, error: 'Please write a note.' };

      const now = Date.now();
      const project = data.projects[domain] || {
        domain,
        name: domain,
        nextNumber: 1,
        createdAt: now,
      };
      const comment = {
        id: store.newId(),
        domain,
        number: project.nextNumber,
        pageKey: store.pageKeyOf(msg.url),
        url: store.cleanUrl(msg.url),
        pageTitle: cleanText(msg.title, 300) || store.cleanUrl(msg.url),
        selector: cleanText(msg.selector, 2000),
        pin: sanitizePin(msg.pin),
        note,
        priority: store.PRIORITIES.includes(msg.priority) ? msg.priority : 'none',
        status: 'open',
        createdAt: now,
        updatedAt: now,
        hasShot: Boolean(msg.image?.dataUrl),
      };
      project.nextNumber += 1;
      project.updatedAt = now;

      const shot = isValidShot(msg.image) ? msg.image : null;
      comment.hasShot = Boolean(shot);
      await store.putProject(project);
      await store.putComment(comment, shot);
      return { ok: true, comment };
    });
  },

  'pp:updateComment'({ id, patch = {} }) {
    return store.serialize(async () => {
      const comment = await store.getComment(id);
      if (!comment) return { ok: false, error: 'Comment not found' };
      if ('note' in patch) {
        const note = cleanText(patch.note, MAX_NOTE);
        if (!note) return { ok: false, error: 'Please write a note.' };
        comment.note = note;
      }
      if (store.PRIORITIES.includes(patch.priority)) comment.priority = patch.priority;
      if (store.STATUSES.includes(patch.status)) comment.status = patch.status;
      comment.updatedAt = Date.now();
      await store.putComment(comment);
      return { ok: true, comment };
    });
  },

  'pp:deleteComment'({ id }) {
    return store.serialize(async () => {
      await store.removeComment(id);
      return { ok: true };
    });
  },

  'pp:renameProject'({ domain, name }) {
    return store.serialize(async () => {
      const project = await store.getProject(domain);
      if (!project) return { ok: false, error: 'Project not found' };
      project.name = cleanText(name, 120) || project.domain;
      project.updatedAt = Date.now();
      await store.putProject(project);
      return { ok: true, project };
    });
  },

  'pp:deleteProject'({ domain }) {
    return store.serialize(async () => {
      await store.removeProject(domain);
      return { ok: true };
    });
  },

  async 'pp:getUsage'() {
    return { ok: true, ...(await usage()).usage };
  },

  async 'pp:openDashboard'({ project }) {
    await openDashboard(project ? { project } : {});
    return { ok: true };
  },

  async 'pp:openUpgrade'() {
    await license.openUpgradePage();
    return { ok: true };
  },

  async 'pp:modeChanged'({ on }, sender) {
    if (sender.tab?.id != null) setBadge(sender.tab.id, on);
    return { ok: true };
  },
};

function sanitizePin(pin = {}) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const ratio = (v) => Math.min(1, Math.max(0, num(v, 0.5)));
  return {
    xRatio: ratio(pin.xRatio),
    yRatio: ratio(pin.yRatio),
    pageX: num(pin.pageX),
    pageY: num(pin.pageY),
    viewportWidth: num(pin.viewportWidth),
  };
}

function isValidShot(image) {
  return (
    image &&
    typeof image.dataUrl === 'string' &&
    image.dataUrl.startsWith('data:image/jpeg;base64,') &&
    image.dataUrl.length < 3_000_000
  );
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from this extension's own pages and content script.
  if (sender.id !== chrome.runtime.id) return false;
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (err) => {
      console.error('PinPoint:', msg.type, err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    });
  return true; // keep the channel open for the async response
});
