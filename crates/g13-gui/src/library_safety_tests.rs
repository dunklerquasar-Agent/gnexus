// Real Rust GUI/daemon modules, only synthetic files. No Tauri runtime or device.
use crate::{backup, library, settings::Settings};
use g13_daemon::profiles::format::{MacroDto, ModeDto};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier, Mutex};
static SEQ: AtomicU64 = AtomicU64::new(0);
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "g13-lib-safe-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(p.join("profiles")).unwrap();
        Self(p)
    }
    fn profiles(&self) -> PathBuf {
        self.0.join("profiles")
    }
    fn macros(&self) -> PathBuf {
        self.0.join("macros.json")
    }
    fn profile(&self) {
        fs::write(self.profiles().join("demo.toml"), "name = \"Demo\"\n").unwrap();
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap()
    }
}
fn m(c: &str) -> MacroDto {
    MacroDto {
        mode: ModeDto::Once,
        steps: vec![format!("down {c}"), format!("up {c}")],
    }
}
#[test]
fn existing_invalid_utf8_is_rejected_unchanged_even_if_called_repeatedly() {
    let t = Temp::new();
    t.profile();
    let bytes = b"\xff\xfe RECOVERABLE";
    fs::write(t.macros(), bytes).unwrap();
    for _ in 0..3 {
        assert!(library::load(&t.profiles()).is_err());
        assert_eq!(fs::read(t.macros()).unwrap(), bytes);
    }
}
#[test]
fn existing_invalid_json_is_rejected_and_not_replaced_by_empty_library() {
    let t = Temp::new();
    t.profile();
    let bytes = b"{ \"old\": BROKEN BUT RECOVERABLE";
    fs::write(t.macros(), bytes).unwrap();
    assert!(library::load(&t.profiles()).is_err());
    assert_eq!(fs::read(t.macros()).unwrap(), bytes);
}
#[test]
fn incompatible_macro_schema_is_rejected_without_overwrite() {
    let t = Temp::new();
    t.profile();
    let text = r#"{"A":{"mode":"NEW_VERSION","steps":[]}}"#;
    fs::write(t.macros(), text).unwrap();
    assert!(library::load(&t.profiles()).is_err());
    assert_eq!(fs::read_to_string(t.macros()).unwrap(), text);
}
#[test]
fn existing_valid_library_is_read_without_rewriting_bytes() {
    let t = Temp::new();
    t.profile();
    let text = "\u{feff}{\n  \"alpha\": {\"steps\":[\"down A\",\"up A\"]}\n}\n";
    fs::write(t.macros(), text).unwrap();
    assert_eq!(
        library::load(&t.profiles()).unwrap().get("alpha"),
        Some(&m("A"))
    );
    assert_eq!(fs::read_to_string(t.macros()).unwrap(), text);
}
#[test]
fn missing_library_seeds_and_keeps_g13_and_mouse_macros() {
    let t = Temp::new();
    fs::write(
        t.profiles().join("a.toml"),
        "name = \"A\"\n[macros.one]\nsteps = [\"down A\",\"up A\"]\n",
    )
    .unwrap();
    fs::write(
        t.0.join("mouse-profiles.json"),
        r#"{"profiles":[{"settings":{"macros":{"two":{"steps":["down B","up B"]}}}}]}"#,
    )
    .unwrap();
    let lib = library::load(&t.profiles()).unwrap();
    assert_eq!(lib.get("one"), Some(&m("A")));
    assert_eq!(lib.get("two"), Some(&m("B")));
    assert!(t.macros().exists());
}
#[test]
fn unreadable_seed_profile_prevents_creating_incomplete_library() {
    let t = Temp::new();
    fs::write(t.profiles().join("bad.toml"), "name = [broken").unwrap();
    assert!(library::load(&t.profiles()).is_err());
    assert!(!t.macros().exists());
}
#[test]
fn broken_mouse_seed_prevents_creating_incomplete_library() {
    let t = Temp::new();
    t.profile();
    fs::write(t.0.join("mouse-profiles.json"), "invalid { json").unwrap();
    assert!(library::load(&t.profiles()).is_err());
    assert!(!t.macros().exists());
}
#[test]
fn missing_profile_directory_refuses_to_seed_empty_library() {
    let t = Temp::new();
    fs::remove_dir_all(t.profiles()).unwrap();
    assert!(library::load(&t.profiles()).is_err());
    assert!(!t.macros().exists());
}
#[test]
fn serialized_real_read_modify_write_keeps_independent_macros() {
    let t = Temp::new();
    t.profile();
    library::save(&t.profiles(), &library::Library::new()).unwrap();
    let dir = Arc::new(t.profiles());
    let lock = Arc::new(Mutex::new(()));
    let barrier = Arc::new(Barrier::new(8));
    std::thread::scope(|s| {
        for i in 0..8 {
            let dir = dir.clone();
            let lock = lock.clone();
            let barrier = barrier.clone();
            s.spawn(move || {
                barrier.wait();
                let _g = lock.lock().unwrap();
                let mut lib = library::load(&dir).unwrap();
                lib.insert(format!("macro{i}"), m("A"));
                library::save(&dir, &lib).unwrap();
            });
        }
    });
    assert_eq!(library::load(&t.profiles()).unwrap().len(), 8);
}
#[test]
fn backup_refuses_unreadable_extra_instead_of_omitting_it() {
    let t = Temp::new();
    t.profile();
    let bytes = b"\xff\xfe RECOVERABLE";
    fs::write(t.macros(), bytes).unwrap();
    assert!(backup::collect(&t.profiles(), &Settings::default(), false).is_err());
    assert_eq!(fs::read(t.macros()).unwrap(), bytes);
}
#[test]
fn backup_still_accepts_absent_optional_extra_files() {
    let t = Temp::new();
    t.profile();
    let b = backup::collect(&t.profiles(), &Settings::default(), false).unwrap();
    assert_eq!(b.profiles.len(), 1);
    assert!(b.files.is_empty());
}
#[test]
fn backup_refuses_unreadable_profile_directory() {
    let t = Temp::new();
    let p = t.0.join("not-a-directory");
    fs::write(&p, b"x").unwrap();
    assert!(backup::collect(&p, &Settings::default(), false).is_err());
}
#[test]
fn backup_refuses_an_unsafe_profile_id() {
    let t = Temp::new();
    fs::write(t.profiles().join("bad name.toml"), "name = \"x\"\n").unwrap();
    assert!(backup::collect(&t.profiles(), &Settings::default(), false).is_err());
}
#[cfg(unix)]
#[test]
fn backup_refuses_symlinked_profile_without_touching_it() {
    use std::os::unix::fs::symlink;
    let t = Temp::new();
    t.profile();
    let link = t.profiles().join("alias.toml");
    symlink(t.profiles().join("demo.toml"), &link).unwrap();
    assert!(backup::collect(&t.profiles(), &Settings::default(), false).is_err());
    assert!(link.is_symlink());
}
#[cfg(unix)]
#[test]
fn backup_refuses_case_ambiguous_ids() {
    let t = Temp::new();
    t.profile();
    fs::write(t.profiles().join("DEMO.toml"), "name = \"Other\"\n").unwrap();
    assert!(backup::collect(&t.profiles(), &Settings::default(), false).is_err());
}

#[cfg(unix)]
#[test]
fn library_refuses_symlink_without_reading_or_writing_target() {
    use std::os::unix::fs::symlink;
    let t = Temp::new();
    t.profile();
    let target = t.0.join("target.json");
    let text = r#"{"alpha":{"steps":[]}}"#;
    fs::write(&target, text).unwrap();
    symlink(&target, t.macros()).unwrap();
    assert!(library::load(&t.profiles()).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), text);
}
#[cfg(unix)]
#[test]
fn backup_refuses_symlinked_extra_file() {
    use std::os::unix::fs::symlink;
    let t = Temp::new();
    t.profile();
    let target = t.0.join("target.json");
    fs::write(&target, "{}").unwrap();
    symlink(&target, t.macros()).unwrap();
    assert!(backup::collect(&t.profiles(), &Settings::default(), false).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), "{}");
}

#[test]
fn conditional_put_rejects_stale_same_name_without_writing() {
    let t = Temp::new();
    t.profile();
    library::save(&t.profiles(), &library::Library::new()).unwrap();
    library::put_if_unchanged(&t.profiles(), "same".into(), m("A"), None, None, None).unwrap();
    library::put_if_unchanged(
        &t.profiles(),
        "same".into(),
        m("B"),
        None,
        Some(m("A")),
        None,
    )
    .unwrap();
    let bytes = fs::read(t.macros()).unwrap();
    let err = library::put_if_unchanged(
        &t.profiles(),
        "same".into(),
        m("C"),
        None,
        Some(m("A")),
        None,
    )
    .unwrap_err();
    assert!(err.contains("MACRO_LIBRARY_CONFLICT"));
    assert_eq!(fs::read(t.macros()).unwrap(), bytes);
    assert_eq!(
        library::load(&t.profiles()).unwrap().get("same"),
        Some(&m("B"))
    );
}
#[test]
fn conditional_independent_puts_both_survive() {
    let t = Temp::new();
    t.profile();
    library::save(&t.profiles(), &library::Library::new()).unwrap();
    library::put_if_unchanged(&t.profiles(), "one".into(), m("A"), None, None, None).unwrap();
    library::put_if_unchanged(&t.profiles(), "two".into(), m("B"), None, None, None).unwrap();
    let lib = library::load(&t.profiles()).unwrap();
    assert_eq!(lib.get("one"), Some(&m("A")));
    assert_eq!(lib.get("two"), Some(&m("B")));
}
#[test]
fn conditional_identical_put_is_idempotent_after_an_uncertain_reply() {
    let t = Temp::new();
    t.profile();
    library::save(&t.profiles(), &library::Library::new()).unwrap();
    for _ in 0..2 {
        library::put_if_unchanged(&t.profiles(), "one".into(), m("A"), None, None, None).unwrap();
    }
    assert_eq!(library::load(&t.profiles()).unwrap().len(), 1);
}
#[test]
fn conditional_rename_rejects_known_existing_destination() {
    let t = Temp::new();
    t.profile();
    let mut lib = library::Library::new();
    lib.insert("old".into(), m("A"));
    lib.insert("taken".into(), m("B"));
    library::save(&t.profiles(), &lib).unwrap();
    let before = fs::read(t.macros()).unwrap();
    let e = library::put_if_unchanged(
        &t.profiles(),
        "taken".into(),
        m("A"),
        Some("old".into()),
        Some(m("B")),
        Some(m("A")),
    )
    .unwrap_err();
    assert!(e.contains("MACRO_LIBRARY_NAME_EXISTS"));
    assert_eq!(fs::read(t.macros()).unwrap(), before);
}
#[test]
fn conditional_rename_rejects_unseen_new_destination() {
    let t = Temp::new();
    t.profile();
    let mut lib = library::Library::new();
    lib.insert("old".into(), m("A"));
    lib.insert("new".into(), m("B"));
    library::save(&t.profiles(), &lib).unwrap();
    let before = fs::read(t.macros()).unwrap();
    let e = library::put_if_unchanged(
        &t.profiles(),
        "new".into(),
        m("A"),
        Some("old".into()),
        None,
        Some(m("A")),
    )
    .unwrap_err();
    assert!(e.contains("MACRO_LIBRARY_CONFLICT:new"));
    assert_eq!(fs::read(t.macros()).unwrap(), before);
}
#[test]
fn conditional_rename_rejects_changed_source_without_creating_destination() {
    let t = Temp::new();
    t.profile();
    let mut lib = library::Library::new();
    lib.insert("old".into(), m("B"));
    library::save(&t.profiles(), &lib).unwrap();
    let before = fs::read(t.macros()).unwrap();
    let e = library::put_if_unchanged(
        &t.profiles(),
        "new".into(),
        m("A"),
        Some("old".into()),
        None,
        Some(m("A")),
    )
    .unwrap_err();
    assert!(e.contains("MACRO_LIBRARY_CONFLICT:old"));
    assert_eq!(fs::read(t.macros()).unwrap(), before);
}
#[test]
fn conditional_rename_and_delete_are_idempotent_when_already_applied() {
    let t = Temp::new();
    t.profile();
    let mut lib = library::Library::new();
    lib.insert("old".into(), m("A"));
    library::save(&t.profiles(), &lib).unwrap();
    for _ in 0..2 {
        library::put_if_unchanged(
            &t.profiles(),
            "new".into(),
            m("A"),
            Some("old".into()),
            None,
            Some(m("A")),
        )
        .unwrap();
    }
    assert!(library::load(&t.profiles()).unwrap().contains_key("new"));
    for _ in 0..2 {
        library::remove_if_unchanged(&t.profiles(), "new", Some(m("A"))).unwrap();
    }
    assert!(library::load(&t.profiles()).unwrap().is_empty());
}
#[test]
fn conditional_delete_rejects_stale_value() {
    let t = Temp::new();
    t.profile();
    let mut lib = library::Library::new();
    lib.insert("same".into(), m("B"));
    library::save(&t.profiles(), &lib).unwrap();
    let before = fs::read(t.macros()).unwrap();
    let e = library::remove_if_unchanged(&t.profiles(), "same", Some(m("A"))).unwrap_err();
    assert!(e.contains("MACRO_LIBRARY_CONFLICT"));
    assert_eq!(fs::read(t.macros()).unwrap(), before);
}
#[test]
fn two_serialized_gui_style_stale_writers_cannot_both_win() {
    let t = Temp::new();
    t.profile();
    let mut lib = library::Library::new();
    lib.insert("same".into(), m("A"));
    library::save(&t.profiles(), &lib).unwrap();
    let dir = Arc::new(t.profiles());
    let lock = Arc::new(Mutex::new(()));
    let barrier = Arc::new(Barrier::new(2));
    let outcomes = std::thread::scope(|s| {
        let mut jobs = Vec::new();
        for key in ["B", "C"] {
            let dir = dir.clone();
            let lock = lock.clone();
            let barrier = barrier.clone();
            jobs.push(s.spawn(move || {
                barrier.wait();
                let _g = lock.lock().unwrap();
                library::put_if_unchanged(&dir, "same".into(), m(key), None, Some(m("A")), None)
            }));
        }
        jobs.into_iter()
            .map(|j| j.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(outcomes.iter().filter(|x| x.is_ok()).count(), 1);
    assert_eq!(outcomes.iter().filter(|x| x.is_err()).count(), 1);
}
