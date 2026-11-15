//! Everything between the USB cable and the engine.
//!
//! ```text
//!  G13 ──HID──▶ [hid::HidWorker thread] ──DeviceEvent──▶ engine
//!                     ▲                                    │
//!                     └────────────DeviceCommand───────────┘
//! ```
//!
//! The worker thread exclusively owns the `HidDevice`: it reads input
//! reports, turns them into edge events via [`tracker::InputTracker`], and
//! executes outgoing commands (LEDs, backlight, LCD frames) between reads.

pub mod hid;
pub mod tracker;

use g13_core::{G13Key, G13LcdBuffer, MKeyLeds, RgbColor, StickPosition};

/// Device → engine.
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceEvent {
    /// The G13 was opened (initial plug or hot-replug). The engine must
    /// re-push its LED / backlight / LCD state.
    Connected,
    /// The G13 disappeared. Release events for every held key have already
    /// been emitted before this one.
    Disconnected,
    /// Events derived from one input report, or the final releases plus
    /// disconnect. The engine handles the entire batch before its next tick.
    /// InputTracker and the HID worker only create flat batches.
    Batch(Vec<DeviceEvent>),
    /// A key changed state (edge-triggered, never repeated).
    Key { key: G13Key, pressed: bool },
    /// The stick moved by more than the configured hysteresis.
    Stick(StickPosition),
    /// A smaller raw position change, needed to stop continuous mouse motion
    /// precisely at the dead-zone edge. Does not change filtered key/gamepad behavior.
    StickSample(StickPosition),
}

/// Engine → device.
#[derive(Debug, Clone, PartialEq)]
pub enum DeviceCommand {
    SetMKeyLeds(MKeyLeds),
    SetBacklight(RgbColor),
    DrawLcd(Box<G13LcdBuffer>),
}
