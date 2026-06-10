// popup.js — identity, Friend Code, pairing status, and the Sharing toggle.
// Consumes the frozen `window.YTB` contract from shared.js (task 03). The popup is
// the only UI surface; all persisted state lives in chrome.storage.local (via YTB)
// so it survives a browser restart. See CONTEXT.md for terminology.

// Built-in word lists for client-side Friend Code generation. A code is one word
// from each list joined by hyphens: "<gerund>-<adjective>-<animal>" (e.g.
// JUMPING-SILLY-DEER after normalizeCode uppercases it). The three lists below are
// 100 words each, so the code space is 100 * 100 * 100 = 1,000,000 combinations —
// large enough that two independently-generated codes almost never collide.
const CODE_VERBS = [
  "jumping", "running", "dancing", "singing", "hopping", "gliding", "soaring",
  "diving", "sprinting", "leaping", "dashing", "rolling", "spinning", "twirling",
  "floating", "drifting", "climbing", "crawling", "marching", "prancing",
  "galloping", "bouncing", "swaying", "swimming", "sailing", "racing", "zooming",
  "skipping", "strolling", "wandering", "roaming", "darting", "swooping",
  "charging", "romping", "trotting", "bounding", "vaulting", "swirling",
  "whirling", "flipping", "twisting", "turning", "shaking", "wiggling",
  "jiggling", "giggling", "laughing", "smiling", "grinning", "beaming",
  "glowing", "shining", "sparkling", "glittering", "blinking", "winking",
  "nodding", "waving", "clapping", "stomping", "tapping", "humming",
  "whistling", "chirping", "buzzing", "snoozing", "dreaming", "yawning",
  "stretching", "wobbling", "tumbling", "juggling", "hiking", "jogging",
  "rowing", "paddling", "surfing", "skating", "sliding", "coasting", "cruising",
  "hovering", "fluttering", "flapping", "pouncing", "scampering", "scurrying",
  "sneaking", "creeping", "strutting", "waddling", "shuffling", "munching",
  "nibbling", "snacking", "splashing", "wading", "prowling", "frolicking",
];

const CODE_ADJECTIVES = [
  "silly", "happy", "sleepy", "grumpy", "sneaky", "fuzzy", "fluffy", "bouncy",
  "cheery", "jolly", "zippy", "perky", "spunky", "cranky", "dizzy", "wobbly",
  "snazzy", "jazzy", "nifty", "quirky", "wacky", "zany", "goofy", "clumsy",
  "cuddly", "chubby", "tiny", "mighty", "brave", "bold", "shy", "calm",
  "mellow", "jumpy", "nervous", "curious", "clever", "witty", "wise", "dapper",
  "fancy", "shiny", "glossy", "sparkly", "dusty", "misty", "frosty", "sunny",
  "stormy", "breezy", "chilly", "toasty", "cozy", "snug", "plump", "slim",
  "swift", "speedy", "nimble", "lanky", "stubby", "spotty", "stripy", "patchy",
  "scruffy", "shaggy", "bristly", "prickly", "silky", "velvety", "squishy",
  "bumpy", "lumpy", "rugged", "rusty", "golden", "silver", "amber", "crimson",
  "violet", "teal", "minty", "peachy", "lemony", "cherry", "honey", "mossy",
  "leafy", "rocky", "sandy", "muddy", "swampy", "cosmic", "lunar", "solar",
  "starry", "royal", "noble", "humble", "merry",
];

const CODE_ANIMALS = [
  "deer", "wolf", "bear", "lynx", "hawk", "otter", "fox", "owl", "seal", "moth",
  "crab", "newt", "toad", "wren", "ibis", "puma", "koi", "elk", "mole", "swan",
  "hare", "lion", "tiger", "panda", "koala", "sloth", "llama", "camel", "moose",
  "bison", "horse", "zebra", "goat", "sheep", "pony", "piglet", "calf", "lamb",
  "fawn", "cub", "kitten", "puppy", "ferret", "weasel", "badger", "beaver",
  "raccoon", "skunk", "possum", "hedgehog", "squirrel", "chipmunk", "rabbit",
  "bunny", "marmot", "gopher", "vole", "shrew", "bat", "falcon", "eagle",
  "osprey", "heron", "egret", "stork", "crane", "robin", "sparrow", "finch",
  "magpie", "raven", "crow", "dove", "pigeon", "parrot", "toucan", "puffin",
  "penguin", "pelican", "flamingo", "peacock", "turkey", "rooster", "duck",
  "goose", "quail", "turtle", "tortoise", "gecko", "iguana", "lizard", "cobra",
  "viper", "python", "salmon", "trout", "perch", "minnow", "guppy", "dolphin",
];

const el = {
  nameField: document.getElementById("name-field"),
  name: document.getElementById("name"),
  nameValue: document.getElementById("name-value"),
  nameEdit: document.getElementById("name-edit"),
  nameSave: document.getElementById("name-save"),
  codeField: document.getElementById("code-field"),
  code: document.getElementById("code"),
  codeValue: document.getElementById("code-value"),
  codeEdit: document.getElementById("code-edit"),
  codeSave: document.getElementById("code-save"),
  generate: document.getElementById("generate"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  statusSub: document.getElementById("status-sub"),
  sharing: document.getElementById("sharing"),
  backendUrl: document.getElementById("backend-url"),
  confirmOverlay: document.getElementById("confirm-overlay"),
  confirmTitle: document.getElementById("confirm-title"),
  confirmBody: document.getElementById("confirm-body"),
  confirmCancel: document.getElementById("confirm-cancel"),
  confirmDisconnect: document.getElementById("confirm-disconnect"),
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
  el.nameValue.textContent = config.name || "";
  el.codeValue.textContent = config.code || "";
  el.sharing.checked = config.sharing;

  // A field starts locked iff it already holds a non-empty committed value, so a
  // fresh install (both blank) opens straight into edit mode (onboarding unchanged).
  setFieldLocked(el.nameField, !!config.name);
  setFieldLocked(el.codeField, !!config.code);

  wireHandlers();
  await refreshStatus(config.code);
}

function wireHandlers() {
  // Display Name is cosmetic; persist every keystroke so closing the popup never
  // loses input. Name collisions are harmless — identity is the Client ID.
  el.name.addEventListener("input", () => {
    YTB.setConfig({ name: el.name.value });
  });

  // Persist the (normalized) code on every keystroke so a quick close keeps it.
  // Pairing status is only re-fetched on commit (commitCode), not per keystroke.
  el.code.addEventListener("input", () => {
    YTB.setConfig({ code: YTB.normalizeCode(el.code.value) });
  });

  // --- commit: Save click, Enter, or blur turns an editable value into a locked
  // one. Blur is skipped when focus moves to a sibling control (Generate keeps
  // editing; Save handles its own commit) so neither prematurely locks the field.
  el.nameSave.addEventListener("click", commitName);
  el.name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitName();
  });
  el.name.addEventListener("blur", (e) => {
    if (e.relatedTarget === el.nameSave) return;
    commitName();
  });

  el.codeSave.addEventListener("click", commitCode);
  el.code.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commitCode();
  });
  el.code.addEventListener("blur", (e) => {
    if (e.relatedTarget === el.generate || e.relatedTarget === el.codeSave) return;
    commitCode();
  });

  // --- edit: Name is harmless (cosmetic) → unlock immediately. Code edit is the
  // "leaving your buddy" moment → always confirm first (the field is only locked
  // when a code is set, so there is always something to disconnect from).
  el.nameEdit.addEventListener("click", () => {
    setFieldLocked(el.nameField, false);
    el.name.focus();
  });
  el.codeEdit.addEventListener("click", openDisconnectConfirm);

  el.generate.addEventListener("click", () => {
    // Fill + persist a fresh code but stay in edit mode (no lock) — the user
    // still confirms with Save. generateCode() is owned by the generation step.
    const code = generateCode();
    el.code.value = code;
    YTB.setConfig({ code });
    el.code.focus();
  });

  // --- disconnect confirmation dialog.
  el.confirmCancel.addEventListener("click", hideConfirm);
  el.confirmDisconnect.addEventListener("click", disconnect);
  // Dismiss (cancel) on backdrop click or Escape, so the dialog is never a trap.
  el.confirmOverlay.addEventListener("click", (e) => {
    if (e.target === el.confirmOverlay) hideConfirm();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.confirmOverlay.hidden) hideConfirm();
  });

  // The reporter (task 05) reads this flag; the popup only writes it. Off stops our
  // POSTs but the renderer keeps showing the Buddy's markers.
  el.sharing.addEventListener("change", () => {
    YTB.setConfig({ sharing: el.sharing.checked });
  });
}

/** Toggle a field between locked (value + Edit) and editable (input + Save). */
function setFieldLocked(field, locked) {
  field.classList.toggle("is-locked", locked);
}

// Commit the Display Name: trim, persist, mirror into the locked view, and lock
// only when non-empty (a blank name has nothing to lock, so it stays editable).
function commitName() {
  const name = el.name.value.trim();
  el.name.value = name;
  el.nameValue.textContent = name;
  YTB.setConfig({ name });
  setFieldLocked(el.nameField, name.length > 0);
}

// Commit the Friend Code: normalize, persist, refresh pairing status, and lock
// only when non-empty. Reached from a fresh/empty edit state (editing an existing
// code always goes through disconnect first), so it never bypasses the confirm.
function commitCode() {
  const code = YTB.normalizeCode(el.code.value);
  el.code.value = code;
  el.codeValue.textContent = code;
  YTB.setConfig({ code });
  setFieldLocked(el.codeField, code.length > 0);
  refreshStatus(code);
}

// Open the disconnect confirmation for the currently-locked Friend Code. Copy
// adapts to whether a buddy is actually connected (see CONTEXT.md "Paired").
async function openDisconnectConfirm() {
  const { code } = await YTB.getConfig();
  const names = await buddyNames(code);
  if (names.length > 0) {
    const label = names.length === 1 ? "buddy" : "buddies";
    el.confirmTitle.textContent = "Are you sure you want to go?";
    el.confirmBody.textContent = `This will disconnect you from your ${label}: ${names.join(
      ", "
    )}.`;
  } else {
    el.confirmTitle.textContent = "Change your Friend Code?";
    el.confirmBody.textContent = "No buddy has connected to this code yet.";
  }
  showConfirm();
}

// Buddy Display Names under `code`, deduped by Client ID (one person watching
// several videos appears once); an unnamed buddy falls back to "your Buddy".
async function buddyNames(code) {
  if (!code) return [];
  const records = await YTB.getRecords(code);
  const latestByClient = new Map();
  for (const r of records) {
    if (!r || r.clientId === myClientId) continue;
    const prev = latestByClient.get(r.clientId);
    if (!prev || r.updatedAt > prev.updatedAt) latestByClient.set(r.clientId, r);
  }
  return Array.from(latestByClient.values(), (r) =>
    r.name && r.name.trim() ? r.name.trim() : "your Buddy"
  );
}

// Confirmed disconnect: client-only. Clear the code locally → reporter stops
// POSTing and the renderer stops drawing (both bail on an empty code); our old
// records under the old code expire via the backend's 14-day TTL.
function disconnect() {
  hideConfirm();
  el.code.value = "";
  el.codeValue.textContent = "";
  YTB.setConfig({ code: "" });
  setFieldLocked(el.codeField, false);
  el.code.focus();
  refreshStatus("");
}

function showConfirm() {
  el.confirmOverlay.hidden = false;
}

function hideConfirm() {
  el.confirmOverlay.hidden = true;
}

function generateCode() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const verb = pick(CODE_VERBS);
  const adjective = pick(CODE_ADJECTIVES);
  const animal = pick(CODE_ANIMALS);
  return YTB.normalizeCode(`${verb}-${adjective}-${animal}`);
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
