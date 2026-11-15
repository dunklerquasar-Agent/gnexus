//! Continuous relative mouse movement from a calibrated G13 stick.
//!
//! HID reports are only sent on changes, so movement must be integrated on
//! the engine clock rather than generated once per report.

use std::time::{Duration, Instant};

use super::TICK;

/// Relative mouse counts per second at full deflection and 100% speed.
const BASE_COUNTS_PER_SECOND: f64 = 800.0;
/// Do not catch up a long pause with a large, surprising pointer jump.
const MAX_ELAPSED: Duration = Duration::from_millis(50);

#[derive(Debug, Default)]
pub(super) struct StickMouse {
    /// Require the stick to visit its dead zone after enabling the mode.
    armed: bool,
    last_tick: Option<Instant>,
    remainder_x: f64,
    remainder_y: f64,
}

impl StickMouse {
    pub(super) fn reset(&mut self) {
        *self = Self::default();
    }

    #[cfg(test)]
    pub(super) fn armed(&self) -> bool {
        self.armed
    }

    /// `(x, y)` is a radial-deadzone-adjusted unit vector, with +Y up.
    /// Output is relative mouse counts, with +Y down. Fractional counts are
    /// carried across ticks so very small movements do not get rounded away.
    pub(super) fn step(
        &mut self,
        now: Instant,
        (x, y): (f32, f32),
        speed: u16,
    ) -> Option<(i32, i32)> {
        let neutral = x == 0.0 && y == 0.0;
        if !self.armed {
            self.last_tick = Some(now);
            self.armed = neutral;
            return None;
        }
        if neutral {
            self.last_tick = Some(now);
            self.remainder_x = 0.0;
            self.remainder_y = 0.0;
            return None;
        }

        let last = self.last_tick?;
        let elapsed = now.saturating_duration_since(last);
        // Keep time across short event-driven ticks; otherwise a constant
        // stream of events could prevent the 10 ms interval from ever passing.
        if elapsed < TICK {
            return None;
        }
        self.last_tick = Some(now);
        let seconds = elapsed.min(MAX_ELAPSED).as_secs_f64();
        let rate = BASE_COUNTS_PER_SECOND * f64::from(speed.clamp(10, 200)) / 100.0;
        let dx = Self::axis(&mut self.remainder_x, f64::from(x), rate * seconds);
        let dy = Self::axis(&mut self.remainder_y, -f64::from(y), rate * seconds);
        (dx != 0 || dy != 0).then_some((dx, dy))
    }

    fn axis(remainder: &mut f64, direction: f64, distance: f64) -> i32 {
        // No old sub-count may leak into a stop or the opposite direction.
        if direction == 0.0 || (*remainder != 0.0 && remainder.signum() != direction.signum()) {
            *remainder = 0.0;
        }
        *remainder += direction * distance;
        let whole = remainder.trunc();
        *remainder -= whole;
        whole as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_neutral_before_moving_and_then_continues() {
        let t = Instant::now();
        let mut mouse = StickMouse::default();
        assert_eq!(mouse.step(t, (1.0, 0.0), 100), None);
        assert_eq!(
            mouse.step(t + Duration::from_secs(1), (1.0, 0.0), 100),
            None
        );
        assert!(!mouse.armed());
        assert_eq!(
            mouse.step(t + Duration::from_millis(1010), (0.0, 0.0), 100),
            None
        );
        assert!(mouse.armed());
        assert_eq!(
            mouse.step(t + Duration::from_millis(1020), (1.0, 0.0), 100),
            Some((8, 0))
        );
        assert_eq!(
            mouse.step(t + Duration::from_millis(1030), (1.0, 0.0), 100),
            Some((8, 0))
        );
        assert_eq!(
            mouse.step(t + Duration::from_millis(1040), (0.0, 0.0), 100),
            None
        );
        mouse.reset();
        assert!(!mouse.armed());
    }

    fn distance_for(period_ms: u64, speed: u16) -> i32 {
        let t = Instant::now();
        let mut mouse = StickMouse::default();
        mouse.step(t, (0.0, 0.0), speed);
        (1..=1000 / period_ms)
            .filter_map(|i| mouse.step(t + Duration::from_millis(i * period_ms), (1.0, 0.0), speed))
            .map(|(x, _)| x)
            .sum()
    }

    #[test]
    fn elapsed_time_and_speed_not_number_of_reports_control_distance() {
        for period in [5, 10, 25] {
            assert!(
                (distance_for(period, 100) - 800).abs() <= 1,
                "period {period}"
            );
        }
        assert!((distance_for(10, 50) - 400).abs() <= 1);
        assert!((distance_for(10, 200) - 1600).abs() <= 1);
        assert!(
            (distance_for(10, 1) - 80).abs() <= 1,
            "defensive lower clamp"
        );
        assert!(
            (distance_for(10, 500) - 1600).abs() <= 1,
            "defensive upper clamp"
        );
    }

    #[test]
    fn fractional_movement_is_preserved_but_cleared_on_stop_or_reversal() {
        let t = Instant::now();
        // Each step contributes less than one count, but they add up.
        let mut tiny = StickMouse::default();
        tiny.step(t, (0.0, 0.0), 100);
        let mut sum = 0;
        for i in 1..=130 {
            sum += tiny
                .step(t + Duration::from_millis(i * 10), (0.001, 0.0), 100)
                .map_or(0, |v| v.0);
        }
        assert_eq!(sum, 1);

        let mut m = StickMouse::default();
        m.step(t, (0.0, 0.0), 100);
        assert_eq!(
            m.step(t + Duration::from_millis(10), (0.1125, 0.0), 100),
            None
        );
        assert_eq!(
            m.step(t + Duration::from_millis(20), (-0.1125, 0.0), 100),
            None
        );
        assert_eq!(
            m.step(t + Duration::from_millis(30), (-0.1125, 0.0), 100),
            Some((-1, 0))
        );
        m.step(t + Duration::from_millis(40), (0.0, 0.0), 100);
        assert_eq!(
            m.step(t + Duration::from_millis(50), (-0.1125, 0.0), 100),
            None
        );
    }

    #[test]
    fn y_axis_is_inverted_and_long_stalls_do_not_jump() {
        let t = Instant::now();
        let mut m = StickMouse::default();
        m.step(t, (0.0, 0.0), 100);
        assert_eq!(
            m.step(t + Duration::from_millis(10), (0.0, 1.0), 100),
            Some((0, -8))
        );
        assert_eq!(
            m.step(t + Duration::from_secs(10), (1.0, 0.0), 100),
            Some((40, 0))
        );
        assert_eq!(
            m.step(
                t + Duration::from_secs(10) + Duration::from_millis(10),
                (0.0, -1.0),
                100
            ),
            Some((0, 8))
        );
    }
}
