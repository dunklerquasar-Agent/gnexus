//! Edge detection: turns successive 8-byte input reports into
//! `Pressed` / `Released` transitions and filtered stick movements.

use g13_core::{G13InputReport, G13Key, StickPosition};

use super::DeviceEvent;

#[derive(Debug, Clone)]
pub struct InputTracker {
    prev_keys: u64,
    prev_stick: Option<StickPosition>,
    /// Most recent raw sample (including changes below the hysteresis).
    prev_sample: Option<StickPosition>,
    /// Minimum change (raw units, per axis) before a stick event is emitted;
    /// filters potentiometer noise.
    stick_hysteresis: u8,
}

impl InputTracker {
    pub fn new(stick_hysteresis: u8) -> Self {
        Self { prev_keys: 0, prev_stick: None, prev_sample: None, stick_hysteresis }
    }

    /// Bitmask of the keys currently considered held.
    pub fn held_mask(&self) -> u64 {
        self.prev_keys
    }

    /// Collect all edges from one report into one channel message. The
    /// engine must not tick between a bank-key edge and the stick position
    /// from that *same* report, even if the producer is descheduled.
    pub fn batch(&mut self, report: &G13InputReport) -> Option<DeviceEvent> {
        let mut events = Vec::new();
        self.update(report, |event| events.push(event));
        (!events.is_empty()).then_some(DeviceEvent::Batch(events))
    }

    /// Feed one report; `emit` is called for every resulting event.
    ///
    /// Ordering guarantees within one report: all releases first, then all
    /// presses (each group in bit order), then the stick event. Real HID
    /// delivery uses `batch`, not independently sent events.
    pub fn update(&mut self, report: &G13InputReport, mut emit: impl FnMut(DeviceEvent)) {
        let now = report.key_mask();
        let changed = now ^ self.prev_keys;
        if changed != 0 {
            Self::emit_edges(changed & self.prev_keys, false, &mut emit);
            Self::emit_edges(changed & now, true, &mut emit);
            self.prev_keys = now;
        }

        let stick = report.stick();
        let moved = match self.prev_stick {
            None => true,
            Some(p) => {
                p.raw_x.abs_diff(stick.raw_x) >= self.stick_hysteresis
                    || p.raw_y.abs_diff(stick.raw_y) >= self.stick_hysteresis
                    // always report reaching the physical end stops
                    || (stick != p && (matches!(stick.raw_x, 0 | 255) || matches!(stick.raw_y, 0 | 255)))
            }
        };
        if moved {
            self.prev_stick = Some(stick);
            emit(DeviceEvent::Stick(stick));
        } else if self.prev_sample != Some(stick) {
            // Keep the latest position even below the old filter threshold:
            // otherwise a tiny step into the mouse dead zone could be lost
            // and the cursor could keep drifting indefinitely.
            emit(DeviceEvent::StickSample(stick));
        }
        self.prev_sample = Some(stick);
    }

    /// Emit a release for every held key and reset (used on disconnect).
    pub fn release_all(&mut self, mut emit: impl FnMut(DeviceEvent)) {
        Self::emit_edges(self.prev_keys, false, &mut emit);
        self.prev_keys = 0;
        self.prev_stick = None;
        self.prev_sample = None;
    }

    fn emit_edges(mut bits: u64, pressed: bool, emit: &mut impl FnMut(DeviceEvent)) {
        while bits != 0 {
            let idx = bits.trailing_zeros() as u8;
            bits &= bits - 1;
            if let Some(key) = G13Key::from_bit_index(idx) {
                emit(DeviceEvent::Key { key, pressed });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a raw report from a `key_mask()`-style mask (+ the idle status bits).
    fn report(keys: u64, x: u8, y: u8) -> G13InputReport {
        let mut raw = 0x80_0080_0000u64; // byte 5 bit 7, byte 7 bit 7
        for k in G13Key::ALL {
            if keys & k.mask() != 0 {
                raw |= 1 << k.report_bit();
            }
        }
        let mut b = [0u8; 8];
        b[0] = 1;
        b[1] = x;
        b[2] = y;
        b[3..8].copy_from_slice(&raw.to_le_bytes()[..5]);
        G13InputReport::from_bytes(&b).unwrap()
    }

    fn collect(t: &mut InputTracker, r: &G13InputReport) -> Vec<DeviceEvent> {
        let mut v = Vec::new();
        t.update(r, |e| v.push(e));
        v.retain(|e| !matches!(e, DeviceEvent::Stick(_) | DeviceEvent::StickSample(_)));
        v
    }

    #[test]
    fn batch_keeps_report_edges_in_order_and_omits_unchanged_reports() {
        let mut tracker = InputTracker::new(3);
        assert_eq!(tracker.batch(&report(0, 128, 128)), Some(DeviceEvent::Batch(vec![
            DeviceEvent::Stick(StickPosition { raw_x: 128, raw_y: 128 }),
        ])));
        assert_eq!(tracker.batch(&report(0, 128, 128)), None);
        let keys = G13Key::M2.mask() | G13Key::G1.mask();
        let batch = tracker.batch(&report(keys, 208, 128)).expect("changed report");
        let DeviceEvent::Batch(events) = batch else { panic!("not a batch") };
        assert_eq!(events.len(), 3);
        assert!(events[..2].iter().all(|e| matches!(e, DeviceEvent::Key { pressed: true, .. })));
        assert_eq!(events[2], DeviceEvent::Stick(StickPosition { raw_x: 208, raw_y: 128 }));
        assert_eq!(tracker.batch(&report(keys, 208, 128)), None);
        let batch = tracker.batch(&report(0, 206, 128)).expect("released and sub-hysteresis sample");
        let DeviceEvent::Batch(events) = batch else { panic!("not a batch") };
        assert!(events[..2].iter().all(|e| matches!(e, DeviceEvent::Key { pressed: false, .. })));
        assert_eq!(events[2], DeviceEvent::StickSample(StickPosition { raw_x: 206, raw_y: 128 }));
    }

    #[test]
    fn press_and_release_edges() {
        let mut t = InputTracker::new(3);
        let g1 = G13Key::G1.mask();
        let mr = G13Key::MR.mask();
        assert_eq!(collect(&mut t, &report(g1, 128, 128)), vec![DeviceEvent::Key { key: G13Key::G1, pressed: true }]);
        // repeated identical report → nothing
        assert!(collect(&mut t, &report(g1, 128, 128)).is_empty());
        // G1 released and MR pressed in the same report: release first
        assert_eq!(
            collect(&mut t, &report(mr, 128, 128)),
            vec![
                DeviceEvent::Key { key: G13Key::G1, pressed: false },
                DeviceEvent::Key { key: G13Key::MR, pressed: true },
            ]
        );
    }

    #[test]
    fn release_all_on_disconnect() {
        let mut t = InputTracker::new(3);
        collect(&mut t, &report(G13Key::G5.mask() | G13Key::M3.mask(), 128, 128));
        let mut v = Vec::new();
        t.release_all(|e| v.push(e));
        assert_eq!(
            v,
            vec![
                DeviceEvent::Key { key: G13Key::G5, pressed: false },
                DeviceEvent::Key { key: G13Key::M3, pressed: false },
            ]
        );
        assert_eq!(t.held_mask(), 0);
    }

    #[test]
    fn sub_hysteresis_samples_are_forwarded_once_and_reset_on_disconnect() {
        let mut t = InputTracker::new(3);
        let mut events = Vec::new();
        t.update(&report(0, 142, 128), |e| events.push(e));
        t.update(&report(0, 140, 128), |e| events.push(e)); // 2 units: below filter
        t.update(&report(0, 140, 128), |e| events.push(e)); // identical: no extra event
        t.update(&report(0, 142, 128), |e| events.push(e)); // return to filtered value
        assert_eq!(events, vec![
            DeviceEvent::Stick(StickPosition { raw_x: 142, raw_y: 128 }),
            DeviceEvent::StickSample(StickPosition { raw_x: 140, raw_y: 128 }),
            DeviceEvent::StickSample(StickPosition { raw_x: 142, raw_y: 128 }),
        ]);
        t.release_all(|_| {});
        events.clear();
        t.update(&report(0, 142, 128), |e| events.push(e));
        assert_eq!(events, vec![DeviceEvent::Stick(StickPosition { raw_x: 142, raw_y: 128 })]);
    }

    #[test]
    fn stick_hysteresis() {
        let mut t = InputTracker::new(3);
        let mut n = 0;
        let mut count_filtered = |e| { if matches!(e, DeviceEvent::Stick(_)) { n += 1 } };
        t.update(&report(0, 128, 128), &mut count_filtered); // first report always emits stick
        t.update(&report(0, 129, 127), &mut count_filtered); // below the filter
        t.update(&report(0, 131, 128), &mut count_filtered); // real move
        t.update(&report(0, 255, 128), &mut count_filtered); // end stop
        assert_eq!(n, 3);
    }
}
