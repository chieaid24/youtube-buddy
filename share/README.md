# share/ — frozen shareable build

A snapshot of YouTube Buddy you can hand to a friend **today**, wired to its own
isolated backend so ongoing development in `../extension` and `../backend` never
touches your friend's data.

- **`share/extension/`** — frozen copy of the extension. `BACKEND_URL` (in
  `shared.js`) and `host_permissions` (in `manifest.json`) point at the `stable`
  worker, not `localhost`. Loads as `YouTube Buddy (Shared)` so it can sit next to
  your dev unpacked build without confusion.
- **Backend** — the `stable` worker, defined as an environment in
  `../backend/wrangler.jsonc` (`env.stable`): worker `youtube-buddy-stable` with
  its **own KV namespace** (`PROGRESS` → `2196cd7850b64825af8a5e042f282a31`),
  separate from the dev KV. Shares the source in `../backend/src`, but only
  changes when you explicitly redeploy it.

Live URL: `https://youtube-buddy-stable.aidanchien18-a8d.workers.dev`

## Install (your friend — and you)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. **Load unpacked** → select the `share/extension` folder.
4. Click the extension icon → set a **Display Name** and turn **Sharing** on.
5. One of you **creates** a Friend Code; the others **join** with it. Same code =
   one Group (up to 5 people — you + 4 Buddies). Watch YouTube; you'll see each
   other's position markers, color-coded per Buddy.

To send it: zip the `share/extension` folder and have them unzip + Load unpacked.

## Maintaining the stable backend (you)

Wrangler needs Node ≥ 22 (`nvm use 22`). From `../backend`:

```bash
npx wrangler deploy --env stable     # redeploy the shared worker
npx wrangler tail --env stable       # live logs
```

Day-to-day `npm run dev` / `npm run deploy` only touch the **default** worker —
the stable instance stays put until you run `--env stable`.

## Refreshing this snapshot

When you want the shared build to include newer extension work:

```bash
rm -rf share/extension && cp -r extension share/extension
# then re-apply the two stable pointers:
#   shared.js  → BACKEND_URL = the stable workers.dev URL above
#   manifest.json → name "YouTube Buddy (Shared)", host_permissions = stable URL (not localhost)
```

Your friend re-loads the folder (chrome://extensions → refresh) to pick it up.
