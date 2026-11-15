//! Integration tests with deterministic time and no real input injection.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

use g13_core::{G13InputReport, G13Key, StickPosition};

use super::action::{Action, Macro, MacroMode, MacroStep, TapDance};
use super::bindings::{Input, MBank, Profile, StickDir, StickMode};
use super::{Engine, UiEvent};
use crate::device::DeviceEvent;
use crate::device::tracker::InputTracker;
use crate::keycode::{KeyCode, MouseButton};
use crate::platform::mock::{Injected, RecordingInjector};
use crate::platform::{InputInjector, PlatformError, PlatformResult};

fn mouse_profile() -> Profile {
    let mut p = Profile::default();
    p.stick.mode = StickMode::Mouse;
    p.stick.deadzone = 0.15;
    p
}

fn rig(p: Profile) -> (Engine, Arc<RecordingInjector>) {
    let (tx, _rx) = channel();
    let inj = Arc::new(RecordingInjector::new());
    (Engine::new(inj.clone(), tx, p), inj)
}

fn pos(e: &mut Engine, time: Instant, x: u8, y: u8) {
    e.handle_at(
        DeviceEvent::Stick(StickPosition { raw_x: x, raw_y: y }),
        time,
    );
}

fn report(x: u8, y: u8) -> G13InputReport {
    G13InputReport::from_bytes(&[1, x, y, 0, 0, 0x80, 0, 0x80]).unwrap()
}

fn feed(tracker: &mut InputTracker, e: &mut Engine, time: Instant, x: u8, y: u8) {
    tracker.update(&report(x, y), |ev| e.handle_at(ev, time));
}

#[test]
fn mouse_continues_without_further_reports_and_stops_at_rest() {
    let (mut e, inj) = rig(mouse_profile());
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    pos(&mut e, t + Duration::from_millis(10), 208, 128);
    for i in 1..=10 {
        e.tick_at(t + Duration::from_millis(10 * i));
    }
    let events = inj.take();
    assert_eq!(
        events.len(),
        10,
        "the held stick must keep moving: {events:?}"
    );
    assert!(events.iter().all(|ev| *ev == Injected::Move(8, 0)));
    pos(&mut e, t + Duration::from_millis(110), 128, 128);
    for i in 11..=50 {
        e.tick_at(t + Duration::from_millis(10 * i));
    }
    assert!(inj.take().is_empty(), "rest must stop movement immediately");
}

#[test]
fn long_clock_gap_discards_stale_position_and_requires_a_new_neutral_sample() {
    let (mut e, inj) = rig(mouse_profile());
    let ui = e.subscribe();
    let mut tracker = InputTracker::new(3);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    feed(&mut tracker, &mut e, t, 128, 128);
    e.tick_at(t);
    feed(&mut tracker, &mut e, t + Duration::from_millis(10), 208, 128);
    e.tick_at(t + Duration::from_millis(10));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)]);

    // A queued sample just before the first tick could itself be stale.
    feed(&mut tracker, &mut e, t + Duration::from_millis(800), 207, 128);
    e.tick_at(t + Duration::from_millis(800));
    for i in 81..=100 {
        e.tick_at(t + Duration::from_millis(i * 10));
    }
    assert!(inj.take().is_empty(), "never continue with the old deflection");
    assert!(e.mouse_stick.is_none());
    assert_eq!(ui.try_iter().filter(|ev| *ev == UiEvent::StickMousePaused).count(), 1);

    // Repeating an identical report is filtered and cannot arm the mouse.
    feed(&mut tracker, &mut e, t + Duration::from_millis(1010), 207, 128);
    e.tick_at(t + Duration::from_millis(1010));
    assert!(!e.stick_mouse.armed());
    // A fresh off-centre report must not arm it either.
    feed(&mut tracker, &mut e, t + Duration::from_millis(1020), 205, 128);
    e.tick_at(t + Duration::from_millis(1020));
    assert!(!e.stick_mouse.armed());
    feed(&mut tracker, &mut e, t + Duration::from_millis(1030), 128, 128);
    e.tick_at(t + Duration::from_millis(1030));
    assert!(e.stick_mouse.armed());
    assert!(inj.take().is_empty());
    feed(&mut tracker, &mut e, t + Duration::from_millis(1040), 208, 128);
    e.tick_at(t + Duration::from_millis(1040));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)]);
}

#[test]
fn gap_in_keyboard_mode_cannot_supply_a_stale_neutral_to_mouse_mode() {
    let mut p = Profile::default();
    p.stick.bank_modes[MBank::M2.index()] = Some(StickMode::Mouse);
    let (mut e, inj) = rig(p);
    let mut tracker = InputTracker::new(3);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    feed(&mut tracker, &mut e, t, 128, 128);
    e.tick_at(t);
    e.tick_at(t + Duration::from_millis(700));
    e.handle_at(DeviceEvent::Key { key: G13Key::M2, pressed: true }, t + Duration::from_millis(710));
    e.tick_at(t + Duration::from_millis(710));
    assert!(!e.stick_mouse.armed());
    feed(&mut tracker, &mut e, t + Duration::from_millis(720), 208, 128);
    e.tick_at(t + Duration::from_millis(720));
    e.tick_at(t + Duration::from_millis(730));
    assert!(inj.take().is_empty());
    feed(&mut tracker, &mut e, t + Duration::from_millis(740), 128, 128);
    e.tick_at(t + Duration::from_millis(740));
    feed(&mut tracker, &mut e, t + Duration::from_millis(750), 208, 128);
    e.tick_at(t + Duration::from_millis(750));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)]);
}

#[test]
fn short_stall_is_bounded_without_needlessly_disarming() {
    let (mut e, inj) = rig(mouse_profile());
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    pos(&mut e, t + Duration::from_millis(10), 208, 128);
    e.tick_at(t + Duration::from_millis(10));
    inj.take();
    e.tick_at(t + Duration::from_millis(210));
    assert_eq!(inj.take(), vec![Injected::Move(40, 0)], "at most 50 ms catch-up");
    e.tick_at(t + Duration::from_millis(220));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)]);
}

#[test]
fn four_directions_and_diagonals_have_the_correct_sign() {
    let (mut e, inj) = rig(mouse_profile());
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    for (i, (x, y, sx, sy)) in [
        (208, 128, 1, 0),
        (48, 128, -1, 0),
        (128, 48, 0, -1),
        (128, 208, 0, 1),
        (208, 48, 1, -1),
    ]
    .into_iter()
    .enumerate()
    {
        let now = t + Duration::from_millis(20 * i as u64 + 10);
        pos(&mut e, now, x, y);
        e.tick_at(now);
        let events = inj.take();
        let [Injected::Move(dx, dy)] = &events[..] else {
            panic!("{events:?}")
        };
        assert_eq!((dx.signum(), dy.signum()), (sx, sy));
        if sx != 0 && sy != 0 {
            assert!(dx.abs() < 8 && dy.abs() < 8, "diagonal speed is normalized");
        }
        pos(&mut e, now + Duration::from_millis(10), 128, 128);
        e.tick_at(now + Duration::from_millis(10));
    }
}

#[test]
fn below_hysteresis_crossing_into_dead_zone_stops_pointer() {
    let (mut e, inj) = rig(mouse_profile());
    let mut tracker = InputTracker::new(3);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    feed(&mut tracker, &mut e, t, 128, 128);
    e.tick_at(t);
    // 142 is just outside the 15% radial dead zone. 140 is inside it,
    // but differs by only two raw units from the last filtered position.
    feed(
        &mut tracker,
        &mut e,
        t + Duration::from_millis(10),
        142,
        128,
    );
    for i in 1..=10 {
        e.tick_at(t + Duration::from_millis(10 * i));
    }
    assert!(
        inj.take()
            .iter()
            .any(|ev| matches!(ev, Injected::Move(x, 0) if *x > 0))
    );
    feed(
        &mut tracker,
        &mut e,
        t + Duration::from_millis(110),
        140,
        128,
    );
    for i in 11..=60 {
        e.tick_at(t + Duration::from_millis(10 * i));
    }
    assert!(
        inj.take().is_empty(),
        "sub-hysteresis return must not leave the mouse drifting"
    );
}

#[test]
fn disconnected_profile_switch_reconnect_and_shutdown_never_leave_motion_running() {
    let (mut e, inj) = rig(mouse_profile());
    let t = Instant::now();
    pos(&mut e, t, 128, 128);
    e.tick_at(t); // not connected
    pos(&mut e, t, 208, 128);
    e.tick_at(t + Duration::from_millis(100));
    assert!(inj.take().is_empty());

    e.handle_at(DeviceEvent::Connected, t + Duration::from_millis(110));
    pos(&mut e, t + Duration::from_millis(110), 208, 128);
    e.tick_at(t + Duration::from_millis(110));
    e.tick_at(t + Duration::from_millis(210));
    assert!(
        inj.take().is_empty(),
        "a held stick must visit neutral after connect"
    );
    pos(&mut e, t + Duration::from_millis(220), 128, 128);
    e.tick_at(t + Duration::from_millis(220));
    pos(&mut e, t + Duration::from_millis(230), 208, 128);
    e.tick_at(t + Duration::from_millis(230));
    assert!(!inj.take().is_empty());

    e.set_profile(Profile::default());
    e.tick_at(t + Duration::from_millis(240));
    assert!(
        inj.take().is_empty(),
        "keyboard mode must not inject mouse movement"
    );
    e.set_profile(mouse_profile());
    e.tick_at(t + Duration::from_millis(250));
    e.tick_at(t + Duration::from_millis(350));
    assert!(
        inj.take().is_empty(),
        "re-enabled mouse must wait for neutral"
    );
    pos(&mut e, t + Duration::from_millis(360), 128, 128);
    e.tick_at(t + Duration::from_millis(360));
    pos(&mut e, t + Duration::from_millis(370), 208, 128);
    e.tick_at(t + Duration::from_millis(370));
    assert!(!inj.take().is_empty());
    e.handle_at(DeviceEvent::Disconnected, t + Duration::from_millis(380));
    e.tick_at(t + Duration::from_secs(2));
    assert!(inj.take().is_empty(), "disconnect must stop the motion");
    e.handle_at(DeviceEvent::Connected, t + Duration::from_secs(3));
    e.tick_at(t + Duration::from_secs(4));
    assert!(
        inj.take().is_empty(),
        "reconnect must not reuse the old position"
    );
    pos(&mut e, t + Duration::from_secs(4), 128, 128);
    e.tick_at(t + Duration::from_secs(4));
    pos(
        &mut e,
        t + Duration::from_secs(4) + Duration::from_millis(10),
        208,
        128,
    );
    e.tick_at(t + Duration::from_secs(4) + Duration::from_millis(10));
    assert!(!inj.take().is_empty());
    e.shutdown();
    e.tick_at(t + Duration::from_secs(5));
    assert!(inj.take().is_empty(), "shutdown must stop the motion");
}

#[test]
fn drifted_rest_is_calibrated_before_motion_and_held_deflection_is_not_recentered() {
    let mut p = mouse_profile();
    p.stick.deadzone = 0.35;
    let (mut e, inj) = rig(p);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 126, 111); // observed G13 rest can be offset from 128
    for i in 0..=150 {
        e.tick_at(t + Duration::from_millis(10 * i));
    }
    assert!(
        inj.take().is_empty(),
        "do not move while finding the rest point"
    );
    let mut smaller_deadzone = mouse_profile();
    smaller_deadzone.stick.deadzone = 0.10;
    e.set_profile(smaller_deadzone);
    e.tick_at(t + Duration::from_millis(1500)); // neutral at the learnt centre
    pos(&mut e, t + Duration::from_millis(1510), 143, 111); // small intentional deflection
    for i in 151..=450 {
        e.tick_at(t + Duration::from_millis(10 * i));
    }
    let events = inj.take();
    assert!(
        events.len() > 30,
        "small held deflection should keep moving: {} events",
        events.len()
    );
    assert!(matches!(events.last(), Some(Injected::Move(x, 0)) if *x > 0));
}

#[test]
fn bound_mouse_button_can_be_held_while_moving_and_is_released_on_disconnect() {
    let mut p = mouse_profile();
    p.bank_mut(MBank::M1)
        .set(G13Key::G23, Action::MouseButton(MouseButton::Left));
    let (mut e, inj) = rig(p);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    e.handle_at(
        DeviceEvent::Key {
            key: G13Key::G23,
            pressed: true,
        },
        t,
    );
    pos(&mut e, t + Duration::from_millis(10), 208, 128);
    e.tick_at(t + Duration::from_millis(10));
    e.handle_at(DeviceEvent::Disconnected, t + Duration::from_millis(20));
    assert_eq!(
        inj.take(),
        vec![
            Injected::Button(MouseButton::Left, true),
            Injected::Move(8, 0),
            Injected::Button(MouseButton::Left, false),
        ]
    );
}

#[derive(Default)]
struct FailingInjector(AtomicUsize);
impl InputInjector for FailingInjector {
    fn key(&self, _: KeyCode, _: bool) -> PlatformResult {
        Ok(())
    }
    fn mouse_button(&self, _: MouseButton, _: bool) -> PlatformResult {
        Ok(())
    }
    fn mouse_wheel(&self, _: i32, _: bool) -> PlatformResult {
        Ok(())
    }
    fn mouse_move(&self, _: i32, _: i32) -> PlatformResult {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(PlatformError::Os("test failure".into()))
    }
}

#[test]
fn injection_failure_is_reported_once_then_suspended_until_profile_reload() {
    let inj = Arc::new(FailingInjector::default());
    let (tx, _rx) = channel();
    let mut e = Engine::new(inj.clone(), tx, mouse_profile());
    let ui = e.subscribe();
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    pos(&mut e, t + Duration::from_millis(10), 208, 128);
    for i in 1..=20 {
        e.tick_at(t + Duration::from_millis(10 * i));
    }
    assert_eq!(inj.0.load(Ordering::SeqCst), 1);
    assert_eq!(
        ui.try_iter()
            .filter(|ev| matches!(ev, UiEvent::StickMouseError(_)))
            .count(),
        1
    );
    e.set_profile(mouse_profile());
    pos(&mut e, t + Duration::from_millis(210), 128, 128);
    e.tick_at(t + Duration::from_millis(210));
    pos(&mut e, t + Duration::from_millis(220), 208, 128);
    e.tick_at(t + Duration::from_millis(220));
    assert_eq!(
        inj.0.load(Ordering::SeqCst),
        2,
        "profile reload permits a retry"
    );
}

#[test]
fn settling_uses_latest_raw_sample_even_below_filter_threshold() {
    let mut p = mouse_profile();
    p.stick.deadzone = 0.35;
    let (mut e, inj) = rig(p);
    let mut tracker = InputTracker::new(3);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    feed(&mut tracker, &mut e, t, 126, 111);
    e.tick_at(t);
    // The settled point must be the final sample 127,111, not the filtered
    // point 126,111. Small changes must not restart the 1.5-second timer.
    for i in 1..50 {
        e.tick_at(t + Duration::from_millis(i * 10));
    }
    feed(
        &mut tracker,
        &mut e,
        t + Duration::from_millis(500),
        127,
        111,
    );
    for i in 50..=150 {
        e.tick_at(t + Duration::from_millis(i * 10));
    }
    assert!(e.stick_mouse.armed());
    assert_eq!(
        e.mouse_calibration.vector(
            StickPosition {
                raw_x: 127,
                raw_y: 111
            },
            0.0
        ),
        (0.0, 0.0),
        "the true latest rest sample should be the learnt centre"
    );
    assert!(inj.take().is_empty());
}

#[test]
fn small_deflection_at_activation_is_never_relearned_as_rest() {
    let mut p = mouse_profile();
    p.stick.deadzone = 0.10;
    let (mut e, inj) = rig(p);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 140, 128); // outside 10%, but inside the old auto-settle window
    for i in 0..=300 {
        e.tick_at(t + Duration::from_millis(i * 10));
    }
    assert!(
        !e.stick_mouse.armed(),
        "a held stick may not become a new centre"
    );
    assert!(inj.take().is_empty());
    pos(&mut e, t + Duration::from_millis(3010), 128, 128);
    e.tick_at(t + Duration::from_millis(3010));
    assert!(e.stick_mouse.armed());
    for i in 302..=310 {
        e.tick_at(t + Duration::from_millis(i * 10));
    }
    assert!(
        inj.take().is_empty(),
        "release must not start a reverse drift"
    );
    pos(&mut e, t + Duration::from_millis(3110), 208, 128);
    e.tick_at(t + Duration::from_millis(3110));
    assert!(
        !inj.take().is_empty(),
        "intentional motion works after neutral"
    );
}

#[test]
fn disconnect_or_injection_failure_cannot_recenter_a_held_stick() {
    let mut p = mouse_profile();
    p.stick.deadzone = 0.10;
    let inj = Arc::new(FailingInjector::default());
    let (tx, _rx) = channel();
    let mut e = Engine::new(inj.clone(), tx, p);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    pos(&mut e, t + Duration::from_millis(10), 140, 128);
    for i in 1..=400 {
        e.tick_at(t + Duration::from_millis(i * 10));
    }
    assert_eq!(inj.0.load(Ordering::SeqCst), 1, "one failed injection only");
    assert_eq!(
        e.mouse_calibration.vector(
            StickPosition {
                raw_x: 128,
                raw_y: 128
            },
            0.0
        ),
        (0.0, 0.0),
        "failed mouse motion must not relearn the deflection"
    );
    e.handle_at(DeviceEvent::Disconnected, t + Duration::from_secs(5));
    e.tick_at(t + Duration::from_secs(10));
    assert_eq!(
        e.mouse_calibration.vector(
            StickPosition {
                raw_x: 128,
                raw_y: 128
            },
            0.0
        ),
        (0.0, 0.0),
        "disconnected mouse mode must not settle the stale held position"
    );
}

#[test]
fn mouse_does_not_inherit_a_bad_centre_learnt_while_in_keyboard_mode() {
    let (mut e, inj) = rig(Profile::default());
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 140, 128); // held just outside a later 10% mouse dead zone
    e.tick_at(t + Duration::from_millis(1500)); // old pad calibration considers this rest
    assert_eq!(
        e.pad
            .state(Some((
                StickPosition {
                    raw_x: 140,
                    raw_y: 128
                },
                0.0,
                super::bindings::PadStick::Left
            )))
            .left_x,
        0,
        "the existing gamepad calibration has indeed re-centred"
    );
    let mut mouse = mouse_profile();
    mouse.stick.deadzone = 0.10;
    e.set_profile(mouse);
    for i in 151..=350 {
        e.tick_at(t + Duration::from_millis(i * 10));
    }
    assert!(
        !e.stick_mouse.armed(),
        "the mouse keeps its own uncorrupted centre"
    );
    assert!(inj.take().is_empty());
    pos(&mut e, t + Duration::from_millis(3510), 128, 128);
    e.tick_at(t + Duration::from_millis(3510));
    e.tick_at(t + Duration::from_millis(3600));
    assert!(e.stick_mouse.armed());
    assert!(
        inj.take().is_empty(),
        "returning to physical rest must not drift"
    );
}

#[test]
fn bank_switch_from_keys_to_mouse_releases_only_stick_actions_and_requires_neutral() {
    let mut p = Profile::default();
    p.stick.deadzone = 0.15;
    p.stick.bank_modes[MBank::M2.index()] = Some(StickMode::Mouse);
    p.bank_mut(MBank::M1).set_input(Input::Stick(StickDir::Right), Action::key("D"));
    p.bank_mut(MBank::M1).set(G13Key::G23, Action::MouseButton(MouseButton::Left));
    let (mut e, inj) = rig(p);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    pos(&mut e, t + Duration::from_millis(10), 208, 128);
    e.handle_at(DeviceEvent::Key { key: G13Key::G23, pressed: true }, t + Duration::from_millis(10));
    assert_eq!(inj.take(), vec![Injected::Key(KeyCode::D, true), Injected::Button(MouseButton::Left, true)]);

    e.handle_at(DeviceEvent::Key { key: G13Key::M2, pressed: true }, t + Duration::from_millis(20));
    assert_eq!(inj.take(), vec![Injected::Key(KeyCode::D, false)], "the separately held mouse button is not released");
    e.tick_at(t + Duration::from_millis(20));
    e.tick_at(t + Duration::from_millis(200));
    assert!(inj.take().is_empty(), "entering mouse mode while held must wait");
    pos(&mut e, t + Duration::from_millis(210), 128, 128);
    e.tick_at(t + Duration::from_millis(210));
    pos(&mut e, t + Duration::from_millis(220), 208, 128);
    e.tick_at(t + Duration::from_millis(220));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)]);

    // Like profile changes in upstream G Nexus, entering keyboard mode uses
    // the current stick position and the new bank's direction binding.
    e.handle_at(DeviceEvent::Key { key: G13Key::M1, pressed: true }, t + Duration::from_millis(230));
    e.handle_at(DeviceEvent::Key { key: G13Key::G23, pressed: false }, t + Duration::from_millis(230));
    assert_eq!(inj.take(), vec![Injected::Key(KeyCode::D, true), Injected::Button(MouseButton::Left, false)]);
    pos(&mut e, t + Duration::from_millis(240), 128, 128);
    e.tick_at(t + Duration::from_millis(240));
    assert_eq!(inj.take(), vec![Injected::Key(KeyCode::D, false)]);
}

#[test]
fn switching_between_mouse_banks_keeps_continuous_motion() {
    let (mut e, inj) = rig(mouse_profile());
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    pos(&mut e, t + Duration::from_millis(10), 208, 128);
    e.tick_at(t + Duration::from_millis(10));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)]);
    e.handle_at(DeviceEvent::Key { key: G13Key::M2, pressed: true }, t + Duration::from_millis(11));
    e.tick_at(t + Duration::from_millis(20));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)]);
}

#[test]
fn bank_switch_between_pad_and_mouse_updates_pad_and_guards_mouse_activation() {
    let mut p = mouse_profile();
    p.stick.bank_modes[MBank::M1.index()] = Some(StickMode::Gamepad);
    let (mut e, inj) = rig(p);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    inj.take(); // initial neutral gamepad
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    pos(&mut e, t + Duration::from_millis(10), 208, 128);
    assert!(inj.take().iter().any(|ev| matches!(ev, Injected::Gamepad(s) if s.left_x > 0)));
    e.handle_at(DeviceEvent::Key { key: G13Key::M2, pressed: true }, t + Duration::from_millis(20));
    assert!(inj.take().iter().any(|ev| matches!(ev, Injected::Gamepad(s) if s.left_x == 0 && s.left_y == 0)),
        "leaving gamepad mode must send a neutral stick immediately");
    e.tick_at(t + Duration::from_millis(20));
    e.tick_at(t + Duration::from_millis(100));
    assert!(inj.take().is_empty(), "the held stick must not move the mouse yet");
    pos(&mut e, t + Duration::from_millis(110), 128, 128);
    e.tick_at(t + Duration::from_millis(110));
    pos(&mut e, t + Duration::from_millis(120), 208, 128);
    e.tick_at(t + Duration::from_millis(120));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)]);
    e.handle_at(DeviceEvent::Key { key: G13Key::M1, pressed: true }, t + Duration::from_millis(130));
    assert!(inj.take().iter().any(|ev| matches!(ev, Injected::Gamepad(s) if s.left_x > 0)),
        "entering gamepad mode must send the current position");
    e.tick_at(t + Duration::from_millis(140));
    assert!(inj.take().iter().all(|ev| !matches!(ev, Injected::Move(..))));
}

#[test]
fn leaving_keyboard_mode_cancels_pending_stick_tap_dance_without_firing() {
    let mut p = Profile::default();
    p.stick.bank_modes[MBank::M2.index()] = Some(StickMode::Mouse);
    let td = TapDance { tap: Action::key("W"), hold: Action::key("A"), ..TapDance::default() };
    p.bank_mut(MBank::M1).set_input(Input::Stick(StickDir::Up), Action::TapDance(Arc::new(td)));
    let (mut e, inj) = rig(p);
    let t = Instant::now();
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 0);
    e.handle_at(DeviceEvent::Key { key: G13Key::M2, pressed: true }, t + Duration::from_millis(10));
    e.tick_at(t + Duration::from_secs(1));
    assert!(inj.take().is_empty(), "the bank switch must not synthesize a tap or hold");
}

#[test]
fn leaving_keys_cancels_all_kinds_of_stick_macro_and_releases_its_button() {
    for mode in [MacroMode::Once, MacroMode::RepeatWhileHeld, MacroMode::Toggle] {
        let mac = Arc::new(Macro {
            name: format!("direction-{mode:?}"),
            mode,
            steps: vec![
                MacroStep::MouseDown(MouseButton::Left),
                MacroStep::Delay(Duration::from_secs(5)),
                MacroStep::MouseUp(MouseButton::Left),
            ],
        });
        let mut p = Profile::default();
        p.stick.bank_modes[MBank::M2.index()] = Some(StickMode::Mouse);
        p.bank_mut(MBank::M1).set_input(Input::Stick(StickDir::Right), Action::Macro(mac));
        let (mut e, inj) = rig(p);
        let t = Instant::now();
        e.handle_at(DeviceEvent::Connected, t);
        pos(&mut e, t, 208, 128);
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut down = false;
        while Instant::now() < deadline && !down {
            down |= inj.take().contains(&Injected::Button(MouseButton::Left, true));
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(down, "{mode:?}: macro did not start");
        e.handle_at(DeviceEvent::Key { key: G13Key::M2, pressed: true }, Instant::now());
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut up = false;
        while Instant::now() < deadline && !up {
            up |= inj.take().contains(&Injected::Button(MouseButton::Left, false));
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(up, "{mode:?}: cancelled direction macro must release its button");
    }
}

#[test]
fn global_speed_applies_across_profiles_but_legacy_override_is_preserved() {
    let (mut e, inj) = rig(mouse_profile());
    let t = Instant::now();
    e.set_stick_mouse_speed(50);
    e.handle_at(DeviceEvent::Connected, t);
    pos(&mut e, t, 128, 128);
    e.tick_at(t);
    pos(&mut e, t + Duration::from_millis(10), 208, 128);
    e.tick_at(t + Duration::from_millis(10));
    assert_eq!(inj.take(), vec![Injected::Move(4, 0)]);
    e.set_stick_mouse_speed(150);
    e.tick_at(t + Duration::from_millis(20));
    assert_eq!(inj.take(), vec![Injected::Move(12, 0)]);

    let mut old = mouse_profile();
    old.stick.mouse_speed = Some(100); // explicit legacy 100 must not be treated as absent
    e.set_profile(old);
    pos(&mut e, t + Duration::from_millis(30), 128, 128);
    e.tick_at(t + Duration::from_millis(30));
    pos(&mut e, t + Duration::from_millis(40), 208, 128);
    e.tick_at(t + Duration::from_millis(40));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)]);
    e.set_stick_mouse_speed(200);
    e.tick_at(t + Duration::from_millis(50));
    assert_eq!(inj.take(), vec![Injected::Move(8, 0)], "legacy profile speed takes precedence");

    e.set_profile(mouse_profile());
    pos(&mut e, t + Duration::from_millis(60), 128, 128);
    e.tick_at(t + Duration::from_millis(60));
    pos(&mut e, t + Duration::from_millis(70), 208, 128);
    e.tick_at(t + Duration::from_millis(70));
    assert_eq!(inj.take(), vec![Injected::Move(16, 0)], "another profile inherits the global setting");
    e.set_stick_mouse_speed(999);
    e.tick_at(t + Duration::from_millis(80));
    assert_eq!(inj.take(), vec![Injected::Move(16, 0)], "non-GUI callers are bounded too");
}

fn report_with_keys(keys: u64, x: u8, y: u8) -> G13InputReport {
    let mut raw = 0x80_0080_0000u64;
    for key in G13Key::ALL {
        if keys & key.mask() != 0 {
            raw |= 1 << key.report_bit();
        }
    }
    let mut bytes = [0u8; 8];
    bytes[0] = 1;
    bytes[1] = x;
    bytes[2] = y;
    bytes[3..8].copy_from_slice(&raw.to_le_bytes()[..5]);
    G13InputReport::from_bytes(&bytes).unwrap()
}

#[test]
fn simultaneous_bank_switch_and_deflection_use_the_same_report_before_a_tick() {
    let mut profile = Profile::default();
    profile.stick.deadzone = 0.15;
    profile.stick.bank_modes[MBank::M2.index()] = Some(StickMode::Mouse);
    let (mut engine, injector) = rig(profile);
    let mut tracker = InputTracker::new(3);
    let now = Instant::now();
    engine.handle_at(DeviceEvent::Connected, now);
    engine.handle_at(tracker.batch(&report_with_keys(0, 128, 128)).unwrap(), now);
    engine.tick_at(now);
    let m2 = G13Key::M2.mask();

    // Previously the producer sent the M2 edge separately; the engine could
    // tick and arm using the previous neutral before receiving this deflection.
    let batch = tracker.batch(&report_with_keys(m2, 208, 128)).unwrap();
    engine.handle_at(batch, now + Duration::from_millis(10));
    engine.tick_at(now + Duration::from_millis(10));
    assert_eq!(engine.active_bank(), MBank::M2);
    assert!(!engine.stick_mouse.armed());
    assert!(injector.take().is_empty());
    engine.tick_at(now + Duration::from_millis(20));
    assert!(injector.take().is_empty());

    engine.handle_at(tracker.batch(&report_with_keys(m2, 128, 128)).unwrap(), now + Duration::from_millis(30));
    engine.tick_at(now + Duration::from_millis(30));
    assert!(engine.stick_mouse.armed());
    engine.handle_at(tracker.batch(&report_with_keys(m2, 208, 128)).unwrap(), now + Duration::from_millis(40));
    engine.tick_at(now + Duration::from_millis(40));
    assert_eq!(injector.take(), vec![Injected::Move(8, 0)]);
}

#[test]
fn simultaneous_bank_switch_and_sub_hysteresis_deflection_stays_disarmed() {
    let mut profile = Profile::default();
    profile.stick.deadzone = 0.15;
    profile.stick.bank_modes[MBank::M2.index()] = Some(StickMode::Mouse);
    let (mut engine, injector) = rig(profile);
    let mut tracker = InputTracker::new(3);
    let now = Instant::now();
    engine.handle_at(DeviceEvent::Connected, now);
    engine.handle_at(tracker.batch(&report_with_keys(0, 139, 128)).unwrap(), now);
    engine.tick_at(now);
    let m2 = G13Key::M2.mask();
    // Two raw units cross the 15% edge, but do not create a filtered Stick.
    let batch = tracker.batch(&report_with_keys(m2, 141, 128)).unwrap();
    let DeviceEvent::Batch(events) = &batch else { panic!("not a batch") };
    assert!(events.iter().any(|e| matches!(e, DeviceEvent::StickSample(_))));
    engine.handle_at(batch, now + Duration::from_millis(10));
    engine.tick_at(now + Duration::from_millis(10));
    assert!(!engine.stick_mouse.armed());
    for i in 2..=15 { engine.tick_at(now + Duration::from_millis(10 * i)); }
    assert!(injector.take().is_empty());
    engine.handle_at(tracker.batch(&report_with_keys(m2, 139, 128)).unwrap(), now + Duration::from_millis(160));
    engine.tick_at(now + Duration::from_millis(160));
    assert!(engine.stick_mouse.armed());
    engine.handle_at(tracker.batch(&report_with_keys(m2, 141, 128)).unwrap(), now + Duration::from_millis(170));
    for i in 17..=30 { engine.tick_at(now + Duration::from_millis(10 * i)); }
    assert!(injector.take().iter().any(|e| matches!(e, Injected::Move(dx, 0) if *dx > 0)));
}

#[test]
fn disconnect_batch_stops_motion_after_releasing_pressed_keys() {
    let (mut engine, injector) = rig(mouse_profile());
    let now = Instant::now();
    engine.handle_at(DeviceEvent::Connected, now);
    pos(&mut engine, now, 128, 128);
    engine.tick_at(now);
    pos(&mut engine, now + Duration::from_millis(10), 208, 128);
    engine.tick_at(now + Duration::from_millis(10));
    assert_eq!(injector.take(), vec![Injected::Move(8, 0)]);
    engine.handle_at(DeviceEvent::Batch(vec![
        DeviceEvent::Key { key: G13Key::G1, pressed: false },
        DeviceEvent::Disconnected,
    ]), now + Duration::from_millis(20));
    engine.tick_at(now + Duration::from_millis(20));
    assert!(!engine.is_connected());
    assert!(injector.take().iter().all(|e| !matches!(e, Injected::Move(_, _))));
}
