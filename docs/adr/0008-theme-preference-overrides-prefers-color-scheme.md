# A stored Theme Preference overrides prefers-color-scheme on every extension surface

Until now, both color surfaces the extension owns — the action popup (`popup.html`'s inline `:root`) and every on-video Note surface (the `--ytb-*` tokens injected by `theme.js`) — followed the OS via `@media (prefers-color-scheme)`, independently and with no manual control (DESIGN.md 1.5: "Theme follows `prefers-color-scheme`"). Users asked to pick Light or Dark explicitly.

Two options were on the table: (a) a popup-only toggle, leaving the on-video Notes still tracking `prefers-color-scheme`; or (b) one preference that drives **both** surfaces. We chose (b): a single **Theme Preference** (`light` | `dark` | `system`, default `system`) stored per install in `chrome.storage.local`.

## Decision

- The preference is applied by stamping an explicit theme marker (`data-theme="light"` / `data-theme="dark"`) on the document root; `system` leaves it **unset**.
- `theme.js` supplies the shared `--ytb-*` token sets and the `:root[data-theme="dark"]` and `:root[data-theme="light"]` overrides. An explicit preference wins over the operating-system media query because the attribute selector has higher specificity.
- `theme.js` reads the stored preference and stamps the marker in both contexts. Changing Theme Preference in Room Home restyles the Extension Popup and every open YouTube tab through `chrome.storage.onChanged`; no background worker participates.

## Consequences

- In-page surfaces no longer track YouTube or the operating system when an explicit preference is set. The Extension Popup and in-page surfaces agree with the viewer's choice.
- DESIGN.md 1.5's "theme follows `prefers-color-scheme`" is reframed as the **System default**, not an absolute; the forced modes are new first-class states.
- A forced theme can oppose the operating system. Verify Light on a dark system and Dark on a light system on the Extension Popup, Room Home, and an on-video card.
- The reaction previews/bursts remain the transparent emoji-over-video exception; the marker changes only the token values they draw from, not their transparent treatment.
- Reversible in principle (drop the attribute blocks, restore pure media-query following), but it changes the documented on-video theming contract in DESIGN.md and `theme.js`, hence this record.
