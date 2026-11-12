# DESIGN.md

Design system for **YouTube Buddy's own surfaces**: the read-only Extension Popup,
the Room Home Panel and its Settings view, and the whole on-video Note UI - Video
Timeline Note Previews, the Expanded Note, the Add Note composer, the @-mention
popover, and Playback Notification cards - delivered via the namespaced injected
tokens in `extension/theme.js` (see 1.5). The on-video
progress-bar markers and feed thumbnail Watched-By Dots (`renderer.js`) remain
**out of scope** and keep their player-native look (flat Buddy-colored dots, dark
tooltip), as does the Add Note button sitting inside YouTube's own control bar.

Personality: **soft, warm, friendly** without being childish. Cozy over corporate.
Warmth comes from color, rounded shape, gentle-but-slightly-springy motion, and a
rounded typeface, **not** from mascots, emoji, or illustration. Keep it timeless and
professional; it must not read as "AI made that."

---

## 1. Foundations

### 1.1 Color

OKLCH is the source of truth (Chrome MV3 = modern Chromium, `oklch()` is supported).
Hex in comments is an approximate reference only. Every neutral is tinted warm toward
the accent hue (~55-62). Never use `#000` / `#fff`.

Accent hue anchor: **~55** (soft orange / apricot). The palette is a **Restrained**
color strategy: warm-tinted neutrals carry the surface, one accent family does the
lifting. No second saturated color competes.

```css
:root {
	/* --- Accent: soft apricot ramp (hue ~55) --- */
	--ytb-accent-050: oklch(97.5% 0.018 62); /* #FFF3E9  cream tint / panel wash */
	--ytb-accent-100: oklch(94% 0.045 60); /* #FCE4CE  hover wash, chips */
	--ytb-accent-200: oklch(88% 0.075 58); /* #F8C79A  soft fill, focus halo */
	--ytb-accent-400: oklch(80% 0.1 56); /* #F6B47D */
	--ytb-accent-500: oklch(76% 0.115 55); /* #F6A96B  PRIMARY accent (fills) */
	--ytb-accent-600: oklch(70% 0.13 52); /* #E88B45  hover on fills */
	--ytb-accent-700: oklch(60% 0.14 50); /* #C7712F  DEEP: press, text-on-tint */
	--ytb-accent-800: oklch(50% 0.13 48); /* #9E551F  strong text on cream */

	/* --- Warm neutrals (hue ~58, very low chroma) --- */
	--ytb-surface: oklch(99.2% 0.006 62); /* #FFFDFB  popup background */
	--ytb-surface-tint: oklch(97.5% 0.018 62); /* #FFF3E9  cream sub-panels */
	--ytb-surface-sunk: oklch(95% 0.02 60); /* #F4E9DE  input wells */
	--ytb-line: oklch(91% 0.018 60); /* #ECE1D6  borders / dividers */
	--ytb-line-strong: oklch(85% 0.025 58); /* #DECEBE  input borders */
	--ytb-ink: oklch(28% 0.022 50); /* #3A2E28  primary text (warm ink) */
	--ytb-ink-muted: oklch(52% 0.028 52); /* #7A6656  secondary / meta text */
	--ytb-ink-faint: oklch(64% 0.025 54); /* #A08A78  placeholders, disabled */

	/* --- Semantic (all kept warm so nothing clashes with the orange) --- */
	--ytb-success: oklch(68% 0.14 150); /* #3FA860  paired / "sharing on" */
	--ytb-danger: oklch(55% 0.16 30); /* #C0392B  leave room, warm red */
	--ytb-danger-hover: oklch(49% 0.155 30); /* #A5312A */
	--ytb-neutral: oklch(40% 0.02 52); /* #5A4B40  "stop sharing" confirm */
	--ytb-neutral-hover: oklch(34% 0.02 52); /* #473A31 */

	/* --- Focus + elevation (tinted, never gray) --- */
	--ytb-ring: oklch(76% 0.115 55 / 0.55); /* apricot focus ring */
	--ytb-e-pop: 0 6px 20px oklch(52% 0.06 52 / 0.2); /* color grid popover */
	--ytb-e-dialog: 0 12px 34px oklch(45% 0.06 52 / 0.26); /* confirm modal */
}
```

**Contrast contract (WCAG AA):**

- `--ytb-ink` on `--ytb-surface` / `--ytb-surface-tint`: pass (>= 8:1).
- `--ytb-ink-muted` on `--ytb-surface`: pass for text >= 11px (>= 4.5:1).
- **Filled primary button = apricot `--ytb-accent-500` fill with `--ytb-ink` text.**
  Pastel apricot is too light for white text; dark warm ink on apricot passes AA and
  is the intended cozy look. White text only ever appears on `--ytb-danger` /
  `--ytb-neutral` (the confirm buttons), never on the accent.
- The paired-green and danger-red are used for small meaning cues (status, leave),
  never as large fields.

### 1.2 Typography

**Face:** bundle **Nunito** (a rounded, high-legibility humanist sans, SIL OFL, safe
to embed) as a subset variable `woff2`, base64 inlined via `@font-face` in
`theme.js`. Loading the same file in the popup and content scripts guarantees warm letterforms on every OS
(Windows/Linux users do not have a rounded system font). Subset to Latin-basic plus
the punctuation actually used; target < 40KB. Fall back to `ui-rounded, system-ui`.

```css
@font-face {
	font-family: 'YTB Rounded';
	src: url(data:font/woff2;base64,<SUBSET_NUNITO_VARIABLE>) format('woff2');
	font-weight: 400 800; /* variable */
	font-display: swap;
}
:root {
	--ytb-font: 'YTB Rounded', ui-rounded, 'SF Pro Rounded', system-ui, sans-serif;
}
```

**Type scale** (13px base; hierarchy via weight contrast >= 1.25 and size):

| Token       | Size / line | Weight | Use                                                                                                                                       |
| ----------- | ----------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--t-code`  | 16px / 1.2  | 800    | The pretty Room Code ("The Silly Otters") in Room Home. Color `--ytb-accent-800`.                                                         |
| `--t-title` | 15px / 1.2  | 800    | Reserved surface title.                                                                                                              |
| `--t-body`  | 13px / 1.45 | 400    | Default body, inputs, buttons (buttons 600).                                                                                              |
| `--t-label` | 11px / 1.3  | 600    | Section eyebrows. **Sentence case, no uppercase, minimal letter-spacing** (uppercase reads colder; softer here). Color `--ytb-ink-muted`. |
| `--t-meta`  | 11px / 1.3  | 500    | Buddy last-seen, backend URL, footnotes. Color `--ytb-ink-muted`.                                                                         |

Body line length is a non-issue at 300px; never let a paragraph exceed ~40ch here.

### 1.3 Space, radius, size

```css
:root {
	--ytb-sp-1: 4px;
	--ytb-sp-2: 8px;
	--ytb-sp-3: 12px;
	--ytb-sp-4: 16px;
	--ytb-sp-5: 20px;
	--ytb-sp-6: 24px;
	--ytb-r-sm: 8px; /* inputs, small controls */
	--ytb-r-md: 12px; /* buttons, chips, roster rows */
	--ytb-r-lg: 16px; /* sub-panels, confirm dialog */
	--ytb-r-pill: 999px; /* status indicator, sharing pill */
}
```

- **Popup width: 320px** (up from 300 for breathing room), padding `--ytb-sp-4`.
- Use **rhythmic**, not uniform, spacing: tighter within a group (label -> control =
  `--ytb-sp-1`), looser between groups (`--ytb-sp-4`/`--ytb-sp-5`). Same-padding-everywhere is a ban.
- Generous radius everywhere is the friendliness lever, with **one exception**: the
  buddy **color swatches stay 2px-radius squares** because they are the legend for the
  square on-video markers drawn by `renderer.js`. Do not round them into circles.
- Keep every pointer target at least 24px.

### 1.4 Elevation

Two levels only, both warm-tinted (see `--ytb-e-pop`, `--ytb-e-dialog`). No glassmorphism and no
blur. The Extension Popup contains only its destination button. Room Home uses one grouped card per Settings section.

### 1.5 Shared delivery (namespaced injected tokens)

Every extension surface consumes this system through `extension/theme.js`, loaded right
after `shared.js`. It injects one `:root` stylesheet
into the watch page exposing every token above under a **`--ytb-*` prefix**
(`--ytb-accent-500`, `--ytb-ink`, `--ytb-r-lg`, `--ytb-ease-spring`, ...) so nothing
can collide with YouTube's own custom properties, plus the `@font-face` for
`'YTB Rounded'`. The Nunito base64 subset lives ONLY in theme.js; `popup.html`
loads the same file as a plain `<script>` so both contexts share one blob.

Surface-specific rules:

- **Opaque over video.** Panels and cards are fully opaque (`--ytb-surface`: cream
  in light, espresso in dark) with the elevation shadows, so text stays legible over
  bright frames. Reaction previews/bursts are the deliberate exception — transparent
  emoji-over-video with a text shadow, since they are not cards.
- **Theme Preference: forced Light/Dark, or Auto** (ADR-0008/0009). An explicit
  Light/Dark choice in Settings stamps `data-theme="light"|"dark"` on the
  document root, and the `:root[data-theme=...]` token blocks in `theme.js`
  out-specify the media query, so a forced mode wins over the OS in
  both directions. The third option is **Auto** (stored `'system'`): on YouTube
  pages the marker follows YouTube's own theme (`<html dark>` maps to
  `data-theme`, restamped live on the `ytb:yt-theme` flip content.js emits) so
  in-page surfaces match their surroundings; in the popup — which cannot see a
  page — Auto leaves the marker unset and falls back to `prefers-color-scheme`.
  The pure marker decision lives in `shared.js` (`YTB.themeMarker`).
- **The Room Home Panel** (ADR-0005) is a normal token surface: it consumes
  these `--ytb-*` tokens with no private palette, so it follows the Theme
  Preference — including Auto tracking YouTube's theme — exactly like the Note UI.
  Its thumbnail Dismiss keeps a fixed dark scrim + light glyph (a media overlay,
  the same exception as reaction previews), not a palette color.
- The dark block also flips the light washes (`--ytb-accent-050/100/200`) dark and
  lifts `--ytb-danger-text`, so
  "hover = accent-050 wash" and "errors = danger-text" read correctly in both
  themes. `--ytb-on-accent` / `--ytb-on-fill` match the popup's fill-text contract.
- theme.js also owns **keystroke isolation** for on-video YTB inputs (a
  window-capture guard that replays keydowns on the Add Note / Reply textareas as
  non-bubbling clones, so YouTube player hotkeys never fire while typing) and the
  inline SVG icon factory (`YTBTheme.icon`) honoring the no-emoji-as-icon rule.

---

## 2. Motion

Personality: **gentle base, subtle spring on confirmations and arrivals.** Warm, not
frantic. Everything degrades under `prefers-reduced-motion` to opacity-only or none.
Never animate layout properties (width/height/top/left) for choreography — use
`transform` and `opacity`.

```css
:root {
	--ytb-dur-quick: 140ms;
	--ytb-dur-base: 200ms;
	--ytb-dur-slow: 300ms;
	--ytb-ease-out: cubic-bezier(0.22, 1, 0.36, 1); /* ease-out-quint, default */
	--ytb-ease-spring: cubic-bezier(0.34, 1.3, 0.64, 1); /* mild overshoot, "settle" */
}
@media (prefers-reduced-motion: reduce) {
	/* springs -> ease-out, transforms -> none, keep short opacity fades */
}
```

**Choreography (the "subtle spring" moments):**

- **Buttons:** press = scale 0.97 (`--ytb-dur-quick`); release settles back with
  `--ytb-ease-spring`. Hover = background/color glide only.
- **View switch:** Settings replaces the normal Room Home content without resizing the shell.
- **Switches:** the knob glides between states without bounce.
- **Unseen Note Dot** (on-video): an expanding apricot halo pulses outward from the dot
  (`box-shadow: 0 0 0 Npx` with N 0 -> 6px, opacity 0.75 -> 0; ~1.6s loop, `--ytb-ease-out`),
  until the Mention or Reply is Acknowledged. The 6px dot itself never moves, resizes, or
  recolors — the timeline is dense and a neighbouring dot may sit only 11px away. Under
  reduced-motion the halo becomes a **static gap ring**, no animation: a 1px `#0f0f0f`
  separator against the fill, then a 2px accent ring outside it
  (`box-shadow: 0 0 0 1px #0f0f0f, 0 0 0 3px var(--ytb-accent-500)`). The gap is what makes
  the ring legible and is not optional: the dot is filled with a Buddy Color, and an accent
  ring laid flush against one scores 1.01-2.51:1 on **every** color in the palette (1.06:1
  on `#f0a500`), so the two merge into a single fatter dot. The separator carries the
  contrast instead — >= 3.69:1 against every Buddy Color, 8.7:1 against the ring — and a
  reduced-motion viewer, who has no pulse to fall back on, keeps an Unseen cue they can
  actually see. Any future restyle of this ring must hold both edges at >= 3:1.

The Unseen Note Dot is the only looping animation. It means something is waiting on you.

Springs are **mild** (overshoot < ~6%). This intentionally relaxes impeccable's
strict no-bounce guidance for personality; keep it restrained so it reads warm, not toy-like.

---

## 3. Component playbook

### Extension Popup

Keep the Extension Popup at 320px wide with one full-width primary button labelled **Your Room**. Show inline feedback only if launch fails. Do not render branding, status, or Settings controls. Close the popup after Room Home opens and its YouTube tab is activated.

### Room Home Panel

Keep the fixed, left-docked 480px portrait shell over a dim scrim. The shell owns two mutually exclusive views:

- The normal view stacks Room Feed above Recommendations.
- The Settings view replaces that content with Profile, Room, On-video, and Appearance sections in one scroll.

Show a gear in the normal header. Show Back in the Settings header. Keep Close available in both views. Closing, scrim click, Escape, and single-page navigation remove the panel. Reopening chooses the initial view from the current Room state: Waiting and In room open the normal view; Unpaired and Room full open Settings.

Do not move focus, scroll, or highlight a control for Room full. Trap Tab inside the open panel. If a confirmation is open, Escape dismisses it before a later Escape can close Room Home.

The Buddy Room toggle matches whichever YouTube guide is active: a 40px row in the full guide or a 64x76px entry in the compact mini guide. Keep the buddies icon as the only open-state color change.

### Settings sections

Profile contains one Nickname input. Persist edits to local storage and reassert presence on Enter or blur so Buddies receive the new Display Name.

Room shows Room state and Room Code first. Unpaired and Room full show Create and Join. Waiting and In room show the Buddy roster, a Buddy Color Swatch for each Buddy, and Leave Room. Use the eight fixed Buddy Colors, disable colors assigned to another Buddy, and mark the selected color with the focus-ring token.

On-video contains four switches in this order: Share video progress, Notes Visibility, Buddy Progress Visibility, and Spoiler Default. Put the four-edge Notification Position picker below them. Keep Stop sharing behind a confirmation.

Appearance contains the segmented Theme Preference control: Light, Dark, and Auto.

### Confirmation dialog

Render confirmations inside Room Home, never with `window.confirm`. Use the surface token, large radius, and dialog shadow over a warm translucent backdrop. Focus Cancel when the dialog opens. Leave Room uses the danger fill; Stop sharing uses the neutral action style.

### Your Room launch

Reuse the active tab only when its URL is the YouTube home route. Create a new inactive YouTube Home tab for a watch page, another YouTube route, another site, or no active tab. Retry the direct content-script message until Room Home acknowledges that it opened, then activate the tab and dismiss the popup. Reusing the active Home tab also dismisses the popup after acknowledgement. This ordering preserves the viewer's current page, covers delayed content-script startup, and leaves no persisted launch request for a later tab.

---

## 4. Dark mode

Use the shared `--ytb-*` token sets injected by `theme.js` on the Extension Popup and every in-page extension surface. Dark mode stays warm espresso rather than blue-gray or pure black. Keep apricot fills paired with dark warm ink.

A forced Light or Dark Theme Preference stamps the same marker on the popup and every YouTube tab. Under Auto, in-page surfaces follow YouTube and the popup follows the operating system. Verify text and control contrast in both forced modes.

---

## 5. Accessibility and constraints

- Keep every action keyboard operable with a visible `--ytb-ring` focus indicator.
- Keep semantic button, switch, radio, dialog, and status roles.
- Keep text contrast at WCAG AA in Light and Dark.
- Keep minimum pointer targets at 24px.
- Disable transforms and looping motion under `prefers-reduced-motion`.
- Bundle all assets. Do not add a content security policy exception, CDN, or build step.
- Keep UI copy and source comments in printable ASCII.

---

## 6. Decisions locked (2026-09-05)

| Decision  | Choice                                                |
| --------- | ----------------------------------------------------- |
| Accent    | Soft apricot and warm neutrals                        |
| Typeface  | Bundled Nunito with rounded system fallbacks          |
| Popup     | 320px with one Your Room button  |
| Room Home | 480px portrait shell with normal and Settings views   |
| Settings  | Four visible sections in one scroll                   |
| Theme     | Light, Dark, and Auto through shared `--ytb-*` tokens |
| Motion    | Gentle ease-out with reduced-motion fallbacks         |
