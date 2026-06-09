// popup.js — identity, Friend Code, pairing status, and the Sharing toggle.
// Consumes the frozen `window.YTB` contract from shared.js (task 03). The popup is
// the only UI surface; all persisted state lives in chrome.storage.local (via YTB)
// so it survives a browser restart. See tasks/04-extension-popup.md.

// Small built-in word list for client-side Friend Code generation (e.g. WOLF-42).
const CODE_WORDS = [
  "WOLF", "BEAR", "LYNX", "HAWK", "OTTER", "FOX", "OWL", "SEAL",
  "MOTH", "CRAB", "NEWT", "TOAD", "WREN", "IBIS", "PUMA", "KOI",
  "ELK", "DEER", "MOLE", "SWAN",
];

const el = {
  name: document.getElementById("name"),
  code: document.getElementById("code"),
  generate: document.getElementById("generate"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  statusSub: document.getElementById("status-sub"),
  sharing: document.getElementById("sharing"),
  backendUrl: document.getElementById("backend-url"),
};

let myClientId = "";

init();

async function init() {
  el.backendUrl.textContent = YTB.BACKEND_URL;

  // ensureClientId is generate-once; call on open so pairing comparisons are stable.
  myClientId = await YTB.ensureClientId();

  const config = await YTB.getConfig();
  el.name.value = config.name || "";
  el.code.value = config.code || "";
  el.sharing.checked = config.sharing;

  wireHandlers();
  await refreshStatus(config.code);
}

function wireHandlers() {
  // Display Name is cosmetic; persist every keystroke so closing the popup never
  // loses input. Name collisions are harmless — identity is the Client ID.
  el.name.addEventListener("input", () => {
    YTB.setConfig({ name: el.name.value });
  });

  // Persist the (normalized) code on every keystroke so a quick close keeps it,
  // but only re-fetch pairing status on change/Enter to avoid spamming the backend.
  el.code.addEventListener("input", () => {
    YTB.setConfig({ code: YTB.normalizeCode(el.code.value) });
  });
  el.code.addEventListener("change", () => {
    const code = YTB.normalizeCode(el.code.value);
    el.code.value = code;
    YTB.setConfig({ code });
    refreshStatus(code);
  });

  el.generate.addEventListener("click", () => {
    const code = generateCode();
    el.code.value = code;
    YTB.setConfig({ code });
    refreshStatus(code);
  });

  // The reporter (task 05) reads this flag; the popup only writes it. Off stops our
  // POSTs but the renderer keeps showing the Buddy's markers.
  el.sharing.addEventListener("change", () => {
    YTB.setConfig({ sharing: el.sharing.checked });
  });
}

function generateCode() {
  const word = CODE_WORDS[Math.floor(Math.random() * CODE_WORDS.length)];
  const num = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  return YTB.normalizeCode(`${word}-${num}`);
}

// Pairing status: Unpaired (no code) / Waiting for buddy (code, no foreign record) /
// Paired (a record from another Client ID exists → show Buddy name + last-seen).
async function refreshStatus(code) {
  if (!code) {
    setStatus("unpaired", "Unpaired", "Enter or generate a Friend Code to pair.");
    return;
  }

  const records = await YTB.getRecords(code);
  const buddyRecords = records.filter((r) => r.clientId !== myClientId);

  if (buddyRecords.length === 0) {
    setStatus("waiting", "Waiting for buddy", "");
    return;
  }

  const buddy = buddyRecords.reduce((a, b) =>
    b.updatedAt > a.updatedAt ? b : a
  );
  const who = buddy.name ? buddy.name : "your Buddy";
  setStatus("paired", "Paired", `${who} · last seen ${formatLastSeen(buddy.updatedAt)}`);
}

function setStatus(state, text, sub) {
  el.status.className = `status is-${state}`;
  el.statusText.textContent = text;
  el.statusSub.textContent = sub;
}

// Wall-clock "last seen" for a record's updatedAt (ms epoch). YTB.formatTime is for
// video positions, not timestamps, so format relative time here.
function formatLastSeen(updatedAt) {
  const diff = Date.now() - updatedAt;
  const sec = Math.max(0, Math.round(diff / 1000));
  if (sec < 60) return "just now";
  // Floor larger units so "X ago" never overstates how long it's been.
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
