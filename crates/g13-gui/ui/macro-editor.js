// Macro editor shared by the G13 (Paramètres avancés › Macros) and the mouse
// (real time): a list of macros on the left, the steps of the one chosen on the
// right, and RECORD, which captures the keyboard and the mouse buttons with the
// delays between them (low-level hooks in the back-end).
//
// new MacroEditor({ list, edit, get, set, changed, renamed, deleted })
//   get() / set(obj)   the macros object { name: { mode, steps } } (set: after a rename)
//   changed(msg)       something changed (save, or mark the draft as modified)
//   renamed(old, new)  / deleted(name): update the bindings that use the macro
"use strict";

// The macro library, shared by every G13 and mouse profile (back-end: macros.json).
// A profile keeps its own copy of a macro; the library keeps the latest version.
const MacroLib = {
  items: null,
  loading: null,
  pending: [],
  active: null,
  job: null,
  timer: null,
  error: null,
  loadError: null,
  blocked: false,
  revision: 0,
  generation: 0,

  notify() {
    if (typeof renderMacroLibraryProblem === "function") renderMacroLibraryProblem();
  },
  apply(view, op) {
    if (op.kind === "put") {
      if (op.old && op.old !== op.name) delete view[op.old];
      view[op.name] = structuredClone(op.mac);
    } else delete view[op.name];
  },
  prepare(view, op) {
    const value = (name) => Object.hasOwn(view, name) ? structuredClone(view[name]) : null;
    op.expected = value(op.name);
    if (op.kind === "put") op.expectedOld = op.old ? value(op.old) : null;
    this.apply(view, op);
  },
  ensure(forFlush = false) {
    if (this.items) return Promise.resolve(this.items);
    if (this.loading) return this.loading;
    if (!forFlush && (destructiveOperation || closeBusy())) return Promise.resolve(null);
    const generation = this.generation;
    let job;
    job = Promise.resolve().then(() => invoke("macro_library")).then((lib) => {
      if (generation !== this.generation) return null;
      if (!lib || typeof lib !== "object" || Array.isArray(lib)) throw new Error("invalid macro library");
      const view = Object.assign(Object.create(null), structuredClone(lib));
      const staged = new Set();
      let unobserved = null;
      for (const op of this.pending) {
        // An edit made before this read completed did not observe the shared
        // value. Never promote a later, possibly concurrent value to its CAS
        // base. A name produced by an earlier queued operation is known.
        if (op.unobserved) {
          const affected = op.kind === "put" && op.old ? [op.name, op.old] : [op.name];
          for (const name of affected) {
            const identicalPut = op.kind === "put" && !op.old && name === op.name && profileValueEqual(view[name], op.mac);
            if (!staged.has(name) && Object.hasOwn(view, name) && !identicalPut) unobserved ??= name;
          }
        }
        this.prepare(view, op);
        staged.add(op.name);
        if (op.old) staged.add(op.old);
      }
      this.items = view;
      this.loadError = null;
      if (unobserved !== null) {
        this.blocked = true;
        this.error = `MACRO_LIBRARY_UNOBSERVED:${unobserved}`;
      }
      this.notify();
      return view;
    }).catch((e) => {
      if (generation !== this.generation) return null;
      this.loadError = String(e);
      this.notify();
      toast(t("Chargement de la bibliothèque de macros impossible : {e}", { e }), true);
      return null;
    }).finally(() => { if (this.loading === job) { this.loading = null; this.notify(); } });
    this.loading = job;
    this.notify();
    return job;
  },
  schedule(delay = 400) {
    clearTimeout(this.timer);
    this.timer = null;
    if (destructiveOperation || closeBusy() || this.blocked || this.error || this.loadError) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay);
  },
  resume() {
    if (this.pending.length && !this.job) this.schedule();
  },
  /** Queue immutable operations; do not drop edits while the initial load runs. */
  put(name, mac, old = null) {
    if (!name || !mac) return;
    const op = { kind: "put", name, mac: structuredClone(mac), old: old && old !== name ? old : null, unobserved: !this.items };
    const tail = this.pending[this.pending.length - 1];
    // Only coalesce a not-yet-sent update to the same name, preserving a rename.
    if (!op.old && tail?.kind === "put" && tail.name === name && tail !== this.active) {
      tail.mac = op.mac;
      if (this.items) this.apply(this.items, op);
    } else {
      if (this.items) this.prepare(this.items, op);
      this.pending.push(op);
    }
    this.revision++;
    if (!this.items && !this.loading && !this.loadError && !destructiveOperation && !closeBusy()) this.ensure();
    this.schedule();
    this.notify();
  },
  remove(name) {
    if (!name) return;
    const op = { kind: "delete", name, unobserved: !this.items };
    if (this.items) this.prepare(this.items, op);
    this.pending.push(op);
    this.revision++;
    if (!this.items && !this.loading && !this.loadError && !destructiveOperation && !closeBusy()) this.ensure();
    this.schedule(0);
    this.notify();
  },
  hasWork() { return !!(this.pending.length || this.job || this.loading); },
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.job) return this.job;
    if (this.blocked) return Promise.resolve(false);
    if (!this.pending.length && !this.loading) return Promise.resolve(true);
    let job;
    job = (async () => {
      if (!this.items) {
        const loaded = await this.ensure(true);
        if (!loaded) return !this.pending.length;
      }
      if (this.blocked) return false;
      while (this.pending.length) {
        const op = this.pending[0];
        this.active = op;
        try {
          if (op.kind === "put") await invoke("save_library_macro", { name: op.name, mac: op.mac, old: op.old, expected: op.expected, expectedOld: op.expectedOld });
          else await invoke("delete_library_macro", { name: op.name, expected: op.expected });
        } catch (e) {
          this.error = String(e);
          this.notify();
          toast(t("Bibliothèque de macros non enregistrée : {e}", { e }), true);
          return false;
        } finally { this.active = null; }
        if (this.pending[0] !== op) {
          this.error = "MACRO_QUEUE_CHANGED";
          this.notify();
          return false;
        }
        this.pending.shift();
        this.error = null;
        this.notify();
      }
      clearTimeout(this.timer);
      this.timer = null;
      return true;
    })().finally(() => { if (this.job === job) { this.job = null; this.notify(); } });
    this.job = job;
    this.notify();
    return job;
  },
  /** A replacement may have changed the library after the user's last view. */
  configReplaced() {
    clearTimeout(this.timer);
    this.timer = null;
    this.generation++;
    if (this.pending.length) {
      this.blocked = true;
      this.error = "MACRO_CONFIG_REPLACED";
    } else {
      this.items = null;
      this.loadError = null;
    }
    this.notify();
  },
  discardPending() {
    if (this.job || this.loading || !this.pending.length) return false;
    clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.items = null;
    this.error = null;
    this.loadError = null;
    this.blocked = false;
    this.revision++;
    this.notify();
    return true;
  },
  /** Safely copy a currently visible library item without replacing a profile item. */
  copyInto(name, target) {
    if (!target || typeof target !== "object" || Array.isArray(target) ||
        Object.hasOwn(target, name) || !this.items || !Object.hasOwn(this.items, name)) return false;
    // Assignment to "__proto__" on a regular object would mutate its prototype.
    Object.defineProperty(target, name, { value: structuredClone(this.items[name]), enumerable: true, writable: true, configurable: true });
    return true;
  },
  /** Library macros that `profileMacros` does not have yet. */
  others(profileMacros) {
    return Object.keys(this.items || {}).filter((n) => !Object.hasOwn(profileMacros || {}, n));
  },
};

class MacroEditor {
  constructor(o) {
    this.o = o;
    this.sel = null;
    this.recording = false;
    o.list.addEventListener("click", async (e) => {
      if (e.target.closest("[data-act=add]")) { if (this.add()) { this.render(); this.changed(t("Macro créée")); } return; }
      const lib = e.target.closest(".macro-item.lib");
      if (lib && e.target.closest("[data-act=unlib]")) {
        const name = lib.dataset.name;
        if (!MacroLib.items || !Object.hasOwn(MacroLib.items, name)) { this.render(); return; }
        const revision = MacroLib.revision, generation = MacroLib.generation;
        const seen = structuredClone(MacroLib.items[name]);
        const ok = await ask(t("RETIRER « {name} » DE LA BIBLIOTHÈQUE ?", { name }), "", { confirmOnly: true, ok: t("RETIRER") });
        if (!ok) return;
        if (revision !== MacroLib.revision || generation !== MacroLib.generation || !MacroLib.items ||
            !Object.hasOwn(MacroLib.items, name) || !profileValueEqual(MacroLib.items[name], seen)) {
          toast(t("La bibliothèque a changé ; réessayez."), true);
          this.render();
          return;
        }
        MacroLib.remove(name);
        this.render();
        return;
      }
      if (lib) {
        // copied into this profile, then edited here
        const all = this.o.get();
        if (!MacroLib.copyInto(lib.dataset.name, all)) {
          toast(t("La macro n'est plus disponible ou existe déjà dans ce profil. Actualisez puis réessayez."), true);
          this.render();
          return;
        }
        this.sel = lib.dataset.name;
        this.render();
        this.o.changed(t("Macro « {name} » ajoutée depuis la bibliothèque", { name: lib.dataset.name }));
        return;
      }
      const it = e.target.closest(".macro-item");
      if (it) { this.sel = it.dataset.name; this.render(); }
    });
    o.edit.addEventListener("change", (e) => this.onChange(e));
    o.edit.addEventListener("click", (e) => this.onClick(e));
  }

  get macros() {
    return this.o.get() || {};
  }

  /** New macro "macro-n", selected; returns its name. */
  add() {
    const all = this.o.get();
    if (!all) return null;
    // New names cannot be chosen safely before the shared library is known.
    if (!MacroLib.items) {
      MacroLib.ensure();
      toast(t("Attendez le chargement de la bibliothèque de macros, puis réessayez."), true);
      return null;
    }
    let n = 1;
    while (all[`macro-${n}`] || MacroLib.items?.[`macro-${n}`]) n++;
    const name = `macro-${n}`;
    all[name] = { mode: "once", steps: ["down A", "wait 30", "up A"] };
    this.sel = name;
    MacroLib.put(name, all[name]);
    return name;
  }

  /** Something changed: tell the owner, and keep the macro shown in the library. */
  changed(msg) {
    if (this.sel && this.macros[this.sel]) MacroLib.put(this.sel, this.macros[this.sel]);
    this.o.changed(msg);
  }

  render() {
    if (!MacroLib.items && !MacroLib.loadError) MacroLib.ensure().then((lib) => { if (lib) this.render(); });
    const all = this.macros;
    const names = Object.keys(all);
    if (!this.sel || !all[this.sel]) this.sel = names[0] || null;
    const lib = MacroLib.others(all);
    this.o.list.innerHTML = names.map((n) => {
      const mode = t((MACRO_MODES.find(([m]) => m === (all[n].mode || "once")) || [])[1] || "");
      return `<div class="macro-item ${n === this.sel ? "on" : ""}" data-name="${esc(n)}">▶ ${esc(n)}<small>${esc(mode)}</small></div>`;
    }).join("") + `<button class="ghost small" data-act="add">${t("+ NOUVELLE MACRO")}</button>` +
      (lib.length ? `<div class="group-cap lib-cap" title="${esc(t("Macros des autres profils (G13 et souris) : cliquez pour en mettre une copie dans ce profil"))}">${t("BIBLIOTHÈQUE")}</div>` +
        lib.map((n) => `<div class="macro-item lib" data-name="${esc(n)}" title="${esc(t("Ajouter à ce profil"))}">＋ ${esc(n)}
          <button class="unlib" data-act="unlib" title="${esc(t("Retirer de la bibliothèque"))}">×</button><small>${esc(t("{n} étapes", { n: MacroLib.items[n].steps.length }))}</small></div>`).join("") : "");

    const ed = this.o.edit;
    if (!this.sel) {
      ed.innerHTML = `<p class="muted">${t("Aucune macro dans ce profil.")}</p>`;
      return;
    }
    const m = all[this.sel];
    const steps = m.steps.map((s, i) => {
      const [op, ...rest] = s.trim().split(/\s+/);
      const arg = rest.join(" ");
      const kind = (STEP_OPS.find(([o]) => o === op) || [])[2] || "number";
      let argHtml;
      if (kind === "key") argHtml = `<select class="arg">${keyOptions()}</select>`;
      else if (kind === "button") argHtml = `<select class="arg">${btnOptions()}</select>`;
      else if (kind === "random") {
        const [base = "50", extra = "0"] = rest;
        argHtml = `<input class="arg" type="number" min="0" value="${esc(base)}" title="${esc(t("Pause fixe (ms)"))}">
          <span class="rand-sep" title="${esc(t("Marge aléatoire ajoutée à chaque passage (ms)"))}">+ 0…</span>
          <input class="arg2" type="number" min="0" value="${esc(extra)}" title="${esc(t("Marge aléatoire ajoutée à chaque passage (ms)"))}">`;
      }
      else argHtml = `<input class="arg" type="number" value="${esc(arg)}">`;
      return `<div class="step" data-i="${i}" data-arg="${esc(kind === "key" ? canonicalKey(arg) : arg)}">
        <span class="n">${i + 1}</span>
        <select class="op">${STEP_OPS.map(([o, l]) => `<option value="${o}" ${o === op ? "selected" : ""}>${t(l)}</option>`).join("")}</select>
        ${argHtml}
        <button class="icon-btn" data-up title="${t("Monter")}"><svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></button>
        <button class="icon-btn danger" data-del title="${t("Supprimer l'étape")}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </div>`;
    }).join("");
    const rec = this.recording;
    ed.innerHTML = `
      <div class="row"><label>${t("Nom")}</label><input class="macro-name" value="${esc(this.sel)}" spellcheck="false"></div>
      <div class="row"><label>${t("Mode")}</label><select class="macro-mode">${MACRO_MODES.map(([v, l]) =>
        `<option value="${v}" ${v === (m.mode || "once") ? "selected" : ""}>${t(l)}</option>`).join("")}</select></div>
      <div class="rec-row ${rec ? "on" : ""}">
        <button class="rec-btn" data-act="record">${rec ? `<i class="sq"></i>${t("STOP")}` : `<i></i>${t("RECORD")}`}</button>
        ${rec ? `<span class="rec-live">${t("Enregistrement… faites vos actions (clavier, boutons de souris, molette), puis STOP.")}</span>`
          : `<label class="rec-opt"><input type="checkbox" class="rec-delays" ${MacroEditor.delays ? "checked" : ""}> ${t("Garder les délais réels")}</label>
             <span class="muted small-print">${t("RECORD remplace les étapes de cette macro.")}</span>`}
      </div>
      <div class="group-cap">${t("Étapes")}</div>
      <div class="steps">${steps || `<p class="muted small-print">${t("Aucune étape.")}</p>`}</div>
      <div class="row">
        <button class="ghost small" data-act="step-add">${t("+ ÉTAPE")}</button>
        <button class="ghost small" data-act="step-tap">${t("+ FRAPPE DE TOUCHE")}</button>
        <span style="flex:1"></span>
        <button class="ghost small" data-act="del" style="color:var(--danger)">${t("SUPPRIMER LA MACRO")}</button>
      </div>`;
    for (const st of ed.querySelectorAll(".steps .step")) {
      const sel = st.querySelector("select.arg");
      if (sel) sel.value = st.dataset.arg;
    }
  }

  onChange(e) {
    const all = this.macros;
    const m = all[this.sel];
    if (!m) return;
    if (e.target.classList.contains("rec-delays")) { MacroEditor.delays = e.target.checked; return; }
    if (e.target.classList.contains("macro-mode")) { m.mode = e.target.value; this.changed(t("Mode enregistré")); this.render(); return; }
    if (e.target.classList.contains("macro-name")) {
      const nn = e.target.value.trim();
      if (!MacroLib.items) {
        MacroLib.ensure();
        toast(t("Attendez le chargement de la bibliothèque de macros, puis réessayez."), true);
        e.target.value = this.sel;
        return;
      }
      if (!nn || (nn !== this.sel && (Object.hasOwn(all, nn) || Object.hasOwn(MacroLib.items, nn)))) {
        toast(t("Nom vide ou déjà utilisé"), true); e.target.value = this.sel; return;
      }
      // insertion order kept
      const old = this.sel;
      this.o.set(Object.fromEntries(Object.entries(all).map(([k, v]) => [k === old ? nn : k, v])));
      this.sel = nn;
      this.o.renamed(old, nn);
      MacroLib.put(nn, this.macros[nn], old);
      this.render();
      this.o.changed(t("Macro renommée"));
      return;
    }
    const row = e.target.closest(".step");
    if (!row) return;
    if (e.target.classList.contains("op")) {
      const kind = STEP_OPS.find(([o]) => o === e.target.value)[2];
      const def = kind === "key" ? "A" : kind === "button" ? "Left" : kind === "random" ? "50 20" : e.target.value === "wait" ? "50" : "1";
      m.steps[+row.dataset.i] = `${e.target.value} ${def}`;
      this.render();
    } else {
      const op = row.querySelector(".op").value;
      const n = (sel) => Math.max(0, Math.round(+row.querySelector(sel).value || 0));
      m.steps[+row.dataset.i] = op === "wait_random" ? `wait_random ${n(".arg")} ${n(".arg2")}` : `${op} ${row.querySelector(".arg").value}`;
    }
    this.changed();
  }

  onClick(e) {
    const m = this.sel && this.macros[this.sel];
    if (!m) return;
    const row = e.target.closest(".step");
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "record") { this.toggleRecord(); return; }
    if (e.target.closest("[data-del]") && row) m.steps.splice(+row.dataset.i, 1);
    else if (e.target.closest("[data-up]") && row) {
      const i = +row.dataset.i;
      if (i > 0) [m.steps[i - 1], m.steps[i]] = [m.steps[i], m.steps[i - 1]];
    } else if (act === "step-add") m.steps.push("wait 50");
    else if (act === "step-tap") m.steps.push("down A", "wait 30", "up A", "wait 30");
    else if (act === "del") {
      const name = this.sel;
      delete this.macros[name];
      this.sel = null;
      this.o.deleted(name);
    } else return;
    this.render();
    this.changed();
  }

  /** RECORD / STOP. The click on STOP itself is left out of the macro. */
  async toggleRecord() {
    if (!this.recording) {
      try {
        await invoke("record_start");
        this.recording = true;
        this.render();
      } catch (e) { toast(t("Enregistrement impossible : {e}", { e }), true); }
      return;
    }
    this.recording = false;
    try {
      const steps = await invoke("record_stop", { delays: !!MacroEditor.delays });
      const m = this.macros[this.sel];
      if (m && steps.length) {
        m.steps = steps;
        this.changed(t("{n} étapes enregistrées", { n: steps.length }));
      } else if (!steps.length) toast(t("Rien n'a été enregistré"));
    } catch (e) { toast(String(e), true); }
    this.render();
  }

  /** Leaving the editor while recording: stop and drop the capture. */
  abort() {
    if (!this.recording) return;
    this.recording = false;
    invoke("record_stop", { delays: false }).catch(() => {});
  }
}
MacroEditor.delays = true;

// built on use: the labels follow the chosen layout and language
const keyOptions = () => ALL_CODES.map((c) => `<option value="${c}">${esc(KEY_LABELS[c])}  (${c})</option>`).join("");
const btnOptions = () => ["Left", "Right", "Middle", "Back", "Forward"]
  .map((b) => `<option value="${b}">${esc(t(MOUSE.find(([o]) => o.mouse === b)[2]))}</option>`).join("");
