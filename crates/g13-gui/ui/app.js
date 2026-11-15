// G Nexus front-end. Talks to the Rust side through Tauri commands and the
// "g13" event stream; the edited model is the profile file itself (FileDto).
"use strict";

// Also set the property for DOM implementations that do not reflect the HTML attribute.
document.body.inert = true;

const { invoke: invokeNative } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
// Long-running native operations already started before a close must finish
// before the close handshake may acknowledge. No new ones start while frozen.
const closeSensitive = new Set(["assign_game", "create_profile", "delete_profile", "import_lgs",
  "import_config", "reset_config", "record_start", "record_stop", "set_settings", "set_language",
  "backup_now", "export_config", "export_lgs"]);
const closeSensitiveJobs = new Set();
let closeOperation = false, frozenForQuit = false, reloadOperation = false, cancelSerial = 0, bootReady = false;
const closeBusy = () => closeOperation || frozenForQuit || reloadOperation;
function invoke(cmd, args) {
  const sensitive = closeSensitive.has(cmd);
  if (sensitive && closeBusy()) return Promise.reject(new Error("WINDOW_CLOSING: opération annulée"));
  const job = Promise.resolve(invokeNative(cmd, args));
  if (sensitive) {
    closeSensitiveJobs.add(job);
    job.then(() => closeSensitiveJobs.delete(job), () => closeSensitiveJobs.delete(job));
  }
  return job;
}
function syncInert() {
  document.body.inert = !bootReady || closeBusy() || destructiveOperation;
}
/** Same page, two windows: the main one and the in-game overlay (#overlay). */
const OVERLAY = location.hash === "#overlay";
if (OVERLAY) document.documentElement.classList.add("overlay");

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const S = {
  profiles: [],
  editId: null,
  dto: null,
  bank: "M1",
  activeId: "",
  connected: false,
  offlineEdit: false,
  status: {},
  selected: null,
  mods: new Set(),
  pickerTab: "keyboard",
  advTab: "apps",
  base: {}, // bank → base colour (before brightness)
  game: null, // overlay: executable in the foreground when it was opened
  pinned: null, // profile pinned everywhere ("Tester partout")
};

// ---- helpers --------------------------------------------------------------------

let toastTimer;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), err ? 6000 : 1800);
}

const hex2rgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h || "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
};
const rgb2hex = ({ r, g, b }) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();

function bankObj(bank = S.bank) {
  S.dto.banks ||= {};
  S.dto.banks[bank] ||= {};
  return S.dto.banks[bank];
}

function bankActions(bank = S.bank) {
  const b = bankObj(bank);
  const out = {};
  for (const [k, v] of Object.entries(b)) if (k !== "color") out[k] = v;
  return out;
}

// ---- saving -----------------------------------------------------------------------

// Each profile has its own immutable draft snapshots and serialized writer.
// A failed draft remains in memory; normal navigation refuses to discard it.
const pendingSaves = new Map(), saveWorkers = new Map(), failedSaves = new Map();
const profileBases = new Map(), profileTokens = new Map();
let editRevision = 0, loadRevision = 0, destructiveOperation = false;

function normalizedProfile(dto) {
  if (!dto || typeof dto !== "object") throw new Error("invalid profile");
  dto.rules ||= [];
  dto.macros ||= {};
  return dto;
}

function snapshotProfile(snapshot) {
  if (!snapshot || typeof snapshot.token !== "string" || !snapshot.token) throw new Error("invalid profile identity");
  return { profile: normalizedProfile(snapshot.profile), token: snapshot.token };
}

function profileForSave(raw) {
  const dto = structuredClone(raw);
  // Keep half-typed rows in the visible draft, but do not persist them.
  dto.rules = (dto.rules || []).filter((r) => (r.exe && r.exe.trim()) || (r.title && r.title.trim()))
    .map((r) => {
      const o = {};
      if (r.exe && r.exe.trim()) o.exe = r.exe.trim();
      if (r.title && r.title.trim()) o.title = r.title.trim();
      return o;
    });
  return dto;
}

function explainProfileError(error) {
  const raw = String(error), owner = raw.match(/RULE_OWNER_CONFLICT:([a-zA-Z0-9_-]+)/);
  if (owner) return t("Une règle du profil {id} peut correspondre à la même fenêtre. Modifiez d'abord les associations ; cette modification n'a pas été enregistrée.", { id: owner[1] });
  if (raw.includes("RULE_OWNERS_UNAVAILABLE:")) return t("Impossible de vérifier les associations : au moins un profil est illisible ou non pris en charge.");
  if (raw.includes("COMBINED_RULE_CONFLICT:")) return t("Cette règle combine programme et titre. Modifiez-la directement au lieu de l'élargir automatiquement.");
  if (raw.includes("CONFIG_OVERLAY_OPEN")) return t("Fermez d'abord l'overlay avant de remplacer la configuration.");
  return raw;
}

function renderSaveProblem() {
  const problem = failedSaves.get(S.editId);
  $("#profile-save-banner").classList.toggle("hidden", !problem);
  $("#profile-draft").classList.toggle("hidden", !problem);
  if (problem) {
    $("#profile-save-message").textContent = t("Non enregistré : {e}", { e: explainProfileError(problem) });
    $("#profile-draft-data").textContent = JSON.stringify(S.dto, null, 2);
  }
}

function holdFailedDraft(id, error, fallback) {
  if (!pendingSaves.has(id) && fallback) pendingSaves.set(id, fallback);
  const pending = pendingSaves.get(id);
  if (pending?.timer) { clearTimeout(pending.timer); pending.timer = null; }
  failedSaves.set(id, String(error));
  if (id === S.editId) {
    renderSaveProblem();
    toast(t("Non enregistré : {e}", { e: explainProfileError(error) }), true);
  }
}

/** Colour dialog while open: { target, h, s, v } (see openColor). */
let CP = null;
function save(msg) {
  if (!S.editId || !S.dto) return;
  const id = S.editId, token = profileTokens.get(id), base = profileBases.get(id);
  if (!token || !base) { holdFailedDraft(id, "profil sans base de modification"); return; }
  editRevision++;
  const previous = pendingSaves.get(id);
  if (previous?.timer) clearTimeout(previous.timer);
  const next = { raw: structuredClone(S.dto), base: structuredClone(base), token, msg, timer: null };
  pendingSaves.set(id, next);
  if (!failedSaves.has(id) && !destructiveOperation) {
    next.timer = setTimeout(() => { next.timer = null; flushProfile(id); }, 220);
  }
  renderSaveProblem();
}

function rebuildBaseColors() {
  S.base = {};
  for (const b of ["M1", "M2", "M3"]) {
    const c = hex2rgb(bankObj(b).color);
    if (c) {
      const m = Math.max(c.r, c.g, c.b, 1);
      S.base[b] = { rgb: rgb2hex({ r: (c.r * 255) / m, g: (c.g * 255) / m, b: (c.b * 255) / m }), bright: Math.round((m / 255) * 100) };
    }
  }
}

async function drainProfile(id) {
  while (!failedSaves.has(id) && pendingSaves.has(id)) {
    const snapshot = pendingSaves.get(id);
    if (snapshot.timer) clearTimeout(snapshot.timer);
    pendingSaves.delete(id);
    const sent = profileForSave(snapshot.raw);
    try {
      const response = snapshotProfile(await invoke("save_profile", {
        id, base: snapshot.base, profile: sent, token: snapshot.token,
      }));
      if (response.token !== snapshot.token) throw new Error("PROFILE_REPLACED: profile identity changed");
      const merged = response.profile, pending = pendingSaves.get(id);
      const visible = S.editId === id && profileTokens.get(id) === snapshot.token ? S.dto : null;
      // Do not give a newer local draft the remote version as its ancestor.
      // Otherwise a follow-up save could silently overwrite a remote change.
      if ((pending && profileDeltaConflicts(sent, pending.raw, merged)) ||
          (visible && profileDeltaConflicts(sent, visible, merged))) {
        const fallback = visible ? { raw: structuredClone(visible), base: structuredClone(snapshot.base), token: snapshot.token, timer: null } : snapshot;
        holdFailedDraft(id, "PROFILE_CONFLICT: modifications simultanées", fallback);
        return false;
      }
      if (pending) {
        pending.base = rebaseProfileAncestor(sent, pending.raw, merged);
        pending.raw = applyProfileDelta(sent, pending.raw, merged);
      }
      if (visible) {
        const before = structuredClone(visible);
        profileBases.set(id, rebaseProfileAncestor(sent, visible, merged));
        const rebased = applyProfileDelta(sent, visible, merged);
        if (!profileValueEqual(rebased, visible)) {
          S.dto = rebased;
          rebuildBaseColors();
          render();
          if (!profileValueEqual(before.rules || [], rebased.rules || []) && $("#advanced").classList.contains("open")) {
            renderRules(); renderDetected();
          }
        }
      }
      if (snapshot.msg && S.editId === id) toast(snapshot.msg);
      refreshProfiles();
    } catch (e) {
      holdFailedDraft(id, e, snapshot);
      return false;
    }
  }
  return !failedSaves.has(id);
}

function flushProfile(id) {
  if (!id) return Promise.resolve(true);
  if (saveWorkers.has(id)) return saveWorkers.get(id);
  if (failedSaves.has(id)) { renderSaveProblem(); return Promise.resolve(false); }
  let job;
  job = drainProfile(id).finally(() => { if (saveWorkers.get(id) === job) saveWorkers.delete(id); });
  saveWorkers.set(id, job);
  return job;
}

async function flushAllProfiles() {
  const ids = new Set([...pendingSaves.keys(), ...saveWorkers.keys(), ...failedSaves.keys()]);
  for (const id of ids) if (!(await flushProfile(id))) return false;
  return true;
}

function resumeHeldSaves() {
  if (destructiveOperation || closeBusy()) return;
  for (const [id, pending] of pendingSaves) {
    if (!failedSaves.has(id) && !pending.timer) pending.timer = setTimeout(() => { pending.timer = null; flushProfile(id); }, 220);
  }
  MacroLib.resume();
}

function renderMacroLibraryProblem() {
  const error = MacroLib.error || MacroLib.loadError;
  const banner = $("#macro-save-banner"), draft = $("#macro-draft");
  if (!banner || !draft) return;
  banner.classList.toggle("hidden", !error);
  draft.classList.toggle("hidden", !error);
  if (!error) return;
  let reason = error;
  if (error === "MACRO_CONFIG_REPLACED") reason = t("La configuration a changé pendant une modification de la bibliothèque. Copiez la file, puis abandonnez-la avant de recharger.");
  else if (error.includes("MACRO_LIBRARY_CONFLICT:")) reason = t("Cette macro a changé ailleurs. Copiez la file avant de l'abandonner, puis rechargez la bibliothèque.");
  else if (error.includes("MACRO_LIBRARY_NAME_EXISTS:")) reason = t("Ce nom existe déjà dans la bibliothèque ; aucune macro n'a été écrasée.");
  else if (error.includes("MACRO_LIBRARY_UNOBSERVED:")) reason = t("La bibliothèque n'était pas chargée au début de cette modification. Copiez la file avant de l'abandonner, puis rechargez la bibliothèque.");
  $("#macro-save-message").textContent = t("Bibliothèque de macros : {e}", { e: reason });
  $("#macro-draft-data").textContent = JSON.stringify(MacroLib.pending, null, 2);
  $("#macro-draft-retry").disabled = !!(MacroLib.blocked || MacroLib.job || MacroLib.loading);
  $("#macro-draft-discard").disabled = !!(MacroLib.job || MacroLib.loading || !MacroLib.pending.length);
}
$("#macro-save-review").addEventListener("click", () => openAdvanced("macros"));
$("#macro-draft-retry").addEventListener("click", async () => {
  if (MacroLib.blocked || MacroLib.job || MacroLib.loading) return;
  if (MacroLib.pending.length) await MacroLib.flush();
  else await MacroLib.ensure();
  G13Macros.render();
});
$("#macro-draft-discard").addEventListener("click", async () => {
  if (MacroLib.job || MacroLib.loading || !MacroLib.pending.length) return;
  const revision = MacroLib.revision, snapshot = JSON.stringify(MacroLib.pending);
  const ok = await ask(t("ABANDONNER LA FILE DE LA BIBLIOTHÈQUE ?"), "", { confirmOnly: true, ok: t("CONFIRMER") });
  if (!ok) return;
  if (revision !== MacroLib.revision || snapshot !== JSON.stringify(MacroLib.pending) || MacroLib.job || MacroLib.loading) {
    toast(t("La file a changé ; réessayez."), true);
    return;
  }
  if (MacroLib.discardPending()) {
    toast(t("File de la bibliothèque abandonnée ; les copies dans les profils sont conservées."));
    G13Macros.render();
  }
});

// ---- profiles ---------------------------------------------------------------------

async function refreshProfiles() {
  try {
    S.profiles = await invoke("list_profiles");
  } catch (e) {
    toast(String(e), true);
    S.profiles = [];
  }
  renderProfileMenu();
  renderStatus();
}

function installEditSnapshot(id, snapshot) {
  const dto = snapshot.profile;
  S.editId = id; S.dto = dto;
  profileBases.set(id, structuredClone(dto));
  profileTokens.set(id, snapshot.token);
  rebuildBaseColors();
  G13Macros.sel = null;
  if (!OVERLAY) invoke("set_preview", { id }).catch(() => {});
  if (!document.body.classList.contains("mouse-mode") && !document.body.classList.contains("headset-mode")) $("#ov-name").textContent = dto.name || id;
  renderSaveProblem();
  render();
}

async function loadEdit(id) {
  if (destructiveOperation || closeBusy()) return false;
  const revision = ++loadRevision;
  try {
    if (!(await flushProfile(S.editId))) return false;
    if (id !== S.editId && !(await flushProfile(id))) return false;
    if (revision !== loadRevision) return false;
    const beforeRead = editRevision;
    const snapshot = snapshotProfile(await invoke("load_profile_edit", { id }));
    if (closeBusy() || revision !== loadRevision || beforeRead !== editRevision) return false;
    installEditSnapshot(id, snapshot);
    return true;
  } catch (e) {
    toast(t("Profil illisible : {e}", { e }), true);
    return false;
  }
}

// Failed drafts are exposed as selectable JSON and require an explicit
// discard; they are not silently replaced by a later profile read.
$("#profile-save-review").addEventListener("click", () => { if (S.dto) openAdvanced("apps"); });
$("#profile-draft-retry").addEventListener("click", async () => {
  const id = S.editId;
  if (!id || destructiveOperation || !failedSaves.has(id)) return;
  failedSaves.delete(id);
  renderSaveProblem();
  await flushProfile(id);
});
$("#profile-draft-discard").addEventListener("click", async () => {
  const id = S.editId, error = failedSaves.get(id), token = profileTokens.get(id);
  if (!id || !error || destructiveOperation) return;
  const revision = editRevision, navigation = loadRevision, draft = structuredClone(S.dto);
  if (!(await ask(t("ABANDONNER CE BROUILLON ET RECHARGER ?"), "", { confirmOnly: true, ok: t("CONFIRMER") }))) return;
  const unchanged = () => S.editId === id && profileTokens.get(id) === token && failedSaves.get(id) === error &&
    editRevision === revision && loadRevision === navigation && profileValueEqual(S.dto, draft);
  if (!unchanged()) { toast(t("Le brouillon a changé ; réessayez."), true); return; }
  destructiveOperation = true; syncInert();
  try {
    if (saveWorkers.has(id)) await saveWorkers.get(id);
    if (!unchanged()) { toast(t("Le brouillon a changé ; réessayez."), true); return; }
    const profiles = await invoke("list_profiles");
    const next = profiles.find((p) => p.id === id) || profiles.find((p) => p.id === S.activeId) || profiles[0];
    if (!next) throw new Error("aucun profil lisible");
    const snapshot = snapshotProfile(await invoke("load_profile_edit", { id: next.id }));
    if (!unchanged()) { toast(t("Le brouillon a changé ; réessayez."), true); return; }
    const pending = pendingSaves.get(id); if (pending?.timer) clearTimeout(pending.timer);
    pendingSaves.delete(id); failedSaves.delete(id); profileBases.delete(id); profileTokens.delete(id);
    ++loadRevision;
    S.profiles = profiles;
    installEditSnapshot(next.id, snapshot);
    toast(t("Brouillon abandonné et profils rechargés"));
  } catch (e) { toast(t("Rechargement impossible : {e}", { e }), true); }
  finally { destructiveOperation = false; syncInert(); resumeHeldSaves(); }
});

function renderProfileMenu() {
  const idx = S.profiles.findIndex((p) => p.id === S.editId);
  const cur = S.profiles[idx];
  $("#profile-num").textContent = cur ? t("PROFIL {n}", { n: idx + 1 }) : t("PROFIL");
  $("#profile-name").innerHTML = cur ? (cur.default ? '<span class="star">★</span> ' : "") + esc(cur.name) : "—";
  $("#profile-label-text").textContent = cur ? cur.name.toUpperCase() : "";
  $("#profile-label-text").title = cur ? t("Profil {n} · {name}", { n: idx + 1, name: cur.name }) : "";
  $("#profile-list").innerHTML = S.profiles
    .map((p, i) => {
      const tip = `${i + 1}. ${p.name}${p.default ? " " + t("(par défaut)") : ""}${p.apps.length ? " — " + p.apps.join(", ") : ""}${p.error ? " — " + t("fichier invalide : {e}", { e: p.error }) : ""}`;
      return `<button class="bank prof ${p.id === S.editId ? "on" : ""} ${p.error ? "err" : ""}" data-id="${esc(p.id)}" title="${esc(tip)}">
        ${i + 1}${p.id === S.activeId ? `<i class="act" title="${t("actif sur le G13")}"></i>` : ""}</button>`;
    })
    .join("") + `<button class="bank add" id="profile-add" title="${t("Nouveau profil")}">+</button>`;
  $("#btn-default").classList.toggle("on", !!cur?.default);
  renderScope(cur);
  if (OVERLAY) renderOverlayBar(cur);
}

/** Overlay head for the device shown: the G13's (renderOverlayBar) or the mouse's. */
function renderOverlayHead() {
  if (document.body.classList.contains("headset-mode")) {
    const st = Headset.status;
    $("#ov-name").textContent = st?.present ? st.name : t("Casque non détecté");
    $("#ov-game-text").textContent = st?.connected && st.battery != null ? t("Batterie : {n} %", { n: st.battery }) : "";
    $("#ov-assign").classList.add("hidden");
    return;
  }
  if (!document.body.classList.contains("mouse-mode")) {
    const cur = S.profiles.find((p) => p.id === S.editId);
    $("#ov-name").textContent = S.dto?.name || "—";
    renderOverlayBar(cur);
    return;
  }
  const m = Mouse;
  const host = m.host();
  const game = S.game;
  $("#ov-name").textContent = host ? m.softName(m.softIndex()) : m.status?.connected ? t("Profil intégré {n}", { n: m.sector() }) : t("Souris non détectée");
  const bound = host && game && (m.softProfile()?.apps || []).some((a) => a.toLowerCase() === game.toLowerCase());
  $("#ov-game-text").innerHTML = !game || !host
    ? t("Profil affiché : <b>{name}</b>", { name: esc($("#ov-name").textContent) })
    : bound
      ? t("Jeu : <b>{game}</b> · utilise ce profil", { game: esc(game) })
      : t("Jeu : <b>{game}</b> · ce profil ne lui est pas associé", { game: esc(game) });
  $("#ov-assign").classList.toggle("hidden", !game || !host || bound);
}

/** Overlay: profile shortcuts (top right) and the game line. */
function renderOverlayBar(cur) {
  if (document.body.classList.contains("mouse-mode") || document.body.classList.contains("headset-mode")) return renderOverlayHead();
  $("#ov-profiles").innerHTML = S.profiles.map((p, i) =>
    `<button class="bank prof ${p.id === S.editId ? "on" : ""}" data-id="${esc(p.id)}" title="${esc(`${i + 1}. ${p.name}`)}">
      ${i + 1}${p.id === S.activeId ? '<i class="act"></i>' : ""}</button>`).join("");
  const game = S.game;
  const bound = game && (S.dto?.rules || []).some((r) => (r.exe || "").toLowerCase() === game.toLowerCase());
  $("#ov-game-text").innerHTML = !game
    ? t("Profil affiché : <b>{name}</b>", { name: esc(cur?.name || "—") })
    : bound
      ? t("Jeu : <b>{game}</b> · utilise ce profil", { game: esc(game) })
      : t("Jeu : <b>{game}</b> · ce profil ne lui est pas associé", { game: esc(game) });
  $("#ov-assign").classList.toggle("hidden", !game || bound);
}

$("#ov-profiles").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-id]");
  if (!b || b.dataset.id === S.editId) return;
  if (await loadEdit(b.dataset.id)) {
    // while the overlay has the focus, the G13 follows the profile shown here
    invoke("set_preview", { id: b.dataset.id }).catch(() => {});
  }
});

$("#ov-assign").addEventListener("click", async () => {
  if (S.game && document.body.classList.contains("mouse-mode")) {
    Mouse.bindApp(S.game);
    toast(t("« {name} » s'activera désormais dans {app}", { name: Mouse.softName(Mouse.softIndex()), app: S.game }));
    return;
  }
  if (S.game && S.editId) await bindApp(S.game);
});

/** Tell where the edited profile applies once this window loses the focus. */
function renderScope(cur) {
  const bar = $("#scope-bar");
  if (!cur || !S.dto) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const apps = (S.dto.rules || []).map((r) => r.exe || r.title).filter(Boolean);
  const def = S.profiles.find((p) => p.default);
  const pinned = S.profiles.find((p) => p.id === S.pinned);
  $("#scope-pin").textContent = S.pinned === cur.id ? t("ARRÊTER LE TEST") : t("TESTER PARTOUT");
  $("#scope-pin").classList.toggle("primary", S.pinned === cur.id);
  let html, warn = false;
  if (pinned) {
    html = t("Test en cours : « <b>{name}</b> » est actif sur le G13 <b>dans toutes les applications</b> (associations et profil par défaut ignorés) jusqu'à « Arrêter le test ».", { name: esc(pinned.name) });
    warn = S.pinned !== cur.id;
  } else if (apps.length) {
    html = t("« <b>{name}</b> » s'active tout seul dans : <b>{apps}</b>.", { name: esc(cur.name), apps: esc(apps.join(", ")) }) +
      (cur.default ? " " + t("Partout ailleurs aussi (profil par défaut ★).") : "");
  } else if (cur.default) {
    html = t("« <b>{name}</b> » est le profil par défaut ★ : il s'applique partout où aucun profil de jeu n'est associé.", { name: esc(cur.name) });
  } else {
    warn = true;
    html = t("Vous modifiez « <b>{name}</b> » : il est actif ici pour l'essai, mais hors de G Nexus c'est « <b>{def}</b> » ★ qui s'applique, car ce profil n'est associé à aucun jeu.",
      { name: esc(cur.name), def: esc(def ? def.name : "?") });
  }
  bar.classList.toggle("warn", warn);
  $("#scope-text").innerHTML = html;
  $("#scope-default").classList.toggle("hidden", !!cur.default);
  $("#scope-app").classList.toggle("hidden", apps.length > 0);
}

// ---- main render -------------------------------------------------------------------

function render() {
  if (!S.dto) return;
  const labels = {};
  for (const [k, v] of Object.entries(bankActions())) labels[k] = actionLabel(v);
  Device.setLabels(labels);
  Device.setBank(S.bank);
  for (const b of $$(".bank[data-bank]")) b.classList.toggle("on", b.dataset.bank === S.bank);
  $("#bank-label-text").textContent = t("MENU {bank}", { bank: S.bank });
  renderColor();
  renderStick();
  Device.setLcd([S.dto.name || "", t("Menu {bank}", { bank: S.bank }), S.connected ? "G Nexus" : t("hors ligne")]);
  renderProfileMenu();
  renderOffline();
}

function stickCfg() {
  return { mode: S.dto.stick?.mode || "keys", deadzone: S.dto.stick?.deadzone ?? 35, target: S.dto.stick?.target || "left" };
}

function renderStick() {
  const { mode, deadzone, target } = stickCfg();
  Device.setStickMode(mode, target);
  $("#device").classList.toggle("gamepad", mode !== "keys");
  for (const b of $$("#stick-mode .pill-btn")) b.classList.toggle("on", b.dataset.mode === mode);
  $("#stick-mode-label").textContent = mode === "keys" ? t("CLAVIER") : t("MANETTE");
  $("#deadzone").value = deadzone;
  $("#dz-val").textContent = deadzone + " %";
}

function setStick(patch, msg) {
  const st = { ...stickCfg(), ...patch };
  if (st.target === "left") delete st.target; // default, kept out of the file
  S.dto.stick = st;
  renderStick();
  save(msg);
}

// Both the G13 profile queue and the shared macro queue must drain. A new
// edit can arrive while the other queue is being awaited, so recheck both.
async function flushAllEdits() {
  for (;;) {
    if (!(await flushAllProfiles())) return false;
    if (!(await MacroLib.flush())) return false;
    if (!pendingSaves.size && !saveWorkers.size && !failedSaves.size && !MacroLib.hasWork()) return true;
  }
}

// All native routes (window X / Alt+F4 / overlay key / tray / restart) use the
// same request. A cancelled/failed save vetoes close; never discard a draft.
const closeRequests = [];
let closeRunner = null;
function hasUnsavedMouseWork() {
  // The G502 editor owns a separate draft. Do not claim a successful close
  // while that draft is dirty or its save is still awaiting device status.
  return !!Mouse.saving || (!!Mouse.draft && Mouse.dirty());
}
function unresolvedCloseUi() {
  return !!document.querySelector("#prompt.open") || !!CP || G13Macros.recording || !!Mouse.macroEd?.recording || hasUnsavedMouseWork();
}
function flushBeforeClose({ payload: token }) {
  closeRequests.push(token);
  if (closeRunner) return closeRunner;
  // Commit change-only fields before freezing actual user input.
  if (!unresolvedCloseUi()) document.activeElement?.blur();
  closeOperation = true;
  syncInert();
  closeRunner = (async () => {
    while (closeRequests.length) {
      const token = closeRequests.shift(), serial = cancelSerial;
      try {
        const blockers = unresolvedCloseUi() || destructiveOperation || reloadOperation;
        const actions = blockers ? [] : await Promise.allSettled([...closeSensitiveJobs]);
        const actionsOk = actions.every((a) => a.status === "fulfilled");
        const saved = !blockers && actionsOk && !unresolvedCloseUi() && !destructiveOperation &&
          !reloadOperation && await flushAllEdits() && !unresolvedCloseUi();
        const hold = await invoke("finish_window_close", { token, saved });
        frozenForQuit = !!hold && serial === cancelSerial;
        if (!saved) toast(hasUnsavedMouseWork()
          ? t("Enregistrez ou annulez le brouillon de souris ; attendez la fin d'un enregistrement en cours.")
          : t("Fermeture annulée : terminez le dialogue ou corrigez les modifications non enregistrées."), true);
      } catch (e) {
        // If delivery fails twice the native guard stays pending rather than
        // allowing data loss. A broken IPC can require restarting the app.
        await invoke("finish_window_close", { token, saved: false }).catch(() => {});
        toast(t("Fermeture annulée : {e}", { e }), true);
      }
    }
  })().finally(() => {
    closeRunner = null;
    closeOperation = false;
    syncInert();
    resumeHeldSaves();
  });
  return closeRunner;
}
function closeCancelled() {
  cancelSerial++;
  frozenForQuit = false;
  syncInert();
  resumeHeldSaves();
}
async function reloadAfterFlush() {
  if (closeBusy() || destructiveOperation) return;
  if (unresolvedCloseUi()) {
    if (hasUnsavedMouseWork()) toast(t("Enregistrez ou annulez le brouillon de souris ; attendez la fin d'un enregistrement en cours."), true);
    return;
  }
  reloadOperation = true;
  syncInert();
  try {
    if (await flushAllEdits()) location.reload();
    else toast(t("Actualisation annulée : des modifications n'ont pas pu être enregistrées."), true);
  } finally {
    reloadOperation = false;
    syncInert();
    resumeHeldSaves();
  }
}

function renderColor() {
  const dev = $("#device");
  const base = S.base[S.bank];
  const col = bankObj().color;
  const root = document.documentElement.style;
  dev.classList.toggle("no-color", !col);
  dev.style.setProperty("--glow", col && hex2rgb(col) ? col : "#a7aebb");
  // what the G13 actually shows: key legends and LCD take this colour…
  root.setProperty("--tint", col && hex2rgb(col) ? col : "#ffffff");
  dev.style.setProperty("--tint", col && hex2rgb(col) ? col : "#ffffff");
  // …and the whole app (tabs, selections, picker) uses its hue as accent
  if (base) root.setProperty("--accent", base.rgb);
  else root.removeProperty("--accent");
  if (base) {
    // glow shows the hue at a readable intensity; the device gets the dimmed value
    dev.style.setProperty("--glow", base.rgb);
    $("#bright").value = base.bright;
    $("#bright-val").textContent = base.bright + "%";
  } else {
    $("#bright").value = 100;
    $("#bright-val").textContent = "—";
  }
  $("#color-btn").title = col ? t("Couleur du menu {bank} : {color}", { bank: S.bank, color: col }) : t("Aucune couleur : celle du menu précédent est conservée");
  if (Device.lastFrame) Device.setLcdFrame(Device.lastFrame, lcdColor());
}

/** Colour of lit LCD pixels: the menu colour lightened like the key legends. */
function lcdColor() {
  const c = hex2rgb(bankObj().color) || { r: 255, g: 255, b: 255 };
  const mix = (v) => v * 0.62 + 255 * 0.38;
  return rgb2hex({ r: mix(c.r), g: mix(c.g), b: mix(c.b) });
}

function applyColor() {
  const base = S.base[S.bank];
  if (!base) return;
  const c = hex2rgb(base.rgb);
  const f = base.bright / 100;
  bankObj().color = rgb2hex({ r: c.r * f, g: c.g * f, b: c.b * f });
  renderColor();
  save();
}

function renderStatus() {
  const chip = $("#status-chip");
  const st = S.status;
  chip.classList.toggle("ok", S.connected);
  chip.classList.toggle("warn", !!st.error);
  let text = st.error ? t("Moteur arrêté") : S.connected ? t("G13 connecté") : t("G13 non détecté");
  if (st.dry_run) text += " · " + t("simulation");
  $("#status-text").textContent = text;
  chip.title = st.error || "";
  const act = S.profiles.find((p) => p.id === S.activeId);
  $("#active-profile").textContent = act ? act.name : S.activeId || "—";
}

function renderOffline() {
  const off = !S.connected && !S.offlineEdit;
  $("#device").classList.toggle("offline-mode", off);
  $("#offline").classList.toggle("show", off);
}

// ---- picker -------------------------------------------------------------------------

function openSheet(id) {
  closeSheets(false);
  $("#scrim").classList.add("show");
  $(id).classList.add("open");
}

function closeSheets(clearSel = true) {
  if (CP) return closeColor(false); // scrim / Échap on the colour dialog = Annuler
  $$(".sheet.open, .modal.open").forEach((s) => s.classList.remove("open"));
  $("#scrim").classList.remove("show");
  // a sheet closed while recording: the capture is dropped
  G13Macros.abort();
  Mouse.macroEd?.abort();
  if (clearSel) {
    S.selected = null;
    Device.setSelected(null);
    MouseDevice.setSelected(null);
  }
}

/** The G13 key `id` in the picker. */
function openPicker(id) {
  if (!S.dto) return;
  S.selected = id;
  Device.setSelected(id);
  const names = { G25: t("G25 · clic stick"), STICK_UP: "Stick ↑", STICK_DOWN: "Stick ↓", STICK_LEFT: "Stick ←", STICK_RIGHT: "Stick →" };
  openPickerFor({
    label: names[id] || id,
    sub: t("MENU {bank}", { bank: S.bank }),
    dance: true,
    get: () => bankObj()[id],
    set: (action) => {
      const b = bankObj();
      if (action == null) delete b[id];
      else b[id] = action;
      render();
      save(`${id} → ${action == null ? t("aucune action") : actionLabel(action)}`);
    },
  });
  Device.setSelected(id);
}

/** Key dragged onto another: its action replaces the target's and it becomes blank. */
function moveKey(from, to) {
  if (!S.dto || from === to) return;
  const b = bankObj();
  if (b[from] == null) { toast(t("{key} n'a aucune action à déplacer", { key: from }), true); return; }
  b[to] = b[from];
  delete b[from];
  render();
  save(t("{from} déplacé sur {to}", { from, to }));
}

/**
 * Open the action picker for any target: { label, sub, get(), set(action), mouse? }.
 * `mouse: true` limits it to what a mouse's memory can hold (one key + modifiers,
 * media keys, mouse buttons and the mouse's own functions; no macro, no gamepad).
 */
function openPickerFor(target) {
  S.pick = target;
  S.mods.clear();
  // a mouse has macros only in real time (target.macros)
  const hidden = target.mouse ? (target.macros ? ["pad"] : ["pad", "macros"]) : [];
  $$("#picker-tabs button").forEach((b) => b.classList.toggle("hidden", hidden.includes(b.dataset.tab)));
  if (hidden.includes(S.pickerTab)) S.pickerTab = "keyboard";
  $("#picker-key").textContent = target.label;
  $("#picker-bank").textContent = target.sub || "";
  // multi-state key (G13): the modes panel edits one mode at a time
  if (target.dance) {
    const cur = target.get();
    S.dance = isDance(cur) ? structuredClone(cur) : { tap: cur ?? null };
    S.danceSlot = "tap";
    S.danceTouched = false;
  }
  $("#picker").classList.toggle("with-dance", !!target.dance);
  $("#picker-dance").classList.toggle("hidden", !target.dance);
  renderPicker();
  openSheet("#picker");
}

function renderPicker() {
  const dance = S.pick?.dance;
  const whole = S.pick?.get();
  // with the modes panel, the highlighted action is the selected mode's
  const cur = dance ? S.dance[S.danceSlot] : whole;
  $("#picker-current").textContent = whole == null ? t("aucune") : isDance(whole) ? danceSummary(whole) : actionLabel(whole);
  if (dance) {
    $("#dance-grid").innerHTML = DANCE_SLOTS.map(([k, name, title]) => {
      const a = S.dance[k];
      return `<button class="dance-slot${k === S.danceSlot ? " on" : ""}" data-slot="${k}" title="${esc(t(title))}">
        <span class="ds-name">${name}</span>
        <span class="ds-act${a == null ? " empty" : ""}">${a == null ? "×" : esc(actionLabel(a))}</span>
        ${a != null ? `<span class="ds-clear" data-clear="${k}" title="${esc(t("Vider ce mode"))}">×</span>` : ""}</button>`;
    }).join("");
  }
  $$("#picker-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.pickerTab));
  $("#mods").classList.toggle("hidden", !["keyboard", "basic"].includes(S.pickerTab));
  $$("#mods button").forEach((b) => b.classList.toggle("on", S.mods.has(b.dataset.mod)));
  const body = $("#picker-body");
  const isCur = (a) => (sameAction(cur, a) ? " cur" : "");

  if (S.pickerTab === "keyboard") {
    body.innerHTML = KEYBOARD_ROWS.map((row) => `<div class="kb-row">${row.map(([code, main, sub, u = 1]) => {
      const w = u * 50 + (u - 1) * 7;
      return `<button class="kb-key${isCur(code)}" data-code="${code}" style="width:${w}px" title="${code}">${esc(main)}${sub ? `<sup>${esc(sub)}</sup>` : ""}</button>`;
    }).join("")}</div>`).join("");
  } else if (S.pickerTab === "basic") {
    body.innerHTML = BASIC_GROUPS.map(([cap, codes]) => `<div class="group-cap">${t(cap)}</div><div class="tiles">${codes
      .map((c) => `<button class="tile${isCur(c)}" data-code="${c}" title="${c}">${esc(KEY_LABELS[c] || c)}</button>`).join("")}</div>`).join("");
  } else if (S.pickerTab === "media") {
    body.innerHTML = `<div class="tiles">${MEDIA.map(([c, title, icon]) =>
      `<button class="tile${isCur(c)}" data-code="${c}" title="${t(title)}">${icon}</button>`).join("")}</div>`;
  } else if (S.pickerTab === "mouse" && S.pick?.mouse) {
    // a mouse's memory: its buttons (no wheel steps) and its own functions
    body.innerHTML = `<div class="group-cap">${t("Boutons")}</div><div class="tiles">${MOUSE.map(([a, , title], i) => a.mouse
      ? `<button class="tile${isCur(a)}" data-mouse="${i}" title="${t(title)}">${esc(actionLabel(a))}</button>` : "").join("")}</div>
      ${MOUSE_SPECIAL_GROUPS.map(([cap, list]) => `<div class="group-cap">${t(cap)}</div><div class="tiles">${list.map(([id, , title]) =>
        `<button class="tile${isCur({ special: id })}" data-special="${id}" title="${esc(t(title))}">${esc(actionLabel({ special: id }))}</button>`).join("")}</div>`).join("")}`;
  } else if (S.pickerTab === "mouse") {
    body.innerHTML = `<div class="tiles">${MOUSE.map(([a, label, title], i) =>
      `<button class="tile${isCur(a)}" data-mouse="${i}" title="${t(title)}">${esc(actionLabel(a))}</button>`).join("")}</div>`;
  } else if (S.pickerTab === "pad") {
    const tip = (id, title) => (/^Bouton [ABXY]$/.test(title) ? t("Bouton {b}", { b: id }) : t(title));
    body.innerHTML = PAD_GROUPS.map(([cap, list]) => `<div class="group-cap">${t(cap)}</div><div class="tiles">${list
      .map(([id, label, title]) => `<button class="tile${isCur({ pad: id })}" data-pad="${id}" title="${esc(tip(id, title))}">${esc(label)}</button>`).join("")}</div>`).join("") +
      `<p class="muted" style="font-size:13px">${ON_LINUX
        ? t("Boutons d'une manette Xbox 360 virtuelle. Mettez le stick en mode manette pour en faire son joystick analogique.")
        : t("Boutons d'une manette Xbox 360 virtuelle (pilote ViGEmBus). Mettez le stick en mode manette pour en faire son joystick analogique.")}</p>`;
  } else {
    const all = S.pick?.macros ? S.pick.macros() : S.dto.macros || {};
    const names = Object.keys(all);
    const mode = (n) => t((MACRO_MODES.find(([m]) => m === (all[n].mode || "once")) || [])[1] || "");
    if (!MacroLib.items && !MacroLib.loadError) MacroLib.ensure().then((lib) => { if (lib && S.pickerTab === "macros") renderPicker(); });
    const lib = MacroLib.others(all);
    body.innerHTML = `<div class="tiles">${names.map((n) =>
      `<button class="tile wide${isCur({ macro: n })}" data-macro="${esc(n)}" title="${esc(mode(n))}">▶ ${esc(n)}</button>`).join("")}
      <button class="tile wide" id="macro-new-assign">${t("+ NOUVELLE MACRO")}</button></div>
      ${lib.length ? `<div class="group-cap">${t("BIBLIOTHÈQUE")}</div><div class="tiles">${lib.map((n) =>
        `<button class="tile wide lib" data-libmacro="${esc(n)}" title="${esc(t("Macro d'un autre profil : une copie est ajoutée à ce profil"))}">＋ ${esc(n)}</button>`).join("")}</div>` : ""}
      <p class="muted" style="font-size:13px">${t("Les macros se modifient dans « Paramètres avancés › Macros ».")}</p>`;
  }
}

function assign(action) {
  const target = S.pick;
  if (target?.dance) {
    // fills the selected mode; a plain one-shot pick (Tap only) still closes the sheet
    S.dance[S.danceSlot] = action;
    const plain = S.danceSlot === "tap" && !S.danceTouched && DANCE_SLOTS.every(([k]) => k === "tap" || S.dance[k] == null);
    target.set(danceValue(S.dance));
    if (plain) closeSheets();
    else { S.mods.clear(); renderPicker(); }
    return;
  }
  closeSheets();
  target?.set(action);
}

$("#dance-grid").addEventListener("click", (e) => {
  const clear = e.target.closest("[data-clear]");
  const slot = clear?.dataset.clear || e.target.closest("[data-slot]")?.dataset.slot;
  if (!slot || !S.pick?.dance) return;
  S.danceSlot = slot;
  S.danceTouched = true;
  S.mods.clear();
  if (clear) {
    S.dance[slot] = null;
    S.pick.set(danceValue(S.dance));
  }
  renderPicker();
});

$("#picker-body").addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.dataset.code) {
    const keys = [...S.mods].filter((m) => m !== button.dataset.code);
    assign([...keys, button.dataset.code].join("+"));
  } else if (button.dataset.mouse) {
    assign(structuredClone(MOUSE[+button.dataset.mouse][0]));
  } else if (button.dataset.special) {
    assign({ special: button.dataset.special });
  } else if (button.dataset.pad) {
    assign({ pad: button.dataset.pad });
  } else if (button.dataset.macro) {
    assign({ macro: button.dataset.macro });
  } else if (button.dataset.libmacro) {
    // a macro of another profile: copied into this one, then bound
    const name = button.dataset.libmacro;
    const all = S.pick?.macros ? S.pick.macros() : S.dto.macros;
    if (!MacroLib.copyInto(name, all)) {
      toast(t("La macro n'est plus disponible ou existe déjà dans ce profil. Actualisez puis réessayez."), true);
      renderPicker();
      return;
    }
    assign({ macro: name });
  } else if (button.id === "macro-new-assign" && S.pick?.newMacro) {
    const pick = S.pick;
    const name = pick.newMacro();
    if (!name) return;
    assign({ macro: name });
    pick.openMacros?.();
  } else if (button.id === "macro-new-assign") {
    const name = newMacro();
    if (!name) return;
    assign({ macro: name });
    openAdvanced("macros");
  }
});
$("#picker-tabs").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (t) { S.pickerTab = t.dataset.tab; renderPicker(); }
});
$("#mods").addEventListener("click", (e) => {
  const t = e.target.closest("button[data-mod]");
  if (!t) return;
  const m = t.dataset.mod;
  S.mods.has(m) ? S.mods.delete(m) : S.mods.add(m);
  renderPicker();
});
$("#picker-none").addEventListener("click", () => assign(null));

// ---- advanced: rules + macros ----------------------------------------------------------

function openAdvanced(tab = S.advTab) {
  if (!S.dto) return;
  S.advTab = tab;
  $("#adv-profile").textContent = t("PROFIL « {name} »", { name: S.dto.name || "" });
  renderAdvanced();
  openSheet("#advanced");
}

function renderAdvanced() {
  $$("#adv-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.advTab));
  $("#adv-apps").classList.toggle("hidden", S.advTab !== "apps");
  $("#adv-macros").classList.toggle("hidden", S.advTab !== "macros");
  if (S.advTab === "apps") { renderRules(); renderDetected(); }
  else renderMacros();
}

/** Detected applications as one-click chips (bind to the profile shown). */
async function renderDetected() {
  let list;
  try { list = await invoke("detected_apps"); } catch { list = { running: [], recent: [] }; }
  const lower = (s) => (s || "").toLowerCase();
  const mine = (S.dto.rules || []).map((r) => lower(r.exe));
  const owner = (exe) => S.profiles.find((p) => p.id !== S.editId && p.apps.some((a) => lower(a) === lower(exe)));
  const chip = (a) => {
    const bound = mine.includes(lower(a.exe));
    const other = owner(a.exe);
    return `<button class="app-chip ${bound ? "bound" : ""}" data-exe="${esc(a.exe)}" ${bound ? "disabled" : ""}
      title="${esc(a.title)}"><b>${esc(a.exe)}</b><span>${esc(a.title || "")}</span>
      ${bound ? `<em>${t("associée à ce profil")}</em>` : other ? `<em>${t("actuellement : {name}", { name: esc(other.name) })}</em>` : ""}</button>`;
  };
  $("#apps-running").innerHTML = list.running.map(chip).join("") ||
    `<span class="muted" style="font-size:13px">${t("Aucune application ouverte détectée.")}</span>`;
  $("#apps-recent").innerHTML = list.recent.map(chip).join("");
  $("#apps-recent-cap").classList.toggle("hidden", !list.recent.length);
}

async function bindApp(exe) {
  const id = S.editId, token = profileTokens.get(id), navigation = loadRevision;
  if (!id || !token || destructiveOperation) return;
  try {
    if (!(await flushProfile(id)) || closeBusy() || S.editId !== id || loadRevision !== navigation) return;
    await invoke("assign_game", { id, exe, token });
    await refreshProfiles();
    if (S.editId !== id || loadRevision !== navigation) return;
    const keepTab = S.advTab;
    if (!(await loadEdit(id))) return;
    S.advTab = keepTab;
    renderAdvanced();
    toast(t("« {name} » s'activera dans {app}", { name: S.dto.name, app: exe }));
  } catch (e) {
    if (String(e).includes("PROFILE_REPLACED:") && S.editId === id) {
      holdFailedDraft(id, e, { raw: structuredClone(S.dto), base: structuredClone(profileBases.get(id)), token, timer: null });
    } else toast(explainProfileError(e), true);
  }
}

for (const id of ["#apps-running", "#apps-recent"]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest(".app-chip");
    if (b && !b.disabled) bindApp(b.dataset.exe);
  });
}
$("#apps-refresh").addEventListener("click", renderDetected);
$("#rule-browse").addEventListener("click", async () => {
  const id = S.editId, navigation = loadRevision;
  try {
    const exe = await invoke("pick_exe");
    if (exe && S.editId === id && loadRevision === navigation) await bindApp(exe);
  } catch (e) { toast(String(e), true); }
});

function renderRules() {
  $("#rules").innerHTML = S.dto.rules.map((r, i) => `<div class="rule" data-i="${i}">
      <input class="exe" data-f="exe" placeholder="programme.exe" value="${esc(r.exe || "")}" spellcheck="false">
      <input class="title" data-f="title" placeholder="${t("ou un texte du titre de la fenêtre (facultatif)")}" value="${esc(r.title || "")}" spellcheck="false">
      <button class="icon-btn danger" data-del title="${t("Retirer")}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>`).join("") || `<p class="muted" style="font-size:13px">${t("Aucune application associée.")}</p>`;
}

$("#rules").addEventListener("input", (e) => {
  const row = e.target.closest(".rule");
  if (!row) return;
  S.dto.rules[+row.dataset.i][e.target.dataset.f] = e.target.value;
  save();
});
$("#rules").addEventListener("click", (e) => {
  if (!e.target.closest("[data-del]")) return;
  S.dto.rules.splice(+e.target.closest(".rule").dataset.i, 1);
  renderRules();
  save(t("Application retirée"));
});
$("#rule-add").addEventListener("click", () => {
  S.dto.rules.push({ exe: "" });
  editRevision++; // even a blank row must survive an in-flight profile read
  renderSaveProblem();
  renderRules();
  $$("#rules input.exe").pop()?.focus();
});

// G13 macros: the shared editor (macro-editor.js), on the profile being edited
const G13Macros = new MacroEditor({
  list: $("#macro-list"),
  edit: $("#macro-edit"),
  get: () => S.dto?.macros,
  set: (m) => { S.dto.macros = m; },
  changed: (msg) => save(msg),
  renamed: (old, nn) => {
    mapMacroUses((a) => (a.macro === old ? { macro: nn } : a));
    render();
  },
  deleted: (name) => {
    mapMacroUses((a) => (a.macro === name ? null : a));
    render();
  },
});
const renderMacros = () => G13Macros.render();

/** Rewrite every bound action of the three banks (modes of multi-state keys included); null unbinds. */
function mapMacroUses(f) {
  for (const b of ["M1", "M2", "M3"]) for (const [k, v] of Object.entries(bankActions(b))) {
    if (v == null) continue;
    let nv;
    if (isDance(v)) {
      const d = {};
      for (const [s] of DANCE_SLOTS) d[s] = v[s] != null ? f(v[s]) : null;
      nv = danceValue(d);
    } else nv = f(v);
    if (nv == null) delete bankObj(b)[k];
    else bankObj(b)[k] = nv;
  }
}
const newMacro = () => G13Macros.add();

$("#adv-tabs").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (t) { S.advTab = t.dataset.tab; renderAdvanced(); }
});

// ---- settings ------------------------------------------------------------------------

/** Settings sections: GÉNÉRAL / CLAVIER G13 / SOURIS / CASQUE (several panes may share a tab). */
function showSettingsTab(tab) {
  $$("#set-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  $$("#settings .set-pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== tab));
}
$("#set-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showSettingsTab(b.dataset.tab);
});
// About: version, the author's GitHub and Ko-fi pages (opened in the browser)
invoke("app_version").then((v) => { $("#about-version").textContent = t("version {v}", { v }); }).catch(() => {});
for (const [id, which] of [["#about-github", "github"], ["#about-kofi", "kofi"], ["#about-jasp", "jaspmakes"]]) {
  $(id).addEventListener("click", (e) => {
    e.preventDefault();
    invoke("open_link", { which }).catch((x) => toast(String(x), true));
  });
}
$$(".ms-export-btn").forEach((b) => b.addEventListener("click", async () => {
  if (!Mouse.draft) { toast(t("Souris non détectée"), true); return; }
  try {
    const path = await invoke("export_mouse_profile", { settings: Mouse.draft });
    if (path) toast(t("Profil de la souris exporté : {path}", { path }));
  } catch (e) { toast(t("Export impossible : {e}", { e }), true); }
}));
$$(".ms-import-btn").forEach((b) => b.addEventListener("click", async () => {
  if (!Mouse.draft) { toast(t("Souris non détectée"), true); return; }
  try {
    const s = await invoke("import_mouse_profile");
    if (!s) return;
    Mouse.draft = s;
    closeSheets();
    Mouse.show(true);
    Mouse.render();
    Mouse.preview(true);
    toast(Mouse.host() ? t("Profil importé : vérifiez puis « Enregistrer »") : t("Profil importé : vérifiez puis « Enregistrer dans la souris »"));
  } catch (e) { toast(t("Import impossible : {e}", { e }), true); }
}));

async function openSettings() {
  const cls = document.body.classList;
  showSettingsTab(cls.contains("mouse-mode") ? "mouse" : cls.contains("headset-mode") ? "headset" : "general");
  try {
    const s = await invoke("get_settings");
    $("#set-autostart").checked = s.autostart;
    $("#set-minimized").checked = s.start_minimized;
    $("#set-tray").checked = s.close_to_tray;
    $("#set-overlay").value = s.overlay_key || "";
    $("#set-overlay-pos").value = s.overlay_position || "right";
    $("#set-dir").textContent = s.profiles_dir || "—";
    $("#set-lang").value = s.language || "";
    $("#set-layout").value = s.keyboard_layout || "";
    $("#set-backup").value = s.auto_backup || "weekly";
    $("#set-backup-keep").value = s.auto_backup_keep || 10;
    showLastBackup(s.last_backup);
  } catch (e) { toast(String(e), true); }
  checkAccess();
  openSheet("#settings");
}

async function writeSettings() {
  try {
    await invoke("set_settings", {
      autostart: $("#set-autostart").checked,
      startMinimized: $("#set-minimized").checked,
      closeToTray: $("#set-tray").checked,
      overlayKey: $("#set-overlay").value || null,
      overlayPosition: $("#set-overlay-pos").value,
      autoBackup: $("#set-backup").value,
      autoBackupKeep: Math.max(1, Math.min(100, +$("#set-backup-keep").value || 10)),
    });
    toast(t("Paramètres enregistrés"));
  } catch (e) {
    toast(String(e), true);
    openSettings();
  }
}
function fillOverlayKeys() {
  $("#set-overlay").innerHTML = `<option value="">${t("Désactivé")}</option>` +
    Array.from({ length: 25 }, (_, i) => `G${i + 1}`)
      .map((k) => `<option value="${k}">${k === "G25" ? t("G25 · clic du stick") : k}</option>`).join("");
}
for (const id of ["#set-autostart", "#set-minimized", "#set-tray", "#set-overlay", "#set-overlay-pos", "#set-backup", "#set-backup-keep"])
  $(id).addEventListener("change", writeSettings);
function showLastBackup(date) {
  $("#set-backup-last").textContent = date ? t("Dernière sauvegarde : {date}", { date }) : t("Aucune sauvegarde pour l'instant");
}
$("#set-backup-now").addEventListener("click", async () => {
  try {
    if (!(await flushAllEdits()) || closeBusy()) return;
    const date = await invoke("backup_now");
    showLastBackup(date);
    toast(t("Configuration sauvegardée"));
  } catch (e) { toast(t("Sauvegarde impossible : {e}", { e }), true); }
});
$("#set-open-dir").addEventListener("click", () => invoke("open_profiles_dir").catch((e) => toast(String(e), true)));

// language and picker keyboard: saved, then both windows reload in the new language
async function writeLanguage() {
  try {
    if (!(await flushAllEdits()) || closeBusy()) return;
    await invoke("set_language", { language: $("#set-lang").value || null, keyboardLayout: $("#set-layout").value || null });
  } catch (e) { toast(String(e), true); }
}
$("#set-lang").addEventListener("change", writeLanguage);
$("#set-layout").addEventListener("change", writeLanguage);

$("#cfg-export").addEventListener("click", async () => {
  try {
    if (!(await flushAllEdits())) return;
    const path = await invoke("export_config");
    if (path) toast(t("Configuration exportée : {path}", { path }));
  } catch (e) { toast(t("Export impossible : {e}", { e }), true); }
});
async function replaceConfig(reset) {
  if (destructiveOperation) return;
  const title = reset ? t("TOUT REMETTRE PAR DÉFAUT ?") : t("REMPLACER TOUS LES PROFILS ET PARAMÈTRES ?");
  if (!(await ask(title, "", { confirmOnly: true, ok: reset ? t("RÉINITIALISER") : t("IMPORTER") }))) return;
  if (destructiveOperation) return;
  destructiveOperation = true; syncInert();
  try {
    if (!(await flushAllEdits())) return;
    const id = S.editId, token = profileTokens.get(id), revision = editRevision, macroAtStart = MacroLib.revision;
    const n = await invoke(reset ? "reset_config" : "import_config");
    if (!reset && n == null) return;
    const macroChanged = MacroLib.revision !== macroAtStart;
    MacroLib.configReplaced();
    if (editRevision !== revision && id && S.editId === id) {
      holdFailedDraft(id, "PROFILE_REPLACED: configuration remplacée pendant l'édition",
        { raw: structuredClone(S.dto), base: structuredClone(profileBases.get(id)), token, timer: null });
      return;
    }
    if (macroChanged) {
      toast(t("La bibliothèque a changé pendant l'import : examinez la file locale."), true);
      return;
    }
    sessionStorage.setItem("g13-toast", reset ? t("Configuration réinitialisée") : t("Configuration importée : {n} profil(s)", { n }));
    location.reload();
  } catch (e) {
    if (String(e).includes("CONFIG_MAY_BE_PARTIAL:")) {
      MacroLib.configReplaced();
      if (S.editId) holdFailedDraft(S.editId, e, { raw: structuredClone(S.dto), base: structuredClone(profileBases.get(S.editId)), token: profileTokens.get(S.editId), timer: null });
    }
    const reason = explainProfileError(e);
    toast(reset ? t("Réinitialisation impossible : {e}", { e: reason }) : t("Import impossible : {e}", { e: reason }), true);
  } finally { destructiveOperation = false; syncInert(); resumeHeldSaves(); }
}
$("#cfg-import").addEventListener("click", () => replaceConfig(false));
$("#cfg-reset").addEventListener("click", () => replaceConfig(true));
$("#cfg-backups").addEventListener("click", () => invoke("open_backups_dir").catch((e) => toast(String(e), true)));
$("#set-backup-open").addEventListener("click", () => invoke("open_backups_dir").catch((e) => toast(String(e), true)));

// ---- small dialogs ----------------------------------------------------------------------

function ask(title, value = "", { confirmOnly = false, ok = "OK", placeholder = "" } = {}) {
  return new Promise((resolve) => {
    const m = $("#prompt"), inp = $("#prompt-input");
    $("#prompt-title").textContent = title;
    inp.placeholder = placeholder;
    inp.classList.toggle("hidden", confirmOnly);
    inp.value = value;
    $("#prompt-ok").textContent = ok || "OK";
    closeSheets(false);
    $("#scrim").classList.add("show");
    m.classList.add("open");
    if (!confirmOnly) setTimeout(() => { inp.focus(); inp.select(); }, 30);
    const done = (v) => {
      m.classList.remove("open");
      $("#scrim").classList.remove("show");
      $("#prompt-ok").onclick = $("#prompt-cancel").onclick = inp.onkeydown = null;
      resolve(v);
    };
    $("#prompt-ok").onclick = () => done(confirmOnly ? true : inp.value.trim() || null);
    $("#prompt-cancel").onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === "Enter") $("#prompt-ok").click(); if (e.key === "Escape") done(null); };
  });
}

// ---- header actions -----------------------------------------------------------------------

$("#profile-list").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.id === "profile-add") newProfile();
  else if (b.dataset.id !== S.editId) loadEdit(b.dataset.id);
});

async function newProfile() {
  const name = await ask(t("NOUVEAU PROFIL"), "", { placeholder: t("nom du jeu ou de l'application") });
  if (!name) return;
  try { const id = await invoke("create_profile", { name, from: null }); await refreshProfiles(); await loadEdit(id); toast(t("Profil créé")); }
  catch (e) { toast(String(e), true); }
}
$("#btn-new").addEventListener("click", newProfile);

$("#stick-mode").addEventListener("click", (e) => {
  const b = e.target.closest(".pill-btn");
  if (!b || !S.dto) return;
  const mode = b.dataset.mode;
  if (mode === stickCfg().mode) return;
  // a gamepad stick wants a small dead zone, keys a large one: swap the defaults
  const dz = stickCfg().deadzone;
  const deadzone = mode === "gamepad" && dz === 35 ? 15 : mode === "keys" && dz === 15 ? 35 : dz;
  setStick({ mode, deadzone }, mode === "gamepad" ? t("Stick en mode manette (joystick analogique)") : t("Stick en mode clavier"));
  if (mode === "gamepad") checkGamepad();
});

/** Warn when the virtual gamepad cannot be created (ViGEmBus missing). */
async function checkGamepad() {
  try { await invoke("gamepad_status"); }
  catch (e) {
    toast(ON_LINUX ? t("Mode manette indisponible : {e}", { e })
      : t("Mode manette indisponible : {e}. Installez le pilote ViGEmBus (github.com/nefarius/ViGEmBus).", { e }), true);
  }
}
$("#btn-dup").addEventListener("click", async () => {
  if (!S.dto) return;
  const from = S.editId, navigation = loadRevision;
  const name = await ask(t("DUPLIQUER LE PROFIL"), t("{name} (copie)", { name: S.dto.name }));
  if (!name || S.editId !== from || loadRevision !== navigation) return;
  try {
    if (!(await flushProfile(from)) || S.editId !== from || loadRevision !== navigation) return;
    const id = await invoke("create_profile", { name, from }); await refreshProfiles();
    if (await loadEdit(id)) toast(t("Profil dupliqué"));
  } catch (e) { toast(String(e), true); }
});
$("#btn-rename").addEventListener("click", async () => {
  if (!S.dto) return;
  const id = S.editId, navigation = loadRevision;
  const name = await ask(t("RENOMMER LE PROFIL"), S.dto.name);
  if (!name || id !== S.editId || navigation !== loadRevision) return;
  S.dto.name = name;
  render();
  save(t("Profil renommé"));
});
function makeDefault() {
  if (!S.dto || S.dto.default) return;
  S.dto.default = true;
  save(t("Profil par défaut : il s'applique maintenant partout"));
}
$("#btn-default").addEventListener("click", makeDefault);
$("#scope-default").addEventListener("click", makeDefault);
$("#scope-pin").addEventListener("click", async () => {
  if (!S.editId) return;
  S.pinned = S.pinned === S.editId ? null : S.editId;
  await invoke("set_pinned", { id: S.pinned }).catch((e) => toast(String(e), true));
  renderProfileMenu();
  toast(S.pinned ? t("Profil actif partout jusqu'à l'arrêt du test") : t("Test arrêté : bascule automatique rétablie"));
});
$("#scope-app").addEventListener("click", () => openAdvanced("apps"));
// ---- clear bindings ------------------------------------------------------------------------
// Keys and stick directions only: colours, macros, rules and stick settings are kept.

$("#btn-clear").addEventListener("click", () => {
  if (!S.dto) return;
  $("#clear-text").textContent = t("Retire l'action de toutes les touches G et des directions du stick du profil « {name} ». Les couleurs, les macros, les applications associées et le mode du stick sont conservés.", { name: S.dto.name });
  $("#clear-bank").textContent = t("MENU {bank} SEULEMENT", { bank: S.bank });
  openSheet("#clear");
});

function clearBanks(banks) {
  for (const b of banks) {
    const obj = bankObj(b);
    for (const k of Object.keys(obj)) if (k !== "color") delete obj[k];
  }
  closeSheets();
  render();
  save(banks.length > 1 ? t("Touches de M1, M2 et M3 effacées") : t("Touches du menu {bank} effacées", { bank: banks[0] }));
}
$("#clear-bank").addEventListener("click", () => clearBanks([S.bank]));
$("#clear-all").addEventListener("click", () => clearBanks(["M1", "M2", "M3"]));

$("#btn-delete").addEventListener("click", async () => {
  if (!S.dto || destructiveOperation) return;
  const id = S.editId, token = profileTokens.get(id), navigation = loadRevision, revision = editRevision;
  const draft = structuredClone(S.dto);
  const ok = await ask(t("SUPPRIMER « {name} » ?", { name: draft.name }), "", { confirmOnly: true, ok: t("SUPPRIMER") });
  if (!ok || destructiveOperation) return;
  const unchanged = () => S.editId === id && profileTokens.get(id) === token && loadRevision === navigation &&
    editRevision === revision && profileValueEqual(S.dto, draft);
  if (!unchanged()) { toast(t("Le profil affiché a changé ; confirmez à nouveau la suppression."), true); return; }
  destructiveOperation = true; syncInert();
  try {
    if (!(await flushProfile(id))) return;
    if (!unchanged()) { toast(t("Le profil affiché a changé ; confirmez à nouveau la suppression."), true); return; }
    const expected = profileForSave(profileBases.get(id));
    await invoke("delete_profile", { id, expected, token });
    if (!unchanged()) {
      holdFailedDraft(id, "PROFILE_REPLACED: le profil a été supprimé pendant l'édition",
        { raw: structuredClone(S.dto), base: structuredClone(profileBases.get(id)), token, timer: null });
      return;
    }
    await refreshProfiles();
    if (!unchanged()) {
      holdFailedDraft(id, "PROFILE_REPLACED: le profil a été supprimé pendant l'édition",
        { raw: structuredClone(S.dto), base: structuredClone(profileBases.get(id)), token, timer: null });
      return;
    }
    profileBases.delete(id); profileTokens.delete(id); pendingSaves.delete(id); failedSaves.delete(id);
    S.editId = null; S.dto = null;
    const next = S.profiles.find((p) => p.id === S.activeId) || S.profiles[0];
    destructiveOperation = false; syncInert();
    if (next) await loadEdit(next.id);
    toast(t("Profil supprimé"));
  } catch (e) { toast(String(e), true); }
  finally { destructiveOperation = false; syncInert(); resumeHeldSaves(); }
});
// ---- Logitech Gaming Software import / export -------------------------------------------------

function showReport(title, text, items) {
  $("#report-title").textContent = title;
  $("#report-text").textContent = text;
  $("#report-list").innerHTML = items.map((s) => `<li>${esc(s)}</li>`).join("");
  $("#report-list").classList.toggle("hidden", !items.length);
  openSheet("#report");
}

$("#btn-import").addEventListener("click", async () => {
  try {
    if (!(await flushAllEdits()) || closeBusy()) return;
    const r = await invoke("import_lgs");
    if (!r) return; // cancelled
    await refreshProfiles();
    if (!(await loadEdit(r.id))) {
      toast(t("Profil importé, mais l'affichage n'a pas changé ; vérifiez le brouillon."), true);
      return;
    }
    if (r.skipped.length) {
      showReport("IMPORT LGS", t("Profil « {name} » importé. Ces éléments n'ont pas pu être repris :", { name: r.name }), r.skipped);
    } else {
      toast(t("Profil « {name} » importé", { name: r.name }));
    }
  } catch (e) { toast(t("Import impossible : {e}", { e: explainProfileError(e) }), true); }
});

$("#btn-export").addEventListener("click", async () => {
  if (!S.editId) return;
  try {
    const id = S.editId;
    if (!(await flushProfile(id))) return;
    const skipped = await invoke("export_lgs", { id });
    if (skipped == null) return; // cancelled
    if (skipped.length) {
      showReport("EXPORT LGS", t("Profil exporté. Ces éléments ne passent pas, ou pas entièrement, dans Logitech Gaming Software :"), skipped);
    } else {
      toast(t("Profil exporté pour Logitech Gaming Software"));
    }
  } catch (e) { toast(t("Export impossible : {e}", { e }), true); }
});

$("#btn-settings").addEventListener("click", openSettings);
$("#btn-advanced").addEventListener("click", () => openAdvanced());
$("#offline-edit").addEventListener("click", () => { S.offlineEdit = true; renderOffline(); });
$("#scrim").addEventListener("click", () => closeSheets());
$$("[data-close]").forEach((b) => b.addEventListener("click", () => closeSheets()));
async function closeOverlayFromPage() {
  if (await flushAllEdits()) await invoke("close_overlay");
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const open = document.querySelector(".sheet.open, .modal.open");
  if (open || !OVERLAY) closeSheets();
  else closeOverlayFromPage();
});
$("#ov-close").addEventListener("click", () => { closeOverlayFromPage(); });

$("#bank-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-bank]");
  if (b) { S.bank = b.dataset.bank; render(); }
});

// ---- colour dialog -------------------------------------------------------------------------
// Live preview on the G13 while choosing; Annuler (or closing) restores the previous colour.

const COLOR_PRESETS = [["Rouge", "#FF0000"], ["Orange", "#FF6A00"], ["Jaune", "#FFD200"],
  ["Vert", "#00FF3C"], ["Turquoise", "#19E3CF"], ["Bleu", "#0050FF"]];

function hsv2hex(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return rgb2hex({ r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 });
}
function hex2hsv(hex) {
  const c = hex2rgb(hex) || { r: 25, g: 227, b: 207 };
  const r = c.r / 255, g = c.g / 255, b = c.b / 255;
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

/**
 * Open the colour dialog for `target`: { initial, label, preview(hex), restore(), done(hex) }.
 * preview runs at every change, restore on Annuler / Échap / click outside, done on Appliquer.
 */
function openColor(target) {
  openSheet("#colorpick");
  CP = { target, ...hex2hsv(target.initial || "#19E3CF") };
  $("#cp-bank").textContent = target.label || "";
  $("#cp-presets").innerHTML = COLOR_PRESETS.map(([n, c]) =>
    `<button data-c="${c}" title="${t(n)}" style="--c:${c}"></button>`).join("");
  drawColor(false);
}

/** Redraw the dialog; `apply` also previews the colour on the G13 (and saves it). */
function drawColor(apply = true) {
  const hex = hsv2hex(CP.h, CP.s, CP.v).toUpperCase();
  const cv = $("#cp-sv"), ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
  ctx.fillStyle = hsv2hex(CP.h, 1, 1); ctx.fillRect(0, 0, w, h);
  const white = ctx.createLinearGradient(0, 0, w, 0);
  white.addColorStop(0, "#fff"); white.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = white; ctx.fillRect(0, 0, w, h);
  const black = ctx.createLinearGradient(0, 0, 0, h);
  black.addColorStop(0, "rgba(0,0,0,0)"); black.addColorStop(1, "#000");
  ctx.fillStyle = black; ctx.fillRect(0, 0, w, h);
  ctx.beginPath(); ctx.arc(CP.s * w, (1 - CP.v) * h, 7, 0, Math.PI * 2);
  ctx.lineWidth = 2.5; ctx.strokeStyle = CP.v > 0.5 ? "#000" : "#fff"; ctx.stroke();
  $("#cp-hue").value = Math.round(CP.h);
  $("#cp-swatch").style.background = hex;
  if (document.activeElement !== $("#cp-hex")) $("#cp-hex").value = hex;
  $$("#cp-presets button").forEach((b) => b.classList.toggle("on", b.dataset.c === hex));
  if (apply) CP.target.preview(hex);
}

function closeColor(keep) {
  if (!CP) return;
  const { target } = CP;
  const hex = hsv2hex(CP.h, CP.s, CP.v).toUpperCase();
  CP = null;
  if (keep) target.done(hex);
  else target.restore();
  closeSheets();
}

/** The G13's colour for the menu shown (live on the device while choosing). */
function openBankColor() {
  if (!S.dto) return;
  const cur = S.base[S.bank];
  const prev = { base: cur ? { ...cur } : null, color: bankObj().color ?? null };
  openColor({
    initial: cur?.rgb,
    label: t("MENU {bank}", { bank: S.bank }),
    preview: (hex) => {
      S.base[S.bank] = { rgb: hex, bright: S.base[S.bank]?.bright ?? 100 };
      applyColor();
    },
    restore: () => {
      if (prev.base) S.base[S.bank] = prev.base; else delete S.base[S.bank];
      if (prev.color) bankObj().color = prev.color; else delete bankObj().color;
      renderColor();
      save();
    },
    done: () => toast(t("Couleur du menu {bank} : {color}", { bank: S.bank, color: bankObj().color })),
  });
}

$("#cp-presets").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-c]");
  if (b) { Object.assign(CP, hex2hsv(b.dataset.c)); drawColor(); }
});
$("#cp-hue").addEventListener("input", (e) => { CP.h = +e.target.value; drawColor(); });
$("#cp-hex").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  if (/^#?[0-9a-f]{6}$/i.test(v)) { Object.assign(CP, hex2hsv(v.startsWith("#") ? v : "#" + v)); drawColor(); }
});
{
  const pick = (e) => {
    const r = $("#cp-sv").getBoundingClientRect();
    CP.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    CP.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    drawColor();
  };
  $("#cp-sv").addEventListener("pointerdown", (e) => { $("#cp-sv").setPointerCapture(e.pointerId); pick(e); });
  $("#cp-sv").addEventListener("pointermove", (e) => { if (e.buttons & 1) pick(e); });
}
$("#cp-ok").addEventListener("click", () => closeColor(true));
$("#cp-cancel").addEventListener("click", () => closeColor(false));

// ---- Logitech software running alongside ----------------------------------------------------

function renderConflicts(list) {
  const products = [...new Set(list.map((c) => c.product))];
  $("#conflict-banner").classList.toggle("hidden", !products.length);
  if (!products.length) return;
  const who = products.join(t(" et "));
  $("#conflict-text").textContent = products.length > 1
    ? t("{who} sont lancés : ils captent les touches du G13, qui ne répondront pas ici. Fermez-les, puis désactivez leur lancement automatique (Gestionnaire des tâches › Applications de démarrage) ou désinstallez-les. (Logitech G HUB, lui, peut rester ouvert.)", { who })
    : t("{who} est lancé : il capte les touches du G13, qui ne répondront pas ici. Fermez-le, puis désactivez son lancement automatique (Gestionnaire des tâches › Applications de démarrage) ou désinstallez-le. (Logitech G HUB, lui, peut rester ouvert.)", { who });
}

async function checkConflicts() {
  try { renderConflicts(await invoke("conflicting_software")); } catch { /* mock / unavailable */ }
}

$("#conflict-close").addEventListener("click", async () => {
  try {
    const left = await invoke("close_conflicting_software");
    renderConflicts(left);
    toast(left.length ? t("Certains processus n'ont pas pu être fermés (droits administrateur ?)") : t("Logiciels Logitech fermés"), !!left.length);
  } catch (e) { toast(String(e), true); }
});

// ---- Linux: access to the devices (udev rules), container ------------------------------------

let ACCESS = null;
function renderAccess(a) {
  ACCESS = a;
  const banner = $("#access-banner");
  $("#set-access").classList.toggle("hidden", !a);
  if (!a) { banner.classList.add("hidden"); return; }
  const missing = [...a.blocked];
  if (!a.uinput) missing.push(t("le clavier virtuel (/dev/uinput)"));
  let text = "";
  if (a.container) {
    text = t("G Nexus tourne dans un conteneur (distrobox, toolbox) : le démarrage à l'ouverture de session, l'heure du LCD et l'overlay peuvent mal fonctionner. Lancez l'AppImage de G Nexus directement sur le système, hors du conteneur.");
  } else if (missing.length) {
    text = t("G Nexus n'a pas accès à : {who}. Autorisez l'accès une fois (le mot de passe administrateur est demandé), puis rebranchez l'appareil si besoin.", { who: missing.join(", ") });
  }
  banner.classList.toggle("hidden", !text);
  $("#access-text").textContent = text;
  $("#access-grant").classList.toggle("hidden", a.container || !missing.length);
  // Settings › General
  $("#set-access-state").textContent = a.container ? t("dans un conteneur : non disponible")
    : missing.length ? t("manquant : {who}", { who: missing.join(", ") })
    : a.record ? t("OK (RECORD compris)") : t("OK (RECORD non autorisé)");
  $("#set-access-grant").classList.toggle("hidden", a.container || !missing.length);
  $("#set-access-record").classList.toggle("hidden", a.container || a.record);
}

async function checkAccess() {
  try { renderAccess(await invoke("device_access")); } catch { renderAccess(null); /* mock / unavailable */ }
}

async function grantAccess(record) {
  const buttons = ["#access-grant", "#set-access-grant", "#set-access-record"].map((id) => $(id));
  buttons.forEach((b) => { b.disabled = true; });
  try {
    const restart = await invoke("install_device_access", { record });
    if (restart) {
      sessionStorage.setItem("g13-toast", t("Accès aux appareils autorisé"));
      toast(t("Accès autorisé : G Nexus redémarre…"));
      setTimeout(() => invoke("restart_app").catch(() => {}), 1200);
      return;
    }
    await checkAccess();
    toast(ACCESS && (ACCESS.blocked.length || !ACCESS.uinput)
      ? t("Règles installées : rebranchez l'appareil pour terminer") : t("Accès aux appareils autorisé"));
  } catch (e) {
    toast(t("Accès non autorisé : {e}", { e }), true);
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}
$("#access-grant").addEventListener("click", () => grantAccess(!!(ACCESS && ACCESS.record)));
$("#set-access-grant").addEventListener("click", () => grantAccess(!!(ACCESS && ACCESS.record)));
$("#set-access-record").addEventListener("click", () => grantAccess(true));

// ---- boot ------------------------------------------------------------------------------------

async function boot() {
  // Register both event listeners before enabling any interaction: unready
  // windows may close immediately, so they must not yet hold editable drafts.
  await listen("flush-before-close", flushBeforeClose);
  await listen("flush-close-cancelled", closeCancelled);
  for (;;) {
    try { if (await invoke("window_ready")) break; }
    catch (e) { console.error("window readiness:", e); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  while (closeBusy()) await new Promise((resolve) => setTimeout(resolve, 100));
  bootReady = true;
  syncInert();
  // language and keyboard before anything is drawn
  let settings = {};
  try { settings = await invoke("get_settings"); } catch { /* mock */ }
  LANG = pickLang(settings.language);
  if (!OVERLAY) invoke("ui_language", { lang: LANG }).catch(() => {});
  applyLayout(settings.keyboard_layout || LANG_LAYOUT[LANG], LANG);
  translateDom();
  fillOverlayKeys();
  listen("language-changed", reloadAfterFlush);
  const pending = sessionStorage.getItem("g13-toast");
  if (pending) { sessionStorage.removeItem("g13-toast"); setTimeout(() => toast(pending), 300); }

  Device.build($("#device"), {
    onKey: openPicker,
    onBank: (b) => { S.bank = b; render(); },
    onMove: moveKey,
  });
  const fit = () => Device.fit($("#device-wrap"));
  new ResizeObserver(fit).observe($("#device-wrap"));
  fit();

  $("#color-btn").addEventListener("click", openBankColor);
  $("#color-wheel").addEventListener("click", openBankColor);
  Mouse.init();
  Headset.init();
  $("#bright").addEventListener("input", (e) => {
    if (!S.base[S.bank]) S.base[S.bank] = { rgb: "#FFFFFF", bright: 100 };
    S.base[S.bank].bright = +e.target.value;
    applyColor();
  });
  $("#device").addEventListener("click", (e) => {
    const b = e.target.closest(".pad-ctl button");
    if (b && S.dto) setStick({ target: b.dataset.target }, b.dataset.target === "left" ? t("Stick → joystick gauche") : t("Stick → joystick droit"));
  });
  $("#deadzone").addEventListener("input", (e) => {
    if (S.dto) setStick({ deadzone: +e.target.value });
  });

  await listen("g13", ({ payload: ev }) => {
    switch (ev.type) {
      case "key": Device.setLive(ev.key, ev.pressed); break;
      case "bank": S.bank = ev.bank; render(); break;
      case "profile": S.activeId = ev.id; refreshProfiles(); break;
      case "connected": S.connected = ev.value; if (ev.value) S.offlineEdit = false; render(); renderStatus(); break;
      case "record": Device.setRecording(ev.value); break;
      case "lcd": Device.setLcdFrame(ev.frame, S.dto ? lcdColor() : "#ffffff"); break;
      case "pinned": S.pinned = ev.id || null; renderProfileMenu(); break;
      case "gamepad_error": toast(t("Manette virtuelle : {m}", { m: ev.message }), true); break;
      case "mouse": Mouse.update(ev.status); break;
      case "headset": Headset.update(ev.status); break;
    }
  });

  invoke("key_names").then((names) => {
    const missing = ALL_CODES.filter((c) => !names.includes(c));
    if (missing.length) console.error("catalog.js: unknown key names", missing);
  }).catch(() => {});

  S.status = await invoke("get_status");
  S.connected = S.status.connected;
  S.activeId = S.status.active_profile;
  S.bank = S.status.bank || "M1";
  S.pinned = S.status.pinned || null;
  await refreshProfiles();
  if (S.status.lcd) Device.lastFrame = S.status.lcd;

  if (OVERLAY) {
    // opened by the overlay key (the window is created then): show the game's profile and menu
    const open = async (payload) => {
      closeSheets();
      S.game = payload.game || null;
      S.bank = payload.bank || "M1";
      // the mouse shows the profile it is using (the game's)
      if (!Mouse.draft || !Mouse.dirty()) {
        Mouse.editSoft = null;
        Mouse.editSector = null;
        Mouse.draft = structuredClone(Mouse.slotSettings() ?? null);
        Mouse.render();
      }
      await refreshProfiles();
      await loadEdit(payload.profile);
    };
    // the page is loaded: ask what to show (the window appears at the same time)
    const payload = await invoke("overlay_ready").catch(() => null);
    if (payload) {
      await open(payload);
      render();
      renderStatus();
      invoke("get_settings").then((s) => { $("#ov-key").textContent = s.overlay_key || "G25"; }).catch(() => {});
      return;
    }
    invoke("get_settings").then((s) => { $("#ov-key").textContent = s.overlay_key || "G25"; }).catch(() => {});
  } else {
    checkConflicts();
    setInterval(checkConflicts, 15000);
    checkAccess();
    setInterval(checkAccess, 5000);
    // the overlay may have edited a profile and changed the preview: take them back
    await listen("overlay-closed", async () => {
      await refreshProfiles();
      if (S.editId) await loadEdit(S.editId);
    });
  }

  const first = S.profiles.find((p) => p.id === S.activeId) || S.profiles.find((p) => p.default) || S.profiles[0];
  if (first) await loadEdit(first.id);
  render();
  renderStatus();
}

boot().catch((e) => toast(t("Erreur au démarrage : {e}", { e }), true));
