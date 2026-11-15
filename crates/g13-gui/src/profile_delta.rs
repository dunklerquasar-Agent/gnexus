//! Apply only fields that changed between a GUI's base and edited snapshot.
//!
//! The main window and overlay can edit a profile independently. Both send
//! their own base and desired values; applying the delta to the latest file
//! preserves unrelated changes. Arrays and scalar values are atomic conflict
//! units. A caller must reject `conflicts` before applying the delta and must
//! serialize file operations and validate the merged result.

use std::collections::BTreeSet;

use serde_json::Value;

/// Apply `base -> edited` to `current`. `None` means an absent object key,
/// which is distinct from an explicit JSON null.
pub fn apply(base: Option<&Value>, edited: Option<&Value>, current: Option<&Value>) -> Option<Value> {
    if base == edited {
        return current.cloned();
    }
    let edited = edited?; // an explicit deletion
    let edited_object = edited.as_object();
    let base_object = base.and_then(Value::as_object);
    let current_object = current.and_then(Value::as_object);
    if let Some(changes) = edited_object
        && (base.is_none() || base_object.is_some())
        && (current.is_none() || current_object.is_some())
    {
        let mut out = current_object.cloned().unwrap_or_default();
        let keys: BTreeSet<_> = base_object.into_iter().flat_map(|m| m.keys()).chain(changes.keys()).collect();
        for key in keys {
            match apply(base_object.and_then(|m| m.get(key)), changes.get(key), current_object.and_then(|m| m.get(key))) {
                Some(value) => { out.insert(key.clone(), value); }
                None => { out.remove(key); }
            }
        }
        return Some(Value::Object(out));
    }
    Some(edited.clone())
}

/// Detect incompatible simultaneous edits without writing anything. Absent
/// keys differ from JSON null; objects merge recursively, arrays and scalars
/// are whole values. A remote deletion of an edited parent is a conflict.
pub fn conflicts(base: Option<&Value>, edited: Option<&Value>, current: Option<&Value>) -> bool {
    if base == edited || base == current || edited == current {
        return false;
    }
    let (changes, latest) = match (edited.and_then(Value::as_object), current.and_then(Value::as_object)) {
        (Some(changes), Some(latest)) => (changes, latest),
        _ => return true,
    };
    let ancestor = match base {
        None => None,
        Some(Value::Object(map)) => Some(map),
        _ => return true,
    };
    let keys: BTreeSet<_> = ancestor.into_iter().flat_map(|m| m.keys()).chain(changes.keys()).collect();
    keys.into_iter().any(|key| conflicts(ancestor.and_then(|m| m.get(key)), changes.get(key), latest.get(key)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn merge(base: Value, edited: Value, current: Value) -> Value {
        apply(Some(&base), Some(&edited), Some(&current)).unwrap()
    }

    #[test]
    fn separate_banks_and_other_fields_survive_simultaneous_edits() {
        let base = json!({"name":"test", "banks":{"M1":{}}, "rules":[]});
        let main = json!({"name":"test", "banks":{"M1":{},"M2":{"G2":"W"}}, "rules":[]});
        let overlay = json!({"name":"test", "banks":{"M1":{"G1":"Q"}}, "rules":[{"exe":"game.exe"}]});
        assert_eq!(merge(base, main, overlay), json!({"name":"test", "banks":{"M1":{"G1":"Q"},"M2":{"G2":"W"}}, "rules":[{"exe":"game.exe"}]}));
    }

    #[test]
    fn missing_null_deletions_and_same_field_conflicts_are_explicit() {
        let base = json!({"x": 1, "y": null, "obj":{"one": 1, "two": 2}, "list":[1,2]});
        let edited = json!({"x": 2, "obj":{"two": 2}, "list":[3]});
        let current = json!({"x": 9, "y": 7, "obj":{"one": 1, "two": 4, "three": 5}, "list":[1,4]});
        assert_eq!(merge(base, edited, current), json!({"x":2, "obj":{"two":4, "three":5}, "list":[3]}));
    }

    #[test]
    fn unchanged_fields_do_not_resurrect_a_removed_value() {
        assert_eq!(merge(json!({"x":1,"y":2}), json!({"x":1,"y":3}), json!({"y":2})), json!({"y":3}));
    }

    #[test]
    fn conflicts_are_detected_per_path_and_not_for_identical_changes() {
        let cases = [
            (json!({"a":1,"b":1}), json!({"a":2,"b":1}), json!({"a":1,"b":2}), false),
            (json!({"a":1}), json!({"a":2}), json!({"a":3}), true),
            (json!({"a":1}), json!({"a":2}), json!({"a":2}), false),
            (json!({"a":[1]}), json!({"a":[2]}), json!({"a":[3]}), true),
            (json!({}), json!({"a":{"x":1}}), json!({"a":{"y":2}}), false),
            (json!({"a":{"x":1}}), json!({"a":{"x":1,"y":2}}), json!({}), true),
            (json!({"a":null}), json!({}), json!({"a":1}), true),
            (json!({}), json!({"a":null}), json!({"a":1}), true),
            (json!({"a":{"x":1,"y":1}}), json!({"a":{"x":2,"y":1}}), json!({"a":{"x":1,"y":2}}), false),
        ];
        for (base, edited, current, expected) in cases {
            assert_eq!(conflicts(Some(&base), Some(&edited), Some(&current)), expected,
                "base={base}, edited={edited}, current={current}");
        }
    }
}
