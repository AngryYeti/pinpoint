// lib/license.js
// PLACEHOLDER license module. Payments are NOT wired up yet.
//
// Everything that asks "is this user on the paid plan?" goes through getLicense(),
// so plugging in ExtensionPay later only means changing this one file.
//
// ---------------------------------------------------------------------------
// HOW TO PLUG IN EXTENSIONPAY LATER (summary — see README "Adding payments"):
//   1. Create an account + extension at https://extensionpay.com and note your extension ID.
//   2. From the "extpay" npm package, copy dist/ExtPay.module.js AND dist/ExtPay.js
//      into lib/. Bundle them locally — never load them from a URL.
//   3. In manifest.json add the content script ExtensionPay requires:
//        "content_scripts": [{
//          "matches": ["https://extensionpay.com/*"],
//          "js": ["lib/ExtPay.js"], "run_at": "document_start"
//        }]
//   4. Replace the bodies below:
//        import ExtPay from './ExtPay.module.js';
//        const extpay = ExtPay('your-extension-id');
//        export function startLicenseBackground() { extpay.startBackground(); }
//        export async function getLicense() {
//          const user = await extpay.getUser();
//          return { paid: user.paid, plan: user.paid ? 'pro' : 'free', source: 'extensionpay' };
//        }
//        export function openUpgradePage() { extpay.openPaymentPage(); }
// ---------------------------------------------------------------------------

export const FREE_LIMITS = Object.freeze({ projects: 1, comments: 15 });

// Developer switch so you can test the "Pro" experience before payments exist.
// In the dashboard's DevTools console run:
//   chrome.storage.local.set({ 'license:devOverride': 'pro' })    // pretend to be Pro
//   chrome.storage.local.remove('license:devOverride')            // back to Free
const DEV_OVERRIDE_KEY = 'license:devOverride';

/** Called once when the background service worker starts. No-op for now. */
export function startLicenseBackground() {
  // extpay.startBackground();  <- ExtensionPay goes here.
}

/** @returns {Promise<{paid: boolean, plan: 'free'|'pro', source: string}>} */
export async function getLicense() {
  const stored = await chrome.storage.local.get(DEV_OVERRIDE_KEY);
  const paid = stored[DEV_OVERRIDE_KEY] === 'pro';
  return { paid, plan: paid ? 'pro' : 'free', source: paid ? 'dev-override' : 'placeholder' };
}

/** Opens the upgrade page. Swap for extpay.openPaymentPage() later. */
export async function openUpgradePage() {
  await chrome.tabs.create({ url: chrome.runtime.getURL('pages/upgrade.html') });
}

/**
 * Can the user add one more comment on this domain?
 * @param {{projects: object, comments: any[]}} data  from store.getAll()
 * @returns {{ok: true} | {ok: false, reason: 'projects'|'comments'}}
 */
export function checkCanAdd(data, domain, license) {
  if (license.paid) return { ok: true };
  const hasProject = Boolean(data.projects[domain]);
  if (!hasProject && Object.keys(data.projects).length >= FREE_LIMITS.projects) {
    return { ok: false, reason: 'projects' };
  }
  if (data.comments.length >= FREE_LIMITS.comments) {
    return { ok: false, reason: 'comments' };
  }
  return { ok: true };
}

export function usageSummary(data, license) {
  return {
    paid: license.paid,
    plan: license.plan,
    commentCount: data.comments.length,
    projectCount: Object.keys(data.projects).length,
    limits: FREE_LIMITS,
  };
}
