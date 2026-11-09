//! Shared bounded project filesystem walk used by codebase search and the
//! quick-open file index.
//!
//! One BFS implementation keeps skip rules, junk-file filtering, ripgrep
//! excludes and truncation semantics identical across both search paths.

use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::UNIX_EPOCH;

/// Directory names every project walk skips (dependency/build/VCS caches).
pub(crate) fn skip_dir_name(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | "target"
            | "dist"
            | "build"
            | ".next"
            | "vendor"
            | ".cache"
            | "repos"
            | ".venv"
            | "venv"
            | "__pycache__"
            | ".turbo"
            | "coverage"
            | "out"
            | ".pnpm-store"
            | ".yarn"
            | "Pods"
            | ".idea"
            | ".vscode"
            | "DerivedData"
    )
}

/// OS thumbnail/index files that are never project content.
pub(crate) fn is_junk_file_name(name: &str) -> bool {
    matches!(name, ".DS_Store" | "Thumbs.db")
}

pub(crate) fn relative_to_root(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

/// Modification time from meta already in hand (avoids a second stat).
pub(crate) fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn file_mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .map(|meta| mtime_ms(&meta))
        .unwrap_or(0)
}

/// `rg --glob` excludes shared by content search and file enumeration.
pub(crate) const RG_BASE_EXCLUDES: [&str; 9] = [
    "!node_modules/**",
    "!.git/**",
    "!target/**",
    "!dist/**",
    "!build/**",
    "!.next/**",
    "!vendor/**",
    "!__pycache__/**",
    "!.cache/**",
];

pub(crate) fn add_rg_base_excludes(command: &mut Command) {
    for glob in RG_BASE_EXCLUDES {
        command.arg("--glob").arg(glob);
    }
}

/// One directory or file yielded by [`ProjectWalk`].
pub(crate) enum WalkEntry {
    Dir {
        name: String,
        path: PathBuf,
    },
    File {
        name: String,
        path: PathBuf,
        meta: fs::Metadata,
    },
}

/// Breadth-first, bounded project walk.
///
/// Sorted? No — callers that need stable output sort themselves. Hidden
/// directories and [`skip_dir_name`] entries are never descended into.
pub(crate) struct ProjectWalk {
    queue: VecDeque<PathBuf>,
    current: Option<fs::ReadDir>,
    files_seen: usize,
    max_files: Option<usize>,
    truncated: bool,
}

impl ProjectWalk {
    pub(crate) fn new(root: &Path, max_files: Option<usize>) -> Self {
        let mut queue = VecDeque::new();
        queue.push_back(root.to_path_buf());
        Self {
            queue,
            current: None,
            files_seen: 0,
            max_files,
            truncated: false,
        }
    }

    pub(crate) fn files_seen(&self) -> usize {
        self.files_seen
    }

    /// True when the file cap stopped the walk.
    pub(crate) fn truncated(&self) -> bool {
        self.truncated
    }

    fn read_next(&mut self) -> Option<Result<fs::DirEntry, std::io::Error>> {
        loop {
            if self.current.is_some() {
                let next = self.current.as_mut().and_then(|read_dir| read_dir.next());
                match next {
                    Some(result) => return Some(result),
                    None => {
                        self.current = None;
                        continue;
                    }
                }
            }
            let dir = self.queue.pop_front()?;
            self.current = fs::read_dir(dir).ok();
        }
    }
}

impl Iterator for ProjectWalk {
    type Item = WalkEntry;

    fn next(&mut self) -> Option<WalkEntry> {
        loop {
            let entry = match self.read_next() {
                Some(Ok(entry)) => entry,
                Some(Err(_)) => continue,
                None => return None,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if is_junk_file_name(&name) {
                continue;
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                if skip_dir_name(&name) || name.starts_with('.') {
                    continue;
                }
                self.queue.push_back(path.clone());
                return Some(WalkEntry::Dir { name, path });
            }
            if !meta.is_file() {
                continue;
            }
            self.files_seen += 1;
            if let Some(max) = self.max_files {
                if self.files_seen > max {
                    self.truncated = true;
                    return None;
                }
            }
            return Some(WalkEntry::File { name, path, meta });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("grok-project-walk-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    #[test]
    fn walks_files_and_directories_but_skips_dependency_dirs() {
        let root = temp_root("walk");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("src/foo.ts"), "x").unwrap();
        fs::write(root.join("README.md"), "x").unwrap();
        fs::write(root.join("node_modules/pkg.ts"), "x").unwrap();
        fs::write(root.join(".hidden/secret.ts"), "x").unwrap();
        fs::write(root.join(".DS_Store"), "x").unwrap();

        let mut files = Vec::new();
        let mut dirs = Vec::new();
        let mut walk = ProjectWalk::new(&root, None);
        for entry in walk.by_ref() {
            match entry {
                WalkEntry::Dir { name, .. } => dirs.push(name),
                WalkEntry::File { path, .. } => {
                    files.push(relative_to_root(&root, &path));
                }
            }
        }

        assert!(dirs.contains(&"src".to_string()));
        assert!(files.contains(&"src/foo.ts".to_string()));
        assert!(files.contains(&"README.md".to_string()));
        assert!(!files.iter().any(|path| path.contains("node_modules")));
        assert!(!files.iter().any(|path| path.contains(".hidden")));
        assert!(!files.iter().any(|path| path.contains(".DS_Store")));
        assert!(!walk.truncated());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn caps_files_and_reports_truncation() {
        let root = temp_root("cap");
        for index in 0..3 {
            fs::write(root.join(format!("file{index}.txt")), "x").unwrap();
        }

        let mut walk = ProjectWalk::new(&root, Some(2));
        let mut count = 0;
        for _ in walk.by_ref() {
            count += 1;
        }

        assert_eq!(count, 2);
        assert!(walk.truncated());
        fs::remove_dir_all(&root).unwrap();
    }
}
