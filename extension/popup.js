// popup.js — identity, Friend Code, pairing status, and the Sharing toggle.
// Consumes the frozen `window.YTB` contract from shared.js (task 03). The popup is
// the only UI surface; all persisted state lives in chrome.storage.local (via YTB)
// so it survives a browser restart. See CONTEXT.md for terminology.

// Built-in word lists for client-side Friend Code generation. A code is one word
// from each list joined by hyphens: "<verb>-<adjective>-<animal>" (e.g.
// "run-silly-fox"). Every word is <= 6 letters so codes stay short and easy to
// read out and re-type; verbs mix short base forms and gerunds. The lists below
// are large enough (~76 * ~85 * ~86 ≈ 555k combinations) that two independently
// generated codes almost never collide.
const CODE_VERBS = [
  "run", "hop", "jump", "swim", "leap", "dash", "race", "spin", "roll", "dive",
  "sing", "dance", "skip", "jog", "climb", "crawl", "glide", "soar", "hike",
  "row", "surf", "skate", "slide", "float", "drift", "sail", "zoom", "march",
  "prance", "romp", "trot", "bound", "vault", "swirl", "twist", "shake", "flip",
  "wave", "clap", "stomp", "hum", "buzz", "snore", "dream", "yawn", "wobble",
  "tumble", "juggle", "paddle", "coast", "hover", "pounce", "sneak", "creep",
  "strut", "waddle", "wade", "prowl", "dart", "swoop", "charge", "sway",
  "wiggle", "giggle", "laugh", "smile", "grin", "glow", "shine", "blink",
  "wink", "munch", "splash", "bounce", "gallop",
];

const CODE_ADJECTIVES = [
  "silly", "happy", "fuzzy", "jolly", "zippy", "perky", "dizzy", "nifty",
  "wacky", "zany", "goofy", "tiny", "brave", "bold", "calm", "jumpy", "wise",
  "fancy", "shiny", "dusty", "misty", "sunny", "cozy", "snug", "plump", "slim",
  "swift", "lanky", "silky", "bumpy", "lumpy", "rusty", "amber", "teal",
  "minty", "honey", "mossy", "leafy", "rocky", "sandy", "muddy", "lunar",
  "solar", "royal", "noble", "merry", "sleepy", "grumpy", "sneaky", "fluffy",
  "bouncy", "cheery", "spunky", "cranky", "wobbly", "snazzy", "quirky",
  "clumsy", "cuddly", "chubby", "mighty", "mellow", "clever", "dapper",
  "glossy", "frosty", "stormy", "breezy", "chilly", "toasty", "nimble",
  "stubby", "spotty", "stripy", "patchy", "shaggy", "rugged", "golden",
  "silver", "violet", "peachy", "cherry", "swampy", "cosmic", "starry",
  "humble",
];

const CODE_ANIMALS = [
  "deer", "wolf", "bear", "lynx", "hawk", "otter", "fox", "owl", "seal", "moth",
  "crab", "newt", "toad", "wren", "ibis", "puma", "koi", "elk", "mole", "swan",
  "hare", "lion", "tiger", "panda", "koala", "sloth", "llama", "camel", "moose",
  "bison", "horse", "zebra", "goat", "sheep", "pony", "calf", "lamb", "fawn",
  "cub", "puppy", "ferret", "badger", "beaver", "skunk", "possum", "rabbit",
  "bunny", "marmot", "gopher", "vole", "shrew", "bat", "falcon", "eagle",
  "heron", "egret", "stork", "crane", "robin", "finch", "magpie", "raven",
  "crow", "dove", "pigeon", "parrot", "toucan", "puffin", "turkey", "duck",
  "goose", "quail", "turtle", "gecko", "iguana", "lizard", "cobra", "viper",
  "python", "salmon", "trout", "perch", "minnow", "guppy", "kitten",
];

const el = {
  name: document.getElementById("name"),
  // Friend Code views (mutually exclusive — only one is shown at a time).
  viewChooser: document.getElementById("view-chooser"),
  viewJoin: document.getElementById("view-join"),
  viewConnected: document.getElementById("view-connected"),
  chooseCreate: document.getElementById("choose-create"),
  chooseJoin: document.getElementById("choose-join"),
  chooserCancel: document.getElementById("chooser-cancel"),
  joinInput: document.getElementById("join-input"),
  joinSubmit: document.getElementById("join-submit"),
  joinBack: document.getElementById("join-back"),
  code: document.getElementById("code"),
  reroll: document.getElementById("reroll"),
  changeCode: document.getElementById("change-code"),
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
  el.sharing.checked = config.sharing;

  wireHandlers();

  // Route to the right view: an active code → Connected (refresh status with a
  // real GET); otherwise the chooser (true first run, nothing to Cancel back to).
  if (config.code) {
    showConnected(config.code, config.codeOrigin);
    await refreshStatus(config.code);
  } else {
    showView("chooser");
  }
}

function wireHandlers() {
  // Display Name is cosmetic; persist every keystroke so closing the popup never
  // loses input. Name collisions are harmless — identity is the Client ID.
  el.name.addEventListener("input", () => {
    YTB.setConfig({ name: el.name.value });
  });

  // Chooser → Create: mint + commit a fresh code immediately (no confirm step).
  el.chooseCreate.addEventListener("click", () => createAndCommit());

  // Chooser → Join: switch to the free-text entry view.
  el.chooseJoin.addEventListener("click", () => {
    el.joinInput.value = "";
    showView("join");
    el.joinInput.focus();
  });

  // Chooser → Cancel: only reachable when a code already exists (via "Change
  // code"); return to Connected without touching the active code.
  el.chooserCancel.addEventListener("click", async () => {
    const { code, codeOrigin } = await YTB.getConfig();
    if (!code) return; // No active code — nothing to cancel back to.
    showConnected(code, codeOrigin);
    await refreshStatus(code);
  });

  // Join → submit: normalize (trim + lowercase) and commit verbatim. Pure match —
  // no word-list validation; pairing succeeds only if it matches a real code.
  el.joinSubmit.addEventListener("click", () => joinAndCommit());
  el.joinInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinAndCommit();
  });

  // Join → Back: abandon entry, return to the chooser (active code untouched).
  el.joinBack.addEventListener("click", () => showView("chooser"));

  // Connected → Re-roll: only shown for created codes; mint + commit a new one.
  el.reroll.addEventListener("click", () => createAndCommit());

  // Connected → Change code: reopen the chooser. The active code stays committed
  // until a new one replaces it, so an accidental tap never drops pairing.
  el.changeCode.addEventListener("click", () => showView("chooser"));

  // The reporter (task 05) reads this flag; the popup only writes it. Off stops our
  // POSTs but the renderer keeps showing the Buddy's markers.
  el.sharing.addEventListener("change", () => {
    YTB.setConfig({ sharing: el.sharing.checked });
  });
}

// Create flow: generate a code, commit it, land on Connected. A brand-new random
// code can't be paired yet, so we set status to "Waiting for buddy" WITHOUT a GET.
async function createAndCommit() {
  const code = generateCode();
  await YTB.setConfig({ code, codeOrigin: "created" });
  showConnected(code, "created");
  setStatus("waiting", "Waiting for buddy", "");
}

// Join flow: commit the typed code (normalized) and refresh status with a real
// GET — that GET is the actual "did it match?" check.
async function joinAndCommit() {
  const code = YTB.normalizeCode(el.joinInput.value);
  if (!code) return; // Empty — stay on the entry view.
  await YTB.setConfig({ code, codeOrigin: "joined" });
  showConnected(code, "joined");
  await refreshStatus(code);
}

function generateCode() {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const verb = pick(CODE_VERBS);
  const adjective = pick(CODE_ADJECTIVES);
  const animal = pick(CODE_ANIMALS);
  return YTB.normalizeCode(`${verb}-${adjective}-${animal}`);
}

// --- view switching ----------------------------------------------------------

// Show exactly one of the three Friend Code views. The Cancel link in the chooser
// only makes sense when an active code exists (reached via "Change code").
function showView(name) {
  el.viewChooser.hidden = name !== "chooser";
  el.viewJoin.hidden = name !== "join";
  el.viewConnected.hidden = name !== "connected";
  if (name === "chooser") {
    YTB.getConfig().then(({ code }) => {
      el.chooserCancel.hidden = !code;
    });
  }
}

// Render the Connected view for an active code. Re-roll is offered only for codes
// we created — re-rolling a joined code would silently un-pair from the Buddy.
function showConnected(code, codeOrigin) {
  el.code.value = code;
  el.reroll.hidden = codeOrigin !== "created";
  showView("connected");
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
