# Task 03 — Extension: foundation (manifest + shared.js + content.js bootstrap)

> Part of the [task breakdown](./INDEX.md). Track: **extension**. Depends on: nothing
> (uses a placeholder backend URL until [02 deploy](./02-backend-deploy.md) supplies the real
> one). **Blocks/feeds:** [04 popup](./04-extension-popup.md),
> [05 reporter](./05-extension-reporter.md), [06 renderer](./06-extension-renderer.md) — they
> all build against the contracts frozen below.

## Goal

Lay the shared skeleton for the Chrome extension:

1. **`extension/manifest.json`** — Manifest V3, the permissions, the popup, and the content
   script `js` array (load order matters).
2. **`extension/shared.js`** — the `window.YTB` global: backend URL constant, config storage
   helpers, the API client, and formatting utils. Used by **both** the popup and the content
   script.
3. **`extension/content.js`** — the bootstrap that owns the **single** SPA-navigation
   detector and emits `ytb:navigate` / `ytb:mutation` events. Reporter and renderer are pure
   consumers of these events — they never detect navigation themselves.

This is PRD plan-of-record step 4 (the manifest half) plus the coordination layer the
reporter/renderer need.

## Why these three files are one task

They are the **contract hub**. Everything else in the extension track is written against the
`YTB` API surface, the manifest's content-script load order, and the `ytb:*` events. Freezing
them in one place lets [04](./04-extension-popup.md), [05](./05-extension-reporter.md), and
[06](./06-extension-renderer.md) run concurrently without colliding.

## Architecture constraints (from [ADR-0001](../docs/adr/0001-content-script-owned-sync.md))

- **No background service worker. No `chrome.alarms`. No `background` entry in the manifest.**
  The content script owns the entire sync loop because the video position only exists in the
  page; a background alarm would do zero useful work when no YouTube tab is open.
- Manifest needs only `storage` + host permissions.

---

## Contracts

These are **frozen**. [04](./04-extension-popup.md), [05](./05-extension-reporter.md), and
[06](./06-extension-renderer.md) depend on them verbatim. If something here must change,
update this section and every consumer task in lockstep.

### Contract A — `extension/manifest.json`

- `"manifest_version": 3`.
- `"permissions": ["storage"]` — nothing else.
- `"host_permissions"`: `"*://*.youtube.com/*"` **and** the backend URL (`BACKEND_URL`,
  initially `"http://localhost:8787/*"`; swap to the deployed `…workers.dev/*` after
  [02](./02-backend-deploy.md)). Host permission for the backend is required so `fetch` from
  both the popup and the content script reaches it.
- `"action"`: `{ "default_popup": "popup.html" }` (the popup is built in
  [04](./04-extension-popup.md); just wire it here).
- **`"content_scripts"`** — one entry, matched on YouTube, with this **exact `js` load
  order** (shared first so `YTB` exists; bootstrap last so listeners are attached before the
  initial event fires):
  ```json
  {
    "matches": ["*://*.youtube.com/*"],
    "js": ["shared.js", "reporter.js", "renderer.js", "content.js"],
    "run_at": "document_idle"
  }
  ```
  `reporter.js` and `renderer.js` are created by tasks 05 and 06; list them now. All four
  files run in the **same content-script world / shared global scope**, so they communicate
  via `window.YTB` and `document` events (no ES-module `import` — content scripts are not
  modules).
- **No `background`, no `alarms`.**

### Contract B — `window.YTB` (in `extension/shared.js`)

`shared.js` defines a global `YTB` object and assigns `window.YTB = YTB`. It is loaded by the
popup (`<script src="shared.js"></script>` before `popup.js`) and as the first content-script
file. Content scripts can use `chrome.storage` and `fetch`, so all helpers work in both
contexts.

```js
// extension/shared.js
const YTB = {
  // --- config ---
  BACKEND_URL: "http://localhost:8787", // PLACEHOLDER — replace with deployed URL (task 02)

  // --- storage (chrome.storage.local) ---
  // Stored keys: name (Display Name), code (Friend Code), clientId, sharing (boolean).
  async getConfig() {
    // → { name: string, code: string, clientId: string, sharing: boolean }
    // Apply defaults for unset keys: name "", code "", sharing true.
  },
  async setConfig(partial) {
    // Merge-write the given subset of { name, code, sharing } into chrome.storage.local.
  },
  async ensureClientId() {
    // Return existing clientId, or generate one ONCE (8 hex chars via crypto.getRandomValues)
    // and persist it. Stable per install. → string
  },

  // --- API client (talks to BACKEND_URL; see task 01 for the wire format) ---
  async postProgress({ clientId, name, videoId, timestamp, duration }) {
    // POST BACKEND_URL + "/?code=" + encodeURIComponent(code-from-config or passed in).
    // NOTE: decide whether `code` is read from config inside here or passed in — be
    // consistent and document it in the file. Body is the 5 fields above (no updatedAt).
    // → resolves to { ok: true } | throws/returns falsy on network error (callers tolerate
    //   failure silently per PRD "minimal error handling").
  },
  async getRecords(code) {
    // GET BACKEND_URL + "/?code=" + encodeURIComponent(code).
    // → Array<ProgressRecord> (flat; everyone under the code). On error → [].
  },

  // --- utils ---
  formatTime(seconds) {
    // → "M:SS" or "H:MM:SS" for tooltips. e.g. 412 → "6:52".
  },
  normalizeCode(raw) {
    // Trim + uppercase a Friend Code so "wolf-42" and "WOLF-42" pair. → string
  },
};
window.YTB = YTB;
```

**`ProgressRecord`** (returned by `getRecords`, defined by the backend in
[task 01](./01-backend-data-model.md)):

```ts
{ clientId: string, name: string, videoId: string,
  timestamp: number, duration: number, updatedAt: number }
```

A record is the **Buddy's** iff `record.clientId !== myClientId`. The server does no
filtering; consumers split mine-vs-Buddy themselves.

Decide once and document in `shared.js`: does `postProgress`/`getRecords` read `code` from
config internally, or take it as an argument? Recommended: `getRecords(code)` takes it
(popup already has the code); `postProgress` reads `code` from config (the reporter just
wants to "send my current position"). Whatever you choose, state it in a comment so tasks 04
and 05 call it correctly.

### Contract C — content-script events (from `extension/content.js`)

`content.js` is the **only** place that detects YouTube navigation and DOM churn. It emits
two events on `document`; reporter and renderer subscribe.

- **`ytb:navigate`** — fired **once on initial load** and **on every SPA navigation**.
  ```js
  document.dispatchEvent(new CustomEvent("ytb:navigate", {
    detail: { url: location.href, videoId: <string|null> }
  }));
  ```
  `videoId` is the `v=` param when on a `/watch` page, else `null`.
- **`ytb:mutation`** — **throttled** (e.g. ≤ once per 500ms), fired when the page's DOM
  subtree changes (feed lazy-loads more thumbnails). Renderer uses this to re-apply
  thumbnail bars. No meaningful `detail` required.

How `content.js` should detect navigation (in priority order):

1. Listen for YouTube's own `yt-navigate-finish` event on `document`/`window` (the Polymer
   app fires it on SPA nav) — primary signal.
2. Fall back to comparing `location.href` on a `MutationObserver` of `document.body` (also
   the source of the throttled `ytb:mutation`) and/or a short URL poll.

`content.js` itself does **no** reporting or rendering — it only detects and dispatches. It
must dispatch the initial `ytb:navigate` after the other scripts have attached their
listeners; because the `js` array runs in order and reporter/renderer register listeners
synchronously at top level, `content.js` (last) can dispatch synchronously on load.

---

## `videoId` extraction helper (shared expectation)

The active video's id is the `v=` query param of a `/watch` URL. content.js computes it for
the `ytb:navigate` detail. You may also expose a tiny helper on `YTB` if convenient (e.g.
`YTB.videoIdFromUrl(url)`), but it is not required by the contracts — reporter/renderer can
read `e.detail.videoId`.

## Steps

1. Create `extension/manifest.json` per Contract A.
2. Create `extension/shared.js` per Contract B (full implementations of the stubbed methods).
3. Create `extension/content.js` per Contract C.
4. Load the unpacked extension in Chrome (`chrome://extensions` → Developer mode → Load
   unpacked → select `extension/`) and confirm: it loads without manifest errors, and on a
   YouTube `/watch` page `ytb:navigate` fires (verify via a temporary `console.log` listener,
   then remove it). Reporter/renderer being absent at first is fine — list them in the
   manifest before they exist and Chrome will warn about missing files; create empty stubs or
   coordinate so the three consumer files exist before final load testing.

## Gotchas

- **Content scripts are not ES modules** — no `import`/`export`. Share state via the global
  scope (`window.YTB`) and `document` events. This is why the `js` array order matters.
- **CORS / host permission:** `fetch` to the backend needs the backend URL in
  `host_permissions`; the Worker already returns `Access-Control-Allow-Origin: *`
  (see [task 01](./01-backend-data-model.md)).
- **Placeholder URL:** ship `http://localhost:8787`; swap to the deployed URL from
  [task 02](./02-backend-deploy.md) (also update the host-permission entry).
- Manifest will warn if `reporter.js`/`renderer.js` don't exist yet — that's expected during
  parallel dev; the extension only fully loads once tasks 05/06 land their files.

## Acceptance criteria

- `extension/manifest.json` is valid MV3: `storage` permission, both host permissions, popup
  wired, content-script `js` order = `["shared.js","reporter.js","renderer.js","content.js"]`,
  no `background`/`alarms`.
- `window.YTB` exposes all of Contract B and works from both popup and content-script
  contexts (config round-trips through `chrome.storage.local`; `ensureClientId` is stable).
- `content.js` fires `ytb:navigate` on load and on SPA navigation (with correct `videoId`),
  and throttled `ytb:mutation` on feed changes.

## Consumers (build against the contracts above)

- [04 popup](./04-extension-popup.md) — uses Contract B (config, `getRecords`,
  `normalizeCode`).
- [05 reporter](./05-extension-reporter.md) — uses Contract B (`postProgress`, config) +
  Contract C (`ytb:navigate`).
- [06 renderer](./06-extension-renderer.md) — uses Contract B (`getRecords`, `formatTime`) +
  Contract C (`ytb:navigate`, `ytb:mutation`).
