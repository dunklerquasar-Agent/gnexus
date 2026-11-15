//! Profile files as seen by the GUI: list / load / save / create / delete.
//! The JSON model is `g13_daemon::profiles::FileDto` (same structure as the
//! TOML file); every save is validated with the daemon's own `from_dto`.
//! The engine picks changes up through its hot reload.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use g13_core::G13Key;
use g13_daemon::profiles::{FileDto, MatchRule, dto_to_toml, from_dto};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ProfileSummary {
    pub id: String,
    /// Stable position in the list (the number shown on the profile button).
    pub number: u32,
    pub name: String,
    pub default: bool,
    /// Executable names / titles the profile is bound to.
    pub apps: Vec<String>,
    /// Set when the file cannot be read or is invalid.
    pub error: Option<String>,
}

/// Ids are file stems; only allow safe characters (no path traversal).
fn file(dir: &Path, id: &str) -> Result<PathBuf, String> {
    let ok = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok { Ok(dir.join(format!("{id}.toml"))) } else { Err(format!("identifiant de profil invalide : {id:?}")) }
}

fn ids(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("toml")))
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(str::to_string))
        .collect();
    v.sort();
    v
}

/// All profiles, ordered by number. Valid profiles without a number get the
/// next free ones (written to their file once), so the list order is stable.
pub fn list(dir: &Path) -> Vec<ProfileSummary> {
    let loaded: Vec<(String, Result<FileDto, String>)> = ids(dir)
        .into_iter()
        .map(|id| {
            let r = load(dir, &id).and_then(|dto| from_dto(dto.clone()).map(|_| dto).map_err(|e| e.0));
            (id, r)
        })
        .collect();
    let mut next = loaded.iter().filter_map(|(_, r)| r.as_ref().ok()?.number).max().unwrap_or(0) + 1;
    let mut out: Vec<ProfileSummary> = loaded
        .into_iter()
        .map(|(id, r)| match r {
            Ok(mut dto) => {
                if dto.number.is_none() {
                    dto.number = Some(next);
                    next += 1;
                    if let Err(e) = write(dir, &id, &dto) {
                        log::warn!("cannot number profile '{id}': {e}");
                    }
                }
                ProfileSummary {
                    number: dto.number.unwrap_or(u32::MAX),
                    name: dto.name,
                    default: dto.default,
                    apps: dto.rules.iter().filter_map(|r| r.exe.clone().or_else(|| r.title.clone())).collect(),
                    error: None,
                    id,
                }
            }
            Err(e) => ProfileSummary { number: u32::MAX, name: id.clone(), id, default: false, apps: vec![], error: Some(e) },
        })
        .collect();
    out.sort_by(|a, b| a.number.cmp(&b.number).then_with(|| a.id.cmp(&b.id)));
    out
}

pub fn load(dir: &Path, id: &str) -> Result<FileDto, String> {
    let text = fs::read_to_string(file(dir, id)?).map_err(|e| e.to_string())?;
    toml::from_str(&text).map_err(|e| e.to_string())
}

fn write(dir: &Path, id: &str, dto: &FileDto) -> Result<(), String> {
    let text = dto_to_toml(dto).map_err(|e| e.0)?;
    fs::write(file(dir, id)?, text).map_err(|e| e.to_string())
}

/// Create only; never truncate a path another process created after our scan.
/// An I/O failure can still leave a partially written new file.
fn write_new(dir: &Path, id: &str, dto: &FileDto) -> Result<(), String> {
    let text = dto_to_toml(dto).map_err(|e| e.0)?;
    let path = file(dir, id)?;
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&path)
        .map_err(|e| format!("impossible de créer {} sans écraser : {e}", path.display()))?;
    f.write_all(text.as_bytes()).map_err(|e| format!("PROFILE_CREATE_PARTIAL:{id}: {}: {e}", path.display()))
}

/// Match the engine's ASCII case-insensitive, optional .exe suffix semantics.
fn same_executable(a: &str, b: &str) -> bool {
    fn strip_exe(name: &str) -> &str {
        match name.len().checked_sub(4) {
            Some(i) if name.is_char_boundary(i) && name[i..].eq_ignore_ascii_case(".exe") => &name[..i],
            _ => name,
        }
    }
    strip_exe(a).eq_ignore_ascii_case(strip_exe(b))
}

/// Distinct title substrings may occur in one title. A title-only rule may
/// overlap any executable. Distinct EXE names are treated as disjoint, as in
/// the Windows watcher (which has no app_id). On Linux the engine can also
/// match a different app_id; this deliberately remains an identified gap.
fn could_overlap(a: &MatchRule, b: &MatchRule) -> bool {
    if (a.exe.is_none() && a.title.is_none()) || (b.exe.is_none() && b.title.is_none()) { return false; }
    match (a.exe.as_deref(), b.exe.as_deref()) {
        (Some(x), Some(y)) => same_executable(x, y),
        _ => true,
    }
}

/// Unlike the display list, ownership checks fail closed on unreadable,
/// unsupported or symlinked profile entries; otherwise an owner could be missed.
fn checked_assignment_ids(dir: &Path) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("dossier de profils illisible : {e}"))?;
    let mut found = Vec::new();
    for entry in entries {
        let path = entry.map_err(|e| format!("entrée de profil illisible : {e}"))?.path();
        if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("toml")) { continue; }
        let stem = path.file_stem().and_then(|s| s.to_str()).ok_or("nom de fichier de profil non valide")?.to_string();
        let expected_path = file(dir, &stem)?;
        let kind = fs::symlink_metadata(&path).map_err(|e| format!("profil {stem} illisible : {e}"))?.file_type();
        if !kind.is_file() || (cfg!(not(windows)) && path != expected_path) {
            return Err(format!("fichier de profil non pris en charge : {}", path.display()));
        }
        found.push(stem);
    }
    found.sort();
    Ok(found)
}

/// Refuse newly introduced overlaps, but leave pre-existing overlaps and
/// unrelated edits alone. This conservative first version offers no override;
/// external writers are outside the GUI mutex and can still race this check.
pub fn check_new_rule_claims(dir: &Path, exclude: Option<&str>, added: &[MatchRule]) -> Result<(), String> {
    if added.is_empty() { return Ok(()); }
    let ids = checked_assignment_ids(dir).map_err(|e| format!("RULE_OWNERS_UNAVAILABLE: {e}"))?;
    for other in ids {
        if exclude == Some(other.as_str()) { continue; }
        let dto = load(dir, &other).map_err(|e| format!("RULE_OWNERS_UNAVAILABLE: {other}: {e}"))?;
        from_dto(dto.clone()).map_err(|e| format!("RULE_OWNERS_UNAVAILABLE: {other}: {}", e.0))?;
        if added.iter().any(|draft| dto.rules.iter().any(|r| could_overlap(draft, r))) {
            return Err(format!("RULE_OWNER_CONFLICT:{other}"));
        }
    }
    Ok(())
}

/// Validate and write. Marking a profile as default clears the flag elsewhere.
pub fn save(dir: &Path, id: &str, dto: &FileDto) -> Result<(), String> {
    from_dto(dto.clone()).map_err(|e| e.0)?;
    // Keys assigned in any order in the UI are written G1 → G25.
    let mut dto = dto.clone();
    for bank in [&mut dto.banks.m1, &mut dto.banks.m2, &mut dto.banks.m3] {
        let order = |k: &String| G13Key::from_id(k).map_or(u8::MAX, G13Key::bit_index);
        bank.keys.sort_by(|a, _, b, _| order(a).cmp(&order(b)));
    }
    let dto = &dto;
    if dto.default {
        for other in ids(dir).into_iter().filter(|o| o != id) {
            if let Ok(mut o) = load(dir, &other)
                && o.default
            {
                o.default = false;
                write(dir, &other, &o)?;
            }
        }
    }
    write(dir, id, dto)
}

/// New profile named `name`, empty or copied from `from` (without its
/// application rules, so two profiles don't claim the same app). Returns its id.
pub fn create(dir: &Path, name: &str, from: Option<&str>) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("le nom ne peut pas être vide".into());
    }
    let mut dto = match from {
        Some(src) => load(dir, src)?,
        None => FileDto::default(),
    };
    dto.name = name.to_string();
    dto.rules.clear();
    create_from(dir, dto)
}

/// Write `dto` as a new profile (next number, never the default, unique id
/// derived from its name). Returns the id.
pub fn create_from(dir: &Path, mut dto: FileDto) -> Result<String, String> {
    from_dto(dto.clone()).map_err(|e| e.0)?;
    // Check before any write or automatic numbering: on conflict the selected
    // LGS file and every existing profile remain untouched.
    check_new_rule_claims(dir, None, &dto.rules)?;
    dto.default = false;
    let max_number = ids(dir).into_iter().filter_map(|id| load(dir, &id).ok()?.number).max().unwrap_or(0);
    dto.number = Some(max_number.checked_add(1).ok_or("numéro de profil épuisé")?);

    let base: String = dto
        .name
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'a'..='z' | '0'..='9' => c,
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            _ => '-',
        })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let base = if base.is_empty() { "profil".to_string() } else { base };
    let existing = ids(dir);
    let id = (1..)
        .map(|n| if n == 1 { base.clone() } else { format!("{base}-{n}") })
        .find(|c| !existing.iter().any(|old| old.eq_ignore_ascii_case(c)))
        .expect("unbounded range");
    write_new(dir, &id, &dto)?;
    Ok(id)
}

/// Associate a simple executable with this profile without deleting or
/// widening any other rule. Overlaps require manual resolution; no automatic
/// cross-file move or unreviewed EXE+title change occurs.
pub fn assign_app(dir: &Path, id: &str, exe: &str) -> Result<(), String> {
    let exe = exe.trim();
    if exe.is_empty() { return Err("aucune application".into()); }
    let mut target = load(dir, id).map_err(|e| format!("profil cible {id} illisible : {e}"))?;
    from_dto(target.clone()).map_err(|e| format!("profil cible {id} invalide : {}", e.0))?;
    let same = |r: &MatchRule| r.exe.as_deref().is_some_and(|s| same_executable(s, exe));
    if target.rules.iter().any(|r| same(r) && r.title.is_some()) {
        return Err(format!("COMBINED_RULE_CONFLICT:{id}"));
    }
    let desired = MatchRule::exe(exe);
    check_new_rule_claims(dir, Some(id), std::slice::from_ref(&desired))?;
    if target.rules.iter().any(same) { return Ok(()); }
    target.rules.push(desired);
    from_dto(target.clone()).map_err(|e| format!("profil cible {id} invalide : {}", e.0))?;
    // Do not touch any unrelated profile or default flag.
    write(dir, id, &target)
}

pub fn delete(dir: &Path, id: &str) -> Result<(), String> {
    if ids(dir).len() <= 1 {
        return Err("impossible de supprimer le dernier profil".into());
    }
    fs::remove_file(file(dir, id)?).map_err(|e| e.to_string())
}
