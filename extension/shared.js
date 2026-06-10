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

  // --- storage (chrome.storage.local) ---
  // Stored keys: name (Display Name), code (Friend Code), clientId, sharing (boolean).

  /**
   * Read the full config, applying defaults for unset keys.
   * `clientId` is "" until ensureClientId() has minted one — call that when you
   * need a guaranteed id.
   * @returns {Promise<{name: string, code: string, clientId: string, sharing: boolean}>}
   */
  async getConfig() {
    const stored = await chrome.storage.local.get([
      "name",
      "code",
      "clientId",
      "sharing",
    ]);
    return {
      name: stored.name ?? "",
      code: stored.code ?? "",
      clientId: stored.clientId ?? "",
      sharing: stored.sharing ?? true,
    };
  },

  /**
   * Merge-write a subset of { name, code, sharing } into chrome.storage.local.
   * `clientId` is intentionally NOT writable here — it is owned by ensureClientId.
   * @param {{name?: string, code?: string, sharing?: boolean}} partial
   */
  async setConfig(partial) {
    const next = {};
    for (const key of ["name", "code", "sharing"]) {
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
   * Trim + uppercase a Friend Code so "wolf-42" and "WOLF-42" pair.
   * @param {string} raw
   * @returns {string}
   */
  normalizeCode(raw) {
    return String(raw ?? "").trim().toUpperCase();
  },
};

window.YTB = YTB;
