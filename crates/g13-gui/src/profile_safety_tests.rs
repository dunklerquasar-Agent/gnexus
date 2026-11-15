// Included in a test-only crate using the REAL GUI and daemon modules.
// Uses only temporary synthetic profiles and our own tiny XML; not Tauri or G13.
use crate::{profile_edits::ProfileEdits, profiles_io};
use g13_daemon::profiles::{FileDto, MatchRule};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

static N: AtomicU64 = AtomicU64::new(1);
struct Dir(std::path::PathBuf);
impl Dir {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "gnexus-rule-check-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        std::fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| {
                let p = entry.unwrap().path();
                (
                    p.file_name().unwrap().to_string_lossy().to_string(),
                    std::fs::read(&p).unwrap(),
                )
            })
            .collect()
    }
    fn seed(&self, id: &str, name: &str, rules: Vec<MatchRule>, num: Option<u32>) {
        let p = FileDto {
            name: name.into(),
            number: num,
            rules,
            ..FileDto::default()
        };
        profiles_io::save(self.path(), id, &p).unwrap()
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap()
    }
}
fn exe(s: &str) -> MatchRule {
    MatchRule::exe(s)
}
fn both(s: &str, title: &str) -> MatchRule {
    MatchRule {
        exe: Some(s.into()),
        title: Some(title.into()),
    }
}
fn title(t: &str) -> MatchRule {
    MatchRule {
        exe: None,
        title: Some(t.into()),
    }
}
fn demo() -> (Dir, ProfileEdits, crate::profile_edits::EditSnapshot) {
    let d = Dir::new();
    d.seed("demo", "Demo", vec![], Some(1));
    let mut e = ProfileEdits::default();
    let s = e.load(d.path(), "demo").unwrap();
    (d, e, s)
}

#[test]
fn combined_other_rule_is_not_deleted_by_one_click_assign() {
    let (d, _, _) = demo();
    d.seed("owner", "Owner", vec![both("Game.EXE", "Editor")], Some(2));
    let before = d.snapshot();
    let err = profiles_io::assign_app(d.path(), "demo", "game").unwrap_err();
    assert!(err.contains("RULE_OWNER_CONFLICT"), "{err}");
    assert_eq!(d.snapshot(), before);
}
#[test]
fn simple_other_rule_is_not_moved_without_explicit_decision() {
    let (d, _, _) = demo();
    d.seed("owner", "Owner", vec![exe("Game.EXE")], Some(2));
    let before = d.snapshot();
    let err = profiles_io::assign_app(d.path(), "demo", "game").unwrap_err();
    assert!(err.contains("RULE_OWNER_CONFLICT"), "{err}");
    assert_eq!(d.snapshot(), before);
}
#[test]
fn title_only_claim_conservatively_blocks_direct_assign() {
    let (d, _, _) = demo();
    d.seed("owner", "Owner", vec![title("Window")], Some(2));
    let before = d.snapshot();
    assert!(
        profiles_io::assign_app(d.path(), "demo", "x.exe")
            .unwrap_err()
            .contains("RULE_OWNER_CONFLICT")
    );
    assert_eq!(d.snapshot(), before);
}
#[test]
fn combined_target_rule_is_not_silently_widened() {
    let d = Dir::new();
    d.seed("demo", "Demo", vec![both("game.exe", "Editor")], Some(1));
    let before = d.snapshot();
    assert!(
        profiles_io::assign_app(d.path(), "demo", "game")
            .unwrap_err()
            .contains("COMBINED_RULE_CONFLICT")
    );
    assert_eq!(d.snapshot(), before);
}
#[test]
fn unrelated_executable_combined_rule_remains_unchanged_on_assign() {
    let (d, _, _) = demo();
    d.seed("owner", "Owner", vec![both("other.exe", "Editor")], Some(2));
    let owner = std::fs::read(d.path().join("owner.toml")).unwrap();
    profiles_io::assign_app(d.path(), "demo", "game.exe").unwrap();
    assert_eq!(
        profiles_io::load(d.path(), "demo").unwrap().rules,
        vec![exe("game.exe")]
    );
    assert_eq!(std::fs::read(d.path().join("owner.toml")).unwrap(), owner);
}
#[test]
fn idempotent_assign_does_not_rewrite_target() {
    let d = Dir::new();
    d.seed("demo", "Demo", vec![exe("game.exe")], Some(1));
    let before = d.snapshot();
    profiles_io::assign_app(d.path(), "demo", "GAME").unwrap();
    assert_eq!(d.snapshot(), before);
}
#[test]
fn bad_other_profile_prevents_assignment_before_any_write() {
    let (d, _, _) = demo();
    std::fs::write(d.path().join("bad.toml"), b"bad = [\n").unwrap();
    let before = d.snapshot();
    assert!(
        profiles_io::assign_app(d.path(), "demo", "game")
            .unwrap_err()
            .contains("RULE_OWNERS_UNAVAILABLE")
    );
    assert_eq!(d.snapshot(), before);
}
#[test]
fn saving_new_overlapping_rule_rejects_entire_edit_without_write() {
    let (d, e, s) = demo();
    d.seed("owner", "Owner", vec![exe("Game.EXE")], Some(2));
    let before = d.snapshot();
    let mut changed = s.profile.clone();
    changed.name = "Do not save".into();
    changed.rules = vec![exe("game")];
    let err = e
        .save(d.path(), "demo", &s.profile, &changed, &s.token)
        .unwrap_err();
    assert!(err.contains("RULE_OWNER_CONFLICT"), "{err}");
    assert_eq!(d.snapshot(), before);
}
#[test]
fn existing_overlap_does_not_block_nonrule_edit() {
    let d = Dir::new();
    d.seed("demo", "Demo", vec![exe("game")], Some(1));
    d.seed("owner", "Owner", vec![exe("GAME.exe")], Some(2));
    let mut e = ProfileEdits::default();
    let s = e.load(d.path(), "demo").unwrap();
    let mut changed = s.profile.clone();
    changed.name = "Still editable".into();
    assert_eq!(
        e.save(d.path(), "demo", &s.profile, &changed, &s.token)
            .unwrap()
            .name,
        "Still editable"
    );
    assert_eq!(
        profiles_io::load(d.path(), "owner").unwrap().rules,
        vec![exe("GAME.exe")]
    );
}
#[test]
fn editing_a_rule_to_a_possible_overlap_is_blocked() {
    let d = Dir::new();
    d.seed("demo", "Demo", vec![exe("old")], Some(1));
    d.seed("owner", "Owner", vec![both("game", "specific")], Some(2));
    let mut e = ProfileEdits::default();
    let s = e.load(d.path(), "demo").unwrap();
    let mut changed = s.profile.clone();
    changed.rules = vec![both("GAME.exe", "other")];
    let before = d.snapshot();
    assert!(
        e.save(d.path(), "demo", &s.profile, &changed, &s.token)
            .unwrap_err()
            .contains("RULE_OWNER_CONFLICT")
    );
    assert_eq!(d.snapshot(), before);
}
#[test]
fn unrelated_save_or_rule_removal_remains_possible_with_bad_other_profile() {
    let d = Dir::new();
    d.seed("demo", "Demo", vec![exe("game")], Some(1));
    std::fs::write(d.path().join("bad.toml"), b"bad = [\n").unwrap();
    let mut e = ProfileEdits::default();
    let s = e.load(d.path(), "demo").unwrap();
    let mut changed = s.profile.clone();
    changed.name = "Allowed".into();
    changed.rules.clear();
    assert_eq!(
        e.save(d.path(), "demo", &s.profile, &changed, &s.token)
            .unwrap()
            .name,
        "Allowed"
    );
}
#[test]
fn new_rule_requires_all_owners_to_be_inspectable() {
    let (d, e, s) = demo();
    std::fs::write(d.path().join("bad.toml"), b"bad = [\n").unwrap();
    let before = d.snapshot();
    let mut changed = s.profile.clone();
    changed.rules = vec![exe("game")];
    let err = e
        .save(d.path(), "demo", &s.profile, &changed, &s.token)
        .unwrap_err();
    assert!(err.contains("RULE_OWNERS_UNAVAILABLE"), "{err}");
    assert_eq!(d.snapshot(), before);
}
#[test]
fn actual_lgs_xml_conflict_is_rejected_before_numbering_any_existing_file() {
    let d = Dir::new();
    d.seed("owner", "Owner", vec![exe("GAME.exe")], None);
    let before = d.snapshot();
    let imported = g13_daemon::profiles::lgs::import(
        r#"<profile name="Imported"><target path="C:\\Games\\game"/></profile>"#,
    )
    .unwrap();
    assert_eq!(imported.dto.rules, vec![exe("game")]);
    let err = profiles_io::create_from(d.path(), imported.dto).unwrap_err();
    assert!(err.contains("RULE_OWNER_CONFLICT"), "{err}");
    assert_eq!(d.snapshot(), before);
}
#[test]
fn nonconflicting_lgs_xml_is_imported_without_numbering_existing_files() {
    let d = Dir::new();
    d.seed("owner", "Owner", vec![exe("other.exe")], None);
    let owner = std::fs::read(d.path().join("owner.toml")).unwrap();
    let imported = g13_daemon::profiles::lgs::import(
        r#"<profile name="Imported"><target path="C:\\Games\\game.exe"/></profile>"#,
    )
    .unwrap();
    let id = profiles_io::create_from(d.path(), imported.dto).unwrap();
    assert_eq!(
        profiles_io::load(d.path(), &id).unwrap().rules,
        vec![exe("game.exe")]
    );
    assert_eq!(std::fs::read(d.path().join("owner.toml")).unwrap(), owner);
}
#[test]
fn new_profile_name_collision_is_case_insensitive_even_on_linux() {
    let d = Dir::new();
    d.seed("IMPORTED", "Existing", vec![], Some(1));
    let before = std::fs::read(d.path().join("IMPORTED.toml")).unwrap();
    let id = profiles_io::create_from(
        d.path(),
        FileDto {
            name: "Imported".into(),
            ..FileDto::default()
        },
    )
    .unwrap();
    assert_eq!(id, "imported-2");
    assert_eq!(
        std::fs::read(d.path().join("IMPORTED.toml")).unwrap(),
        before
    );
}
#[test]
fn concurrent_profiles_cannot_both_add_same_app_through_gui_mutex() {
    use std::sync::{Arc, Barrier, Mutex};
    let d = Dir::new();
    d.seed("one", "One", vec![], Some(1));
    d.seed("two", "Two", vec![], Some(2));
    let mut e = ProfileEdits::default();
    let a = e.load(d.path(), "one").unwrap();
    let b = e.load(d.path(), "two").unwrap();
    let e = Arc::new(Mutex::new(e));
    let barrier = Arc::new(Barrier::new(3));
    let mut threads = vec![];
    for (id, s) in [("one", a), ("two", b)] {
        let e = e.clone();
        let barrier = barrier.clone();
        let dir = d.path().to_path_buf();
        threads.push(std::thread::spawn(move || {
            let mut edited = s.profile.clone();
            edited.rules = vec![exe("game.exe")];
            barrier.wait();
            e.lock()
                .unwrap()
                .save(&dir, id, &s.profile, &edited, &s.token)
        }));
    }
    barrier.wait();
    let r: Vec<_> = threads.into_iter().map(|x| x.join().unwrap()).collect();
    assert_eq!(r.iter().filter(|x| x.is_ok()).count(), 1, "{r:?}");
    assert_eq!(
        r.iter()
            .filter(|x| x
                .as_ref()
                .err()
                .is_some_and(|e| e.contains("RULE_OWNER_CONFLICT")))
            .count(),
        1,
        "{r:?}"
    );
}

#[test]
fn semantically_invalid_toml_is_not_ignored_for_new_claims() {
    let (d, e, s) = demo();
    let invalid:FileDto=serde_json::from_value(serde_json::json!({"name":"Bad","banks":{"M1":{"G1":"DefinitelyInvalidKey"},"M2":{},"M3":{}}})).unwrap();
    assert!(g13_daemon::profiles::from_dto(invalid.clone()).is_err());
    std::fs::write(
        d.path().join("invalid.toml"),
        g13_daemon::profiles::dto_to_toml(&invalid).unwrap(),
    )
    .unwrap();
    let before = d.snapshot();
    let mut changed = s.profile.clone();
    changed.rules = vec![exe("game.exe")];
    assert!(
        e.save(d.path(), "demo", &s.profile, &changed, &s.token)
            .unwrap_err()
            .contains("RULE_OWNERS_UNAVAILABLE")
    );
    assert_eq!(d.snapshot(), before);
}
#[cfg(unix)]
#[test]
fn symlinked_profile_is_not_followed_during_an_owner_check() {
    use std::os::unix::fs::symlink;
    let (d, e, s) = demo();
    d.seed("owner", "Owner", vec![], Some(2));
    symlink(d.path().join("owner.toml"), d.path().join("shadow.toml")).unwrap();
    let before = d.snapshot();
    let mut changed = s.profile.clone();
    changed.rules = vec![exe("game.exe")];
    assert!(
        e.save(d.path(), "demo", &s.profile, &changed, &s.token)
            .unwrap_err()
            .contains("RULE_OWNERS_UNAVAILABLE")
    );
    assert_eq!(d.snapshot(), before);
}
#[test]
fn unrelated_rule_can_be_added_while_other_exe_has_a_combined_rule() {
    let (d, e, s) = demo();
    d.seed("owner", "Owner", vec![both("other.exe", "Editor")], Some(2));
    let mut changed = s.profile.clone();
    changed.rules = vec![exe("game")];
    let out = e
        .save(d.path(), "demo", &s.profile, &changed, &s.token)
        .unwrap();
    assert_eq!(out.rules, vec![exe("game")]);
    assert_eq!(
        profiles_io::load(d.path(), "owner").unwrap().rules,
        vec![both("other.exe", "Editor")]
    );
}
#[test]
fn idempotent_rule_save_does_not_reject_preexisting_overlap() {
    let (d, e, s) = demo();
    let mut same = s.profile.clone();
    same.rules = vec![exe("game.exe")];
    // Mimic an already established legacy overlap; this invocation must not create another one.
    profiles_io::save(d.path(), "demo", &same).unwrap();
    d.seed("owner", "Owner", vec![exe("GAME")], Some(2));
    let out = e
        .save(d.path(), "demo", &s.profile, &same, &s.token)
        .unwrap();
    assert_eq!(out.rules, vec![exe("game.exe")]);
}
#[test]
fn unicode_executable_with_ascii_suffix_is_compared_without_panics() {
    let (d, e, s) = demo();
    d.seed("owner", "Owner", vec![exe("ÄPP.EXE")], Some(2));
    let mut changed = s.profile.clone();
    changed.rules = vec![exe("Äpp")];
    assert!(
        e.save(d.path(), "demo", &s.profile, &changed, &s.token)
            .unwrap_err()
            .contains("RULE_OWNER_CONFLICT")
    );
}
#[test]
fn lgs_import_without_rule_is_not_blocked_by_unreadable_unrelated_profile() {
    let d = Dir::new();
    std::fs::write(d.path().join("bad.toml"), b"bad = [\n").unwrap();
    let imported = g13_daemon::profiles::lgs::import(r#"<profile name="No Target"/>"#).unwrap();
    let id = profiles_io::create_from(d.path(), imported.dto).unwrap();
    assert_eq!(id, "no-target");
    assert!(profiles_io::load(d.path(), &id).unwrap().rules.is_empty());
}
#[test]
#[ignore = "documents a known Linux matching gap rather than desired behavior"]
fn expected_linux_gap_different_process_name_and_app_id_can_both_match() {
    use g13_daemon::platform::ForegroundApp;
    let d = Dir::new();
    d.seed("one", "One", vec![exe("game")], Some(1));
    d.seed("two", "Two", vec![], Some(2));
    // The real Windows watcher sets app_id=None; Linux may populate it independently.
    let window = ForegroundApp {
        process_name: "game.exe".into(),
        app_id: Some("browser".into()),
        ..ForegroundApp::default()
    };
    assert!(exe("game").matches(&window) && exe("browser").matches(&window));
    profiles_io::assign_app(d.path(), "two", "browser").unwrap();
    assert_eq!(
        profiles_io::load(d.path(), "one").unwrap().rules,
        vec![exe("game")]
    );
    assert_eq!(
        profiles_io::load(d.path(), "two").unwrap().rules,
        vec![exe("browser")]
    );
}
