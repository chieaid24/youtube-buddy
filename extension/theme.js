// extension/theme.js
//
// The shared on-video design foundation: one injected stylesheet exposing the
// namespaced --ytb-* design tokens (apricot ramp, warm neutrals, semantic
// colors, radii, spacing, motion) mirroring DESIGN.md sections 1/2/4, plus the
// bundled "YTB Rounded" Nunito @font-face. Every token is --ytb-* prefixed so
// nothing collides with YouTube's own custom properties; dark mode follows
// prefers-color-scheme (warm espresso), independent of YouTube's own theme.
//
// This file is the single home of the base64 Nunito subset: popup.html loads
// it as a plain <script> (the popup's @font-face comes from here too), and the
// content-script array loads it right after shared.js so every on-video Note
// surface (notes.js, composer.js, mentions.js) can consume the tokens.
//
// It also owns KEYSTROKE ISOLATION for on-video YTB inputs. YouTube's player
// handles hotkeys in the capture phase (on #movie_player / document), i.e.
// BEFORE any bubble-phase stopPropagation a textarea handler could run — so
// space toggled play while typing. The guard below listens at window capture
// (the only node above YouTube's handlers), swallows key events originating
// from a YTB on-video textarea, and synchronously replays a non-bubbling
// KeyboardEvent clone on that textarea. Existing textarea-level listeners
// (mentions.js first, then the host's Enter/Escape handling — registration
// order is preserved) run against the clone exactly as before; preventDefault
// on the clone is forwarded to the real event so Enter never inserts a
// newline it shouldn't. The character itself still types normally because the
// real event's default action is untouched.
//
// Exposes `window.YTBTheme`:
//   - icon(name) — inline SVG icons ('send', 'play', 'close') built via
//     createElementNS (CSP-safe and Trusted-Types-safe: no innerHTML, no
//     external asset, and not an emoji-as-icon).

(function () {
	'use strict';

	const STYLE_ID = 'ytb-theme';
	const SVG_NS = 'http://www.w3.org/2000/svg';

	// Nunito, subset to printable ASCII (U+0020-007E) with its full wght axis
	// kept intact (limiting the axis corrupts advance widths off the default
	// weight), base64-inlined so no surface ever fetches a font (CSP).
	const NUNITO_WOFF2_BASE64 = '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';

	const TOKENS_CSS = `
@font-face {
	font-family: 'YTB Rounded';
	src: url(data:font/woff2;base64,${NUNITO_WOFF2_BASE64}) format('woff2');
	font-weight: 200 1000;
	font-style: normal;
	font-display: swap;
}
:root {
	/* --- Accent: soft apricot ramp (hue ~55) --- */
	--ytb-accent-050: oklch(97.5% 0.018 62);
	--ytb-accent-100: oklch(94% 0.045 60);
	--ytb-accent-200: oklch(88% 0.075 58);
	--ytb-accent-400: oklch(80% 0.1 56);
	--ytb-accent-500: oklch(76% 0.115 55);
	--ytb-accent-600: oklch(70% 0.13 52);
	--ytb-accent-700: oklch(60% 0.14 50);
	--ytb-accent-800: oklch(50% 0.13 48);

	/* --- Warm neutrals (hue ~58, very low chroma) --- */
	--ytb-surface: oklch(99.2% 0.006 62);
	--ytb-surface-tint: oklch(97.5% 0.018 62);
	--ytb-surface-sunk: oklch(95% 0.02 60);
	--ytb-line: oklch(91% 0.018 60);
	--ytb-line-strong: oklch(85% 0.025 58);
	--ytb-ink: oklch(28% 0.022 50);
	--ytb-ink-muted: oklch(52% 0.028 52);
	--ytb-ink-faint: oklch(64% 0.025 54);

	/* --- Semantic (kept warm so nothing clashes with the orange) --- */
	--ytb-success: oklch(68% 0.14 150);
	--ytb-danger: oklch(55% 0.16 30);
	--ytb-danger-hover: oklch(49% 0.155 30);
	--ytb-danger-text: oklch(53% 0.16 30);
	--ytb-neutral: oklch(40% 0.02 52);
	--ytb-neutral-hover: oklch(34% 0.02 52);
	/* Text on filled buttons: warm near-white on danger/neutral fills, and a
	   FIXED dark warm ink on apricot fills in BOTH themes (pastel apricot is
	   too light for white text) — same contract as the popup. */
	--ytb-on-fill: oklch(99% 0.005 62);
	--ytb-on-accent: oklch(28% 0.022 50);

	/* --- Focus + elevation (tinted, never gray) --- */
	--ytb-ring: oklch(76% 0.115 55 / 0.55);
	--ytb-e-pop: 0 6px 20px oklch(52% 0.06 52 / 0.2);
	--ytb-e-dialog: 0 12px 34px oklch(45% 0.06 52 / 0.26);

	/* --- Type, radius, space, motion --- */
	--ytb-font: 'YTB Rounded', ui-rounded, 'SF Pro Rounded', 'Segoe UI', system-ui, sans-serif;
	--ytb-r-sm: 8px;
	--ytb-r-md: 12px;
	--ytb-r-lg: 16px;
	--ytb-r-pill: 999px;
	--ytb-sp-1: 4px;
	--ytb-sp-2: 8px;
	--ytb-sp-3: 12px;
	--ytb-sp-4: 16px;
	--ytb-sp-5: 20px;
	--ytb-sp-6: 24px;
	--ytb-dur-quick: 140ms;
	--ytb-dur-base: 200ms;
	--ytb-dur-slow: 300ms;
	--ytb-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
	--ytb-ease-spring: cubic-bezier(0.34, 1.3, 0.64, 1);
}
@media (prefers-color-scheme: dark) {
	:root {
		/* Warm espresso, not blue-gray (DESIGN.md section 4). The 050-200
		   washes flip dark so "hover = accent-050 wash" reads right in both
		   themes; danger lifts so it stays legible on espresso. */
		--ytb-accent-050: oklch(29% 0.025 55);
		--ytb-accent-100: oklch(33% 0.035 55);
		--ytb-accent-200: oklch(46% 0.06 55);
		--ytb-accent-500: oklch(78% 0.13 58);
		--ytb-accent-600: oklch(84% 0.125 60);
		--ytb-accent-700: oklch(68% 0.14 55);
		--ytb-accent-800: oklch(82% 0.12 60);
		--ytb-surface: oklch(23% 0.014 52);
		--ytb-surface-tint: oklch(27% 0.018 52);
		--ytb-surface-sunk: oklch(20% 0.014 52);
		--ytb-line: oklch(33% 0.018 52);
		--ytb-line-strong: oklch(40% 0.02 52);
		--ytb-ink: oklch(94% 0.015 68);
		--ytb-ink-muted: oklch(74% 0.02 62);
		--ytb-ink-faint: oklch(58% 0.018 58);
		--ytb-danger-text: oklch(72% 0.15 28);
		--ytb-on-accent: oklch(25% 0.02 50);
		--ytb-ring: oklch(78% 0.13 58 / 0.55);
		--ytb-e-pop: 0 8px 24px oklch(0% 0 0 / 0.45);
		--ytb-e-dialog: 0 14px 40px oklch(0% 0 0 / 0.55);
	}
}
@media (prefers-reduced-motion: reduce) {
	:root {
		--ytb-ease-spring: cubic-bezier(0.22, 1, 0.36, 1);
	}
}
`;

	function injectTheme() {
		if (document.getElementById(STYLE_ID)) return;
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = TOKENS_CSS;
		(document.head || document.documentElement).appendChild(style);
	}
	injectTheme();

	// --- inline SVG icons ---

	const ICON_PATHS = {
		// Paper plane (send).
		send: 'M3.4 20.4a1 1 0 0 1-1.4-.91v-4.62a1 1 0 0 1 .87-.99L17 12 2.87 10.12a1 1 0 0 1-.87-.99V4.51a1 1 0 0 1 1.4-.91l17.45 7.48a1 1 0 0 1 0 1.84L3.4 20.4Z',
		// Play triangle (Go here).
		play: 'M8 5.14v13.72a1 1 0 0 0 1.52.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z',
		// Dismiss cross.
		close: 'M18.3 5.7a1 1 0 0 0-1.4 0L12 10.6 7.1 5.7a1 1 0 0 0-1.4 1.4l4.9 4.9-4.9 4.9a1 1 0 1 0 1.4 1.4l4.9-4.9 4.9 4.9a1 1 0 0 0 1.4-1.4L13.4 12l4.9-4.9a1 1 0 0 0 0-1.4Z',
	};

	function icon(name) {
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', ICON_PATHS[name] || '');
		path.setAttribute('fill', 'currentColor');
		svg.append(path);
		return svg;
	}

	// --- keystroke isolation for on-video YTB inputs ---

	const GUARDED_INPUTS = '#ytb-note-panel textarea, #ytb-note-composer textarea';

	for (const type of ['keydown', 'keyup', 'keypress']) {
		window.addEventListener(
			type,
			(event) => {
				const target = event.target;
				if (!(target instanceof Element) || !target.matches(GUARDED_INPUTS)) return;
				// Nothing below window ever sees the real event — not YouTube's
				// capture-phase player hotkeys, not the page. The default action
				// (typing the character) is deliberately left alone.
				event.stopImmediatePropagation();
				if (type !== 'keydown') return;
				const replay = new KeyboardEvent('keydown', {
					key: event.key,
					code: event.code,
					location: event.location,
					repeat: event.repeat,
					isComposing: event.isComposing,
					ctrlKey: event.ctrlKey,
					shiftKey: event.shiftKey,
					altKey: event.altKey,
					metaKey: event.metaKey,
					bubbles: false,
					cancelable: true,
				});
				target.dispatchEvent(replay);
				if (replay.defaultPrevented) event.preventDefault();
			},
			true,
		);
	}

	window.YTBTheme = { icon };
})();
