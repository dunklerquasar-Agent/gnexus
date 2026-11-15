// Apply a local snapshot's changes to the latest acknowledged profile.
// Matches the Rust profile_delta module: object keys merge recursively; arrays
// and scalars are atomic; an absent key is different from JSON null. A
// conflicting same-path edit must be blocked before this function is used.
"use strict";

function profileValueEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== b.length) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Object.hasOwn(b, k) && profileValueEqual(a[k], b[k]));
}

function applyProfileDelta(base, edited, current) {
  if (profileValueEqual(base, edited)) return structuredClone(current);
  if (edited === undefined) return undefined;
  const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (record(edited) && (base === undefined || record(base)) && (current === undefined || record(current))) {
    const out = current === undefined ? {} : structuredClone(current);
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(edited)]);
    for (const key of keys) {
      const value = applyProfileDelta(base?.[key], edited[key], current?.[key]);
      if (value === undefined) delete out[key];
      else Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    }
    return out;
  }
  return structuredClone(edited);
}

// The same conflict policy as the Rust backend. A locally changed object
// cannot be rebased over a remote deletion of its parent.
function profileDeltaConflicts(base, edited, current) {
  if (profileValueEqual(base, edited) || profileValueEqual(base, current) || profileValueEqual(edited, current)) return false;
  const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!record(edited) || !record(current) || !(base === undefined || record(base))) return true;
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(edited)]);
  return [...keys].some((k) => profileDeltaConflicts(base?.[k], edited[k], current[k]));
}

// After one save succeeds, keep the old ancestor for paths changed in the
// meantime, while advancing untouched paths to the returned merged value.
// Called only after profileDeltaConflicts() has ruled out incompatible edits.
function rebaseProfileAncestor(sent, local, merged) {
  if (profileValueEqual(sent, local)) return structuredClone(merged);
  // No remote change: preserve an absent ancestor as absent, not as {}.
  if (profileValueEqual(sent, merged)) return structuredClone(sent);
  const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (record(local) && (sent === undefined || record(sent)) && (merged === undefined || record(merged))) {
    const out = merged === undefined ? {} : structuredClone(merged);
    const keys = new Set([...Object.keys(sent || {}), ...Object.keys(local)]);
    for (const key of keys) {
      const value = rebaseProfileAncestor(sent?.[key], local[key], merged?.[key]);
      if (value === undefined) delete out[key];
      else Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    }
    return out;
  }
  return structuredClone(sent);
}

// Allows the same implementation to be unit-tested under Node without a DOM.
if (typeof module !== "undefined") module.exports = { profileValueEqual, applyProfileDelta, profileDeltaConflicts, rebaseProfileAncestor };
