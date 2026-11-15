//! Macro library (`<config>/macros.json`): every macro made in G Nexus, for
//! the G13 and the mouse, so that one made in a profile can be used in any other.
//! A profile keeps its own copy (the engine and the mouse thread read the
//! profile); the library holds the latest version of each macro by name.
//!
//! The first time, it is filled with the macros already in the G13 profiles
//! and in the mouse profiles.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use g13_daemon::profiles::FileDto;
use g13_daemon::profiles::format::MacroDto;

pub type Library = BTreeMap<String, MacroDto>;

fn path(profiles_dir: &Path) -> Option<PathBuf> {
    profiles_dir.parent().map(|p| p.join("macros.json"))
}

/// The library, built from the existing profiles only if it is genuinely absent.
/// An unreadable or malformed existing file is never treated as an empty library.
pub fn load(profiles_dir: &Path) -> Result<Library, String> {
    let p = path(profiles_dir).ok_or("aucun dossier de configuration")?;
    match fs::symlink_metadata(&p) {
        Ok(meta) => {
            if !meta.file_type().is_file() {
                return Err(format!("bibliothèque de macros non ordinaire : {}", p.display()));
            }
            let text = fs::read_to_string(&p).map_err(|e| format!("bibliothèque de macros illisible {} : {e}", p.display()))?;
            serde_json::from_str(text.trim_start_matches('\u{feff}'))
                .map_err(|e| format!("bibliothèque de macros invalide {} : {e}", p.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let lib = seed(profiles_dir)?;
            save_new(&p, &lib)?; // a concurrent creator must never be truncated
            Ok(lib)
        }
        Err(e) => Err(format!("bibliothèque de macros illisible {} : {e}", p.display())),
    }
}

/// Create only; a failed write can leave a new partial file, but must never
/// replace an already existing library (including an external creator).
fn save_new(path: &Path, lib: &Library) -> Result<(), String> {
    let text = serde_json::to_string_pretty(lib).map_err(|e| e.to_string())?;
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)
        .map_err(|e| format!("impossible de créer la bibliothèque {} sans écraser : {e}", path.display()))?;
    file.write_all(text.as_bytes()).map_err(|e| format!("bibliothèque créée partiellement {} : {e}", path.display()))
}

pub fn save(profiles_dir: &Path, lib: &Library) -> Result<(), String> {
    let p = path(profiles_dir).ok_or("aucun dossier de configuration")?;
    let text = serde_json::to_string_pretty(lib).map_err(|e| e.to_string())?;
    fs::write(&p, text).map_err(|e| format!("{}: {e}", p.display()))
}

/// Compare the names affected by a put/rename before modifying the shared file.
/// The caller serializes these operations with other GUI library/backup access.
pub fn put_if_unchanged(
    profiles_dir: &Path,
    name: String,
    mac: MacroDto,
    old: Option<String>,
    expected: Option<MacroDto>,
    expected_old: Option<MacroDto>,
) -> Result<(), String> {
    let mut lib = load(profiles_dir)?;
    let old = old.filter(|o| *o != name);
    if old.is_some() && expected.is_some() { return Err(format!("MACRO_LIBRARY_NAME_EXISTS:{name}")); }
    // A response might have been lost after an already-completed operation.
    if lib.get(&name) == Some(&mac) && old.as_ref().is_none_or(|o| !lib.contains_key(o)) { return Ok(()); }
    if lib.get(&name) != expected.as_ref() { return Err(format!("MACRO_LIBRARY_CONFLICT:{name}")); }
    if let Some(old) = old {
        if lib.get(&old) != expected_old.as_ref() { return Err(format!("MACRO_LIBRARY_CONFLICT:{old}")); }
        lib.remove(&old);
    }
    lib.insert(name, mac);
    save(profiles_dir, &lib)
}

/// Remove a name only if it still holds the value the editor observed.
pub fn remove_if_unchanged(profiles_dir: &Path, name: &str, expected: Option<MacroDto>) -> Result<(), String> {
    let mut lib = load(profiles_dir)?;
    if !lib.contains_key(name) { return Ok(()); } // idempotent retry
    if lib.get(name) != expected.as_ref() { return Err(format!("MACRO_LIBRARY_CONFLICT:{name}")); }
    lib.remove(name);
    save(profiles_dir, &lib)
}

/// Seed only when the inputs can actually be read, so that an incomplete
/// seed is not mistaken for the complete shared library.
fn seed(profiles_dir: &Path) -> Result<Library, String> {
    let mut lib = Library::new();
    let entries = fs::read_dir(profiles_dir).map_err(|e| format!("{} : {e}", profiles_dir.display()))?;
    for e in entries {
        let p = e.map_err(|e| format!("{} : {e}", profiles_dir.display()))?.path();
        if !p.extension().is_some_and(|x| x.eq_ignore_ascii_case("toml")) { continue; }
        let text = fs::read_to_string(&p).map_err(|e| format!("{} : {e}", p.display()))?;
        let dto = toml::from_str::<FileDto>(&text).map_err(|e| format!("{} : {e}", p.display()))?;
        for (name, m) in dto.macros { lib.entry(name).or_insert(m); }
    }
    let mouse = profiles_dir.parent().ok_or("aucun dossier de configuration")?.join("mouse-profiles.json");
    match fs::read_to_string(&mouse) {
        Ok(text) => {
            let v = serde_json::from_str::<serde_json::Value>(text.trim_start_matches('\u{feff}'))
                .map_err(|e| format!("{} : {e}", mouse.display()))?;
            for prof in v["profiles"].as_array().into_iter().flatten() {
                let Some(macros) = prof["settings"]["macros"].as_object() else { continue };
                for (name, m) in macros {
                    let m = serde_json::from_value::<MacroDto>(m.clone())
                        .map_err(|e| format!("{} : macro {name:?} : {e}", mouse.display()))?;
                    lib.entry(name.clone()).or_insert(m);
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{} : {e}", mouse.display())),
    }
    Ok(lib)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_file_creation_does_not_truncate_a_racing_creator() {
        let root = std::env::temp_dir().join(format!("g13-lib-create-new-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let p = root.join("macros.json");
        fs::write(&p, b"created by another writer").unwrap();
        assert!(save_new(&p, &Library::new()).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"created by another writer");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn seeded_from_the_profiles_then_saved() {
        let root = std::env::temp_dir().join(format!("g13-lib-{}", std::process::id()));
        let dir = root.join("profiles");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.toml"), "name = \"A\"\n[macros.spam]\nsteps = [\"down A\", \"wait 30\", \"up A\"]\n").unwrap();
        fs::write(
            root.join("mouse-profiles.json"),
            r#"{"profiles":[{"name":"","settings":{"macros":{"reload":{"mode":"once","steps":["down R","up R"]}}}}]}"#,
        )
        .unwrap();
        let lib = load(&dir).unwrap();
        assert_eq!(lib.keys().collect::<Vec<_>>(), ["reload", "spam"]);
        assert!(root.join("macros.json").exists());
        // once saved, the file is what counts
        save(&dir, &Library::new()).unwrap();
        assert!(load(&dir).unwrap().is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
