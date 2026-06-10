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
  name: document.getElementById("name"),
  code: document.getElementById("code"),
  generate: document.getElementById("generate"),
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  statusSub: document.getElementById("status-sub"),
  roster: document.getElementById("roster"),
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
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const verb = pick(CODE_VERBS);
  const adjective = pick(CODE_ADJECTIVES);
  const animal = pick(CODE_ANIMALS);
  return YTB.normalizeCode(`${verb}-${adjective}-${animal}`);
}

// Group status, from my perspective (a Friend Code is one Group of up to
// YTB.MAX_MEMBERS people):
//   Unpaired      — no code.
//   Waiting       — code set, but no Buddy has a record yet.
//   In group      — 1+ Buddies; list each with their color swatch + last-seen.
//   Group full    — 5 others already, I'm not one of them (the locked-out 6th).
async function refreshStatus(code) {
  if (!code) {
    setStatus("unpaired", "Unpaired", "Enter or generate a Friend Code to pair.");
    renderRoster([]);
    return;
  }

  const records = await YTB.getRecords(code);
  const { buddies, locked } = YTB.groupView(records, myClientId);

  if (locked) {
    setStatus("full", "Group full", `This code already has ${YTB.MAX_MEMBERS} members.`);
    renderRoster([]);
    return;
  }

  if (buddies.length === 0) {
    setStatus("waiting", "Waiting for buddy", "");
    renderRoster([]);
    return;
  }

  const noun = buddies.length === 1 ? "buddy" : "buddies";
  setStatus("ingroup", "In group", `${buddies.length} ${noun}`);
  renderRoster(buddies);
}

function setStatus(state, text, sub) {
  el.status.className = `status is-${state}`;
  el.statusText.textContent = text;
  el.statusSub.textContent = sub;
}

// Render one row per Buddy: [color swatch] name · last-seen. The swatch color
// matches that Buddy's markers/segments (YTB.buddyColor), so the popup doubles
// as the color legend. Newest-active Buddy first (groupView already sorts).
function renderRoster(buddies) {
  el.roster.textContent = "";
  for (const b of buddies) {
    const row = document.createElement("div");
    row.className = "buddy";

    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = YTB.buddyColor(b.clientId);

    const name = document.createElement("span");
    name.className = "buddy-name";
    name.textContent = b.name ? b.name : "Buddy";

    const seen = document.createElement("span");
    seen.className = "buddy-seen";
    seen.textContent = formatLastSeen(b.updatedAt);

    row.append(swatch, name, seen);
    el.roster.appendChild(row);
  }
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
