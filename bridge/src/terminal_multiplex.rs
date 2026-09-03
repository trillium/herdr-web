//! Shared state that lets several websocket clients view one terminal at once.
//!
//! A `terminal_id` has exactly one daemon attach behind it (see
//! `SharedTerminalSession` in `web_bridge`), so everything that is per-viewer
//! on a normal terminal — what has been painted, how big the grid is — has to
//! be reconciled here before it reaches the daemon.

use std::collections::{HashMap, VecDeque};

use bytes::{Bytes, BytesMut};

/// Bytes of the most recent terminal output kept per shared session so a client
/// joining a live attach can be repainted immediately.
///
/// A `broadcast::Receiver` only yields frames published after it subscribes,
/// and the only full repaint the daemon emits is the one that follows a fresh
/// attach. Without a replay a second viewer therefore stays blank until the pty
/// happens to write again — forever, on an idle shell.
///
/// 1 MiB comfortably holds a full repaint of a very large window (a 400x100
/// grid is 40k cells, well under 512 KiB even with an SGR sequence per cell)
/// plus a healthy tail of scrollback, while capping the per-terminal cost at an
/// eighth of the input backlog budget the writer already allows.
pub const MAX_TERMINAL_REPLAY_BYTES: usize = 1024 * 1024;

/// A bounded window over the most recent terminal output.
///
/// Eviction happens at whole-chunk granularity, so once the window has
/// overflowed a replay can begin part-way through an escape sequence. That is
/// the same position a viewer is in when it scrolls back through a pty stream:
/// the renderer resyncs on the next complete sequence, and the following full
/// repaint (a TUI redraw, or the next shell prompt) restores exact state.
#[derive(Debug)]
pub struct TerminalReplayBuffer {
    chunks: VecDeque<Bytes>,
    len: usize,
    capacity: usize,
}

impl TerminalReplayBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            len: 0,
            capacity,
        }
    }

    pub fn push(&mut self, chunk: Bytes) {
        if self.capacity == 0 || chunk.is_empty() {
            return;
        }
        if chunk.len() >= self.capacity {
            // A single oversized chunk replaces the whole window; only its
            // tail can be kept, and the older chunks it supersedes are moot.
            let tail = chunk.slice(chunk.len() - self.capacity..);
            self.chunks.clear();
            self.len = tail.len();
            self.chunks.push_back(tail);
            return;
        }
        self.len += chunk.len();
        self.chunks.push_back(chunk);
        while self.len > self.capacity {
            let Some(front) = self.chunks.pop_front() else {
                break;
            };
            self.len -= front.len();
        }
    }

    /// The buffered output as one frame, or `None` when nothing has been seen.
    pub fn snapshot(&self) -> Option<Bytes> {
        if self.chunks.is_empty() {
            return None;
        }
        let mut out = BytesMut::with_capacity(self.len);
        for chunk in &self.chunks {
            out.extend_from_slice(chunk);
        }
        Some(out.freeze())
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.len
    }
}

/// One client's view geometry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalViewSize {
    pub cols: u16,
    pub rows: u16,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
}

impl TerminalViewSize {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            cell_width_px: 0,
            cell_height_px: 0,
        }
    }

    /// Whether this size describes a grid that can actually hold a cell.
    ///
    /// Clients do report zero: mobile Safari measures a pane before layout has
    /// settled, and a backgrounded PWA reports a collapsed viewport. Because
    /// the coalesced size is a per-axis minimum, a single such report would
    /// otherwise pull the shared pty to 0x0 and blank every viewer at once.
    fn is_usable(self) -> bool {
        self.cols > 0 && self.rows > 0
    }

    /// The smallest grid worth asking the daemon for.
    fn floor(self) -> Self {
        Self {
            cols: self.cols.max(1),
            rows: self.rows.max(1),
            ..self
        }
    }

    fn min(self, other: Self) -> Self {
        Self {
            cols: self.cols.min(other.cols),
            rows: self.rows.min(other.rows),
            cell_width_px: self.cell_width_px.min(other.cell_width_px),
            cell_height_px: self.cell_height_px.min(other.cell_height_px),
        }
    }
}

/// Reconciles every connected client's geometry into the single size the shared
/// pty can have.
///
/// The coalesced size is the per-axis minimum across all connected clients: a
/// larger viewer can letterbox a small grid, but a smaller viewer cannot show
/// columns that do not fit, so sizing to the smallest is what keeps the content
/// readable everywhere. Cell pixels are minimised on the same rule — they scale
/// Kitty graphics, and the smallest cell is the one every client can render
/// within.
///
/// `applied` tracks what the daemon was last told, so a join or resize that
/// does not move the minimum sends nothing.
#[derive(Debug)]
pub struct TerminalSizeCoalescer {
    clients: HashMap<u64, TerminalViewSize>,
    applied: TerminalViewSize,
}

impl TerminalSizeCoalescer {
    /// `applied` is the size already established with the daemon by the attach
    /// handshake, so the client that opened the attach does not re-send it.
    pub fn new(applied: TerminalViewSize) -> Self {
        Self {
            clients: HashMap::new(),
            applied,
        }
    }

    /// Records a client's geometry on connect or resize.
    ///
    /// A degenerate size is ignored outright rather than recorded: the client
    /// stays connected and keeps whatever geometry it last reported, so a
    /// transient 0 during layout leaves the shared pty alone instead of
    /// collapsing it. See `TerminalViewSize::is_usable`.
    ///
    /// Returns the size to send to the daemon, or `None` when the coalesced
    /// size is unchanged.
    pub fn set(&mut self, client: u64, size: TerminalViewSize) -> Option<TerminalViewSize> {
        if !size.is_usable() {
            return None;
        }
        self.clients.insert(client, size);
        self.reconcile()
    }

    /// Drops a disconnecting client.
    ///
    /// Returns `None` once the last client leaves: nobody is watching, and
    /// resizing a pty with no viewers would only reflow the next viewer's
    /// scrollback for nothing.
    pub fn remove(&mut self, client: u64) -> Option<TerminalViewSize> {
        self.clients.remove(&client);
        if self.clients.is_empty() {
            return None;
        }
        self.reconcile()
    }

    /// The minimum across connected clients, or `None` when there are none.
    pub fn coalesced(&self) -> Option<TerminalViewSize> {
        self.clients.values().copied().reduce(TerminalViewSize::min)
    }

    /// What the daemon was last told.
    #[cfg(test)]
    pub fn applied(&self) -> TerminalViewSize {
        self.applied
    }

    fn reconcile(&mut self) -> Option<TerminalViewSize> {
        // `set` already refuses degenerate sizes, so the floor is a backstop
        // for the seeded `applied` value coming from an attach handshake this
        // module did not perform: nothing below 1x1 ever reaches the daemon.
        let coalesced = self.coalesced()?.floor();
        if coalesced == self.applied {
            return None;
        }
        self.applied = coalesced;
        Some(coalesced)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(cols: u16, rows: u16) -> TerminalViewSize {
        TerminalViewSize::new(cols, rows)
    }

    #[test]
    fn replay_starts_empty() {
        let buffer = TerminalReplayBuffer::new(64);
        assert_eq!(buffer.snapshot(), None);
        assert_eq!(buffer.len(), 0);
    }

    #[test]
    fn replay_concatenates_chunks_in_order() {
        let mut buffer = TerminalReplayBuffer::new(64);
        buffer.push(Bytes::from_static(b"hello "));
        buffer.push(Bytes::from_static(b"world"));
        assert_eq!(buffer.snapshot(), Some(Bytes::from_static(b"hello world")));
        assert_eq!(buffer.len(), 11);
    }

    #[test]
    fn replay_ignores_empty_chunks() {
        let mut buffer = TerminalReplayBuffer::new(64);
        buffer.push(Bytes::new());
        assert_eq!(buffer.snapshot(), None);
    }

    #[test]
    fn replay_evicts_oldest_chunks_past_the_cap() {
        let mut buffer = TerminalReplayBuffer::new(8);
        buffer.push(Bytes::from_static(b"aaaa"));
        buffer.push(Bytes::from_static(b"bbbb"));
        buffer.push(Bytes::from_static(b"cccc"));
        assert_eq!(buffer.snapshot(), Some(Bytes::from_static(b"bbbbcccc")));
        assert_eq!(buffer.len(), 8);
    }

    #[test]
    fn replay_keeps_only_the_tail_of_an_oversized_chunk() {
        let mut buffer = TerminalReplayBuffer::new(4);
        buffer.push(Bytes::from_static(b"old"));
        buffer.push(Bytes::from_static(b"0123456789"));
        assert_eq!(buffer.snapshot(), Some(Bytes::from_static(b"6789")));
        assert_eq!(buffer.len(), 4);
    }

    #[test]
    fn replay_with_zero_capacity_keeps_nothing() {
        let mut buffer = TerminalReplayBuffer::new(0);
        buffer.push(Bytes::from_static(b"anything"));
        assert_eq!(buffer.snapshot(), None);
    }

    #[test]
    fn first_client_matching_the_attach_size_sends_no_resize() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        assert_eq!(coalescer.set(1, size(120, 40)), None);
        assert_eq!(coalescer.applied(), size(120, 40));
    }

    #[test]
    fn joining_smaller_client_shrinks_the_pty() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        assert_eq!(coalescer.set(1, size(120, 40)), None);
        assert_eq!(coalescer.set(2, size(60, 25)), Some(size(60, 25)));
        assert_eq!(coalescer.applied(), size(60, 25));
    }

    #[test]
    fn joining_larger_client_does_not_grow_the_pty() {
        let mut coalescer = TerminalSizeCoalescer::new(size(60, 25));
        assert_eq!(coalescer.set(1, size(60, 25)), None);
        assert_eq!(coalescer.set(2, size(200, 60)), None);
        assert_eq!(coalescer.applied(), size(60, 25));
    }

    #[test]
    fn minimum_is_taken_per_axis_across_many_clients() {
        let mut coalescer = TerminalSizeCoalescer::new(size(200, 60));
        coalescer.set(1, size(200, 60));
        coalescer.set(2, size(80, 90));
        assert_eq!(coalescer.set(3, size(150, 30)), Some(size(80, 30)));
        assert_eq!(coalescer.coalesced(), Some(size(80, 30)));
    }

    #[test]
    fn cell_pixels_coalesce_to_the_smallest_reported() {
        let mut coalescer = TerminalSizeCoalescer::new(TerminalViewSize {
            cols: 100,
            rows: 40,
            cell_width_px: 12,
            cell_height_px: 24,
        });
        coalescer.set(
            1,
            TerminalViewSize {
                cols: 100,
                rows: 40,
                cell_width_px: 12,
                cell_height_px: 24,
            },
        );
        assert_eq!(
            coalescer.set(
                2,
                TerminalViewSize {
                    cols: 100,
                    rows: 40,
                    cell_width_px: 8,
                    cell_height_px: 30,
                },
            ),
            Some(TerminalViewSize {
                cols: 100,
                rows: 40,
                cell_width_px: 8,
                cell_height_px: 24,
            })
        );
    }

    #[test]
    fn resizing_a_client_recomputes_the_minimum() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        coalescer.set(1, size(120, 40));
        assert_eq!(coalescer.set(2, size(60, 25)), Some(size(60, 25)));
        // The small client grows, so the pty may grow back to the other client.
        assert_eq!(coalescer.set(2, size(120, 40)), Some(size(120, 40)));
    }

    #[test]
    fn repeated_identical_updates_send_no_redundant_resize() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        assert_eq!(coalescer.set(1, size(80, 24)), Some(size(80, 24)));
        assert_eq!(coalescer.set(1, size(80, 24)), None);
        assert_eq!(coalescer.set(2, size(100, 50)), None);
        assert_eq!(coalescer.set(2, size(100, 50)), None);
    }

    #[test]
    fn disconnect_releases_the_constraint_it_imposed() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        coalescer.set(1, size(120, 40));
        assert_eq!(coalescer.set(2, size(60, 25)), Some(size(60, 25)));
        assert_eq!(coalescer.remove(2), Some(size(120, 40)));
        assert_eq!(coalescer.applied(), size(120, 40));
    }

    #[test]
    fn disconnect_of_a_non_constraining_client_sends_nothing() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        coalescer.set(1, size(60, 25));
        coalescer.set(2, size(120, 40));
        assert_eq!(coalescer.remove(2), None);
        assert_eq!(coalescer.applied(), size(60, 25));
    }

    #[test]
    fn last_client_leaving_does_not_resize() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        coalescer.set(1, size(60, 25));
        assert_eq!(coalescer.remove(1), None);
        assert_eq!(coalescer.coalesced(), None);
        // The daemon was last told the small size and is left that way.
        assert_eq!(coalescer.applied(), size(60, 25));
    }

    #[test]
    fn removing_an_unknown_client_is_inert() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        coalescer.set(1, size(60, 25));
        assert_eq!(coalescer.remove(99), None);
        assert_eq!(coalescer.applied(), size(60, 25));
    }

    #[test]
    fn a_zero_size_client_joining_does_not_collapse_the_pty() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        coalescer.set(1, size(120, 40));
        // Mobile Safari measuring a pane before layout settles.
        assert_eq!(coalescer.set(2, size(0, 0)), None);
        assert_eq!(coalescer.set(3, size(80, 0)), None);
        assert_eq!(coalescer.set(4, size(0, 24)), None);
        assert_eq!(coalescer.coalesced(), Some(size(120, 40)));
        assert_eq!(coalescer.applied(), size(120, 40));
    }

    #[test]
    fn a_client_set_holding_only_zero_sizes_never_resizes() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        assert_eq!(coalescer.set(1, size(0, 0)), None);
        assert_eq!(coalescer.set(2, size(0, 30)), None);
        // Nothing was recorded, so there is no coalesced size to send at all.
        assert_eq!(coalescer.coalesced(), None);
        assert_eq!(coalescer.applied(), size(120, 40));
        // The first real report still lands.
        assert_eq!(coalescer.set(1, size(90, 30)), Some(size(90, 30)));
    }

    #[test]
    fn a_zero_resize_from_a_connected_client_keeps_its_last_good_size() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        coalescer.set(1, size(120, 40));
        assert_eq!(coalescer.set(2, size(60, 25)), Some(size(60, 25)));
        // The phone is backgrounded and reports a collapsed viewport.
        assert_eq!(coalescer.set(2, size(0, 0)), None);
        assert_eq!(coalescer.coalesced(), Some(size(60, 25)));
        assert_eq!(coalescer.applied(), size(60, 25));
        // It comes back to the foreground and reports real geometry again.
        assert_eq!(coalescer.set(2, size(70, 30)), Some(size(70, 30)));
    }

    #[test]
    fn a_zero_size_client_still_releases_cleanly() {
        let mut coalescer = TerminalSizeCoalescer::new(size(120, 40));
        coalescer.set(1, size(60, 25));
        coalescer.set(2, size(0, 0));
        // Client 2 was never recorded, so its disconnect changes nothing.
        assert_eq!(coalescer.remove(2), None);
        assert_eq!(coalescer.coalesced(), Some(size(60, 25)));
    }

    #[test]
    fn a_degenerate_attach_size_is_floored_rather_than_sent_back() {
        // The attach handshake seeds `applied`; if it seeded a zero the floor
        // keeps anything below 1x1 from reaching the daemon.
        let mut coalescer = TerminalSizeCoalescer::new(size(0, 0));
        assert_eq!(coalescer.set(1, size(80, 24)), Some(size(80, 24)));
        assert!(coalescer.applied().cols >= 1 && coalescer.applied().rows >= 1);
    }
}
