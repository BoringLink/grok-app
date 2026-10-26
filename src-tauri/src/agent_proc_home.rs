//! Per-ACP-process `GROK_HOME` so official and custom chats do not share
//! `agent-home/auth.json` (#1293).
//!
//! The canonical agent-home stays the file the app writes (config, sessions,
//! memory, skills, and the auth mirror used for login heal). Each spawned
//! process gets `{app data}/agent-proc/<id>/`:
//!
//! - `auth.json` is a private copy for an official process, and absent for a
//!   custom process. It is never a link back to the canonical file.
//! - `hooks` and `bundled` are real directories. Every other regular file,
//!   including `config.toml`, `hooks-paths`, and `trusted_folders.toml`, is a
//!   private copy (`st_nlink` == 1). The CLI sandbox refuses a symlink on
//!   those directories, a hard-linked hook JSON, and a hard-linked protected
//!   file. A second name for that inode fails every sandboxed chat at startup.
//! - other directories are links to the canonical home, so resume still sees
//!   one sessions directory. Files are a spawn-time copy. The workspace
//!   Seatbelt profile writes `$GROK_HOME`, not the link target, so a sandboxed
//!   spawn also gets a profile that grants the real `sessions` / `memory` /
//!   `skills` directories (#1341).
//!
//! Callers hold `route_auth_lock` across canonical writes and `create`. The
//! snapshot is immutable after that; nested tools inherit `GROK_HOME`.

use std::fs;
use std::path::{Path, PathBuf};

use crate::paths::app_data_root;

const SHARED_DIR_NAMES: &[&str] = &["sessions", "memory", "skills"];
const AUTH_FILE: &str = "auth.json";

/// `{app data}/agent-proc`
pub fn agent_proc_root() -> PathBuf {
    app_data_root().join("agent-proc")
}

/// Seal a private home for one process whose canonical `GROK_HOME` is `canonical`
/// (always the app agent-home). Official auth is copied from `~/.grok/auth.json`.
pub fn create(canonical: &Path, custom_route: bool) -> Result<PathBuf, String> {
    let cli = crate::process_util::user_home()
        .join(".grok")
        .join(AUTH_FILE);
    let mirror = canonical.join(AUTH_FILE);
    // Prefer the login file. Fall back to the agent-home mirror when a CLI
    // subprocess deleted `~/.grok/auth.json` and heal has not copied it back.
    let auth = if custom_route {
        None
    } else if cli.is_file() {
        Some(cli)
    } else if mirror.is_file() {
        Some(mirror)
    } else {
        None
    };
    create_from(canonical, custom_route, auth.as_deref())
}

/// Same as [`create`], with an explicit official auth file for tests.
pub fn create_from(
    canonical: &Path,
    custom_route: bool,
    official_auth: Option<&Path>,
) -> Result<PathBuf, String> {
    fs::create_dir_all(canonical).map_err(|e| format!("create canonical agent home: {e}"))?;
    let root = agent_proc_root();
    fs::create_dir_all(&root).map_err(|e| format!("create agent-proc: {e}"))?;
    let dir = root.join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&dir).map_err(|e| format!("create proc home: {e}"))?;
    if let Err(e) = populate(&dir, canonical, custom_route, official_auth) {
        discard(&dir);
        return Err(e);
    }
    tracing::info!(
        target: "agent_proc_home",
        custom_route,
        home = %dir.display(),
        "sealed private GROK_HOME"
    );
    Ok(dir)
}

fn populate(
    dir: &Path,
    canonical: &Path,
    custom_route: bool,
    official_auth: Option<&Path>,
) -> Result<(), String> {
    for name in SHARED_DIR_NAMES {
        let path = canonical.join(name);
        if !path.exists() {
            fs::create_dir_all(&path).map_err(|e| format!("create {name}: {e}"))?;
        }
    }
    let entries = fs::read_dir(canonical).map_err(|e| format!("read agent home: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read agent home entry: {e}"))?;
        let name = entry.file_name();
        if name == AUTH_FILE {
            continue;
        }
        let src = entry.path();
        let dest = dir.join(&name);
        // CLI >= 1.0.60: `bundled` must be a real directory, same as `hooks`.
        if name == "hooks" || name == "bundled" {
            materialize_real_tree(&src, &dest)?;
            continue;
        }
        // Directories stay linked. Regular files are private copies: a hard
        // link (`st_nlink` > 1) on `config.toml` or `trusted_folders.toml`
        // makes the sandbox refuse to start (#1338, #1341).
        share_entry(&src, &dest)?;
    }
    if custom_route {
        return Ok(());
    }
    if let Some(src) = official_auth {
        if src.is_file() {
            write_private_auth(src, &dir.join(AUTH_FILE))?;
        }
    }
    Ok(())
}

/// Copy a file's bytes into a new inode. `hard_link` would leave `st_nlink` > 1,
/// which the sandbox rejects for hook JSON and protected config files.
fn copy_private_file(src: &Path, dest: &Path) -> Result<(), String> {
    let bytes = fs::read(src).map_err(|e| format!("read {}: {e}", src.display()))?;
    fs::write(dest, &bytes).map_err(|e| format!("write {}: {e}", dest.display()))?;
    Ok(())
}

/// Real directory tree. Symlinks are followed and written as real files or
/// directories so no path component under `hooks` or `bundled` is a link.
fn materialize_real_tree(src: &Path, dest: &Path) -> Result<(), String> {
    materialize_node(src, dest, 0)
}

fn materialize_node(src: &Path, dest: &Path, depth: u32) -> Result<(), String> {
    if depth > 16 {
        return Err(format!("sealed tree too deep: {}", src.display()));
    }
    let meta = fs::metadata(src).map_err(|e| format!("stat {}: {e}", src.display()))?;
    if meta.is_dir() {
        fs::create_dir(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
        let entries = fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("read {}: {e}", src.display()))?;
            materialize_node(&entry.path(), &dest.join(entry.file_name()), depth + 1)?;
        }
        Ok(())
    } else {
        copy_private_file(src, dest)
    }
}

fn share_entry(src: &Path, dest: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(src).map_err(|e| format!("stat {}: {e}", src.display()))?;
    let followed_dir = fs::metadata(src).map(|m| m.is_dir()).unwrap_or(false);
    if meta.is_dir() || followed_dir {
        link_dir(src, dest).map_err(|e| format!("link {}: {e}", src.display()))
    } else {
        share_file(src, dest).map_err(|e| format!("share {}: {e}", src.display()))
    }
}

fn share_file(src: &Path, dest: &Path) -> std::io::Result<()> {
    // Never hard-link. The sandbox treats `st_nlink` > 1 on a protected file
    // (`config.toml`, `trusted_folders.toml`, and any later toml) as a
    // writable alias and refuses to start.
    fs::copy(src, dest).map(|_| ())
}

fn write_private_auth(src: &Path, dest: &Path) -> Result<(), String> {
    let bytes = fs::read(src).map_err(|e| format!("read official auth: {e}"))?;
    fs::write(dest, &bytes).map_err(|e| format!("write proc auth: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dest, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// Directory symlink on Unix, junction on Windows. Junctions do not need
/// developer mode, and `remove_dir` drops the link without following it.
fn link_dir(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("cmd");
        cmd.args(["/C", "mklink", "/J"]).arg(link).arg(target);
        crate::process_util::apply_no_window_std(&mut cmd);
        let out = cmd.output()?;
        if out.status.success() {
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            Err(std::io::Error::other(format!(
                "mklink /J failed: {err}{stdout}"
            )))
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        Err(std::io::Error::other(
            "private agent home links are not supported on this os",
        ))
    }
}

/// Delete one sealed home. Refuses any path that is not a direct child of
/// `agent-proc`, and unlinks directory links instead of following them.
pub fn discard(dir: &Path) {
    if !is_managed_proc_home(dir) {
        tracing::warn!(
            target: "agent_proc_home",
            home = %dir.display(),
            "refusing to discard a path outside agent-proc"
        );
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let _ = remove_proc_child(&path);
        }
    }
    let _ = fs::remove_dir(dir);
}

fn remove_proc_child(path: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        // Directory symlink / junction: remove the link, never the target.
        fs::remove_dir(path).or_else(|_| fs::remove_file(path))
    } else if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn is_managed_proc_home(dir: &Path) -> bool {
    let Ok(root) = agent_proc_root().canonicalize() else {
        return false;
    };
    let Ok(dir) = dir.canonicalize() else {
        return false;
    };
    dir.parent() == Some(root.as_path())
}

/// Built-in profiles whose name cannot carry extra `read_write` roots.
/// `--sandbox workspace` ignores a `[profiles.workspace]` section.
const BUILTIN_SANDBOX_PROFILES: &[&str] = &["workspace", "read-only", "strict", "devbox"];

/// `--sandbox` profile a sealed home should request.
///
/// Built-ins are wrapped (`grok_app_sealed_<base>`) so the sealed
/// `sandbox.toml` can extend them and grant the shared-directory targets.
/// Custom profiles keep their name; the grant is inserted into that section,
/// and a resumed session still asks for the name it was saved with.
pub fn sealed_share_spawn_profile(base: &str) -> String {
    let trimmed = base.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("off") {
        return trimmed.to_ascii_lowercase();
    }
    let lower = trimmed.to_ascii_lowercase();
    if BUILTIN_SANDBOX_PROFILES.contains(&lower.as_str()) {
        format!("grok_app_sealed_{lower}")
    } else {
        trimmed.to_string()
    }
}

/// Write the Seatbelt grant for linked `sessions` / `memory` / `skills`.
///
/// `base_profile` is the profile the user asked for (`workspace`, `strict`,
/// or a custom `app_ws_…` name). No-op for `off`. The file is the sealed
/// copy only; the canonical home is not rewritten.
pub fn install_sealed_share_grant(
    sealed: &Path,
    canonical: &Path,
    base_profile: &str,
) -> Result<(), String> {
    let base = base_profile.trim();
    if base.is_empty() || base.eq_ignore_ascii_case("off") {
        return Ok(());
    }
    let paths = shared_dir_write_paths(canonical);
    let spawn_name = sealed_share_spawn_profile(base);
    let path = sealed.join("sandbox.toml");
    let existing = if path.is_file() {
        fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?
    } else {
        String::new()
    };
    let updated = if spawn_name.eq_ignore_ascii_case(base) {
        ensure_profile_read_write(&existing, &spawn_name, &paths)
    } else {
        let section = render_sealed_share_section(&spawn_name, &base.to_ascii_lowercase(), &paths);
        merge_profile_section(&existing, &spawn_name, &section)
    };
    fs::write(&path, updated).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

fn shared_dir_write_paths(canonical: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for name in SHARED_DIR_NAMES {
        let path = canonical.join(name);
        push_unique_path(&mut out, path.display().to_string());
        if let Ok(real) = path.canonicalize() {
            push_unique_path(&mut out, real.display().to_string());
        }
    }
    out
}

fn push_unique_path(out: &mut Vec<String>, path: String) {
    if !path.is_empty() && !out.iter().any(|have| have == &path) {
        out.push(path);
    }
}

fn toml_basic_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn render_sealed_share_section(name: &str, extends: &str, paths: &[String]) -> String {
    let mut out = format!("[profiles.{name}]\nextends = \"{extends}\"\nread_write = [\n");
    for path in paths {
        out.push_str("  ");
        out.push_str(&toml_basic_string(path));
        out.push_str(",\n");
    }
    out.push_str("]\n");
    out
}

fn merge_profile_section(existing: &str, profile_name: &str, body: &str) -> String {
    let marker = format!("[profiles.{profile_name}]");
    let body = body.trim_end();
    if !existing.lines().any(|line| line.trim() == marker) {
        let mut out = existing.trim_end().to_string();
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(body);
        out.push('\n');
        return out;
    }
    let mut out = String::new();
    let mut skipping = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[profiles.") {
            skipping = trimmed == marker;
            if skipping {
                continue;
            }
        }
        if skipping {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }
    out.push_str(body);
    out.push('\n');
    out
}

/// Add `paths` to an existing profile's `read_write` list. A missing section
/// is created as an extension of `workspace` so the spawn name still resolves.
fn ensure_profile_read_write(existing: &str, profile: &str, paths: &[String]) -> String {
    let marker = format!("[profiles.{profile}]");
    if !existing.lines().any(|line| line.trim() == marker) {
        let section = render_sealed_share_section(profile, "workspace", paths);
        return merge_profile_section(existing, profile, &section);
    }
    let mut before = String::new();
    let mut section: Vec<String> = Vec::new();
    let mut after = String::new();
    let mut phase = 0u8;
    for line in existing.lines() {
        let trimmed = line.trim();
        if phase == 0 {
            if trimmed == marker {
                phase = 1;
                section.push(line.to_string());
            } else {
                before.push_str(line);
                before.push('\n');
            }
        } else if phase == 1 {
            if trimmed.starts_with("[profiles.") {
                phase = 2;
                after.push_str(line);
                after.push('\n');
            } else {
                section.push(line.to_string());
            }
        } else {
            after.push_str(line);
            after.push('\n');
        }
    }
    let section = upsert_read_write_lines(&section, paths);
    let mut out = before;
    for line in section {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str(&after);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn upsert_read_write_lines(section: &[String], paths: &[String]) -> Vec<String> {
    let start = section.iter().position(|line| {
        let trimmed = line.trim();
        trimmed.starts_with("read_write") && trimmed.contains('=') && trimmed.contains('[')
    });
    let Some(start) = start else {
        let mut out: Vec<String> = section
            .iter()
            .filter(|line| !line.trim().is_empty())
            .cloned()
            .collect();
        out.push("read_write = [".into());
        for path in paths {
            out.push(format!("  {},", toml_basic_string(path)));
        }
        out.push("]".into());
        return out;
    };
    let first = &section[start];
    let inline = first.contains('[') && first.contains(']');
    let end = if inline {
        start
    } else {
        section
            .iter()
            .enumerate()
            .skip(start + 1)
            .find(|(_, line)| line.trim() == "]")
            .map(|(index, _)| index)
            .unwrap_or(start)
    };
    let mut have = Vec::new();
    let last = end.min(section.len() - 1);
    for line in &section[start..=last] {
        for path in toml_quoted_strings(line) {
            push_unique_path(&mut have, path);
        }
    }
    for path in paths {
        push_unique_path(&mut have, path.clone());
    }
    let mut block = vec!["read_write = [".to_string()];
    for path in &have {
        block.push(format!("  {},", toml_basic_string(path)));
    }
    block.push("]".to_string());
    let mut out = Vec::new();
    out.extend(section[..start].iter().cloned());
    out.extend(block);
    if end + 1 < section.len() {
        out.extend(section[end + 1..].iter().cloned());
    }
    out
}

fn toml_quoted_strings(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '"' {
            continue;
        }
        let mut cur = String::new();
        while let Some(next) = chars.next() {
            if next == '\\' {
                if let Some(escaped) = chars.next() {
                    cur.push(match escaped {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                }
                continue;
            }
            if next == '"' {
                break;
            }
            cur.push(next);
        }
        out.push(cur);
    }
    out
}

/// Drop sealed homes left by a crashed process. The app is single-instance,
/// so at startup none of these directories belong to a live child.
pub fn sweep_orphans() {
    let Ok(entries) = fs::read_dir(agent_proc_root()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            discard(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn with_app_home<T>(f: impl FnOnce(PathBuf) -> T) -> T {
        static TEST_LOCK: Mutex<()> = Mutex::new(());
        let _test = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _env = crate::paths::APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!(
            "grok-proc-home-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let prev = std::env::var("GROK_APP_HOME").ok();
        std::env::set_var("GROK_APP_HOME", &tmp);
        let out = f(tmp.clone());
        match prev {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = fs::remove_dir_all(&tmp);
        out
    }

    fn canonical_with_config(root: &Path) -> PathBuf {
        let canonical = root.join("agent-home");
        fs::create_dir_all(canonical.join("sessions")).unwrap();
        fs::write(canonical.join("sessions").join("keep.txt"), b"session").unwrap();
        fs::write(canonical.join("config.toml"), b"default = \"grok\"\n").unwrap();
        canonical
    }

    #[test]
    fn official_and_custom_snapshots_do_not_share_auth() {
        with_app_home(|root| {
            let canonical = canonical_with_config(&root);
            fs::write(canonical.join(AUTH_FILE), b"canonical-oidc").unwrap();
            let auth_src = root.join("cli-auth.json");
            fs::write(&auth_src, b"{\"access_token\":\"secret\"}").unwrap();

            let official = create_from(&canonical, false, Some(&auth_src)).unwrap();
            let custom = create_from(&canonical, true, Some(&auth_src)).unwrap();

            assert_eq!(
                fs::read(official.join(AUTH_FILE)).unwrap(),
                fs::read(&auth_src).unwrap()
            );
            assert!(!custom.join(AUTH_FILE).exists());
            assert_eq!(
                fs::read(official.join("sessions").join("keep.txt")).unwrap(),
                b"session"
            );
            assert_eq!(
                fs::read(custom.join("sessions").join("keep.txt")).unwrap(),
                b"session"
            );

            fs::write(&auth_src, b"changed-later").unwrap();
            fs::write(canonical.join(AUTH_FILE), b"rewritten").unwrap();
            assert_eq!(
                fs::read(official.join(AUTH_FILE)).unwrap(),
                b"{\"access_token\":\"secret\"}"
            );
            assert!(!custom.join(AUTH_FILE).exists());

            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                let src_ino = fs::metadata(&auth_src).unwrap().ino();
                let snap_ino = fs::metadata(official.join(AUTH_FILE)).unwrap().ino();
                assert_ne!(src_ino, snap_ino);
                let canon_cfg = fs::metadata(canonical.join("config.toml")).unwrap();
                let snap_cfg = fs::metadata(official.join("config.toml")).unwrap();
                assert_ne!(canon_cfg.ino(), snap_cfg.ino());
                assert_eq!(snap_cfg.nlink(), 1);
                let mode = fs::metadata(official.join(AUTH_FILE)).unwrap().mode() & 0o777;
                assert_eq!(mode, 0o600);
            }
        });
    }

    #[test]
    fn discard_removes_the_snapshot_and_keeps_canonical_sessions() {
        with_app_home(|root| {
            let canonical = canonical_with_config(&root);
            let auth_src = root.join("cli-auth.json");
            fs::write(&auth_src, b"token").unwrap();
            let official = create_from(&canonical, false, Some(&auth_src)).unwrap();
            let marker = canonical.join("sessions").join("keep.txt");

            discard(&official);
            assert!(!official.exists());
            assert_eq!(fs::read(&marker).unwrap(), b"session");

            discard(&canonical);
            assert!(canonical.exists());
            assert_eq!(fs::read(&marker).unwrap(), b"session");
        });
    }

    #[test]
    fn hooks_are_a_real_tree_and_hook_files_are_not_hardlinked() {
        with_app_home(|root| {
            let canonical = canonical_with_config(&root);
            let hook_src = root.join("hook-target.json");
            fs::write(&hook_src, b"{\"event\":\"Stop\"}\n").unwrap();
            let hooks = canonical.join("hooks");
            fs::create_dir_all(hooks.join("nested")).unwrap();
            // Canonical itself may use a symlink and a hard link. The sealed
            // home must not preserve either: the sandbox rejects both.
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&hook_src, hooks.join("linked.json")).unwrap();
            }
            #[cfg(not(unix))]
            {
                fs::write(hooks.join("linked.json"), b"{\"event\":\"Stop\"}\n").unwrap();
            }
            fs::hard_link(&hook_src, hooks.join("nested").join("aliased.json")).unwrap();
            fs::write(canonical.join("hooks-paths"), b"/tmp/hooks-extra\n").unwrap();

            let sealed = create_from(&canonical, true, None).unwrap();
            let sealed_hooks = sealed.join("hooks");
            let hook_meta = fs::symlink_metadata(&sealed_hooks).unwrap();
            assert!(hook_meta.is_dir());
            assert!(
                !hook_meta.file_type().is_symlink(),
                "sealed hooks must be a real directory"
            );
            let linked = sealed_hooks.join("linked.json");
            let linked_meta = fs::symlink_metadata(&linked).unwrap();
            assert!(linked_meta.is_file());
            assert!(!linked_meta.file_type().is_symlink());
            assert_eq!(fs::read(&linked).unwrap(), b"{\"event\":\"Stop\"}\n");
            let aliased = sealed_hooks.join("nested").join("aliased.json");
            assert!(fs::symlink_metadata(&aliased).unwrap().is_file());
            assert_eq!(fs::read(&aliased).unwrap(), b"{\"event\":\"Stop\"}\n");
            assert_eq!(
                fs::read(sealed.join("hooks-paths")).unwrap(),
                b"/tmp/hooks-extra\n"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(fs::metadata(&aliased).unwrap().nlink(), 1);
                assert_ne!(
                    fs::metadata(&hook_src).unwrap().ino(),
                    fs::metadata(&aliased).unwrap().ino()
                );
                assert_eq!(fs::metadata(sealed.join("hooks-paths")).unwrap().nlink(), 1);
                assert_ne!(
                    fs::metadata(canonical.join("hooks-paths")).unwrap().ino(),
                    fs::metadata(sealed.join("hooks-paths")).unwrap().ino()
                );
                // sessions stay shared
                assert_eq!(
                    fs::metadata(canonical.join("sessions")).unwrap().ino(),
                    fs::metadata(sealed.join("sessions")).unwrap().ino()
                );
            }
        });
    }

    #[test]
    fn bundled_is_a_real_tree_and_config_is_not_hardlinked() {
        with_app_home(|root| {
            let canonical = canonical_with_config(&root);
            let bundled_src = root.join("bundled-src");
            fs::create_dir(&bundled_src).unwrap();
            fs::write(bundled_src.join("skill.md"), b"bundled-skill\n").unwrap();
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&bundled_src, canonical.join("bundled")).unwrap();
            }
            #[cfg(not(unix))]
            {
                let bundled = canonical.join("bundled");
                fs::create_dir(&bundled).unwrap();
                fs::write(bundled.join("skill.md"), b"bundled-skill\n").unwrap();
            }

            let sealed = create_from(&canonical, true, None).unwrap();
            let sealed_bundled = sealed.join("bundled");
            let bundled_meta = fs::symlink_metadata(&sealed_bundled).unwrap();
            assert!(bundled_meta.is_dir());
            assert!(
                !bundled_meta.file_type().is_symlink(),
                "sealed bundled must be a real directory"
            );
            let skill = sealed_bundled.join("skill.md");
            let skill_meta = fs::symlink_metadata(&skill).unwrap();
            assert!(skill_meta.is_file());
            assert!(!skill_meta.file_type().is_symlink());
            assert_eq!(fs::read(&skill).unwrap(), b"bundled-skill\n");

            let sealed_config = sealed.join("config.toml");
            assert_eq!(
                fs::read(&sealed_config).unwrap(),
                fs::read(canonical.join("config.toml")).unwrap()
            );
            fs::write(&sealed_config, b"sealed-only\n").unwrap();
            assert_eq!(
                fs::read(canonical.join("config.toml")).unwrap(),
                b"default = \"grok\"\n",
                "canonical config must stay a separate file"
            );

            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(fs::metadata(&skill).unwrap().nlink(), 1);
                assert_ne!(
                    fs::metadata(bundled_src.join("skill.md")).unwrap().ino(),
                    fs::metadata(&skill).unwrap().ino()
                );
                assert_eq!(fs::metadata(&sealed_config).unwrap().nlink(), 1);
                assert_ne!(
                    fs::metadata(canonical.join("config.toml")).unwrap().ino(),
                    fs::metadata(&sealed_config).unwrap().ino()
                );
                assert_eq!(
                    fs::metadata(canonical.join("sessions")).unwrap().ino(),
                    fs::metadata(sealed.join("sessions")).unwrap().ino()
                );
            }
        });
    }

    #[test]
    fn regular_files_are_private_copies() {
        with_app_home(|root| {
            let canonical = canonical_with_config(&root);
            fs::write(canonical.join("trusted_folders.toml"), b"folders = []\n").unwrap();
            fs::write(canonical.join("notes.txt"), b"note\n").unwrap();

            let sealed = create_from(&canonical, true, None).unwrap();
            let sealed_trust = sealed.join("trusted_folders.toml");
            assert_eq!(fs::read(&sealed_trust).unwrap(), b"folders = []\n");
            fs::write(&sealed_trust, b"sealed\n").unwrap();
            assert_eq!(
                fs::read(canonical.join("trusted_folders.toml")).unwrap(),
                b"folders = []\n",
                "a sealed trust file must not alias the canonical one"
            );
            assert_eq!(fs::read(sealed.join("notes.txt")).unwrap(), b"note\n");

            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert_eq!(fs::metadata(&sealed_trust).unwrap().nlink(), 1);
                assert_ne!(
                    fs::metadata(canonical.join("trusted_folders.toml"))
                        .unwrap()
                        .ino(),
                    fs::metadata(&sealed_trust).unwrap().ino()
                );
                assert_eq!(fs::metadata(sealed.join("notes.txt")).unwrap().nlink(), 1);
                assert_eq!(
                    fs::metadata(canonical.join("sessions")).unwrap().ino(),
                    fs::metadata(sealed.join("sessions")).unwrap().ino()
                );
            }
        });
    }

    #[test]
    fn sweep_drops_orphans_only() {
        with_app_home(|root| {
            let canonical = canonical_with_config(&root);
            let auth_src = root.join("cli-auth.json");
            fs::write(&auth_src, b"token").unwrap();
            let first = create_from(&canonical, false, Some(&auth_src)).unwrap();
            let second = create_from(&canonical, true, Some(&auth_src)).unwrap();
            sweep_orphans();
            assert!(!first.exists());
            assert!(!second.exists());
            assert!(canonical.join("sessions").join("keep.txt").is_file());
        });
    }

    #[test]
    fn sealed_share_profile_wraps_builtins_and_keeps_custom_names() {
        assert_eq!(
            sealed_share_spawn_profile("workspace"),
            "grok_app_sealed_workspace"
        );
        assert_eq!(
            sealed_share_spawn_profile(" Read-Only "),
            "grok_app_sealed_read-only"
        );
        assert_eq!(
            sealed_share_spawn_profile("strict"),
            "grok_app_sealed_strict"
        );
        assert_eq!(
            sealed_share_spawn_profile("devbox"),
            "grok_app_sealed_devbox"
        );
        assert_eq!(sealed_share_spawn_profile("off"), "off");
        assert_eq!(sealed_share_spawn_profile("app_ws_ab12"), "app_ws_ab12");
    }

    // Seatbelt grant; Windows has no sandbox and escapes backslashes in the TOML.
    #[cfg(unix)]
    #[test]
    fn sealed_share_grant_keeps_one_sessions_directory() {
        with_app_home(|root| {
            let canonical = canonical_with_config(&root);
            fs::create_dir_all(canonical.join("memory")).unwrap();
            fs::create_dir_all(canonical.join("skills")).unwrap();
            let sealed = create_from(&canonical, true, None).unwrap();
            install_sealed_share_grant(&sealed, &canonical, "workspace").unwrap();
            install_sealed_share_grant(&sealed, &canonical, "workspace").unwrap();

            let text = fs::read_to_string(sealed.join("sandbox.toml")).unwrap();
            assert!(text.contains("[profiles.grok_app_sealed_workspace]"));
            assert!(text.contains("extends = \"workspace\""));
            let sessions = canonical.join("sessions").canonicalize().unwrap();
            let quoted = sessions.display().to_string();
            assert_eq!(text.matches(&quoted).count(), 1, "{text}");
            assert!(text.contains(
                &canonical
                    .join("memory")
                    .canonicalize()
                    .unwrap()
                    .display()
                    .to_string()
            ));
            assert!(text.contains(
                &canonical
                    .join("skills")
                    .canonicalize()
                    .unwrap()
                    .display()
                    .to_string()
            ));
            assert!(!canonical.join("sandbox.toml").exists());

            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                assert!(fs::symlink_metadata(sealed.join("sessions"))
                    .unwrap()
                    .file_type()
                    .is_symlink());
                assert_eq!(
                    fs::metadata(canonical.join("sessions")).unwrap().ino(),
                    fs::metadata(sealed.join("sessions")).unwrap().ino()
                );
            }
        });
    }

    #[test]
    fn sealed_share_grant_appends_custom_profile_without_dropping_roots() {
        let existing = "\
# keep
[profiles.other]
extends = \"strict\"

[profiles.app_ws_ab12]
extends = \"workspace\"
restrict_network = false
read_write = [
  \"/proj/a\",
  \"/proj/b\",
]

[profiles.later]
extends = \"read-only\"
";
        let paths = vec![
            "/agent/sessions".into(),
            "/proj/a".into(),
            "/agent/memory".into(),
        ];
        let once = ensure_profile_read_write(existing, "app_ws_ab12", &paths);
        let twice = ensure_profile_read_write(&once, "app_ws_ab12", &paths);
        assert_eq!(once, twice);
        assert!(once.contains("[profiles.other]"));
        assert!(once.contains("extends = \"strict\""));
        assert!(once.contains("[profiles.later]"));
        assert!(once.contains("restrict_network = false"));
        assert!(once.contains("\"/proj/a\""));
        assert!(once.contains("\"/proj/b\""));
        assert!(once.contains("\"/agent/sessions\""));
        assert!(once.contains("\"/agent/memory\""));
        assert_eq!(once.matches("\"/proj/a\"").count(), 1, "{once}");
        assert_eq!(sealed_share_spawn_profile("app_ws_ab12"), "app_ws_ab12");
    }

    #[test]
    fn sealed_share_section_escapes_quotes() {
        let section = render_sealed_share_section(
            "grok_app_sealed_workspace",
            "workspace",
            &["/tmp/a\"b\\c".into()],
        );
        assert!(section.contains("\"/tmp/a\\\"b\\\\c\""));
        let parsed = toml_quoted_strings(&section);
        assert!(parsed.iter().any(|path| path == "/tmp/a\"b\\c"));
    }

    #[test]
    fn sealed_share_grant_skips_off() {
        with_app_home(|root| {
            let canonical = canonical_with_config(&root);
            let sealed = create_from(&canonical, true, None).unwrap();
            let toml_path = sealed.join("sandbox.toml");
            assert!(!toml_path.exists());
            install_sealed_share_grant(&sealed, &canonical, "off").unwrap();
            assert!(!toml_path.exists());
        });
    }
}
