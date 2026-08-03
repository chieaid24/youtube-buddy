// extension/content/shared-geometry.js
// Progress-bar and Note Band geometry on window.YTB, plus the #174 ownership
// predicates - pure math, tested at the shared.js seam.

(() => {
	const YTB = window.YTB;

	Object.assign(YTB, {
		// The bar's chapter segments in bar-local px, measured fresh each call.
		// A chaptered bar is one `.ytp-chapter-hover-container` per chapter
		// (widths proportional to duration, 4px gaps), so a timestamp's x is NOT
		// `fraction * barWidth` (#159). The ONE place that reads YouTube's chapter
		// DOM; the pure mapping is timeToX.
		barSegments(bar) {
			if (!bar) return [];
			const barRect = bar.getBoundingClientRect();
			const segments = [];
			for (const el of bar.querySelectorAll('.ytp-chapter-hover-container')) {
				const rect = el.getBoundingClientRect();
				if (rect.width > 0) segments.push({ left: rect.left - barRect.left, width: rect.width });
			}
			segments.sort((a, b) => a.left - b.left);
			// Chapter DOM not built yet: treat as one unchaptered segment.
			if (segments.length === 0 && barRect.width > 0) segments.push({ left: 0, width: barRect.width });
			return segments;
		},

		// Map a timestamp to its px offset from the bar's left edge through the
		// measured segments (#159): the timestamp's share of total segment width
		// (gaps excluded) lands where YouTube draws its own playhead, never in a
		// gap (a boundary resolves to the earlier chapter's end); an unchaptered
		// bar reduces to `fraction * barWidth` exactly.
		timeToX(segments, timestamp, duration) {
			const segs = (segments || []).filter((s) => s && Number.isFinite(Number(s.left)) && Number(s.width) > 0);
			if (segs.length === 0) return 0;
			const t = Number(timestamp);
			const d = Number(duration);
			const fraction = Number.isFinite(t) && Number.isFinite(d) && d > 0 ? Math.max(0, Math.min(1, t / d)) : 0;
			const total = segs.reduce((sum, s) => sum + Number(s.width), 0);
			const contentPx = fraction * total;
			let consumed = 0;
			for (const s of segs) {
				const width = Number(s.width);
				if (contentPx <= consumed + width) return Number(s.left) + (contentPx - consumed);
				consumed += width;
			}
			const last = segs[segs.length - 1];
			return Number(last.left) + Number(last.width);
		},

		// The Dot Cluster fan (#162): a MINIMUM DISPLACEMENT solve over every
		// dot's at-rest x, constrained only to keep centers >= the Fan Gap apart.
		// A dot with slack never moves; the constraint is GLOBAL, so a Cluster is
		// exactly the set of dots it chains into one rigid block. The Fan Gap
		// opens to `idealGap` where the bar has room and shrinks toward one dot
		// diameter (touch, never cover); only below that floor does the chain
		// center on the bar, overhanging both ends.
		// Solved as an L2 isotonic regression (PAVA): z_i = x_i - i*gap turns
		// "centers >= gap apart, in x order" into "z nondecreasing", whose
		// minimum-displacement fit is the pooled block means; the bar's edges are
		// a box constraint (clamp) on that fit. Pure display math (no DOM).
		// Returns clusters of ORIGINAL indices (left to right), per-dot offsets
		// in INPUT order, and the resolved gap.
		solveDotFan(xs, options) {
			const input = xs || [];
			const opts = options || {};
			const diameter = Math.max(0, Number(opts.dotDiameter) || 0);
			const width = Math.max(0, Number(opts.barWidth) || 0);
			// The floor is the dot diameter itself: fanned dots may touch, never cover.
			const ideal = Math.max(diameter, Number(opts.idealGap) || 0);
			const offsets = new Array(input.length).fill(0);
			const dots = input.map((x, index) => ({ index, x: Number(x) || 0 })).sort((a, b) => a.x - b.x || a.index - b.index);
			const n = dots.length;
			if (n === 0) return { clusters: [], offsets, gap: ideal };

			// The n-1 gaps must fit within (width - diameter); an unmeasured bar
			// imposes no bound and keeps the ideal.
			const bounded = width > diameter;
			const room = bounded ? width - diameter : Infinity;
			const gap = n > 1 ? Math.min(ideal, Math.max(diameter, room / (n - 1))) : ideal;

			// PAVA: pool adjacent blocks while the left's mean exceeds the right's;
			// each surviving block is a Cluster's rigid core.
			const blocks = []; // { sum, count, start } over the x-sorted dots
			for (let i = 0; i < n; i++) {
				let block = { sum: dots[i].x - i * gap, count: 1, start: i };
				while (blocks.length > 0) {
					const prev = blocks[blocks.length - 1];
					if (prev.sum / prev.count <= block.sum / block.count) break;
					blocks.pop();
					block = {
						sum: prev.sum + block.sum,
						count: prev.count + block.count,
						start: prev.start,
					};
				}
				blocks.push(block);
			}

			// Bar edges as a box constraint: each solved center in
			// [radius, width - radius]; lo > hi means even the floor can't fit, so
			// hold the gap and center the chain.
			const radius = diameter / 2;
			let lo = -Infinity;
			let hi = Infinity;
			if (bounded) {
				lo = radius;
				hi = width - radius - (n - 1) * gap;
				if (lo > hi) {
					const mid = (lo + hi) / 2;
					lo = mid;
					hi = mid;
				}
			}

			const solved = new Array(n);
			for (const block of blocks) {
				const value = Math.min(Math.max(block.sum / block.count, lo), hi);
				for (let k = 0; k < block.count; k++) {
					const i = block.start + k;
					solved[i] = value + i * gap;
				}
			}

			// A Cluster is what the constraint chains together: dots left exactly
			// the Fan Gap apart once the solve settles.
			const EPS = 1e-6;
			const clusters = [];
			let current = null;
			for (let i = 0; i < n; i++) {
				if (current !== null && solved[i] - solved[i - 1] <= gap + EPS) current.push(i);
				else {
					current = [i];
					clusters.push(current);
				}
			}

			for (const cluster of clusters) {
				// A lone dot has no one to separate from and never moves.
				if (cluster.length === 1) continue;
				for (const i of cluster) offsets[dots[i].index] = solved[i] - dots[i].x;
			}
			// Report clusters in the caller's own index space, still left to right.
			return {
				clusters: clusters.map((cluster) => cluster.map((i) => dots[i].index)),
				offsets,
				gap,
			};
		},

		// The Note Band's numbers (#173; CONTEXT.md), the ONE place they live -
		// notes.js builds its CSS from these and the helpers below derive from
		// them, so a change here carries every dependent surface together.
		NOTE_BAND: {
			dotLift: 10, // px from the bar's top edge up to a dot's bottom edge (#162)
			dotDiameter: 6, // the painted glyph
			hitMaxSideReach: 3, // max invisible reach beyond either side of the glyph
			hitHeight: 14, // bottom-anchored at the dot's bottom edge, growing upward only (#158)
			panelGap: 8, // breathing room between the dot glyphs' tops and the Expanded Note
		},

		// Per-side Note Dot hit reach (#202): each side stops at the nearer of its
		// cap or the midpoint to that side's nearest neighbour.
		dotHitReaches(xs, dotDiameter, maxSideReach) {
			const px = (xs || []).map((x) => Number(x) || 0);
			const radius = Math.max(0, Number(dotDiameter) || 0) / 2;
			const cap = Math.max(0, Number(maxSideReach) || 0);
			const reach = (gap) => Math.min(cap, Math.max(0, gap / 2 - radius));
			return px.map((x, i) => {
				let leftGap = Infinity;
				let rightGap = Infinity;
				for (let j = 0; j < px.length; j++) {
					if (j === i) continue;
					const gap = px[j] - x;
					if (gap < 0) leftGap = Math.min(leftGap, -gap);
					else if (gap > 0) rightGap = Math.min(rightGap, gap);
					else leftGap = rightGap = 0;
				}
				return { left: reach(leftGap), right: reach(rightGap) };
			});
		},

		// The Expanded Note's resting anchor above the bar's top edge: derived
		// from dot geometry (lift + glyph + breathing room) rather than hardcoded,
		// so a lift change carries the panel with it (#173).
		panelBarClearance(band) {
			const geometry = band || {};
			return (Number(geometry.dotLift) || 0) + (Number(geometry.dotDiameter) || 0) + (Number(geometry.panelGap) || 0);
		},

		// Whether a MutationObserver batch is ENTIRELY the extension's own churn
		// (#174): a record is ours iff its target sits inside a `ytb-`-prefixed
		// element, or every added/removed node is. content.js drops these instead
		// of emitting `ytb:mutation`, so a render pass can never re-trigger
		// itself. Anything ambiguous counts as NOT ours - a redundant render pass
		// is safe, a missed one is not.
		ytbOwnedChurn(records) {
			const isYtbElement = (node) => {
				if (!node || node.nodeType !== 1) return false;
				if (typeof node.id === 'string' && node.id.startsWith('ytb-')) return true;
				for (const cls of node.classList || []) {
					if (typeof cls === 'string' && cls.startsWith('ytb-')) return true;
				}
				return false;
			};
			// A removed node has no parent, so ownership rests on the removed root itself.
			const isOwned = (node) => {
				for (let n = node; n; n = n.parentNode) {
					if (isYtbElement(n)) return true;
				}
				return false;
			};
			let any = false;
			for (const record of records || []) {
				any = true;
				if (isOwned(record.target)) continue;
				const churn = [...(record.addedNodes || []), ...(record.removedNodes || [])];
				if (churn.length === 0 || !churn.every(isOwned)) return false;
			}
			return any;
		},

		// Whether YouTube's hover-autoplay preview host covers a tile's thumbnail
		// box (#174; caller already matched videoIds). The host overflows its tile
		// on every side, so requiring the intersection to cover at least half the
		// tile's area keeps a duplicate elsewhere in the feed owning its own dots.
		previewOwnsTile(previewRect, tileRect) {
			if (!previewRect || !tileRect) return false;
			const width = Math.min(previewRect.right, tileRect.right) - Math.max(previewRect.left, tileRect.left);
			const height = Math.min(previewRect.bottom, tileRect.bottom) - Math.max(previewRect.top, tileRect.top);
			if (width <= 0 || height <= 0) return false;
			const tileArea = (tileRect.right - tileRect.left) * (tileRect.bottom - tileRect.top);
			return tileArea > 0 && width * height >= tileArea / 2;
		},
	});
})();
