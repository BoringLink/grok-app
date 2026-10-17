// Chat viewport trace sink (DEV diagnostics).
//
// The frontend records why the chat viewport moved to an older message (see
// src/lib/chatViewportTrace.ts). Webview console output is not reachable from a
// packaged `.app`, so the chain is appended to the same daily log the Host
// already writes — a reproduction stays readable afterwards, on disk.
//
// Included into commands/mod.rs, so this file uses `//` comments and fully
// qualified paths rather than module-level `use` items.

/// Longest accepted trace line (chars). The caller caps its payload too; this is
/// the boundary check that keeps a malformed or runaway caller from bloating the
/// log file.
const MAX_TRACE_LINE_CHARS: usize = 8192;

/// Append one chat-viewport trace line to `logs/app.log.<day>`.
///
/// Empty input is a no-op. Over-long input is truncated rather than rejected so
/// a truncated trace is still diagnosable.
#[tauri::command]
pub fn chat_viewport_trace(line: String) -> Result<(), String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let bounded: String = if trimmed.chars().count() > MAX_TRACE_LINE_CHARS {
        trimmed.chars().take(MAX_TRACE_LINE_CHARS).collect()
    } else {
        trimmed.to_string()
    };
    crate::logging::sync_diag(&format!("chat-viewport-trace {bounded}"));
    Ok(())
}
