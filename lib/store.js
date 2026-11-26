// lib/store.js
// Every read and write to chrome.storage.local goes through this file.
//
// Storage layout (one key per record, so editing one comment never rewrites the others):
//   "project:<domain>" -> { domain, name, nextNumber, createdAt, updatedAt }
//   "comment:<id>"     -> { id, domain, number, pageKey, url, pageTitle, selector, pin,
//                           note, priority, status, createdAt, updatedAt, hasShot }
//   "shot:<id>"        -> { dataUrl, width, height }   (cropped JPEG screenshot)
//
// Only the background service worker WRITES (see background.js). Extension pages may READ.

export const PROJECT_PREFIX = 'project:';
export const COMMENT_PREFIX = 'comment:';
export const SHOT_PREFIX = 'shot:';

export const PRIORITIES = ['none', 'low', 'medium', 'high'];
export const STATUSES = ['open', 'done'];

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|ref)$/i;

/** "https://www.client.com/about" -> "client.com". Projects are keyed by this. */
export function domainOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return 'local-files';
    return u.hostname.replace(/^www\./i, '').toLowerCase() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Identifies "the same page": ignores #hash, trailing slashes and tracking params. */
export function pageKeyOf(url) {
  try {
    const u = new URL(url);
    const params = new URLSearchParams(u.search);
    for (const key of [...params.keys()]) {
      if (TRACKING_PARAMS.test(key)) params.delete(key);
    }
    params.sort();
    const qs = params.toString();
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.replace(/^www\./i, '').toLowerCase()}${path}${qs ? '?' + qs : ''}`;
  } catch {
    return String(url);
  }
}

/** URL without the #hash, used for "Open page" links and exports. */
export function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return String(url);
  }
}

export function newId() {
  return crypto.randomUUID();
}

/** Loads everything. Returns { projects: {domain: project}, comments: [], shots: {id: shot} }. */
export async function getAll({ includeShots = true } = {}) {
  const all = await chrome.storage.local.get(null);
  const projects = {};
  const comments = [];
  const shots = {};
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(PROJECT_PREFIX)) projects[value.domain] = value;
    else if (key.startsWith(COMMENT_PREFIX)) comments.push(value);
    else if (includeShots && key.startsWith(SHOT_PREFIX)) shots[key.slice(SHOT_PREFIX.length)] = value;
  }
  comments.sort((a, b) => a.number - b.number);
  return { projects, comments, shots };
}

export async function getComment(id) {
  const key = COMMENT_PREFIX + id;
  return (await chrome.storage.local.get(key))[key] || null;
}

export async function getProject(domain) {
  const key = PROJECT_PREFIX + domain;
  return (await chrome.storage.local.get(key))[key] || null;
}

export async function putProject(project) {
  await chrome.storage.local.set({ [PROJECT_PREFIX + project.domain]: project });
}

export async function putComment(comment, shot) {
  const items = { [COMMENT_PREFIX + comment.id]: comment };
  if (shot) items[SHOT_PREFIX + comment.id] = shot;
  await chrome.storage.local.set(items);
}

export async function removeComment(id) {
  await chrome.storage.local.remove([COMMENT_PREFIX + id, SHOT_PREFIX + id]);
}

export async function removeProject(domain) {
  const { comments } = await getAll({ includeShots: false });
  const keys = [PROJECT_PREFIX + domain];
  for (const c of comments) {
    if (c.domain === domain) keys.push(COMMENT_PREFIX + c.id, SHOT_PREFIX + c.id);
  }
  await chrome.storage.local.remove(keys);
}

/** True if a storage change event touched projects or comments (not just screenshots). */
export function isDataChange(changes) {
  return Object.keys(changes).some(
    (k) => k.startsWith(PROJECT_PREFIX) || k.startsWith(COMMENT_PREFIX) || k.startsWith('license:')
  );
}

// Runs async write operations one at a time, so two quick saves can't race each other
// (for example, both grabbing the same comment number).
let queue = Promise.resolve();
export function serialize(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}
