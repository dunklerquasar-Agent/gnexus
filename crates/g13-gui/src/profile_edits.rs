//! Narrow experimental protection for profile drafts shared by two GUI windows.
//!
//! The caller holds the same mutex across every GUI profile read/write. Tokens
//! detect GUI-internal delete/recreate and whole-configuration replacement,
//! not writes from external processes. Every scalar/array, including rules,
//! is an atomic conflict unit; unrelated object keys can be merged.

use std::collections::HashMap;
use std::path::Path;

use g13_daemon::profiles::FileDto;
use serde::Serialize;
use crate::{profile_delta, profiles_io};

#[derive(Debug, Clone, Serialize)]
pub struct EditSnapshot {
    pub profile: FileDto,
    pub token: String,
}

#[derive(Default)]
pub struct ProfileEdits {
    next: u64,
    tokens: HashMap<String, String>,
}

impl ProfileEdits {
    fn issue(&mut self, id: &str) -> Result<String, String> {
        if let Some(token) = self.tokens.get(id) {
            return Ok(token.clone());
        }
        self.next = self.next.checked_add(1).ok_or("profile session exhausted")?;
        let token = self.next.to_string();
        self.tokens.insert(id.to_string(), token.clone());
        Ok(token)
    }

    pub fn require(&self, id: &str, token: &str) -> Result<(), String> {
        if self.tokens.get(id).is_some_and(|current| current == token) {
            Ok(())
        } else {
            Err("PROFILE_REPLACED: ce profil a été supprimé ou remplacé; brouillon non enregistré".into())
        }
    }

    /// Call after successful creation/deletion; subsequent loads receive a new identity.
    pub fn invalidate(&mut self, id: &str) {
        self.tokens.remove(id);
    }

    /// Call before a destructive import/reset, even if that operation later fails.
    pub fn invalidate_all(&mut self) {
        self.tokens.clear();
    }

    pub fn load(&mut self, dir: &Path, id: &str) -> Result<EditSnapshot, String> {
        let profile = profiles_io::load(dir, id)?;
        Ok(EditSnapshot { profile, token: self.issue(id)? })
    }

    pub fn save(&self, dir: &Path, id: &str, base: &FileDto, edited: &FileDto, token: &str) -> Result<FileDto, String> {
        self.require(id, token)?;
        // Fail if a profile disappeared rather than recreating it from an old draft.
        let current = profiles_io::load(dir, id)?;
        if edited.rules != base.rules && current.rules != base.rules && current.rules != edited.rules {
            return Err("RULES_CONFLICT: les règles ont changé dans une autre fenêtre; brouillon non enregistré".into());
        }
        let encode = |v: &FileDto| serde_json::to_value(v).map_err(|e| e.to_string());
        let (b, e, c) = (encode(base)?, encode(edited)?, encode(&current)?);
        if profile_delta::conflicts(Some(&b), Some(&e), Some(&c)) {
            return Err("PROFILE_CONFLICT: le même champ a changé dans une autre fenêtre; brouillon non enregistré".into());
        }
        let mut merged = profile_delta::apply(Some(&b), Some(&e), Some(&c)).ok_or("profil vide")?;
        let rules = if edited.rules == base.rules { &current.rules } else { &edited.rules };
        merged.as_object_mut().ok_or("profil invalide")?
            .insert("rules".into(), serde_json::to_value(rules).map_err(|e| e.to_string())?);
        let dto: FileDto = serde_json::from_value(merged).map_err(|e| e.to_string())?;
        // Only new rules need a fresh ownership scan. Legacy overlaps and
        // unrelated edits remain usable; no changes are written on conflict.
        let added: Vec<_> = dto.rules.iter().filter(|rule| !base.rules.contains(rule) && !current.rules.contains(rule)).cloned().collect();
        profiles_io::check_new_rule_claims(dir, Some(id), &added)?;
        profiles_io::save(dir, id, &dto)?;
        profiles_io::load(dir, id)
    }

    /// Refuse an altered/replaced saved profile. This cannot see another
    /// window's unsaved draft or changes made by external processes.
    pub fn delete(&mut self, dir: &Path, id: &str, expected: &FileDto, token: &str) -> Result<(), String> {
        self.require(id, token)?;
        let current = profiles_io::load(dir, id)?;
        if serde_json::to_value(expected).map_err(|e| e.to_string())?
            != serde_json::to_value(current).map_err(|e| e.to_string())?
        {
            return Err("PROFILE_DELETE_CONFLICT: le profil enregistré a changé; suppression annulée".into());
        }
        profiles_io::delete(dir, id)?;
        self.invalidate(id);
        Ok(())
    }
}

/// Replacement of every profile cannot inspect an overlay's unsaved RAM draft.
/// Check while holding the same mutex used to start opening that window.
pub fn allow_config_replacement(overlay_opening: bool, overlay_exists: bool) -> Result<(), String> {
    if overlay_opening || overlay_exists { Err("CONFIG_OVERLAY_OPEN".into()) } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(1);
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("g13-narrow-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn init() -> (Scratch, ProfileEdits, EditSnapshot) {
        let dir = Scratch::new();
        let dto: FileDto = serde_json::from_value(json!({"name":"Demo","number":1,"banks":{"M1":{},"M2":{},"M3":{}}})).unwrap();
        profiles_io::save(dir.path(), "demo", &dto).unwrap();
        let mut edits = ProfileEdits::default();
        let loaded = edits.load(dir.path(), "demo").unwrap();
        (dir, edits, loaded)
    }
    fn alter(dto: &FileDto, f: impl FnOnce(&mut Value)) -> FileDto {
        let mut v = serde_json::to_value(dto).unwrap();
        f(&mut v);
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn unrelated_two_window_changes_merge_with_a_shared_identity() {
        let (d, mut edits, a) = init();
        let b = edits.load(d.path(), "demo").unwrap();
        assert_eq!(a.token, b.token);
        let first = alter(&a.profile, |v| v["name"] = json!("Changed"));
        let second = alter(&b.profile, |v| v["banks"]["M1"]["G1"] = json!("Q"));
        edits.save(d.path(), "demo", &a.profile, &first, &a.token).unwrap();
        let final_dto = edits.save(d.path(), "demo", &b.profile, &second, &b.token).unwrap();
        let v = serde_json::to_value(final_dto).unwrap();
        assert_eq!(v["name"], "Changed");
        assert_eq!(v["banks"]["M1"]["G1"], "Q");
    }

    #[test]
    fn divergent_rule_lists_refuse_the_entire_write() {
        let (d, edits, a) = init();
        let first = alter(&a.profile, |v| v["rules"] = json!([{"exe":"first.exe"}]));
        let second = alter(&a.profile, |v| { v["name"] = json!("should not write"); v["rules"] = json!([{"exe":"second.exe"}]); });
        edits.save(d.path(), "demo", &a.profile, &first, &a.token).unwrap();
        assert!(edits.save(d.path(), "demo", &a.profile, &second, &a.token).unwrap_err().contains("RULES_CONFLICT"));
        let v = serde_json::to_value(profiles_io::load(d.path(), "demo").unwrap()).unwrap();
        assert_eq!(v["name"], "Demo");
        assert_eq!(v["rules"], json!([{"exe":"first.exe"}]));
    }

    #[test]
    fn unchanged_empty_rule_base_preserves_concurrent_rules() {
        let (d, edits, a) = init();
        let first = alter(&a.profile, |v| v["rules"] = json!([{"exe":"first.exe"}]));
        let second = alter(&a.profile, |v| v["name"] = json!("Changed"));
        edits.save(d.path(), "demo", &a.profile, &first, &a.token).unwrap();
        let final_dto = edits.save(d.path(), "demo", &a.profile, &second, &a.token).unwrap();
        let v = serde_json::to_value(final_dto).unwrap();
        assert_eq!(v["name"], "Changed");
        assert_eq!(v["rules"], json!([{"exe":"first.exe"}]));
    }

    #[test]
    fn delete_recreate_invalidates_even_identical_content() {
        let (d, mut edits, a) = init();
        std::fs::remove_file(d.path().join("demo.toml")).unwrap();
        edits.invalidate("demo");
        profiles_io::save(d.path(), "demo", &a.profile).unwrap();
        let b = edits.load(d.path(), "demo").unwrap();
        assert_ne!(a.token, b.token);
        assert!(edits.save(d.path(), "demo", &a.profile, &a.profile, &a.token).unwrap_err().contains("PROFILE_REPLACED"));
    }

    #[test]
    fn failed_replacement_still_invalidates_all_sessions() {
        let (d, mut edits, a) = init();
        edits.invalidate_all();
        assert!(edits.save(d.path(), "demo", &a.profile, &a.profile, &a.token).unwrap_err().contains("PROFILE_REPLACED"));
    }

    #[test]
    fn concurrent_scalar_edits_are_not_silently_overwritten() {
        let (d, edits, a) = init();
        let first = alter(&a.profile, |v| v["name"] = json!("First"));
        let second = alter(&a.profile, |v| v["name"] = json!("Second"));
        edits.save(d.path(), "demo", &a.profile, &first, &a.token).unwrap();
        assert!(edits.save(d.path(), "demo", &a.profile, &second, &a.token).unwrap_err().contains("PROFILE_CONFLICT"));
        assert_eq!(profiles_io::load(d.path(), "demo").unwrap().name, "First");
    }

    #[test]
    fn stale_delete_cannot_remove_a_newer_saved_profile() {
        let (d, mut edits, a) = init();
        profiles_io::create(d.path(), "Another", None).unwrap();
        let updated = alter(&a.profile, |v| v["name"] = json!("Newer"));
        edits.save(d.path(), "demo", &a.profile, &updated, &a.token).unwrap();
        assert!(edits.delete(d.path(), "demo", &a.profile, &a.token).unwrap_err().contains("PROFILE_DELETE_CONFLICT"));
        assert_eq!(profiles_io::load(d.path(), "demo").unwrap().name, "Newer");
        edits.delete(d.path(), "demo", &updated, &a.token).unwrap();
        assert!(edits.save(d.path(), "demo", &updated, &updated, &a.token).is_err());
    }

    #[test]
    fn invalid_merged_value_fails_before_the_profile_is_written() {
        let (d, edits, a) = init();
        let invalid = alter(&a.profile, |v| v["banks"]["M1"]["G1"] = json!("A+INVALID_KEY"));
        let before = std::fs::read(d.path().join("demo.toml")).unwrap();
        assert!(edits.save(d.path(), "demo", &a.profile, &invalid, &a.token).is_err());
        assert_eq!(std::fs::read(d.path().join("demo.toml")).unwrap(), before);
    }

    #[test]
    fn concurrent_calls_merge_under_the_shared_caller_mutex() {
        use std::sync::{Arc, Barrier, Mutex};
        let (d, edits, a) = init();
        let shared = Arc::new(Mutex::new(edits));
        let barrier = Arc::new(Barrier::new(3));
        let mut threads = Vec::new();
        for (key, value) in [("G1", "Q"), ("G2", "W")] {
            let edits = shared.clone(); let barrier = barrier.clone(); let path = d.path().to_path_buf();
            let snapshot = a.clone();
            threads.push(std::thread::spawn(move || {
                let changed = alter(&snapshot.profile, |v| v["banks"]["M1"][key] = json!(value));
                barrier.wait();
                edits.lock().unwrap().save(&path, "demo", &snapshot.profile, &changed, &snapshot.token).unwrap();
            }));
        }
        barrier.wait();
        for t in threads { t.join().unwrap(); }
        let v = serde_json::to_value(profiles_io::load(d.path(), "demo").unwrap()).unwrap();
        assert_eq!(v["banks"]["M1"]["G1"], "Q");
        assert_eq!(v["banks"]["M1"]["G2"], "W");
    }

    #[test]
    fn missing_file_is_not_recreated() {
        let (d, edits, a) = init();
        std::fs::remove_file(d.path().join("demo.toml")).unwrap();
        assert!(edits.save(d.path(), "demo", &a.profile, &a.profile, &a.token).is_err());
        assert!(!d.path().join("demo.toml").exists());
    }

    #[test]
    fn configuration_replacement_refuses_open_or_opening_overlay() {
        assert!(allow_config_replacement(false, false).is_ok());
        assert!(allow_config_replacement(true, false).unwrap_err().contains("CONFIG_OVERLAY_OPEN"));
        assert!(allow_config_replacement(false, true).unwrap_err().contains("CONFIG_OVERLAY_OPEN"));
        assert!(allow_config_replacement(true, true).unwrap_err().contains("CONFIG_OVERLAY_OPEN"));
    }

}
