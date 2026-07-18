use std::collections::VecDeque;

const DEQUE_SHRINK_OCCUPANCY_DENOMINATOR: usize = 4;

/// Bounded, chunked terminal scrollback.
///
/// Each push scans only the new data for line boundaries. Eviction advances an
/// offset through the oldest chunk, so retained text is not shifted on every
/// line. The front chunk is compacted only after its discarded prefix is at
/// least as large as its retained suffix, which bounds unused allocation while
/// keeping compaction work geometric.
#[derive(Debug)]
pub(crate) struct TerminalHistory {
    chunks: VecDeque<HistoryChunk>,
    total_lines: usize,
    line_limit: usize,
}

#[derive(Debug)]
struct HistoryChunk {
    data: String,
    start: usize,
    newline_count: usize,
}

impl HistoryChunk {
    fn new(data: &str) -> Self {
        Self {
            data: data.to_owned(),
            start: 0,
            newline_count: count_newlines(data),
        }
    }

    fn retained(&self) -> &str {
        &self.data[self.start..]
    }

    fn discard_through_newline(&mut self, count: usize) {
        debug_assert!(count > 0);
        debug_assert!(count <= self.newline_count);

        let cut = byte_index_after_nth_newline(self.retained(), count);
        self.start += cut;
        self.newline_count -= count;
        self.compact_if_geometric();
    }

    fn compact_if_geometric(&mut self) {
        let retained_len = self.data.len() - self.start;
        if self.start == 0 || self.start < retained_len {
            return;
        }

        if retained_len == 0 {
            self.data.clear();
        } else {
            self.data = self.data[self.start..].to_owned();
        }
        self.start = 0;
    }

    fn is_empty(&self) -> bool {
        self.retained().is_empty()
    }
}

impl TerminalHistory {
    pub(crate) fn new(line_limit: usize) -> Self {
        Self {
            chunks: VecDeque::new(),
            total_lines: 0,
            line_limit,
        }
    }

    pub(crate) fn line_limit(&self) -> usize {
        self.line_limit
    }

    pub(crate) fn push(&mut self, data: &str) {
        if self.line_limit == 0 {
            self.clear();
            return;
        }
        if data.is_empty() {
            return;
        }

        let chunk = HistoryChunk::new(data);
        self.total_lines += chunk.newline_count;
        self.chunks.push_back(chunk);
        self.evict();
    }

    pub(crate) fn clear(&mut self) {
        self.chunks = VecDeque::new();
        self.total_lines = 0;
    }

    pub(crate) fn snapshot(&self) -> String {
        let capacity = self.chunks.iter().map(|chunk| chunk.retained().len()).sum();
        let mut snapshot = String::with_capacity(capacity);
        for chunk in &self.chunks {
            snapshot.push_str(chunk.retained());
        }
        snapshot
    }

    fn evict(&mut self) {
        let chunks_before_eviction = self.chunks.len();
        while self.total_lines > self.line_limit {
            let overflow = self.total_lines - self.line_limit;
            let Some(front_lines) = self.chunks.front().map(|chunk| chunk.newline_count) else {
                break;
            };

            // If the cut falls after this chunk, its trailing partial line is
            // part of an evicted line too. If the cut lands on this chunk's
            // final newline, however, the trailing partial must be retained.
            if front_lines < overflow {
                let removed = self.chunks.pop_front().expect("front chunk exists");
                self.total_lines -= removed.newline_count;
                continue;
            }

            let front = self.chunks.front_mut().expect("front chunk exists");
            front.discard_through_newline(overflow);
            self.total_lines -= overflow;
            if front.is_empty() {
                self.chunks.pop_front();
            }
        }
        self.compact_chunk_slots_after_eviction(chunks_before_eviction);
    }

    fn compact_chunk_slots_after_eviction(&mut self, chunks_before_eviction: usize) {
        if self.chunks.len() == chunks_before_eviction {
            return;
        }
        if self.chunks.is_empty() {
            self.chunks = VecDeque::new();
            return;
        }
        // Shrinking only at quarter occupancy leaves a full growth step of
        // hysteresis after `shrink_to_fit`: a steady push may grow the deque
        // to twice the live length, but the following eviction will not
        // immediately shrink it again.
        if self.chunks.len() <= self.chunks.capacity() / DEQUE_SHRINK_OCCUPANCY_DENOMINATOR {
            self.chunks.shrink_to_fit();
        }
    }
}

fn count_newlines(data: &str) -> usize {
    data.as_bytes()
        .iter()
        .filter(|byte| **byte == b'\n')
        .count()
}

/// Byte index just after the `count`-th newline.
///
/// A newline is one UTF-8 byte, so the returned index is always a character
/// boundary. Callers guarantee that the requested newline exists.
fn byte_index_after_nth_newline(data: &str, count: usize) -> usize {
    let mut remaining = count;
    for (index, byte) in data.bytes().enumerate() {
        if byte != b'\n' {
            continue;
        }
        remaining -= 1;
        if remaining == 0 {
            return index + 1;
        }
    }
    unreachable!("requested newline must exist")
}

#[cfg(test)]
mod tests {
    use super::TerminalHistory;

    fn legacy_push(history: &mut String, data: &str, line_limit: usize) {
        history.push_str(data);
        if line_limit == 0 {
            history.clear();
            return;
        }
        let line_count = history
            .as_bytes()
            .iter()
            .filter(|byte| **byte == b'\n')
            .count();
        if line_count <= line_limit {
            return;
        }
        let mut lines_to_remove = line_count - line_limit;
        let truncate_at = history
            .char_indices()
            .find_map(|(index, character)| {
                if character != '\n' {
                    return None;
                }
                lines_to_remove -= 1;
                (lines_to_remove == 0).then_some(index + character.len_utf8())
            })
            .unwrap_or(0);
        history.drain(..truncate_at);
    }

    #[test]
    fn matches_the_legacy_line_drain_behavior() {
        let mut history = TerminalHistory::new(2);
        history.push("one\ntwo\nthree\n");
        history.push("four\n");
        assert_eq!(history.snapshot(), "three\nfour\n");
    }

    #[test]
    fn preserves_a_partial_line_when_its_chunk_also_contains_the_evicted_line() {
        let mut history = TerminalHistory::new(1);
        history.push("old\nprompt ");
        history.push("new\n");
        assert_eq!(history.snapshot(), "prompt new\n");
    }

    #[test]
    fn recognizes_line_boundaries_split_across_pushes() {
        let mut history = TerminalHistory::new(2);
        history.push("one");
        history.push("\ntw");
        history.push("o\nthr");
        history.push("ee\nprompt");
        assert_eq!(history.snapshot(), "two\nthree\nprompt");
    }

    #[test]
    fn preserves_crlf_bytes_while_counting_lf_boundaries() {
        let mut history = TerminalHistory::new(1);
        history.push("old\r\nprompt ");
        history.push("next\r");
        history.push("\n");
        assert_eq!(history.snapshot(), "prompt next\r\n");
    }

    #[test]
    fn keeps_multibyte_characters_intact_across_eviction() {
        let mut history = TerminalHistory::new(1);
        history.push("héllo\n");
        history.push("wörld");
        history.push(" 🌍\n");
        assert_eq!(history.snapshot(), "wörld 🌍\n");
    }

    #[test]
    fn empty_input_is_a_no_op() {
        let mut history = TerminalHistory::new(1);
        history.push("prompt ");
        history.push("");
        assert_eq!(history.snapshot(), "prompt ");
    }

    #[test]
    fn zero_limit_never_retains_output() {
        let mut history = TerminalHistory::new(0);
        history.push("ignored\nprompt");
        assert!(history.snapshot().is_empty());
        assert_eq!(history.line_limit(), 0);
    }

    #[test]
    fn clear_discards_output_without_changing_the_limit() {
        let mut history = TerminalHistory::new(2);
        history.push("one\ntwo\nprompt");
        history.clear();
        assert!(history.snapshot().is_empty());
        assert_eq!(history.line_limit(), 2);

        history.push("fresh\n");
        assert_eq!(history.snapshot(), "fresh\n");
    }

    #[test]
    fn evicts_whole_chunks_before_trimming_a_prefix() {
        let mut history = TerminalHistory::new(3);
        history.push("a\n");
        history.push("b\n");
        history.push("c\n");
        history.push("d\ne\n");
        assert_eq!(history.snapshot(), "c\nd\ne\n");
    }

    #[test]
    fn trims_a_prefix_within_a_single_large_chunk() {
        let mut history = TerminalHistory::new(2);
        history.push("l1\nl2\nl3\nl4\n");
        assert_eq!(history.snapshot(), "l3\nl4\n");
    }

    #[test]
    fn preserves_five_thousand_line_semantics_over_many_pushes() {
        let mut history = TerminalHistory::new(5_000);
        for index in 0..10_000 {
            history.push(&format!("line-{index}\n"));
        }
        let snapshot = history.snapshot();
        assert_eq!(snapshot.matches('\n').count(), 5_000);
        assert!(snapshot.starts_with("line-5000\n"));
        assert!(snapshot.ends_with("line-9999\n"));
    }

    #[test]
    fn releases_peak_deque_capacity_after_mass_eviction_and_clear() {
        let mut history = TerminalHistory::new(1);
        for _ in 0..4_096 {
            history.push("x");
        }
        history.push("\n");
        let peak_capacity = history.chunks.capacity();
        assert!(peak_capacity >= 4_096);

        history.push("z\n");
        assert_eq!(history.snapshot(), "z\n");
        assert!(
            history.chunks.capacity() <= 8,
            "mass eviction retained capacity {} from peak {peak_capacity}",
            history.chunks.capacity()
        );

        history.clear();
        assert_eq!(history.chunks.capacity(), 0);
        history.push("fresh\n");
        assert_eq!(history.snapshot(), "fresh\n");
        assert!(history.chunks.capacity() <= 8);
    }

    #[test]
    fn steady_state_eviction_preserves_deque_capacity_hysteresis() {
        let mut history = TerminalHistory::new(1_024);
        for _ in 0..1_024 {
            history.push("x\n");
        }

        history.push("y\n");
        let steady_capacity = history.chunks.capacity();
        assert_eq!(history.chunks.len(), 1_024);
        assert!(
            steady_capacity > history.chunks.len(),
            "eviction shrank the deque back to a full allocation"
        );

        for _ in 0..128 {
            history.push("z\n");
            assert_eq!(history.chunks.len(), 1_024);
            assert_eq!(
                history.chunks.capacity(),
                steady_capacity,
                "steady push/evict cycle changed deque capacity"
            );
        }
    }

    #[test]
    fn matches_the_reference_model_across_deterministic_chunkings() {
        let chunkings = [
            vec!["α\r\nbravo\ncharlie🙂\nΔpartial"],
            vec![
                "α", "\r", "\n", "br", "avo\nch", "arlie", "🙂", "\nΔ", "partial",
            ],
            vec!["", "α\r", "\nbravo", "\ncharlie🙂", "\n", "Δpartial", ""],
        ];

        for line_limit in 0..=4 {
            for chunks in &chunkings {
                let mut expected = String::new();
                let mut actual = TerminalHistory::new(line_limit);
                for chunk in chunks {
                    legacy_push(&mut expected, chunk, line_limit);
                    actual.push(chunk);
                    assert_eq!(
                        actual.snapshot(),
                        expected,
                        "line_limit={line_limit}, chunk={chunk:?}"
                    );
                }
            }
        }
    }
}
