# Experimental profile-edit protection

This change is a proposed prerequisite for bank-specific G13 stick edits; it
contains no stick-to-mouse implementation. Its goal is to make common GUI edit
and close paths more conservative, not to guarantee lossless operation.

## Scope

- Each G13 editor retains debounced profile drafts and serializes its writes.
  The GUI keeps a base value and session token, and under its own lock attempts
  to combine non-conflicting changes by the main window and overlay. Conflicts
  are reported and the unsaved local draft is kept in memory for retry, copying
  or explicit discard. External processes do not participate in this lock.
- A close coordinator asks registered, ready windows to flush their profile
  and macro-library queues. A failed flush, certain open dialogs, an active
  recording, a known dirty G502 mouse draft or an in-progress G502 save vetoes
  the modeled close. The user must save or revert that mouse draft explicitly;
  the guard does not pretend to save it. The overlay page's close request also
  waits for the profile and macro queues first.
- Macro-library operations are queued, and expected values are checked under
  the GUI lock. Conflicting same-name changes are refused; unobserved values
  are handled conservatively. Read errors are not silently treated as an empty
  library. Backup creation also reports several read and unsafe-path errors.
- Application-association and import checks refuse certain rule conflicts
  instead of silently taking ownership. Configuration replacement is blocked
  with an overlay open. These checks do not provide an ownership-transfer UI.

## Important limits

This is experimental. The close protocol has state-machine and modeled jsdom
coverage, not a native Tauri/WebView2 or Windows 11 close/quit test. Forced
window destruction, a crash, system shutdown, a broken IPC or missing device
response are not safely handled in every case. Drafts held only in memory may
be lost. The G502 check is limited to known drafts at the close boundary: device
status updates, restore paths and other devices are not comprehensively
coordinated. Backups do not capture every window's unsaved changes.

The GUI mutex and session tokens do not protect against external writers, and
identical delete/recreate or value A→B→A sequences are not generally detected.
File checks can race external changes. Library writes and multi-file restore
are not crash-atomic; a failed creation can leave an incomplete new file. On
Linux, process-name and app-id matches may overlap even when the rule checker
considers names distinct. Invalid or missing profile content can still affect
whether a backup is restorable. None of these checks replaces separate backups.

## Tests

`tests/gui-regressions` runs the actual page scripts in jsdom with modeled
backends, windows and device state. Rust unit tests in `close_guard`, the
profile modules and the GUI test modules exercise synthetic files; on a system
with the GUI build dependencies installed they can be run with
`cargo test --locked -p g13-gui`. One known Linux matching-gap demonstration is
ignored by default. None starts G Nexus or a device, tests native IPC or proves
full LGS compatibility. Before considering use with real profiles or hardware,
native end-to-end testing and review of the above limitations are needed.
