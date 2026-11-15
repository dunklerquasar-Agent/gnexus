use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use g13_core::{G13Key as K, RgbColor};

use super::rules::{MatchRule, select};
use super::store::{DEMO_ID, ProfileStore};
use super::*;
use crate::device::DeviceEvent;
use crate::engine::Engine;
use crate::engine::action::{Action, Macro, MacroMode, MacroStep};
use crate::engine::bindings::{BankBindings, Input, MBank, PadStick, Profile, StickConfig, StickDir, StickMode};
use crate::engine::pad::PadButton;
use crate::engine::demo::demo_profile;
use crate::keycode::{KeyCode as C, MouseButton};
use crate::platform::mock::{Injected, RecordingInjector};
use crate::platform::{ForegroundApp, ForegroundWatcher, PlatformResult};

const SAMPLE: &str = r##"
name = "Jeu"
number = 3
default = true

[stick]
mode = "keys"
deadzone = 20

[[rules]]
exe = "EldenRing"

[[rules]]
title = "mozilla firefox"

[banks.M1]
color = "#ff8000"
G1 = "Esc"
G2 = "ctrl+shift+esc"
G3 = { mouse = "x1" }
G4 = { wheel = -2, horizontal = true }
G25 = { macro = "spam" }
STICK_UP = "W"
stick_left = "A"

[banks.M3]
G10 = { macro = "spam" }

[macros.spam]
mode = "repeat_while_held"
steps = ["down Q", "wait 20ms", "up Q", "mouse_down Left", "mouse_up Left", "wheel 1", "wait 80"]
"##;

fn app(exe: &str, title: &str) -> ForegroundApp {
    ForegroundApp { process_name: exe.into(), title: title.into(), ..ForegroundApp::default() }
}

// ---- format -------------------------------------------------------------------

#[test]
fn demo_profile_roundtrips() {
    let doc = ProfileDoc {
        profile: demo_profile(),
        rules: vec![MatchRule::exe("notepad.exe"), MatchRule { exe: None, title: Some("Bloc".into()) }],
        is_default: true,
        number: Some(4),
    };
    let text = to_toml(&doc).unwrap();
    assert_eq!(from_toml(&text).unwrap(), doc, "{text}");
    // one line per key, in G-key order, identified by G13Key::id()
    assert!(text.contains("\nG25 = { mouse = \"Middle\" }\n"), "{text}");
    assert!(!text.contains("[banks.M1.G"), "{text}");
    let g1 = text.find("\nG1 = ").unwrap();
    let g2 = text.find("\nG2 = ").unwrap();
    let g25 = text.find("\nG25 = ").unwrap();
    assert!(g1 < g2 && g2 < g25, "{text}");
}

#[test]
fn hand_written_file_parses() {
    let doc = from_toml(SAMPLE).unwrap();
    assert!(doc.is_default);
    assert_eq!(doc.rules.len(), 2);
    let p = &doc.profile;
    assert_eq!(p.name, "Jeu");
    let m1 = p.bank(MBank::M1);
    assert_eq!(m1.color, Some(RgbColor::ORANGE));
    assert!(matches!(m1.get(K::G1), Action::Key(c) if c.keys() == [C::Escape]));
    assert!(matches!(m1.get(K::G2), Action::Key(c) if c.keys() == [C::LeftCtrl, C::LeftShift, C::Escape]));
    assert_eq!(m1.get(K::G3), &Action::MouseButton(MouseButton::Back));
    assert_eq!(m1.get(K::G4), &Action::Wheel { delta: -2, horizontal: true });
    assert!(matches!(m1.get_input(Input::Stick(StickDir::Up)), Action::Key(c) if c.keys() == [C::W]));
    assert!(matches!(m1.get_input(Input::Stick(StickDir::Left)), Action::Key(c) if c.keys() == [C::A]));
    assert_eq!(p.stick, StickConfig { mode: StickMode::Keys, deadzone: 0.2, ..StickConfig::default() });
    let Action::Macro(m) = m1.get(K::StickClick) else { panic!("G25 should be a macro") };
    assert_eq!(m.mode, MacroMode::RepeatWhileHeld);
    assert_eq!(m.steps[1], MacroStep::Delay(Duration::from_millis(20)));
    assert_eq!(m.steps.len(), 7);
    // the same macro is shared, not duplicated
    let Action::Macro(m3) = p.bank(MBank::M3).get(K::G10) else { panic!() };
    assert!(Arc::ptr_eq(m, m3));
    assert_eq!(p.bank(MBank::M2), &BankBindings::default());
    // and survives a round trip
    assert_eq!(from_toml(&to_toml(&doc).unwrap()).unwrap(), doc);
}

#[test]
fn json_model_roundtrips_and_keeps_unbound_macros() {
    let mut dto: FileDto = toml::from_str(SAMPLE).unwrap();
    dto.macros.insert(
        "unbound".into(),
        format::MacroDto { mode: format::ModeDto::Toggle, steps: vec!["wheel -1".into()] },
    );
    let json = serde_json::to_string(&dto).unwrap();
    assert!(json.contains(r#""G3":{"mouse":"x1"}"#), "{json}");
    let back: FileDto = serde_json::from_str(&json).unwrap();
    let text = dto_to_toml(&back).unwrap();
    assert!(text.contains("[macros.unbound]"), "{text}");
    assert_eq!(from_toml(&text).unwrap(), from_dto(back).unwrap());
}

#[test]
fn invalid_files_are_rejected_with_context() {
    let cases = [
        ("name = 'x'\n[banks.M1]\nG26 = 'A'", "G26"),
        ("name = 'x'\n[banks.M1]\nM1 = 'A'", "cannot be bound"),
        ("name = 'x'\n[banks.M1]\nG1 = 'Ctrl+Nope'", "Ctrl+Nope"),
        ("name = 'x'\n[banks.M1]\nG1 = { macro = 'missing' }", "missing"),
        ("name = 'x'\n[banks.M1]\ncolor = 'orange'", "color"),
        ("name = 'x'\n[macros.m]\nsteps = ['jump A']", "jump A"),
        ("name = 'x'\n[[rules]]\n", "rule"),
        ("name = 'x'\nnmae = 'typo'", "nmae"),
        ("name = 'x'\n[banks.M4]\n", "M4"),
        ("name = 'x'\n[stick]\ndeadzone = 99\n", "deadzone"),
        ("name = 'x'\n[stick]\nmode = 'trackball'\n", "trackball"),
    ];
    for (text, needle) in cases {
        let err = from_toml(text).expect_err(text).0;
        assert!(err.contains(needle), "{text:?} → {err}");
    }
}

#[test]
fn conflicting_macro_names_cannot_be_saved() {
    let mk = |mode| Action::Macro(Arc::new(Macro { name: "m".into(), mode, steps: vec![] }));
    let mut p = Profile::default();
    p.bank_mut(MBank::M1).set(K::G1, mk(MacroMode::Once));
    p.bank_mut(MBank::M2).set(K::G1, mk(MacroMode::Toggle));
    let doc = ProfileDoc { profile: p, rules: vec![], is_default: false, number: None };
    assert!(to_toml(&doc).is_err());
}

// ---- rules ----------------------------------------------------------------------

#[test]
fn rule_matching() {
    let exe = MatchRule::exe("EldenRing.exe");
    assert!(exe.matches(&app("eldenring.exe", "")));
    assert!(MatchRule::exe("eldenring").matches(&app("ELDENRING.EXE", "")));
    assert!(!exe.matches(&app("eldenring2.exe", "")));

    let title = MatchRule { exe: None, title: Some("firefox".into()) };
    assert!(title.matches(&app("firefox.exe", "GitHub — Mozilla Firefox")));
    assert!(!title.matches(&app("chrome.exe", "Google Chrome")));

    let both = MatchRule { exe: Some("code.exe".into()), title: Some("g13".into()) };
    assert!(both.matches(&app("Code.exe", "main.rs - G13 Rust")));
    assert!(!both.matches(&app("Code.exe", "other project")));

    assert!(!MatchRule::default().matches(&app("x.exe", "")));

    let linux = ForegroundApp { app_id: Some("org.mozilla.firefox".into()), ..app("firefox-bin", "") };
    assert!(MatchRule::exe("org.mozilla.firefox").matches(&linux));
}

#[test]
fn selection_takes_first_match_in_order() {
    let game = [MatchRule::exe("game.exe")];
    let web = [MatchRule { exe: None, title: Some("browser".into()) }];
    let also_game = [MatchRule::exe("game.exe")];
    let cands = || [("a-game", &game[..]), ("b-web", &web[..]), ("c-game", &also_game[..])];
    assert_eq!(select(cands(), &app("game.exe", "")), Some("a-game"));
    assert_eq!(select(cands(), &app("x.exe", "My Browser")), Some("b-web"));
    assert_eq!(select(cands(), &app("notepad.exe", "")), None);
}

// ---- store -------------------------------------------------------------------------

fn temp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("g13d-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
}

fn write_profile(dir: &std::path::Path, id: &str, name: &str, rules: Vec<MatchRule>, g1: &str) {
    let mut p = Profile { name: name.into(), ..Profile::default() };
    p.bank_mut(MBank::M1).set(K::G1, Action::key(g1));
    let text = to_toml(&ProfileDoc { profile: p, rules, is_default: false, number: None }).unwrap();
    fs::write(dir.join(format!("{id}.toml")), text).unwrap();
}

#[test]
fn store_generates_default_and_selects() {
    let dir = temp_dir("store");
    let mut store = ProfileStore::open(&dir).unwrap();
    assert!(dir.join("demo.toml").is_file());
    assert_eq!(store.default_id(), DEMO_ID);
    assert_eq!(store.profile(DEMO_ID), Some(&demo_profile()));

    write_profile(&dir, "notes", "Notes", vec![MatchRule::exe("notepad.exe")], "F1");
    assert_eq!(store.rescan(), vec!["notes".to_string()]);
    assert!(store.rescan().is_empty(), "unchanged files are not reloaded");
    assert_eq!(store.select(&app("Notepad.exe", "")), "notes");
    assert_eq!(store.select(&app("explorer.exe", "")), DEMO_ID);

    // a broken edit keeps the last good version
    fs::write(dir.join("notes.toml"), "name = ").unwrap();
    assert!(store.rescan().is_empty());
    assert_eq!(store.profile("notes").unwrap().name, "Notes");

    fs::remove_file(dir.join("notes.toml")).unwrap();
    assert_eq!(store.rescan(), vec!["notes".to_string()]);
    assert!(store.get("notes").is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn default_flag_wins_and_builtin_is_a_fallback() {
    let dir = temp_dir("default");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("broken.toml"), "not toml at all").unwrap();
    let mut store = ProfileStore::open(&dir).unwrap();
    // nothing loadable: built-in demo in memory, no file written over the broken one
    assert_eq!(store.default_id(), DEMO_ID);
    assert!(store.get(DEMO_ID).unwrap().path.is_none());

    fs::write(dir.join("zz.toml"), "name = 'Z'\ndefault = true\n").unwrap();
    store.rescan();
    assert_eq!(store.default_id(), "zz");
    assert!(store.get(DEMO_ID).is_none(), "placeholder dropped once a real profile exists");
    let _ = fs::remove_dir_all(&dir);
}

// ---- manager -------------------------------------------------------------------------

#[derive(Clone, Default)]
struct FakeWatcher(Arc<Mutex<Option<ForegroundApp>>>);

impl FakeWatcher {
    fn focus(&self, exe: &str) {
        *self.0.lock().unwrap() = Some(app(exe, ""));
    }
}

impl ForegroundWatcher for FakeWatcher {
    fn current(&mut self) -> PlatformResult<Option<ForegroundApp>> {
        Ok(self.0.lock().unwrap().clone())
    }
}

#[test]
fn manager_switches_on_focus_and_releases_held_keys() {
    let dir = temp_dir("manager");
    fs::create_dir_all(&dir).unwrap();
    write_profile(&dir, "base", "Base", vec![], "F1");
    write_profile(&dir, "notes", "Notes", vec![MatchRule::exe("notepad.exe")], "F2");
    let text = fs::read_to_string(dir.join("base.toml")).unwrap();
    fs::write(dir.join("base.toml"), format!("default = true\n{text}")).unwrap();

    let watcher = FakeWatcher::default();
    let mut mgr = ProfileManager::new(ProfileStore::open(&dir).unwrap(), Some(Box::new(watcher.clone())));
    assert_eq!(mgr.active_id(), "base");

    let inj = Arc::new(RecordingInjector::new());
    let (tx, _rx) = channel();
    let mut engine = Engine::new(inj.clone(), tx, mgr.initial_profile());

    // G1 held in "base" (F1), then focus moves to Notepad
    engine.handle(DeviceEvent::Key { key: K::G1, pressed: true });
    watcher.focus("notepad.exe");
    mgr.poll_foreground(&mut engine);
    assert_eq!(mgr.active_id(), "notes");
    assert_eq!(engine.profile().name, "Notes");
    // F1 was released by the switch; releasing G1 now injects nothing more
    engine.handle(DeviceEvent::Key { key: K::G1, pressed: false });
    assert_eq!(inj.take(), vec![Injected::Key(C::F1, true), Injected::Key(C::F1, false)]);

    engine.handle(DeviceEvent::Key { key: K::G1, pressed: true });
    engine.handle(DeviceEvent::Key { key: K::G1, pressed: false });
    assert_eq!(inj.take(), vec![Injected::Key(C::F2, true), Injected::Key(C::F2, false)]);

    // no rule matches → back to the default profile
    watcher.focus("explorer.exe");
    mgr.poll_foreground(&mut engine);
    assert_eq!(mgr.active_id(), "base");

    // hot reload of the active profile
    let text = fs::read_to_string(dir.join("base.toml")).unwrap().replace("\"F1\"", "\"F12\"");
    fs::write(dir.join("base.toml"), text).unwrap();
    mgr.rescan(&mut engine);
    assert!(matches!(engine.profile().bank(MBank::M1).get(K::G1), Action::Key(c) if c.keys() == [C::F12]));

    // preview: the GUI's profile applies only while our own window is focused
    mgr.set_self_exe("g13-studio.exe");
    mgr.set_preview(Some("notes".into()));
    watcher.focus("G13-Studio.exe");
    mgr.poll_foreground(&mut engine);
    assert_eq!(mgr.active_id(), "notes");
    watcher.focus("explorer.exe");
    mgr.poll_foreground(&mut engine);
    assert_eq!(mgr.active_id(), "base");
    mgr.set_preview(None);

    // pinned ("test everywhere"): rules and default ignored until unpinned
    mgr.set_pinned(Some("notes".into()));
    watcher.focus("explorer.exe");
    mgr.poll_foreground(&mut engine);
    assert_eq!(mgr.active_id(), "notes");
    mgr.set_pinned(None);
    mgr.poll_foreground(&mut engine);
    assert_eq!(mgr.active_id(), "base");

    // deleting the profile in use falls back to the default
    watcher.focus("notepad.exe");
    mgr.poll_foreground(&mut engine);
    fs::remove_file(dir.join("notes.toml")).unwrap();
    mgr.rescan(&mut engine);
    assert_eq!(mgr.active_id(), "base");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn gamepad_profile_round_trip() {
    let text = "name = \"p\"\n[stick]\nmode = \"gamepad\"\ndeadzone = 12\ntarget = \"right\"\n\n[banks.M1]\nG1 = { pad = \"A\" }\nG2 = { pad = \"l3\" }\n";
    let doc = format::from_toml(text).unwrap();
    let p = &doc.profile;
    assert_eq!(p.stick, StickConfig { mode: StickMode::Gamepad, deadzone: 0.12, target: PadStick::Right, ..StickConfig::default() });
    assert_eq!(p.bank(MBank::M1).get(K::G2), &Action::Pad(PadButton::LS));
    assert!(p.uses_pad());
    let out = format::to_toml(&doc).unwrap();
    assert!(out.contains("G1 = { pad = \"A\" }") && out.contains("G2 = { pad = \"LS\" }"), "{out}");
    assert_eq!(format::from_toml(&out).unwrap(), doc);
    assert!(format::from_toml("name = \"p\"\n[banks.M1]\nG1 = { pad = \"Z\" }\n").is_err());
}
#[test]
fn mouse_stick_profile_roundtrips_toml_json_and_old_profiles_keep_defaults() {
    let text = "name = \"mouse\"\n[stick]\nmode = \"mouse\"\ndeadzone = 18\nmouse_speed = 140\n\n[banks.M1]\nG23 = { mouse = \"Left\" }\n";
    let doc = from_toml(text).unwrap();
    assert_eq!(doc.profile.stick.mode, StickMode::Mouse);
    assert_eq!(doc.profile.stick.deadzone, 0.18);
    assert_eq!(doc.profile.stick.mouse_speed, Some(140));
    assert_eq!(doc.profile.bank(MBank::M1).get(K::G23), &Action::MouseButton(MouseButton::Left));
    let out = to_toml(&doc).unwrap();
    assert!(out.contains("mode = \"mouse\"") && out.contains("mouse_speed = 140"), "{out}");
    assert_eq!(from_toml(&out).unwrap(), doc);
    let dto = to_dto(&doc).unwrap();
    let json = serde_json::to_string(&dto).unwrap();
    let back = serde_json::from_str::<FileDto>(&json).unwrap();
    assert_eq!(from_dto(back.clone()).unwrap(), doc);
    assert_eq!(from_toml(&dto_to_toml(&back).unwrap()).unwrap(), doc);

    for mode in ["keys", "gamepad", "mouse"] {
        let old = format!("name = \"old\"\n[stick]\nmode = \"{mode}\"\ndeadzone = 35\n");
        let parsed = from_toml(&old).unwrap();
        assert_eq!(parsed.profile.stick.mouse_speed, None);
        assert!(!to_toml(&parsed).unwrap().contains("mouse_speed"), "default need not be written");
    }
    assert_eq!(from_toml("name = \"no stick section\"").unwrap().profile.stick, StickConfig::default());
}

#[test]
fn mouse_speed_and_deadzone_are_validated_in_both_profile_formats() {
    for speed in [0, 9, 201, 1000] {
        let text = format!("name = \"bad\"\n[stick]\nmode = \"mouse\"\nmouse_speed = {speed}\n");
        assert!(from_toml(&text).is_err(), "speed {speed}");
        let json = format!(r#"{{"name":"bad","stick":{{"mode":"mouse","mouse_speed":{speed}}}}}"#);
        let dto = serde_json::from_str::<FileDto>(&json).unwrap();
        assert!(from_dto(dto).is_err(), "JSON speed {speed}");
    }
    for speed in [10, 100, 200] {
        let text = format!("name = \"ok\"\n[stick]\nmode = \"mouse\"\nmouse_speed = {speed}\n");
        assert!(from_toml(&text).is_ok());
    }
    assert!(from_toml("name = \"bad\"\n[stick]\nmode = \"mouse\"\ndeadzone = 96\n").is_err());
    assert!(from_toml("name = \"bad\"\n[stick]\nmode = \"mouse\"\nspeeed = 100\n").is_err());
}

#[test]
fn lgs_export_warns_that_stick_mouse_mode_is_not_exported() {
    let mut p = Profile { name: "mouse export".into(), ..Profile::default() };
    p.stick.mode = StickMode::Mouse;
    p.stick.mouse_speed = Some(140);
    p.bank_mut(MBank::M1).set_input(Input::Stick(StickDir::Up), Action::key("W"));
    let doc = ProfileDoc { profile: p, rules: Vec::new(), is_default: false, number: None };
    let (xml, warnings) = lgs::export(&to_dto(&doc).unwrap());
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].contains("Mode souris"));
    assert!(xml.contains("contextid=\"G26\""), "direction binding still exported: {xml}");
    let imported = lgs::import(&xml).unwrap();
    assert_eq!(from_dto(imported.dto).unwrap().profile.stick.mode, StickMode::Keys);
}

#[test]
fn stick_modes_are_bank_specific_and_old_shared_modes_are_preserved() {
    for mode in ["keys", "gamepad", "mouse"] {
        let text = format!("name = 'legacy'\n[stick]\nmode = '{mode}'\n");
        let doc = from_toml(&text).unwrap();
        assert!(MBank::ALL.into_iter().all(|bank| doc.profile.stick.mode_for(bank) == doc.profile.stick.mode));
        assert_eq!(from_toml(&to_toml(&doc).unwrap()).unwrap(), doc);
    }

    let text = "name = 'three modes'\n[stick]\nmode = 'keys'\ndeadzone = 20\n\
        [stick.bank_modes]\nM2 = 'mouse'\nM3 = 'gamepad'\n\
        [banks.M1]\nSTICK_UP = 'W'\n[banks.M2]\nG23 = { mouse = 'Left' }\n";
    let doc = from_toml(text).unwrap();
    assert_eq!(doc.profile.stick.mode_for(MBank::M1), StickMode::Keys);
    assert_eq!(doc.profile.stick.mode_for(MBank::M2), StickMode::Mouse);
    assert_eq!(doc.profile.stick.mode_for(MBank::M3), StickMode::Gamepad);
    assert!(doc.profile.uses_pad(), "an inactive bank can require the virtual pad");
    let saved = to_toml(&doc).unwrap();
    assert!(saved.contains("[stick.bank_modes]"), "{saved}");
    assert_eq!(from_toml(&saved).unwrap(), doc);
    let json = serde_json::to_string(&to_dto(&doc).unwrap()).unwrap();
    let dto: FileDto = serde_json::from_str(&json).unwrap();
    assert_eq!(from_dto(dto).unwrap(), doc);
}

#[test]
fn stick_bank_modes_reject_unknown_banks_and_modes_in_toml_and_json() {
    for fields in ["M4 = 'mouse'", "m2 = 'mouse'", "M2 = 'trackball'"] {
        let text = format!("name = 'bad'\n[stick.bank_modes]\n{fields}\n");
        assert!(from_toml(&text).is_err(), "accepted {fields}");
    }
    for fields in [r#""M4":"mouse""#, r#""m2":"mouse""#, r#""M2":"trackball""#] {
        let text = format!(r#"{{"name":"bad","stick":{{"bank_modes":{{{fields}}}}}}}"#);
        assert!(serde_json::from_str::<FileDto>(&text).is_err(), "accepted {fields}");
    }
}

#[test]
fn old_explicit_speed_is_retained_including_100_percent() {
    for speed in [10, 100, 140, 200] {
        let text = format!("name = 'legacy mouse'\n[stick]\nmode = 'mouse'\nmouse_speed = {speed}\n");
        let doc = from_toml(&text).unwrap();
        assert_eq!(doc.profile.stick.mouse_speed, Some(speed));
        let saved = to_toml(&doc).unwrap();
        assert!(saved.contains(&format!("mouse_speed = {speed}")), "{saved}");
        assert_eq!(from_toml(&saved).unwrap(), doc);
    }
}

#[test]
fn lgs_export_warns_for_mouse_in_any_effective_bank_and_old_speed() {
    let mut p = Profile { name: "bank mouse".into(), ..Profile::default() };
    p.stick.bank_modes[MBank::M2.index()] = Some(StickMode::Mouse);
    let mut doc = ProfileDoc { profile: p, rules: Vec::new(), is_default: false, number: None };
    let (_, warnings) = lgs::export(&to_dto(&doc).unwrap());
    assert!(warnings.iter().any(|w| w.contains("Mode souris")), "{warnings:?}");

    doc.profile.stick.mode = StickMode::Mouse;
    doc.profile.stick.bank_modes = [Some(StickMode::Keys); 3];
    let (_, warnings) = lgs::export(&to_dto(&doc).unwrap());
    assert!(!warnings.iter().any(|w| w.contains("Mode souris")), "no bank actually uses mouse: {warnings:?}");
    doc.profile.stick.mouse_speed = Some(100);
    let (_, warnings) = lgs::export(&to_dto(&doc).unwrap());
    assert!(warnings.iter().any(|w| w.contains("Mode souris")), "the old speed override would be lost: {warnings:?}");
}

#[test]
fn lgs_export_reports_effective_gamepad_banks_and_other_stick_settings() {
    let mut p = Profile { name: "gamepad bank".into(), ..Profile::default() };
    p.stick.bank_modes[MBank::M2.index()] = Some(StickMode::Gamepad);
    let mut doc = ProfileDoc { profile: p, rules: Vec::new(), is_default: false, number: None };
    let (xml, warnings) = lgs::export(&to_dto(&doc).unwrap());
    assert!(warnings.iter().any(|w| w.contains("manette")), "{warnings:?}");
    assert_eq!(from_dto(lgs::import(&xml).unwrap().dto).unwrap().profile.stick.mode_for(MBank::M2), StickMode::Keys);

    doc.profile.stick.mode = StickMode::Gamepad;
    doc.profile.stick.bank_modes = [Some(StickMode::Keys); 3];
    let (_, warnings) = lgs::export(&to_dto(&doc).unwrap());
    assert!(!warnings.iter().any(|w| w.contains("Mode manette")), "all effective banks are keys: {warnings:?}");
    doc.profile.stick.bank_modes[MBank::M2.index()] = Some(StickMode::Mouse);
    doc.profile.stick.bank_modes[MBank::M3.index()] = Some(StickMode::Gamepad);
    doc.profile.stick.deadzone = 0.20;
    doc.profile.stick.target = PadStick::Right;
    let (_, warnings) = lgs::export(&to_dto(&doc).unwrap());
    assert!(warnings.iter().any(|w| w.contains("Mode souris")), "{warnings:?}");
    assert!(warnings.iter().any(|w| w.contains("Mode manette")), "{warnings:?}");
    assert!(warnings.iter().any(|w| w.contains("Zone morte")), "{warnings:?}");
}
