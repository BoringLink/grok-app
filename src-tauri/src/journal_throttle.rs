//! Streaming journal write throttle (I04).
//!
//! Mid-stream assistant persistence must not rewrite `messages.json` on every
//! token. Flush at most every [`journal_flush_interval_ms`] (500ms while the
//! buffered answer is small, longer once it is large), or immediately when
//! forced (turn end / stop / disconnect).
//!
//! Paragraph breaks do **not** bypass that interval. Agent markdown is full of
//! blank lines; treating each one as a force flush re-read and re-serialized
//! the whole journal many times a second and froze the host on long turns.

use std::time::{Duration, Instant};

/// Spec default: ≥500ms between mid-stream journal flushes.
pub const DEFAULT_JOURNAL_FLUSH_MS: u64 = 500;

/// Hard clamp for custom intervals (tests / future settings).
pub const MIN_JOURNAL_FLUSH_MS: u64 = 50;
pub const MAX_JOURNAL_FLUSH_MS: u64 = 10_000;

/// Normalize a raw flush interval to a safe range.
pub fn normalize_journal_flush_ms(raw: u64) -> u64 {
    raw.clamp(MIN_JOURNAL_FLUSH_MS, MAX_JOURNAL_FLUSH_MS)
}

/// True when a stream chunk is a natural paragraph boundary (double newline).
pub fn is_paragraph_break(chunk: &str) -> bool {
    chunk.contains("\n\n")
}

/// Mid-stream rewrite cadence from the buffered assistant+thought size.
///
/// Small turns stay on [`DEFAULT_JOURNAL_FLUSH_MS`]. Once the buffer is
/// hundreds of kilobytes, each flush rewrites the entire `messages.json`, so
/// the interval grows. Turn-end `force` still flushes immediately.
pub fn journal_flush_interval_ms(content_bytes: usize) -> u64 {
    if content_bytes >= 4_000_000 {
        15_000
    } else if content_bytes >= 1_000_000 {
        5_000
    } else if content_bytes >= 256_000 {
        2_000
    } else {
        DEFAULT_JOURNAL_FLUSH_MS
    }
}

/// Pure decision: whether a journal flush is allowed at `now`.
///
/// `paragraph_break` is accepted so existing callers keep compiling. It does
/// not bypass `min_interval` — see the module note. Only `force` does.
pub fn should_flush_journal(
    last_flush: Option<Instant>,
    min_interval: Duration,
    now: Instant,
    force: bool,
    paragraph_break: bool,
) -> bool {
    let _ = paragraph_break;
    if force {
        return true;
    }
    match last_flush {
        None => true,
        Some(t) => now.saturating_duration_since(t) >= min_interval,
    }
}

/// Tracks last mid-stream journal flush for one live session turn.
#[derive(Debug, Clone)]
pub struct JournalWriteThrottle {
    last_flush: Option<Instant>,
    min_interval: Duration,
}

impl Default for JournalWriteThrottle {
    fn default() -> Self {
        Self::with_default_interval()
    }
}

impl JournalWriteThrottle {
    pub fn new(min_interval_ms: u64) -> Self {
        Self {
            last_flush: None,
            min_interval: Duration::from_millis(normalize_journal_flush_ms(min_interval_ms)),
        }
    }

    pub fn with_default_interval() -> Self {
        Self::new(DEFAULT_JOURNAL_FLUSH_MS)
    }

    #[allow(dead_code)]
    pub fn min_interval(&self) -> Duration {
        self.min_interval
    }

    pub fn last_flush(&self) -> Option<Instant> {
        self.last_flush
    }

    /// Whether a flush should run now at this throttle's fixed interval.
    ///
    /// Live streaming calls [`should_flush_journal`] with an adaptive interval
    /// instead, so non-test builds have no caller.
    #[allow(dead_code)]
    pub fn should_flush(&self, now: Instant, force: bool, paragraph_break: bool) -> bool {
        should_flush_journal(
            self.last_flush,
            self.min_interval,
            now,
            force,
            paragraph_break,
        )
    }

    pub fn mark_flushed(&mut self, now: Instant) {
        self.last_flush = Some(now);
    }

    /// Reset at turn start / after force end-of-turn flush.
    pub fn reset(&mut self) {
        self.last_flush = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_clamps() {
        assert_eq!(normalize_journal_flush_ms(0), MIN_JOURNAL_FLUSH_MS);
        assert_eq!(normalize_journal_flush_ms(500), 500);
        assert_eq!(normalize_journal_flush_ms(99_999), MAX_JOURNAL_FLUSH_MS);
    }

    #[test]
    fn paragraph_break_detects_double_newline() {
        assert!(is_paragraph_break("hello\n\nworld"));
        assert!(is_paragraph_break("\n\n"));
        assert!(!is_paragraph_break("hello\nworld"));
        assert!(!is_paragraph_break("token"));
    }

    #[test]
    fn first_flush_allowed_without_prior() {
        let t0 = Instant::now();
        assert!(should_flush_journal(
            None,
            Duration::from_millis(500),
            t0,
            false,
            false
        ));
    }

    #[test]
    fn throttle_blocks_within_interval() {
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_millis(100);
        assert!(!should_flush_journal(
            Some(t0),
            Duration::from_millis(500),
            t1,
            false,
            false
        ));
    }

    #[test]
    fn throttle_allows_after_interval() {
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_millis(500);
        assert!(should_flush_journal(
            Some(t0),
            Duration::from_millis(500),
            t1,
            false,
            false
        ));
    }

    #[test]
    fn force_bypasses_interval_paragraph_does_not() {
        let t0 = Instant::now();
        let t1 = t0 + Duration::from_millis(10);
        assert!(should_flush_journal(
            Some(t0),
            Duration::from_millis(500),
            t1,
            true,
            false
        ));
        assert!(!should_flush_journal(
            Some(t0),
            Duration::from_millis(500),
            t1,
            false,
            true
        ));
        let t2 = t0 + Duration::from_millis(500);
        assert!(should_flush_journal(
            Some(t0),
            Duration::from_millis(500),
            t2,
            false,
            true
        ));
    }

    #[test]
    fn interval_grows_with_buffered_bytes() {
        assert_eq!(journal_flush_interval_ms(0), DEFAULT_JOURNAL_FLUSH_MS);
        assert_eq!(journal_flush_interval_ms(255_999), DEFAULT_JOURNAL_FLUSH_MS);
        assert_eq!(journal_flush_interval_ms(256_000), 2_000);
        assert_eq!(journal_flush_interval_ms(1_000_000), 5_000);
        assert_eq!(journal_flush_interval_ms(4_000_000), 15_000);
    }

    #[test]
    fn struct_tracks_mark_and_reset() {
        let mut th = JournalWriteThrottle::with_default_interval();
        assert_eq!(th.min_interval(), Duration::from_millis(500));
        let t0 = Instant::now();
        assert!(th.should_flush(t0, false, false));
        th.mark_flushed(t0);
        assert!(!th.should_flush(t0 + Duration::from_millis(100), false, false));
        th.reset();
        assert!(th.should_flush(t0 + Duration::from_millis(100), false, false));
    }

    #[test]
    fn default_matches_spec() {
        assert_eq!(DEFAULT_JOURNAL_FLUSH_MS, 500);
    }
}
