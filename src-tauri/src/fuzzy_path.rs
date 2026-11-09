//! Fuzzy file-path scoring for the quick-open file index.
//!
//! A bounded greedy alignment (case-insensitive subsequence match) with
//! boundary, camelCase, adjacency and exact-substring bonuses. This is not a
//! full Smith-Waterman DP: the index can hold tens of thousands of paths and
//! scoring runs on every keystroke, so each candidate costs O(path length).

/// Matched-character base score.
const MATCH_BASE: i32 = 16;
/// Match starts a path segment / word (`/ \ _ - . space`).
const BOUNDARY_BONUS: i32 = 12;
/// Match starts a camelCase word (`fooBar` → `B`).
const CAMEL_BONUS: i32 = 10;
/// Match sits directly after the previous matched character.
const ADJACENT_BONUS: i32 = 12;
/// Per skipped character between matches.
const GAP_PENALTY: i32 = 1;
/// Cap so one large gap cannot swamp an otherwise good match.
const MAX_GAP_PENALTY: i32 = 20;
/// The whole query appears contiguously.
const EXACT_BONUS: i32 = 60;
/// Earlier matches score better (base name vs nested directory).
const START_BONUS_MAX: i32 = 20;
/// Query matched the file name rather than only its directory path.
const NAME_BONUS: i32 = 40;
/// Candidate start positions tried per text (bounds the greedy scoring).
const MAX_STARTS: usize = 8;

fn is_boundary(prev: char) -> bool {
    matches!(prev, '/' | '\\' | '_' | '-' | '.' | ' ')
}

fn score_positions(original: &[char], positions: &[usize]) -> i32 {
    let mut score = 0;
    let mut previous: Option<usize> = None;
    for &pos in positions {
        score += MATCH_BASE;
        if let Some(prev) = previous {
            if pos == prev + 1 {
                score += ADJACENT_BONUS;
            } else {
                let gap = (pos - prev - 1).min(MAX_GAP_PENALTY as usize) as i32;
                score -= gap * GAP_PENALTY;
            }
        }
        let char_at = original[pos];
        if pos == 0 || is_boundary(original[pos - 1]) {
            score += BOUNDARY_BONUS;
        } else if char_at.is_ascii_uppercase() && original[pos - 1].is_ascii_lowercase() {
            score += CAMEL_BONUS;
        }
        previous = Some(pos);
    }
    let start = positions[0] as i32;
    score += (START_BONUS_MAX - start).max(0);
    let span = positions[positions.len() - 1] - positions[0] + 1;
    if span == positions.len() {
        score += EXACT_BONUS;
    }
    score
}

fn subsequence_positions(haystack: &[char], needle: &[char], start: usize) -> Option<Vec<usize>> {
    let mut positions = Vec::with_capacity(needle.len());
    let mut index = start;
    for wanted in needle {
        while index < haystack.len() && haystack[index] != *wanted {
            index += 1;
        }
        if index == haystack.len() {
            return None;
        }
        positions.push(index);
        index += 1;
    }
    Some(positions)
}

fn score_text(original: &str, lowered_text: &str, needle: &[char]) -> Option<i32> {
    if original.is_empty() || lowered_text.is_empty() || needle.is_empty() {
        return None;
    }
    let original: Vec<char> = original.chars().collect();
    let lowered: Vec<char> = lowered_text.chars().collect();
    let first = needle[0];
    let mut best: Option<i32> = None;
    let mut tried = 0;
    for (index, &ch) in lowered.iter().enumerate() {
        if ch != first {
            continue;
        }
        if tried >= MAX_STARTS {
            break;
        }
        tried += 1;
        let Some(positions) = subsequence_positions(&lowered, needle, index) else {
            continue;
        };
        let score = score_positions(&original, &positions);
        best = Some(best.map_or(score, |current| current.max(score)));
        // A contiguous match is already optimal for this start; stop early.
        if positions.windows(2).all(|pair| pair[1] == pair[0] + 1) {
            break;
        }
    }
    best
}

/// A candidate whose lowercase forms were prepared once by the caller.
pub struct FuzzyTarget<'a> {
    pub text: &'a str,
    pub lowered_text: &'a str,
    pub name: &'a str,
    pub lowered_name: &'a str,
}

/// Fold a query once per search instead of once per candidate.
///
/// ASCII-only folding keeps char indices aligned with the original text
/// (Unicode lowercasing can change a string's length).
pub fn prepare_query(query: &str) -> Option<Vec<char>> {
    if query.is_empty() {
        return None;
    }
    Some(query.to_ascii_lowercase().chars().collect())
}

/// Score a candidate against a prepared query.
///
/// Returns `None` when the query is not a subsequence of either the path or
/// the file name. Callers sort by descending score; ties are theirs to break.
pub fn score_prepared(target: &FuzzyTarget<'_>, needle: &[char]) -> Option<i32> {
    if target.text.is_empty() || needle.is_empty() {
        return None;
    }
    let path_score = score_text(target.text, target.lowered_text, needle);
    let name_score =
        score_text(target.name, target.lowered_name, needle).map(|score| score + NAME_BONUS);
    match (path_score, name_score) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// Convenience wrapper that prepares a single candidate (tests only).
#[cfg(test)]
pub fn score_path(relative_path: &str, name: &str, query: &str) -> Option<i32> {
    let needle = prepare_query(query)?;
    let lowered_path = relative_path.to_ascii_lowercase();
    let lowered_name = name.to_ascii_lowercase();
    score_prepared(
        &FuzzyTarget {
            text: relative_path,
            lowered_text: &lowered_path,
            name,
            lowered_name: &lowered_name,
        },
        &needle,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_or_unmatched_query_scores_none() {
        assert_eq!(score_path("src/app.ts", "app.ts", ""), None);
        assert_eq!(score_path("src/app.ts", "app.ts", "zzz"), None);
    }

    #[test]
    fn case_insensitive_subsequence_matches() {
        assert!(score_path("src/FooBar.ts", "FooBar.ts", "fbr").is_some());
        assert!(score_path("src/FooBar.ts", "FooBar.ts", "FOOBAR").is_some());
    }

    #[test]
    fn exact_contiguous_beats_scattered() {
        let exact = score_path("src/user_service.ts", "user_service.ts", "user").unwrap();
        let scattered = score_path("src/u_s_e_r.ts", "u_s_e_r.ts", "user").unwrap();
        assert!(exact > scattered, "exact={exact} scattered={scattered}");
    }

    #[test]
    fn basename_beats_directory_only_match() {
        let name = score_path("src/app.ts", "app.ts", "app").unwrap();
        let dir = score_path("app/src/index.ts", "index.ts", "app").unwrap();
        assert!(name > dir, "name={name} dir={dir}");
    }

    #[test]
    fn camel_boundary_scores_above_mid_word() {
        let camel = score_path("src/FooBar.ts", "FooBar.ts", "fb").unwrap();
        let mid = score_path("src/xfooBar.ts", "xfooBar.ts", "fb").unwrap();
        assert!(camel > mid, "camel={camel} mid={mid}");
    }

    #[test]
    fn prepared_scoring_matches_the_convenience_wrapper() {
        let path = "src/FooBar.ts";
        let name = "FooBar.ts";
        let needle = prepare_query("fb").expect("query");
        let lowered_path = path.to_ascii_lowercase();
        let lowered_name = name.to_ascii_lowercase();
        let prepared = score_prepared(
            &FuzzyTarget {
                text: path,
                lowered_text: &lowered_path,
                name,
                lowered_name: &lowered_name,
            },
            &needle,
        );

        assert_eq!(prepared, score_path(path, name, "fb"));
    }

    #[test]
    fn query_can_match_path_segments() {
        assert!(score_path("src/components/app.ts", "app.ts", "src/comp").is_some());
        assert!(score_path("src/components/app.ts", "app.ts", "components/app").is_some());
    }
}
