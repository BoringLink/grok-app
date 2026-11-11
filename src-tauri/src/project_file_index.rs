//! Cached per-project file index for the Files pane quick-open search.
//!
//! The tree is walked once per project and reused for [`FILE_INDEX_TTL`], so
//! typing does not re-scan the filesystem on every keystroke. Ranking uses the
//! greedy fuzzy scorer in [`crate::fuzzy_path`]; hits are files only (the pane
//! already has its own directory tree).

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use crate::fuzzy_path::{prepare_query, score_prepared, FuzzyTarget};
use crate::process_util;
use crate::project_codebase_search::clamp_codebase_search_limit;
use crate::project_walk::{
    add_rg_base_excludes, mtime_ms, relative_to_root, ProjectWalk, WalkEntry,
};

/// Hard cap on indexed files per project (memory bound).
pub const FILE_INDEX_MAX_ENTRIES: usize = 50_000;
/// How long a built index serves queries before it is rebuilt.
pub const FILE_INDEX_TTL: Duration = Duration::from_secs(5);
/// Cached projects kept in memory before the oldest is evicted.
const FILE_INDEX_MAX_PROJECTS: usize = 8;
/// Guard against pathological queries from non-UI callers.
const FILE_INDEX_MAX_QUERY_CHARS: usize = 200;

/// One indexed file. Mirrors the codebase-search hit shape the UI already uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexHit {
    pub path: String,
    pub name: String,
    pub relative_path: String,
    pub size: u64,
    pub mtime_ms: u64,
}

/// Result of one fuzzy quick-open search.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexSearchResult {
    pub hits: Vec<FileIndexHit>,
    pub project_path: String,
    pub query: String,
    pub limit: usize,
    /// More matches exist than were returned.
    pub truncated: bool,
    /// The index hit [`FILE_INDEX_MAX_ENTRIES`], so some files are not indexed.
    pub index_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub soft_fail: Option<String>,
}

/// Indexed file plus the lowercase forms used by fuzzy scoring. Preparing
/// them once per index build keeps each keystroke free of per-candidate
/// lowercasing allocations.
struct IndexedFile {
    hit: FileIndexHit,
    lowered_relative_path: String,
    lowered_name: String,
}

struct FileIndexSnapshot {
    entries: Vec<IndexedFile>,
    index_truncated: bool,
}

struct CachedFileIndex {
    built_at: Instant,
    snapshot: Arc<FileIndexSnapshot>,
}

static FILE_INDEXES: OnceLock<Mutex<HashMap<String, CachedFileIndex>>> = OnceLock::new();

fn indexes() -> &'static Mutex<HashMap<String, CachedFileIndex>> {
    FILE_INDEXES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn build_snapshot(root: &Path) -> FileIndexSnapshot {
    let (paths, index_truncated) = collect_paths(root);
    let mut entries: Vec<IndexedFile> = paths
        .into_iter()
        .filter_map(|relative_path| {
            let absolute = root.join(&relative_path);
            let meta = fs::metadata(&absolute).ok()?;
            if !meta.is_file() {
                return None;
            }
            let name = absolute.file_name()?.to_string_lossy().to_string();
            Some(IndexedFile {
                lowered_relative_path: relative_path.to_ascii_lowercase(),
                lowered_name: name.to_ascii_lowercase(),
                hit: FileIndexHit {
                    path: absolute.to_string_lossy().to_string(),
                    name,
                    relative_path,
                    size: meta.len(),
                    mtime_ms: mtime_ms(&meta),
                },
            })
        })
        .collect();
    entries.sort_by(|a, b| a.hit.relative_path.cmp(&b.hit.relative_path));
    FileIndexSnapshot {
        entries,
        index_truncated,
    }
}

/// Prefer `rg --files`: it honours `.gitignore` / `.ignore` and is the same
/// enumeration VS Code-style quick open relies on. Falls back to the shared
/// bounded walk when ripgrep is unavailable or fails.
fn collect_paths(root: &Path) -> (Vec<String>, bool) {
    if let Some(found) = collect_paths_via_rg(root) {
        return found;
    }
    collect_paths_via_walk(root)
}

fn collect_paths_via_rg(root: &Path) -> Option<(Vec<String>, bool)> {
    let rg = which::which("rg").ok()?;
    let mut command = process_util::command(rg);
    command
        .current_dir(root)
        .arg("--files")
        .arg("--color=never");
    add_rg_base_excludes(&mut command);
    command.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = command.spawn().ok()?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let mut paths: Vec<String> = Vec::new();
    let mut truncated = false;
    for line in BufReader::new(stdout).lines().map_while(Result::ok) {
        let relative_path = line.trim();
        if relative_path.is_empty() {
            continue;
        }
        if paths.len() >= FILE_INDEX_MAX_ENTRIES {
            truncated = true;
            break;
        }
        paths.push(relative_path.to_string());
    }
    if truncated {
        let _ = child.kill();
    }
    let status = child.wait().ok()?;
    if truncated {
        return Some((paths, true));
    }
    // Non-zero (other than a kill we initiated) means rg could not enumerate
    // the tree; fall back to the walk instead of reporting an empty project.
    if !status.success() {
        return None;
    }
    Some((paths, false))
}

fn collect_paths_via_walk(root: &Path) -> (Vec<String>, bool) {
    let mut walk = ProjectWalk::new(root, Some(FILE_INDEX_MAX_ENTRIES));
    let paths = walk
        .by_ref()
        .filter_map(|entry| match entry {
            WalkEntry::File { path, .. } => Some(relative_to_root(root, &path)),
            WalkEntry::Dir { .. } => None,
        })
        .collect();
    (paths, walk.truncated())
}

fn snapshot_for(root: &Path) -> Arc<FileIndexSnapshot> {
    let key = root.to_string_lossy().to_string();
    {
        let cache = indexes().lock();
        if let Some(cached) = cache.get(&key) {
            if cached.built_at.elapsed() < FILE_INDEX_TTL {
                return cached.snapshot.clone();
            }
        }
    }
    // Build without the lock: a slow walk/rg spawn must not block queries for
    // other projects. Concurrent rebuilds of the same project are harmless.
    let snapshot = Arc::new(build_snapshot(root));
    let mut cache = indexes().lock();
    if let Some(cached) = cache.get(&key) {
        if cached.built_at.elapsed() < FILE_INDEX_TTL {
            return cached.snapshot.clone();
        }
    }
    if cache.len() >= FILE_INDEX_MAX_PROJECTS && !cache.contains_key(&key) {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, cached)| cached.built_at)
            .map(|(project, _)| project.clone())
        {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        key,
        CachedFileIndex {
            built_at: Instant::now(),
            snapshot: snapshot.clone(),
        },
    );
    snapshot
}

/// Rank a snapshot without touching the filesystem (pure, unit-tested).
fn rank_hits(snapshot: &FileIndexSnapshot, query: &str, limit: usize) -> (Vec<FileIndexHit>, bool) {
    let Some(needle) = prepare_query(query) else {
        return (Vec::new(), false);
    };
    let mut scored: Vec<(i32, &IndexedFile)> = snapshot
        .entries
        .iter()
        .filter_map(|entry| {
            score_prepared(
                &FuzzyTarget {
                    text: &entry.hit.relative_path,
                    lowered_text: &entry.lowered_relative_path,
                    name: &entry.hit.name,
                    lowered_name: &entry.lowered_name,
                },
                &needle,
            )
            .map(|score| (score, entry))
        })
        .collect();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| {
                a.1.hit
                    .relative_path
                    .len()
                    .cmp(&b.1.hit.relative_path.len())
            })
            .then_with(|| a.1.hit.relative_path.cmp(&b.1.hit.relative_path))
    });
    let truncated = scored.len() > limit;
    let hits = scored
        .into_iter()
        .take(limit)
        .map(|(_, entry)| entry.hit.clone())
        .collect();
    (hits, truncated)
}

fn empty_result(
    project_path: &str,
    query: &str,
    limit: usize,
    soft_fail: &str,
) -> FileIndexSearchResult {
    FileIndexSearchResult {
        hits: Vec::new(),
        project_path: project_path.to_string(),
        query: query.to_string(),
        limit,
        truncated: false,
        index_truncated: false,
        soft_fail: Some(soft_fail.to_string()),
    }
}

/// Fuzzy quick-open search over the cached file index.
///
/// Soft-fails (never panics) for missing / non-directory / untrusted roots so
/// the pane can show an honest empty state.
pub fn search_project_files(
    project_path: &str,
    query: &str,
    limit: Option<usize>,
) -> FileIndexSearchResult {
    let limit = clamp_codebase_search_limit(limit);
    let query = query.trim();
    let raw = project_path.trim();
    if raw.is_empty() {
        return empty_result("", query, limit, "no_project");
    }
    if query.is_empty() {
        return empty_result(raw, "", limit, "empty_query");
    }
    if query.chars().count() > FILE_INDEX_MAX_QUERY_CHARS {
        return empty_result(raw, query, limit, "query_too_long");
    }

    let path = PathBuf::from(raw);
    if !path.exists() {
        return empty_result(raw, query, limit, "path_missing");
    }
    if !path.is_dir() {
        return empty_result(raw, query, limit, "not_a_dir");
    }
    let canonical = match path.canonicalize() {
        Ok(canonical) => canonical,
        Err(_) => return empty_result(raw, query, limit, "path_unreadable"),
    };
    if !crate::path_scope::is_allowed(&canonical) {
        return empty_result(raw, query, limit, "untrusted_project");
    }

    let snapshot = snapshot_for(&canonical);
    let (hits, truncated) = rank_hits(&snapshot, query, limit);
    FileIndexSearchResult {
        hits,
        project_path: canonical.to_string_lossy().to_string(),
        query: query.to_string(),
        limit,
        truncated,
        index_truncated: snapshot.index_truncated,
        soft_fail: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(relative_path: &str) -> FileIndexHit {
        let name = relative_path
            .rsplit('/')
            .next()
            .unwrap_or(relative_path)
            .to_string();
        FileIndexHit {
            path: format!("/repo/{relative_path}"),
            name,
            relative_path: relative_path.to_string(),
            size: 1,
            mtime_ms: 0,
        }
    }

    fn indexed(path: &str) -> IndexedFile {
        let hit = hit(path);
        IndexedFile {
            lowered_relative_path: hit.relative_path.to_ascii_lowercase(),
            lowered_name: hit.name.to_ascii_lowercase(),
            hit,
        }
    }

    fn snapshot(entries: &[&str]) -> FileIndexSnapshot {
        FileIndexSnapshot {
            entries: entries.iter().map(|path| indexed(path)).collect(),
            index_truncated: false,
        }
    }

    fn temp_root(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("grok-file-index-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    #[test]
    fn ranks_name_matches_ahead_of_deep_paths() {
        let index = snapshot(&["src/deep/nested/other.ts", "src/app.ts", "app/src/index.ts"]);

        let (hits, truncated) = rank_hits(&index, "app", 10);

        assert!(!truncated);
        assert_eq!(hits[0].relative_path, "src/app.ts");
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn applies_limit_and_reports_truncation() {
        let index = snapshot(&["a/app.ts", "b/app.ts", "c/app.ts"]);

        let (hits, truncated) = rank_hits(&index, "app", 2);

        assert_eq!(hits.len(), 2);
        assert!(truncated);
    }

    #[test]
    fn empty_query_soft_fails() {
        let result = search_project_files("/repo", "   ", None);

        assert!(result.hits.is_empty());
        assert_eq!(result.soft_fail.as_deref(), Some("empty_query"));
    }

    #[test]
    fn builds_an_index_and_skips_ignored_directories() {
        let root = temp_root("build");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("src/foo_bar.ts"), "x").unwrap();
        fs::write(root.join("README.md"), "x").unwrap();
        fs::write(root.join("node_modules/pkg.ts"), "x").unwrap();
        fs::write(root.join(".hidden/secret.ts"), "x").unwrap();

        let built = build_snapshot(&root);
        let paths: Vec<&str> = built
            .entries
            .iter()
            .map(|entry| entry.hit.relative_path.as_str())
            .collect();

        assert!(paths.contains(&"src/foo_bar.ts"));
        assert!(paths.contains(&"README.md"));
        assert!(!paths.contains(&"node_modules/pkg.ts"));
        assert!(!paths.contains(&".hidden/secret.ts"));
        assert!(!built.index_truncated);

        fs::remove_dir_all(&root).unwrap();
    }
}
