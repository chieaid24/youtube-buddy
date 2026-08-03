# Under the Auto Theme Preference, in-page surfaces follow YouTube's own theme, not the OS

Amends ADR-0008.

ADR-0008 made the stored Theme Preference (`light` | `dark` | `system`) drive both the popup and the on-video Note surfaces, with `system` falling through to `prefers-color-scheme` — deliberately independent of YouTube's own theme toggle. The Room Home Section (ADR-0005) never joined that contract: it shipped with its own hardcoded hex palette keyed off YouTube's `html[dark]` attribute, so it followed the page while every other extension surface followed the preference/OS. A viewer with Theme Preference Dark (or a dark OS) on a light YouTube page saw a dark popup and dark Notes next to a light Buddy Room card.

Two ways to close the gap: (a) pull the home card into the ADR-0008 contract as-is (consume the `--ytb-*` tokens, `system` = OS) — but then a YouTube-dark / OS-light viewer gets a glaring light card over a dark page, the exact mismatch the card's `html[dark]` palette was avoiding; or (b) redefine what `system` means for surfaces that live inside YouTube's page.

## Decision

- The third Theme Preference value is renamed **Auto** in the UI (the stored value stays `'system'` — no migration). Forced Light/Dark behavior is unchanged: the explicit `data-theme` marker wins on every surface.
- Under Auto, **in-page surfaces follow YouTube's own theme**: on YouTube pages, `theme.js` stamps `data-theme="dark"` when `<html dark>` is present and `data-theme="light"` when it is not, instead of leaving the marker unset. All `--ytb-*` consumers (Note UI, composer, previews, Room Home Section) follow automatically. The `prefers-color-scheme` media-query blocks remain as the fallback but no longer apply on YouTube pages, where the marker is now always stamped.
- The **popup keeps following the OS** under Auto: it is a separate document that cannot see the page, and importing YouTube's theme would need cross-context plumbing with stale-value edge cases when no YouTube tab is open. `system` there still means "marker unset, media query applies".
- YouTube theme flips are tracked **live**: `content.js` — the sole DOM/navigation observer (ADR-0001 discipline) — watches the `dark` attribute on `document.documentElement` and emits a namespaced event; `theme.js` restamps on it. `theme.js` grows no observer of its own.
- The Room Home Section drops its private hex palette and `html[dark]` block and consumes the shared `--ytb-*` tokens, becoming a normal ADR-0008/0009 surface.
- The home-route guide toggle row is intentionally exempt: it imitates a native YouTube guide row and keeps using YouTube's `--yt-spec-*` variables, following the page in every mode.

## Consequences

- Under Auto, an in-page surface and the popup can disagree (YouTube dark, OS light, or vice versa). Accepted: each surface matches its actual surroundings, and a viewer who wants agreement picks a forced mode.
- Under Auto, the on-video Note UI now tracks YouTube's theme instead of the OS — reversing ADR-0008's "deliberate divergence" for the default case. Forced modes still diverge from YouTube exactly as ADR-0008 describes.
- "Auto" is honest for in-page surfaces ("matches YouTube") and approximately honest for the popup ("matches the OS"); "System" had become misleading, and "Match YouTube" would be wrong for the popup.
- Because the marker is always stamped on YouTube pages, the media-query token blocks effectively serve only the popup's Auto path; they must still be kept in sync with the `data-theme` blocks.
- Reversible by stamping nothing under Auto again (restoring pure OS-follow) and re-hardcoding a page-keyed palette for the home card, but that re-splits the theming contract across surfaces — hence this record.
