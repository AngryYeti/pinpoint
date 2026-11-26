# PinPoint Feedback

A cheap, no-account visual feedback tool for freelance web designers.
Your client clicks anywhere on a live website, leaves a pinned comment, and exports a PDF punch list of every change.

- **No account, no server.** Everything is stored in the browser (`chrome.storage.local`).
- **Minimal permissions:** `activeTab`, `scripting`, `storage`, `downloads`. No "read all your websites" warning.
- **Manifest V3, plain JavaScript.** No framework and no build step.

---

## 1. Install it in Chrome (Load unpacked)

You don't need to build anything. Follow these steps:

1. **Get the folder onto your computer.** Download/unzip it so you have a folder called `pinpoint-feedback` that contains `manifest.json`.
2. Open Chrome and type `chrome://extensions` in the address bar, then press Enter.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** (top-left).
5. Choose the `pinpoint-feedback` folder, the one that directly contains `manifest.json`, and click **Select**.
6. PinPoint Feedback now appears in the list. Click the **puzzle-piece icon** in Chrome's toolbar, then the **pin** next to PinPoint Feedback so its icon stays visible.

> **Changed a file?** Go back to `chrome://extensions` and click the circular **reload** arrow on the PinPoint card, then reload the website tab you're testing on.

## 2. How to use it

| Step | What to do |
| --- | --- |
| Start | Open any website and **click the PinPoint icon** (or press **Alt+Shift+P**). A dark toolbar appears in the bottom-right corner and the icon shows **ON**. |
| Comment | Hover to see elements highlighted, then **click one**. A numbered pin drops and a note box opens. Type the change, optionally pick a priority, then **Save** (or press Ctrl+Enter). |
| Edit | Click any pin to edit the note, change the priority, **Mark as done**, or **Delete**. |
| Browse normally | Click **Pause** (or press Esc) to use links and menus on the page. Pins stay visible. Click **Resume** to keep commenting. |
| See everything | Click **All comments** in the toolbar. A window opens listing every comment, grouped by page. You can rename the project there (for example "Acme Bakery Redesign"). |
| Export | In that window: **Export PDF**, **Export CSV**, or **Copy as text**. The All / Open / Done filter decides which comments are exported. |
| Stop | Click **✕** on the toolbar, or click the PinPoint icon again. |

Pins come back automatically when you open the same page again and turn PinPoint on.

**Other ways to open the comment list:** right-click the PinPoint icon and choose **Options**, or click the icon on a page where extensions can't run (like the New Tab page).

If **Alt+Shift+P** does nothing, open `chrome://extensions/shortcuts` and assign that shortcut to PinPoint. Chrome sometimes leaves the suggested shortcut unassigned until you set it.

### Free plan limits

- 1 project (projects are keyed by site domain, e.g. `client.com`)
- 15 comments in total

Past that, a friendly upgrade prompt appears. Deleting comments or a project frees up space.

**To test "Pro" before payments exist:** open the comment list window, right-click → **Inspect** → **Console** tab, and paste:

```js
chrome.storage.local.set({ 'license:devOverride': 'pro' })
```

To go back to Free:

```js
chrome.storage.local.remove('license:devOverride')
```

---

## 3. File tree

```
pinpoint-feedback/
├── manifest.json            Extension config (MV3, permissions, icons, shortcut)
├── background.js            Service worker: icon click, screenshots + cropping, all saving
├── content/
│   └── overlay.js           Injected into the page on icon click: highlight, pins, note box (Shadow DOM)
├── dashboard/
│   ├── dashboard.html       "All comments" popup window
│   ├── dashboard.css
│   └── dashboard.js         Lists, edits, filters, exports
├── lib/
│   ├── store.js             All chrome.storage.local access + page/domain keys
│   ├── license.js           Placeholder license check + free limits (ExtensionPay goes here)
│   ├── export.js            PDF / CSV / text builders
│   ├── jspdf.umd.min.js     jsPDF 4.2.1, bundled locally (MIT)
│   └── jspdf.LICENSE.txt
├── pages/
│   ├── privacy.html         Privacy policy (nothing leaves the device)
│   ├── upgrade.html         Placeholder "Pro coming soon" page
│   └── page.css
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── README.md
└── STORE_LISTING.md         Chrome Web Store description text
```

### How it works (short version)

- **Permissions.** Clicking the icon gives the extension temporary access to *that one tab* (`activeTab`). `background.js` then injects `content/overlay.js` with `chrome.scripting`. Nothing runs on any site until you click.
- **No style clashes.** All overlay UI lives in a closed **Shadow DOM** attached to a `<pinpoint-feedback>` element. Site CSS can't reach in, and our CSS can't leak out.
- **Screenshots.** When you click an element, the overlay hides itself and the background calls `chrome.tabs.captureVisibleTab`. It then crops the area around the element on an `OffscreenCanvas`, draws the numbered pin on it, and saves it as a small JPEG.
- **Finding the element again.** Each comment stores a CSS selector plus the click position *relative to the element*. If the element can't be found later, the pin falls back to its page coordinates and gets a dashed outline.
- **Storage.** One key per record (`project:<domain>`, `comment:<id>`, `shot:<id>`). Only the background script writes, one operation at a time, so saves never collide.

---

## 4. Adding payments later (ExtensionPay)

Payments are **not** wired up. Everything goes through `lib/license.js`, so this is the only file you'll change:

1. Sign up at [extensionpay.com](https://extensionpay.com), register your extension, and set a price.
2. In a terminal, inside a scratch folder, run:

   ```bash
   npm install extpay
   ```

   Then copy `node_modules/extpay/dist/ExtPay.module.js` and `node_modules/extpay/dist/ExtPay.js` into `pinpoint-feedback/lib/`.
3. Add ExtensionPay's content script to `manifest.json`. It only runs on extensionpay.com:

   ```json
   "content_scripts": [{
     "matches": ["https://extensionpay.com/*"],
     "js": ["lib/ExtPay.js"],
     "run_at": "document_start"
   }]
   ```

4. In `lib/license.js`, replace the placeholder functions with the ExtensionPay versions shown in the comment at the top of that file.
5. Update `pages/privacy.html` to mention the payment provider, and reload the extension.

---

## 5. Publishing to the Chrome Web Store

Before you submit, you will need:

1. A **support email** in `pages/privacy.html` (replace `hello@yetimedia.pro`).
2. A **public privacy policy URL**. The Web Store will not accept the file inside the extension. Host `pages/privacy.html` on GitHub Pages or any site you control, then paste that URL into the listing.
3. The one-time **$5 USD** Chrome Web Store developer registration fee (paid in the developer dashboard with a Google account).
4. At least one **screenshot**, 1280×800 or 640×400 pixels (up to 5). A small **promo tile** of 440×280 is optional but recommended — a starter is in `store-assets/promo-440x280.png`. The 16/48/128 icons are already in `icons/`.
5. A zip of the extension with `manifest.json` at the top level. Leave out `.git`, `README.md` and `STORE_LISTING.md`.

Then:

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole), click **New item**, and upload the zip.
2. Copy the text from `STORE_LISTING.md` into the listing, including the single-purpose statement and permission justifications on the **Privacy** tab.
3. Declare that you don't collect user data and that you use no remote code. Paste the public privacy policy URL.

> After you change any file, go back to `chrome://extensions`, click the circular reload arrow on the PinPoint card, and refresh the website tab you're testing on.

> Note about jsPDF: the original library has one link to a CDN script, used only by a "view in browser" mode this extension never calls. That URL was removed from the bundled copy so the package contains no remote code references.

---

## 6. Known limitations (v1)

- **Chrome blocks extensions on some pages:** `chrome://` pages, the New Tab page, the Chrome Web Store, and the built-in PDF viewer.
- **Content inside iframes** (embedded maps, videos, some checkout widgets) can't be selected. Click the area around the iframe instead.
- **Screenshots need a fresh click on the icon after the page navigates.** If a screenshot can't be taken, the comment still saves and the note box tells you.
- **The PDF uses jsPDF's built-in fonts,** which cover English and Western European characters. Emoji and non-Latin scripts show as `?` in the PDF. CSV and "Copy as text" keep them.
- **Storage is about 10 MB.** Screenshots are compressed (usually 10–80 KB each), which is plenty for the free plan. A future Pro plan with hundreds of comments may need the `unlimitedStorage` permission.
- **Commenting needs a mouse or trackpad.** Pins, the note box, the toolbar and the comment list all work fully with the keyboard and screen readers, but choosing a new element does not yet.
