// extension/shared.js
//
// The `window.YTB` global: backend URL, config storage helpers, the API client,
// and formatting utils. Loaded by BOTH the popup (<script src="shared.js"> before
// popup.js) and as the FIRST content-script file, so every helper must work in
// both contexts (popups and content scripts both have chrome.storage + fetch).
//
// Content scripts are NOT ES modules — this file communicates only via the
// `window.YTB` global, no import/export. See ADR-0001.
//
// `code` ownership (decided once, depended on by tasks 04 and 05):
//   - getRecords(code)  — code is PASSED IN (the popup already holds the code).
//   - postProgress(...) — code is READ FROM CONFIG (the reporter just wants to
//                         "send my current position"; it never carries the code).
// Friend Codes are stored already-normalized (popup calls normalizeCode before
// setConfig), so the API client passes the code through verbatim.

const YTB = {
  // --- config ---
  // PLACEHOLDER backend URL — replace with the deployed …workers.dev URL from
  // task 02 (also update the matching entry in manifest.json host_permissions).
  BACKEND_URL: "http://localhost:8787",

  // A Friend Code is one Group of at most this many distinct Client IDs (you +
  // up to 4 Buddies). Mirrors MAX_MEMBERS in the backend Worker; the server
  // enforces it, the client uses it to detect a full Group (see groupView).
  MAX_MEMBERS: 5,

  // --- storage (chrome.storage.local) ---
  // Stored keys: name (Display Name), code (Friend Code), codeOrigin
  // ("created" | "joined" — how the active code was set; drives the popup's
  // Re-roll affordance), clientId, sharing (boolean).

  /**
   * Read the full config, applying defaults for unset keys.
   * `clientId` is "" until ensureClientId() has minted one — call that when you
   * need a guaranteed id.
   * @returns {Promise<{name: string, code: string, codeOrigin: string, clientId: string, sharing: boolean}>}
   */
  async getConfig() {
    const stored = await chrome.storage.local.get([
      "name",
      "code",
      "codeOrigin",
      "clientId",
      "sharing",
    ]);
    return {
      name: stored.name ?? "",
      code: stored.code ?? "",
      codeOrigin: stored.codeOrigin ?? "",
      clientId: stored.clientId ?? "",
      sharing: stored.sharing ?? true,
    };
  },

  /**
   * Merge-write a subset of { name, code, codeOrigin, sharing } into
   * chrome.storage.local. `clientId` is intentionally NOT writable here — it is
   * owned by ensureClientId.
   * @param {{name?: string, code?: string, codeOrigin?: string, sharing?: boolean}} partial
   */
  async setConfig(partial) {
    const next = {};
    for (const key of ["name", "code", "codeOrigin", "sharing"]) {
      if (key in partial) next[key] = partial[key];
    }
    await chrome.storage.local.set(next);
  },

  /**
   * Return the existing Client ID, or mint one ONCE (8 hex chars) and persist it.
   * Stable for the life of the install.
   * @returns {Promise<string>}
   */
  async ensureClientId() {
    const { clientId } = await chrome.storage.local.get("clientId");
    if (clientId) return clientId;
    const bytes = new Uint8Array(4); // 4 bytes -> 8 hex chars
    crypto.getRandomValues(bytes);
    const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await chrome.storage.local.set({ clientId: id });
    return id;
  },

  // --- API client (talks to BACKEND_URL; wire format defined in task 01) ---

  /**
   * POST this user's current Progress Record. Reads the Friend Code from config.
   * Body is exactly the 5 fields below (no updatedAt — the server sets it).
   * Tolerates failure silently per the PRD's "minimal error handling": resolves
   * to { ok: true } on success, or false on missing code / network / non-2xx.
   * @param {{clientId: string, name: string, videoId: string, timestamp: number, duration: number}} record
   * @returns {Promise<{ok: true}|false>}
   */
  async postProgress({ clientId, name, videoId, timestamp, duration }) {
    const { code } = await YTB.getConfig();
    if (!code) return false; // Unpaired — nothing to share.
    try {
      const res = await fetch(
        YTB.BACKEND_URL + "/?code=" + encodeURIComponent(code),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId, name, videoId, timestamp, duration }),
        }
      );
      return res.ok ? { ok: true } : false;
    } catch {
      return false;
    }
  },

  /**
   * GET every live Progress Record under `code` (mine AND the Buddy's — the
   * server does no filtering; consumers split by comparing clientId).
   * @param {string} code Friend Code (already normalized).
   * @returns {Promise<Array<{clientId: string, name: string, videoId: string, timestamp: number, duration: number, updatedAt: number}>>}
   */
  async getRecords(code) {
    try {
      const res = await fetch(
        YTB.BACKEND_URL + "/?code=" + encodeURIComponent(code)
      );
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  },

  // --- utils ---

  /**
   * Format seconds as "M:SS" (or "H:MM:SS" past an hour) for tooltips.
   * e.g. 412 -> "6:52".
   * @param {number} seconds
   * @returns {string}
   */
  formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const ss = String(s).padStart(2, "0");
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
    return `${m}:${ss}`;
  },

  /**
   * Trim + lowercase a Friend Code so "Wolf-Fox" and "wolf-fox" pair. Codes are
   * generated lowercase; this also normalizes whatever a Buddy types on Join.
   * @param {string} raw
   * @returns {string}
   */
  normalizeCode(raw) {
    return String(raw ?? "").trim().toLowerCase();
  },

  // --- Group helpers (multiple Buddies) ---

  // Five visually distinct marker colors, all clear of YouTube's red watched-bar.
  // A Group holds <= MAX_MEMBERS, so up to 4 Buddies ever need a color at once.
  BUDDY_PALETTE: ["#1ec8ff", "#ff9f1c", "#57d35a", "#b14cff", "#ffd23f"],

  // Playful adjectives for unnamed Buddies (see buddyName). 16 entries: with a
  // 5-color palette, gcd(16, 5) === 1 keeps the adjective independent of the
  // color, so two unnamed Buddies rarely share BOTH.
  ADJECTIVES: [
    "Silly", "Scary", "Sleepy", "Sneaky", "Grumpy", "Goofy", "Wild", "Brave",
    "Cheeky", "Jolly", "Mighty", "Sloppy", "Spooky", "Zesty", "Snazzy", "Wobbly",
  ],

  /**
   * Stable 32-bit hash of a Client ID. The SAME id always hashes the same, so
   * everything keyed off a Buddy (their color, their fallback name) stays
   * stable across videos, thumbnails, the popup, and every viewer.
   * @param {string} clientId
   * @returns {number}
   */
  hashClientId(clientId) {
    const s = String(clientId);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  },

  /**
   * Stable color for a Buddy, hashed from their Client ID — the SAME friend is
   * the SAME color on every video, thumbnail, and the popup roster, regardless
   * of who else is in the Group. With only 5 colors two Buddies can collide;
   * tooltips and the popup roster still disambiguate (accepted tradeoff).
   * @param {string} clientId
   * @returns {string} a hex color from BUDDY_PALETTE
   */
  buddyColor(clientId) {
    const palette = YTB.BUDDY_PALETTE;
    const h = YTB.hashClientId(clientId);
    return palette[((h % palette.length) + palette.length) % palette.length];
  },

  /**
   * Display label for a Buddy. Returns their trimmed Display Name when set, else
   * a stable "<Adjective> Buddy" derived from their Client ID — same adjective
   * on every surface and for every viewer (Display Name is optional, so unnamed
   * Buddies still get a friendly, consistent token). Applies to FOREIGN records
   * only; you never render yourself as a Buddy.
   * @param {string} clientId
   * @param {string} [name]
   * @returns {string}
   */
  buddyName(clientId, name) {
    const trimmed = String(name ?? "").trim();
    if (trimmed) return trimmed;
    const adjs = YTB.ADJECTIVES;
    const h = YTB.hashClientId(clientId);
    return `${adjs[((h % adjs.length) + adjs.length) % adjs.length]} Buddy`;
  },

  /**
   * Reduce a flat records array (mine AND the Buddies') into a Group view from
   * my perspective. A Buddy is any record with a foreign clientId; the Group is
   * capped at MAX_MEMBERS distinct Client IDs.
   * @param {Array<{clientId: string, name: string, updatedAt: number}>} records
   * @param {string} myClientId
   * @returns {{buddies: Array<object>, iAmMember: boolean, locked: boolean}}
   *   buddies — one latest record per distinct Buddy, newest-first.
   *   iAmMember — I already have a record under the code.
   *   locked — the Group is full of OTHERS and I am not one of them (would be
   *            the rejected 6th): render nothing, show "Group full".
   */
  groupView(records, myClientId) {
    const latestByBuddy = new Map(); // clientId -> latest record (any video)
    let iAmMember = false;
    for (const r of records) {
      if (!r || !r.clientId) continue;
      if (r.clientId === myClientId) {
        iAmMember = true;
        continue;
      }
      const prev = latestByBuddy.get(r.clientId);
      if (!prev || r.updatedAt > prev.updatedAt) latestByBuddy.set(r.clientId, r);
    }
    const buddies = Array.from(latestByBuddy.values()).sort(
      (a, b) => b.updatedAt - a.updatedAt
    );
    // 5 distinct others with no record of my own = a full Group I'd be the 6th of.
    const locked = !iAmMember && buddies.length >= YTB.MAX_MEMBERS;
    return { buddies, iAmMember, locked };
  },
};

window.YTB = YTB;
