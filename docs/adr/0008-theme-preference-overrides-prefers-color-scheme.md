# A stored Theme Preference overrides prefers-color-scheme on both the popup and the on-video surfaces

Until now, both color surfaces the extension owns — the action popup (`popup.html`'s inline `:root`) and every on-video Note surface (the `--ytb-*` tokens injected by `theme.js`) — followed the OS via `@media (prefers-color-scheme)`, independently and with no manual control (DESIGN.md 1.5: "Theme follows `prefers-color-scheme`"). Users asked to pick Light or Dark explicitly.

Two options were on the table: (a) a popup-only toggle, leaving the on-video Notes still tracking `prefers-color-scheme`; or (b) one preference that drives **both** surfaces. We chose (b): a single **Theme Preference** (`light` | `dark` | `system`, default `system`) stored per install in `chrome.storage.local`.

## Decision

- The preference is applied by stamping an explicit theme marker (`data-theme="light"` / `data-theme="dark"`) on the document root; `system` leaves it **unset**.
- Both stylesheets gain `:root[data-theme="dark"]` and `:root[data-theme="light"]` blocks that carry the same warm-espresso and cream token sets as today's media-query blocks. Because an attribute selector has higher specificity than `@media (prefers-color-scheme)`'s bare `:root`, an explicit preference **wins** over the OS default, while `system` (no attribute) falls through to the untouched media query. The existing `@media` block stays as the System path.
- `theme.js` reads the stored preference asynchronously on load and stamps the marker on the watch page; the popup does the same for its own document. Both subscribe to `chrome.storage.onChanged` for `theme`, so changing the preference in the popup restyles an already-open YouTube tab live, and vice versa — consistent with ADR-0001 (content scripts own on-page rendering; no background worker).

## Consequences

- On-video Notes **no longer track YouTube's or the OS theme** when an explicit preference is set — a deliberate divergence, so the extension's popup and on-video surfaces always agree with each other and with the user's choice. Under `system` behavior is exactly as before.
- DESIGN.md 1.5's "theme follows `prefers-color-scheme`" is reframed as the **System default**, not an absolute; the forced modes are new first-class states.
- A forced theme can now oppose the OS (Dark chosen on a light OS, or Light on a dark OS). Both forced token sets must pass the same AA contrast bar the media-query sets meet today — verify Light-on-dark-OS and Dark-on-light-OS explicitly, on both the popup and an on-video panel/card, before shipping.
- The reaction previews/bursts remain the transparent emoji-over-video exception; the marker changes only the token values they draw from, not their transparent treatment.
- Reversible in principle (drop the attribute blocks, restore pure media-query following), but it changes the documented on-video theming contract in DESIGN.md and `theme.js`, hence this record.
