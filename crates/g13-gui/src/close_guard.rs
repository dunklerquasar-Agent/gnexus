//! Coordinate graceful window close / tray quit with the frontend's save queue.
//! No I/O here: the application dispatches the returned requests and performs
//! the resulting close or exit after the relevant windows acknowledge them.

use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default)]
pub struct CloseGuard {
    ready: BTreeSet<String>,
    pending: BTreeMap<String, u64>,
    /// One already-flushed window may pass its next CloseRequested event.
    approved: BTreeSet<String>,
    /// An approved close remains in progress until the window is destroyed,
    /// even after the one-shot permission has been consumed or a page reloads.
    closing: BTreeSet<String>,
    quitting: bool,
    next_token: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ClosePlan {
    Flush(u64),
    Immediate,
    AlreadyPending,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Completion {
    Ignore,
    CloseWindow,
    HoldForQuit,
    Exit,
    Cancelled { notify_all: bool },
}

impl CloseGuard {
    pub fn ready(&mut self, label: &str) {
        self.ready.insert(label.to_string());
    }

    /// A page navigating away cannot acknowledge its old request. A previously
    /// approved native close stays marked as closing across page navigation.
    /// Return true if a pending whole-app quit was cancelled.
    pub fn unready(&mut self, label: &str) -> bool {
        let was_ready = self.ready.remove(label);
        let was_pending = self.pending.remove(label).is_some();
        // A window already approved before quit was flushed and needs no new
        // acknowledgement. But if quit raced with approval, cancelling is
        // safer than waiting forever for an acknowledgement from a dead page.
        if was_ready && self.quitting && (was_pending || !self.closing.contains(label)) {
            self.pending.clear();
            self.quitting = false;
            return true;
        }
        false
    }

    /// Only destruction ends a successful native close and permits a future
    /// window with the same label to become ready.
    pub fn destroyed(&mut self, label: &str) -> bool {
        let cancelled = self.unready(label);
        self.approved.remove(label);
        self.closing.remove(label);
        cancelled
    }

    pub fn quitting(&self) -> bool {
        self.quitting
    }

    /// Allow exactly one close event after a successful flush. Routing through
    /// a normal Tauri close (not destroy) preserves last-window exit behavior.
    pub fn approve_close(&mut self, label: &str) {
        self.approved.insert(label.to_string());
        self.closing.insert(label.to_string());
    }

    pub fn take_approved_close(&mut self, label: &str) -> bool {
        self.approved.remove(label)
    }

    /// The native close could not be dispatched; allow the page to retry.
    pub fn cancel_close(&mut self, label: &str) {
        self.approved.remove(label);
        self.closing.remove(label);
    }

    pub fn closing(&self, label: &str) -> bool {
        self.closing.contains(label)
    }

    fn token(&mut self) -> u64 {
        self.next_token = self.next_token.wrapping_add(1).max(1);
        self.next_token
    }

    pub fn request_window(&mut self, label: &str) -> ClosePlan {
        if self.quitting || self.closing.contains(label) || self.pending.contains_key(label) {
            return ClosePlan::AlreadyPending;
        }
        if !self.ready.contains(label) {
            return ClosePlan::Immediate;
        }
        let token = self.token();
        self.pending.insert(label.to_string(), token);
        ClosePlan::Flush(token)
    }

    /// All pending requests are installed before any event is emitted, so an
    /// early acknowledgement cannot exit before the other window was asked.
    /// `None` means a quit is already in progress. The bool says exit now.
    pub fn request_quit(&mut self, open: &[&str]) -> Option<(Vec<(String, u64)>, bool)> {
        if self.quitting {
            return None;
        }
        self.quitting = true;
        let mut requests = Vec::new();
        for &label in open {
            if self.ready.contains(label) && !self.closing.contains(label) && !self.pending.contains_key(label) {
                let token = self.token();
                self.pending.insert(label.to_string(), token);
                requests.push((label.to_string(), token));
            }
        }
        let exit_now = self.pending.is_empty();
        Some((requests, exit_now))
    }

    pub fn complete(&mut self, label: &str, token: u64, saved: bool) -> Completion {
        if self.pending.get(label) != Some(&token) {
            return Completion::Ignore;
        }
        self.pending.remove(label);
        if !saved {
            let notify_all = self.quitting;
            if self.quitting {
                self.quitting = false;
                self.pending.clear();
            }
            return Completion::Cancelled { notify_all };
        }
        if !self.quitting {
            return Completion::CloseWindow;
        }
        if self.pending.is_empty() { Completion::Exit } else { Completion::HoldForQuit }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_close_waits_for_its_own_valid_ack() {
        let mut g = CloseGuard::default();
        assert_eq!(g.request_window("main"), ClosePlan::Immediate); // not yet editable
        g.ready("main");
        let ClosePlan::Flush(n) = g.request_window("main") else { panic!() };
        assert_eq!(g.request_window("main"), ClosePlan::AlreadyPending);
        assert_eq!(g.complete("overlay", n, true), Completion::Ignore);
        assert_eq!(g.complete("main", n + 1, true), Completion::Ignore);
        assert_eq!(g.complete("main", n, true), Completion::CloseWindow);
        assert_eq!(g.complete("main", n, true), Completion::Ignore);
    }

    #[test]
    fn approved_close_passes_only_once_but_stays_closing_until_destroyed() {
        let mut g = CloseGuard::default();
        g.ready("main");
        g.approve_close("main");
        assert!(g.closing("main"));
        assert!(!g.closing("overlay"));
        assert!(!g.take_approved_close("overlay"));
        assert!(g.take_approved_close("main"));
        assert!(!g.take_approved_close("main"));
        assert!(g.closing("main"), "consuming the event must not reopen readiness");
        assert_eq!(g.request_window("main"), ClosePlan::AlreadyPending);
        g.unready("main"); // navigation can precede Destroyed
        assert!(g.closing("main"));
        assert!(!g.destroyed("main"));
        assert!(!g.closing("main"));
        assert_eq!(g.request_window("main"), ClosePlan::Immediate);
        g.approve_close("main");
        g.cancel_close("main"); // close dispatch failed: allow retry
        assert!(!g.closing("main"));
        assert!(!g.take_approved_close("main"));
    }

    #[test]
    fn quitting_does_not_wait_for_an_already_flushed_closing_window() {
        let mut g = CloseGuard::default();
        g.ready("main");
        g.ready("overlay");
        g.approve_close("main");
        assert!(g.take_approved_close("main"));
        let (requests, exit) = g.request_quit(&["main", "overlay"]).unwrap();
        assert!(!exit);
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "overlay");
        assert!(!g.destroyed("main"));
        assert!(g.quitting());
        assert_eq!(g.complete("overlay", requests[0].1, true), Completion::Exit);
    }

    #[test]
    fn quit_racing_with_approval_is_cancelled_instead_of_hanging() {
        let mut g = CloseGuard::default();
        g.ready("main");
        // Simulates quit beginning between an individual flush ACK and native
        // close approval. The queued ACK cannot be expected from a dead page.
        let (requests, exit) = g.request_quit(&["main"]).unwrap();
        assert!(!exit);
        g.approve_close("main");
        assert!(g.take_approved_close("main"));
        assert!(g.destroyed("main"));
        assert!(!g.quitting());
        assert_eq!(g.complete("main", requests[0].1, true), Completion::Ignore);
    }

    #[test]
    fn quit_waits_for_both_windows_and_failed_save_cancels_it() {
        let mut g = CloseGuard::default();
        g.ready("main");
        g.ready("overlay");
        let ClosePlan::Flush(m) = g.request_window("main") else { panic!() };
        let (requests, exit) = g.request_quit(&["main", "overlay"]).unwrap();
        assert!(!exit);
        assert_eq!(requests.len(), 1, "the existing main close is promoted to quit");
        let o = requests[0].1;
        assert_eq!(g.complete("main", m, true), Completion::HoldForQuit);
        assert_eq!(g.complete("overlay", o, false), Completion::Cancelled { notify_all: true });
        assert!(!g.quitting());
        assert_eq!(g.complete("overlay", o, true), Completion::Ignore);

        let (requests, _) = g.request_quit(&["main", "overlay"]).unwrap();
        let m = requests.iter().find(|(l, _)| l == "main").unwrap().1;
        let o = requests.iter().find(|(l, _)| l == "overlay").unwrap().1;
        assert_eq!(g.complete("overlay", o, true), Completion::HoldForQuit);
        assert_eq!(g.complete("main", m, true), Completion::Exit);
    }

    #[test]
    fn a_reload_cancels_a_pending_quit_but_stale_ack_is_ignored() {
        let mut g = CloseGuard::default();
        g.ready("main");
        g.ready("overlay");
        let (requests, _) = g.request_quit(&["main", "overlay"]).unwrap();
        let m = requests.iter().find(|(l, _)| l == "main").unwrap().1;
        assert!(g.unready("overlay"));
        assert!(!g.quitting());
        assert_eq!(g.complete("main", m, true), Completion::Ignore);
        assert_eq!(g.request_window("overlay"), ClosePlan::Immediate);
    }

    #[test]
    fn even_an_already_acknowledged_window_reloading_cancels_quit() {
        let mut g = CloseGuard::default();
        g.ready("main");
        g.ready("overlay");
        let (requests, _) = g.request_quit(&["main", "overlay"]).unwrap();
        let m = requests.iter().find(|(l, _)| l == "main").unwrap().1;
        assert_eq!(g.complete("main", m, true), Completion::HoldForQuit);
        assert!(g.unready("main"));
        assert!(!g.quitting());
    }

    #[test]
    fn failed_individual_flush_keeps_window_open_and_new_attempt_gets_new_token() {
        let mut g = CloseGuard::default();
        g.ready("main");
        let ClosePlan::Flush(old) = g.request_window("main") else { panic!() };
        assert_eq!(g.complete("main", old, false), Completion::Cancelled { notify_all: false });
        assert!(!g.closing("main"));
        let ClosePlan::Flush(new) = g.request_window("main") else { panic!() };
        assert_ne!(old, new);
        assert_eq!(g.complete("main", old, true), Completion::Ignore);
        assert_eq!(g.complete("main", new, true), Completion::CloseWindow);
    }

    #[test]
    fn individual_reload_invalidates_its_pending_token() {
        let mut g = CloseGuard::default();
        g.ready("overlay");
        let ClosePlan::Flush(old) = g.request_window("overlay") else { panic!() };
        assert!(!g.unready("overlay"));
        assert_eq!(g.complete("overlay", old, true), Completion::Ignore);
        g.ready("overlay");
        let ClosePlan::Flush(new) = g.request_window("overlay") else { panic!() };
        assert_ne!(old, new);
    }

    #[test]
    fn duplicated_quit_and_wrong_window_ack_never_release_the_barrier() {
        let mut g = CloseGuard::default();
        g.ready("main");
        g.ready("overlay");
        let (requests, now) = g.request_quit(&["main", "overlay"]).unwrap();
        assert!(!now);
        assert_eq!(g.request_quit(&["main", "overlay"]), None);
        let a = requests.iter().find(|(label, _)| label == "main").unwrap().1;
        let b = requests.iter().find(|(label, _)| label == "overlay").unwrap().1;
        assert_eq!(g.complete("overlay", a, true), Completion::Ignore);
        assert_eq!(g.complete("main", a, true), Completion::HoldForQuit);
        assert_eq!(g.complete("main", a, true), Completion::Ignore);
        assert_eq!(g.complete("overlay", b, true), Completion::Exit);
    }

    #[test]
    fn quit_with_only_inert_not_ready_windows_can_finish_immediately() {
        let mut g = CloseGuard::default();
        let (requests, now) = g.request_quit(&["main", "overlay"]).unwrap();
        assert!(requests.is_empty());
        assert!(now);
        assert!(g.quitting());
    }

}
