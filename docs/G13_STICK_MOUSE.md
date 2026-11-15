# Experimental G13 stick-to-mouse mode

This branch adds a third G13 stick mode: **keyboard**, **gamepad**, or **mouse**. In mouse mode the stick produces continuous relative pointer movement while held, using the existing operating-system mouse injector. It does not require the virtual gamepad driver. The code has automated tests, but has not been exercised on a real G13 under Windows 11. It is not an official G Nexus release.

## Configuration

Choose M1, M2 or M3 in the G13 view, then choose that bank's stick mode with the icons under **Stick mode**. For example, a profile can use keyboard directions on M1, mouse on M2 and the virtual Xbox 360 stick on M3. Logitech also documents configuring the thumbstick per M-key, but the behavior here has not yet been compared with LGS on hardware.

The dead zone and the gamepad's left/right target are shared by the three banks of a profile. Switching one bank's mode does not silently change the dead zone of the other banks. The mouse slider is **global** for the G Nexus application: it is 10–200% of this implementation's own default, with 100% as reset. It is stored with the G Nexus preferences, not in new profiles, and does not change Windows mouse settings or a separate physical mouse. A whole-configuration G Nexus backup includes the preference. The 100% value is not a claim of matching LGS's default.

Older experimental profiles containing an explicit `[stick] mouse_speed` retain that per-profile override, including an explicit 100%. The control then says **profile speed** rather than global speed; choose its ↺ button to remove the override and use the global speed. This is deliberate: opening an old test profile must not silently change its speed. Older profiles without the field use the global value. The headless `g13d` uses 100% unless started with `--stick-mouse-speed 10..200`; an explicit legacy profile override takes precedence there too. The standalone option is not stored as a preference.

A hand-written G Nexus profile can contain, for example:

```toml
name = "Pointer test"

[stick]
mode = "keys"               # fallback for banks without an override
deadzone = 35               # shared across the profile's banks

[stick.bank_modes]
M2 = "mouse"
M3 = "gamepad"

[banks.M1]
STICK_UP = "W"

[banks.M2]
G23 = { mouse = "Left" }
G24 = { mouse = "Right" }
```

Existing G-key assignments are **not** replaced automatically. Assign left/right/middle mouse buttons to whichever G13 keys you prefer; holding a button while moving the stick permits dragging. The default overlay key may reserve G25 (stick click), so change or disable the overlay key in Settings before using G25 as a mouse button. Direction bindings remain in the profile but do not fire while their bank is in mouse or gamepad mode.

Existing profiles with just `[stick] mode = ...` continue to use that same mode in all three banks. The GUI changes only the selected bank's mode, leaving the shared mode as the fallback for other banks. Unknown bank names and modes are rejected. Older G Nexus versions do not know `mouse`, `bank_modes` or the experimental `mouse_speed` field and can reject profiles that contain them: back up profiles before testing or downgrading.

## Safe activation and calibration

- After connection, profile reload, or a bank transition **into** mouse mode, the stick must first visit its calibrated dead zone before mouse movement starts. Release the stick before trying it. Mouse-to-mouse bank changes remain continuous. On disconnect or shutdown movement stops; reconnection waits for a new sample and a neutral position.
- On a bank transition **out of keyboard mode**, held stick-direction actions are released and pending stick-direction tap dances / macros are cancelled without firing a tap. Separately held G-key actions remain held until their physical release, as in existing bank changes. Entering keyboard or gamepad mode uses the current stick position immediately, following the existing profile-switch behavior: do not switch with the stick deflected if an immediate key or gamepad action would be unsafe.
- The mouse has an independent centre calibration so a centre learned while a different stick mode was active cannot silently become its centre. Travel and rest-position logic reuse the gamepad calibration algorithm. While mouse mode is active, a still, near-middle position is re-learned only when it is **already inside** the mouse dead zone. A position outside it is never treated as the centre, including before activation and after an injection failure. An off-centre position inside the dead zone can still be learned as rest.
- With an off-centre resting stick and a very small dead zone, the mouse may stay disarmed rather than move. Increase the dead zone temporarily, release the stick for at least 1.5 seconds, and then reduce the dead zone if desired. The initial profile default is 35%.
- The latest raw position is tracked even for movements below the existing three-unit keyboard/gamepad hysteresis. This is necessary to stop accurately when the stick crosses the dead-zone edge. Keyboard/gamepad edge filtering remains unchanged. All edges derived from one HID report are delivered as a batch, so a tick cannot arm mouse mode from the preceding report between a bank-key edge and a simultaneous stick movement. Disconnect releases and the disconnect notification are batched as well.
- Relative movement is integrated from elapsed time at the engine's approximately 10 ms cadence. Fractions of a count are carried forward; they are discarded on stop or reversal. An individual tick uses at most 50 ms of elapsed time to avoid a large catch-up jump after a short stall. If the engine's clock reports a gap over 500 ms, it discards the last mouse-stick sample even in another stick mode and pauses movement. A new sample in the dead zone is required: if necessary, move and release the stick once. This has deterministic tests but does not prove that every Windows sleep or HID stall is detected; test sleep/resume on real hardware. Full deflection at 100% corresponds to a nominal 800 relative counts per second; actual screen distance depends on OS settings and application handling.
- If mouse injection reports an error, the mode is suspended and the GUI displays the error. Reconnecting the G13 or reloading/switching the profile permits another attempt, again requiring neutral.

## Saving and concurrent windows

This part builds on the separate [profile-edit protection](PROFILE_EDIT_SAFETY.md) prerequisite.

Profile edits are debounced and serialized per window and profile. Under the GUI's application lock, unrelated edits from the main window and overlay can be combined; incompatible changes to the same scalar or array are refused and the local draft is retained in memory for review, retry or explicit discard. The global speed is a separate queued preference. Notifications cause a fresh settings read rather than trusting potentially delayed event payloads; a local pending or failed speed write remains visible until it succeeds. The synthetic two-window tests do not establish actual Tauri IPC or WebView2 behavior.

The experimental close handshake asks ready windows to flush the G13 profile, global speed, and macro-library queues on supported native close/quit routes, and can veto a close if a flush fails. It also refuses close while a known G502 mouse-profile draft is dirty or its save is in progress; the user must save or explicitly revert it. This guard is not a complete G502 draft-safety solution: for example, a separate device-status update or restore path can still affect that draft. Other devices and operations are not comprehensively covered. The handshake has only state-machine and modeled-frontend coverage; native Windows and real close events have **not** been validated. Forced destruction, crashes and system shutdown can still lose drafts; a broken IPC or missing device response can leave a close pending. Do not use this experiment with real profiles or an attached G13.

The rule/import protection in this stack deliberately blocks new conflicting application associations and LGS imports instead of silently taking ownership. It does not offer a transfer confirmation; under Linux the existing `app_id`/process-name matching can still overlap. Restore/reset is blocked while the overlay is open, but other pending work, external writers, crash atomicity and backups are not comprehensively coordinated. Session tokens and the GUI lock do not protect against external processes. Scheduled backups capture files on disk, not all windows' unsaved drafts.

## Logitech Gaming Software compatibility

Logitech's [G13 documentation](https://support.logi.com/hc/en-sg/articles/360023249154-Configuring-the-mini-joystick-thumbstick-on-the-G13-Advanced-Gameboard) describes modes per M-key and a global cursor-speed slider. This prototype now models those scopes; its movement curve, feel, acceleration, speed, edge cases, and interaction with Windows have **not** been compared with LGS and must not be described as identical.

The LGS XML importer does not yet recognize an LGS stick-mouse configuration. The exporter warns if any effective bank uses mouse or gamepad mode, if a legacy profile speed would be lost, or if a non-default dead zone or gamepad target will not be exported. Stored direction bindings may become active in the exported profile. There is no verified XML representation for the stick modes here, so none is invented. Other known XML export losses also remain. An XML export is **not** a complete G Nexus backup. Do not run LGS and G Nexus as simultaneous controllers of the G13; keep LGS installed and back up profiles first.

## Platform and validation notes

Windows uses the existing `SendInput` relative mouse path; Linux uses the existing uinput `REL_X` / `REL_Y` path. Windows integrity-level restrictions or applications with special input handling may affect injection. A browser mock is neither a Tauri nor a hardware test.

In this patch series, `--dry-run` suppresses engine input injection, but the existing LCD media applet can still send real media commands. The application can also open the G13 and change its display, LEDs or lighting. **This is not a hardware-isolated or media-safe simulation.** A separate experimental LCD media dry-run fix exists but is not included here.

Useful checks from the repository root:

```sh
cargo test -p g13-core -p g13-daemon --lib
cargo clippy -p g13-core -p g13-daemon -p g13-gui --all-targets -- -D warnings
cargo check -p g13-core -p g13-daemon -p g13-gui --target x86_64-pc-windows-gnu
```

Before shipping, test on Windows 11 with an actual G13 and compare directly against LGS: neutral drift, all directions, slow and fast motion, diagonals, clicking/dragging, M1/M2/M3 transitions while neutral and held, global speed across profiles, profile reload, disconnect/reconnect, and behavior after sleep or load stalls. Check both LGS-imported and native profiles and preserve a conventional mouse as a fallback.
