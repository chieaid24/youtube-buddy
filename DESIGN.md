# DESIGN.md

Design system for the **YouTube Buddy action popup** (the panel that opens from the
toolbar icon). Scope is the popup only: `extension/popup.html` (markup + inline CSS)
and `extension/popup.js` (wiring). The on-video progress-bar markers, feed thumbnail
bars, and the note composer are **out of scope** and keep their current look.

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
	--c-accent-050: oklch(97.5% 0.018 62); /* #FFF3E9  cream tint / panel wash */
	--c-accent-100: oklch(94% 0.045 60); /* #FCE4CE  hover wash, chips */
	--c-accent-200: oklch(88% 0.075 58); /* #F8C79A  soft fill, focus halo */
	--c-accent-400: oklch(80% 0.1 56); /* #F6B47D */
	--c-accent-500: oklch(76% 0.115 55); /* #F6A96B  PRIMARY accent (fills) */
	--c-accent-600: oklch(70% 0.13 52); /* #E88B45  hover on fills */
	--c-accent-700: oklch(60% 0.14 50); /* #C7712F  DEEP: press, text-on-tint */
	--c-accent-800: oklch(50% 0.13 48); /* #9E551F  strong text on cream */

	/* --- Warm neutrals (hue ~58, very low chroma) --- */
	--c-surface: oklch(99.2% 0.006 62); /* #FFFDFB  popup background */
	--c-surface-tint: oklch(97.5% 0.018 62); /* #FFF3E9  cream sub-panels */
	--c-surface-sunk: oklch(95% 0.02 60); /* #F4E9DE  input wells */
	--c-line: oklch(91% 0.018 60); /* #ECE1D6  borders / dividers */
	--c-line-strong: oklch(85% 0.025 58); /* #DECEBE  input borders */
	--c-ink: oklch(28% 0.022 50); /* #3A2E28  primary text (warm ink) */
	--c-ink-muted: oklch(52% 0.028 52); /* #7A6656  secondary / meta text */
	--c-ink-faint: oklch(64% 0.025 54); /* #A08A78  placeholders, disabled */

	/* --- Semantic (all kept warm so nothing clashes with the orange) --- */
	--c-success: oklch(68% 0.14 150); /* #3FA860  paired / "sharing on" */
	--c-danger: oklch(55% 0.16 30); /* #C0392B  leave room, warm red */
	--c-danger-hover: oklch(49% 0.155 30); /* #A5312A */
	--c-neutral: oklch(40% 0.02 52); /* #5A4B40  "stop sharing" confirm */
	--c-neutral-hover: oklch(34% 0.02 52); /* #473A31 */

	/* --- Focus + elevation (tinted, never gray) --- */
	--c-ring: oklch(76% 0.115 55 / 0.55); /* apricot focus ring */
	--e-pop: 0 6px 20px oklch(52% 0.06 52 / 0.2); /* color grid popover */
	--e-dialog: 0 12px 34px oklch(45% 0.06 52 / 0.26); /* confirm modal */
}
```

**Contrast contract (WCAG AA):**

- `--c-ink` on `--c-surface` / `--c-surface-tint`: pass (>= 8:1).
- `--c-ink-muted` on `--c-surface`: pass for text >= 11px (>= 4.5:1).
- **Filled primary button = apricot `--c-accent-500` fill with `--c-ink` text.**
  Pastel apricot is too light for white text; dark warm ink on apricot passes AA and
  is the intended cozy look. White text only ever appears on `--c-danger` /
  `--c-neutral` (the confirm buttons), never on the accent.
- The paired-green and danger-red are used for small meaning cues (status, leave),
  never as large fields.

### 1.2 Typography

**Face:** bundle **Nunito** (a rounded, high-legibility humanist sans, SIL OFL, safe
to embed) as a subset variable `woff2`, base64 inlined via `@font-face` in
`popup.html`. This is the one CSP-safe way to guarantee warm letterforms on every OS
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
	--font: 'YTB Rounded', ui-rounded, 'SF Pro Rounded', system-ui, sans-serif;
}
```

**Type scale** (13px base; hierarchy via weight contrast >= 1.25 and size):

| Token       | Size / line | Weight | Use                                                                                                                                     |
| ----------- | ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--t-code`  | 16px / 1.2  | 800    | The pretty Room Code ("The Silly Otters") — hero of Connected view. Color `--c-accent-800`.                                             |
| `--t-title` | 15px / 1.2  | 800    | Popup title "YouTube Buddy".                                                                                                            |
| `--t-body`  | 13px / 1.45 | 400    | Default body, inputs, buttons (buttons 600).                                                                                            |
| `--t-label` | 11px / 1.3  | 600    | Section eyebrows. **Sentence case, no uppercase, minimal letter-spacing** (uppercase reads colder; softer here). Color `--c-ink-muted`. |
| `--t-meta`  | 11px / 1.3  | 500    | Buddy last-seen, backend URL, footnotes. Color `--c-ink-muted`.                                                                         |

Body line length is a non-issue at 300px; never let a paragraph exceed ~40ch here.

### 1.3 Space, radius, size

```css
:root {
	--sp-1: 4px;
	--sp-2: 8px;
	--sp-3: 12px;
	--sp-4: 16px;
	--sp-5: 20px;
	--sp-6: 24px;
	--r-sm: 8px; /* inputs, small controls */
	--r-md: 12px; /* buttons, chips, roster rows */
	--r-lg: 16px; /* sub-panels, confirm dialog */
	--r-pill: 999px; /* status indicator, sharing pill */
}
```

- **Popup width: 320px** (up from 300 for breathing room), padding `--sp-4`.
- Use **rhythmic**, not uniform, spacing: tighter within a group (label -> control =
  `--sp-1`), looser between groups (`--sp-4`/`--sp-5`). Same-padding-everywhere is a ban.
- Generous radius everywhere is the friendliness lever, with **one exception**: the
  buddy **color swatches stay 2px-radius squares** because they are the legend for the
  square on-video markers drawn by `renderer.js`. Do not round them into circles.
- Min hit target 24px; the pencil/copy icon buttons already sit at 30-34px, keep that.

### 1.4 Elevation

Two levels only, both warm-tinted (see `--e-pop`, `--e-dialog`). No glassmorphism, no
blur. Cards are not the default: the popup is one warm surface with grouped content,
not a stack of nested cards. Sub-panels (cream `--c-surface-tint`) are used sparingly
to group the Connected-view status block, never nested.

---

## 2. Motion

Personality: **gentle base, subtle spring on confirmations and arrivals.** Warm, not
frantic. Everything degrades under `prefers-reduced-motion` to opacity-only or none.
Never animate layout properties (width/height/top/left) for choreography — use
`transform` and `opacity`.

```css
:root {
	--dur-quick: 140ms;
	--dur-base: 200ms;
	--dur-slow: 300ms;
	--ease-out: cubic-bezier(0.22, 1, 0.36, 1); /* ease-out-quint, default */
	--ease-spring: cubic-bezier(0.34, 1.3, 0.64, 1); /* mild overshoot, "settle" */
}
@media (prefers-reduced-motion: reduce) {
	/* springs -> ease-out, transforms -> none, keep short opacity fades */
}
```

**Choreography (the "subtle spring" moments):**

- **View switch** (chooser <-> join <-> connected): outgoing fades + slides up 6px
  (`--dur-quick`, `--ease-out`); incoming fades in + slides from 6px below
  (`--dur-base`). Cross-fade, no layout jump.
- **Copy check:** the check icon pops in with `--ease-spring` (small overshoot,
  scale 0.5 -> 1); "Copied!" fades in beside it. This is the signature delight beat.
- **Buttons:** press = scale 0.97 (`--dur-quick`); release settles back with
  `--ease-spring`. Hover = background/color glide only.
- **New buddy row:** when the roster gains a row, it fades + slides in with a soft
  `--ease-spring` settle (`--dur-slow`). Existing rows do not jump.
- **Swatch color pick:** the chosen swatch does a quick one-shot wiggle (rotate +/-4deg,
  ~180ms) then settles. Reduced-motion: instant.
- **Sharing toggle:** the state pill glides color + the dot cross-fades; no bounce.
- **Waiting state:** the peach status dot **breathes** (opacity/scale pulse, ~1.6s
  loop, `--ease-out` in and out). This is the only looping animation. Paused under
  reduced-motion.

Springs are **mild** (overshoot < ~6%). This intentionally relaxes impeccable's
strict no-bounce guidance for personality; keep it restrained so it reads warm, not toy-like.

---

## 3. Component playbook

Mapped to the real popup elements. IDs reference current `popup.html`; the implementer
may restructure DOM but must preserve every behavior and the `YTB` / `YTBRoomCode` call
sequences in `popup.js`.

### Header (`.header`)

- Title "YouTube Buddy" (`--t-title`, `--c-ink`). Optional: a small apricot dot or
  underscore accent, no logo art.
- **Nickname** on the right. Two states on one field (`#name-field`):
  - _Editable_ (`#name` input): warm well (`--c-surface-sunk`), `--r-sm`, right-aligned.
    Placeholder in `--c-ink-faint`. Focus = `--c-line` -> `--c-accent-500` border +
    `--c-ring` halo.
  - _Locked chip_ (`.field-locked`): the value as a soft cream chip with the pencil
    (`#name-edit`) as a bare icon at the right edge, muted, darkening on hover.
- Fresh install (blank name) opens editable (onboarding). Commit on Enter/blur; persists
  every keystroke; re-asserts presence on commit.

### Section eyebrow (`.lbl`)

Sentence case, `--t-label`, muted. "Room code", "Nickname" (not ALL CAPS).

### Chooser (`#view-chooser`)

- Two full-width actions, `--sp-2` gap. **"Create a room"** = primary (apricot fill,
  ink text). **"Join a room"** = secondary (cream `--c-surface-tint`, `--c-line-strong`
  border, ink text). Both `--r-md`, 600 weight.
- `#create-feedback`: inline error line in `--c-danger` ("Couldn't reach the server").
- `#chooser-cancel`: text-only accent link, only shown when a code already exists.

### Join (`#view-join`)

- `#join-input` warm well, `--r-sm`, placeholder "The Something Somethings".
- `#join-submit`: disabled + neutral until input, then promotes to apricot primary.
- `#join-feedback`: inline `--c-danger` ("This room doesn't exist yet").
- `#join-back`: text-only accent link.

### Connected (`#view-connected`)

- **Code label** (`#code`): `--t-code`, `--c-accent-800`, ellipsis-truncates. This is
  the visual hero of the view.
- **Copy** (`#copy-code`): bare icon button, muted -> ink on hover; copy/check icons
  crossfade with the spring pop (see Motion). `#copy-feedback` = "Copied!" in
  `--c-success`, "Could not copy" in `--c-danger`.
- **Status block** in a cream `--c-surface-tint` sub-panel (`--r-lg`, `--sp-3` pad):
  - **Unpaired** (no code) — not shown here (routes to chooser).
  - **Waiting** — breathing peach dot + "Waiting for buddies". Sharing toggle live.
  - **In room** — the roster (see below). Sharing toggle live.
  - **Room full** — muted lock cue + "This code already has N members." Toggle inert.
- **Sharing control** (`#sharing-toggle`): render as a small **pill** with a state dot.
  On = paired-green dot + "Sharing"; Off = muted dot + "Not sharing" (strike-through the
  word on hover as the affordance to stop, matching current intent). **Start is instant;
  stop routes through the confirm dialog.** Keep aria-pressed / aria-label.
- **Roster** (`#roster`): one row per buddy = `[2px square swatch] name .......... 5m ago`.
  Swatch color = `YTB.buddyColor`; clicking it opens the color grid. Name in 600, ink;
  last-seen (`--t-meta`, muted, right-aligned) via the existing relative formatter
  ("just now / 5m ago / 2h ago / 3d ago"). Row hover = faint `--c-accent-050` wash.
- **Leave room** (`#leave-room`): danger-red fill, white text, `--r-md`. Always confirms.

### Color grid popover (`#color-grid`)

- Floating popover, `--e-pop`, `--r-lg`, anchored to the clicked swatch (keep the
  flip-above-when-no-room-below logic). 4-column grid of `YTB.BUDDY_COLORS` squares
  (2px radius, matching markers). Used colors disabled at ~0.28 opacity. Selected =
  `--c-ink` outline ring. Dismiss on outside-click or Escape.

### Confirm dialog (`#confirm-overlay`)

- In-popup modal (never `window.confirm`). Backdrop = warm ink at ~0.32 alpha. Box:
  `--c-surface`, `--r-lg`, `--e-dialog`, `--sp-4` pad. Enters with a soft `--ease-spring`
  scale (0.96 -> 1) + fade. Two variants for the OK button: **danger** (red, "Leave") /
  **neutral** (warm charcoal `--c-neutral`, "Stop sharing"). Cancel = secondary. Dismiss
  via Cancel / backdrop / Escape. This is the one justified modal (destructive confirm).

### Footer (`footer`)

- Divider `--c-line`, then "Backend: <url>" in `--t-meta`, muted. Understated.

---

## 4. Dark mode (warm, cozy)

The popup opens over YouTube in either theme, so support both. Dark is **warm espresso**,
not blue-gray, not pure black. Same accent hue, slightly lifted chroma so apricot still
glows on a dark ground.

```css
@media (prefers-color-scheme: dark) {
	:root {
		--c-surface: oklch(23% 0.014 52); /* warm espresso */
		--c-surface-tint: oklch(27% 0.018 52);
		--c-surface-sunk: oklch(20% 0.014 52);
		--c-line: oklch(33% 0.018 52);
		--c-line-strong: oklch(40% 0.02 52);
		--c-ink: oklch(94% 0.015 68); /* warm cream text */
		--c-ink-muted: oklch(74% 0.02 62);
		--c-ink-faint: oklch(58% 0.018 58);
		--c-accent-500: oklch(78% 0.13 58); /* apricot, a touch brighter */
		--c-accent-700: oklch(68% 0.14 55);
		--c-accent-800: oklch(82% 0.12 60); /* code label glows on dark */
		--e-pop: 0 8px 24px oklch(0% 0 0 / 0.45);
		--e-dialog: 0 14px 40px oklch(0% 0 0 / 0.55);
	}
}
```

Primary buttons in dark mode keep **apricot fill + dark-ink text** (the fill is light
enough that ink still wins contrast). Verify AA in both themes before shipping.

---

## 5. Accessibility & constraints (non-negotiable)

- **CSP:** no external resources at all. Inline all CSS, all SVGs, and the base64 font.
  No CDN, no network fetch for assets, no build step (files load directly; keep the
  `shared.js -> room-code.js -> popup.js` load order).
- **Contracts are read-only:** `window.YTB` (shared.js) and `window.YTBRoomCode`
  (room-code.js) APIs must not change; the backend test suite depends on room-code.js.
- Keyboard: everything operable; visible `--c-ring` focus-visible on all controls.
  Preserve existing roles / aria-live regions / aria-pressed / aria-labels.
- `prefers-reduced-motion`: springs -> ease-out, loops paused, transforms dropped.
- Contrast: meet WCAG AA for text in **both** light and dark themes.
- ASCII-only in source and copy. No em dashes in UI copy.

---

## 6. Decisions locked (2026-07-04)

| Decision            | Choice                                                                       |
| ------------------- | ---------------------------------------------------------------------------- |
| Accent              | Soft apricot / peach pastel (hue ~55), Restrained strategy                   |
| Primary button text | Dark warm ink on apricot (pastel too light for white)                        |
| Typeface            | Nunito, bundled base64 variable woff2, `ui-rounded` fallback                 |
| Motion              | Gentle ease-out base + mild spring on confirms/arrivals; reduced-motion safe |
| Personality         | Warm typographic, no mascots / emoji / illustration                          |
| Theme               | Light primary + warm-espresso dark, both AA                                  |
| Popup width         | 320px                                                                        |

Open for implementation to tune: exact Nunito subset/weights, precise OKLCH nudges after
on-screen contrast checks, whether the sharing control is a pill vs inline toggle.
