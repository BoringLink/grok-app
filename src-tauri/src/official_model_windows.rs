//! App-owned per-model context-window overrides for official Grok models.
//!
//! Stored in `{app_data}/official-model-windows.json` rather than
//! `settings.json`: `settings_set` replaces that whole object, while a model
//! row is edited on its own. Missing or unreadable files mean "no overrides";
//! every consumer then falls back to the CLI catalog value.
//!
//! A stored value only applies when the model advertises it (catalog default
//! or one of `context_windows`). An unadvertised value is ignored instead of
//! being forced onto the agent, so a stale setting cannot break a session.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::models_catalog::AvailableModel;

/// Source marker for a user-set model window.
pub const SOURCE_USER: &str = "user";
/// Source marker for the value advertised by the CLI catalog.
pub const SOURCE_CATALOG: &str = "catalog";

const FILE_NAME: &str = "official-model-windows.json";
const VERSION: u32 = 1;
const MAX_MODEL_ID_CHARS: usize = 200;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWindows {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    models: BTreeMap<String, u64>,
}

fn file_path() -> PathBuf {
    crate::paths::app_data_root().join(FILE_NAME)
}

/// Trim ids, drop blank/oversized/control-character keys, and keep positive
/// token counts. Later duplicate keys overwrite earlier ones, matching JSON
/// object semantics.
pub fn normalize(raw: BTreeMap<String, u64>) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    for (id, tokens) in raw {
        let Some(id) = normalize_model_id(&id) else {
            continue;
        };
        if tokens == 0 {
            continue;
        }
        out.insert(id, tokens);
    }
    out
}

fn normalize_model_id(raw: &str) -> Option<String> {
    let id = raw.trim();
    if id.is_empty() || id.chars().count() > MAX_MODEL_ID_CHARS {
        return None;
    }
    if id.chars().any(char::is_control) {
        return None;
    }
    Some(id.to_string())
}

/// Read the override table. A corrupt file is quarantined by the store helper
/// and reads as empty; the error text or raw value never reaches the UI.
pub fn read_overrides() -> BTreeMap<String, u64> {
    read_from(&file_path())
}

fn read_from(path: &Path) -> BTreeMap<String, u64> {
    let stored: StoredWindows = crate::store::read_json_recover(&path.to_path_buf());
    normalize(stored.models)
}

/// Persist one model override. `None` removes the row (explicit clear).
/// Returns the normalized table after the write.
pub fn set_override(model_id: &str, tokens: Option<u64>) -> Result<BTreeMap<String, u64>, String> {
    let id = normalize_model_id(model_id).ok_or_else(|| "model id is invalid".to_string())?;
    let mut map = read_overrides();
    match tokens {
        Some(n) if n > 0 => {
            map.insert(id, n);
        }
        Some(_) => return Err("context window must be positive".into()),
        None => {
            map.remove(&id);
        }
    }
    write_to(&file_path(), &map)?;
    Ok(map)
}

fn write_to(path: &Path, models: &BTreeMap<String, u64>) -> Result<(), String> {
    let stored = StoredWindows {
        version: VERSION,
        models: models.clone(),
    };
    crate::store::write_json(path, &stored)
}

/// Apply stored overrides to a catalog list.
///
/// A value the model does not advertise is ignored, and the row keeps its
/// catalog window. Every row with a window gets a source marker so Settings
/// and the composer can tell a user choice from the CLI catalog.
pub fn apply_overrides(models: &mut [AvailableModel], overrides: &BTreeMap<String, u64>) {
    for model in models.iter_mut() {
        let user = overrides
            .get(model.id.trim())
            .copied()
            .filter(|window| crate::models_catalog::model_supports_context_window(model, *window));
        if let Some(window) = user {
            model.context_window = Some(window);
            model.context_window_source = Some(SOURCE_USER.into());
        } else {
            model.context_window_source = model.context_window.map(|_| SOURCE_CATALOG.into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models_catalog::ReasoningEffort;

    fn model(id: &str, default_window: Option<u64>, windows: Vec<u64>) -> AvailableModel {
        AvailableModel {
            id: id.into(),
            label: id.into(),
            source: "official".into(),
            is_default: false,
            reasoning_efforts: Vec::<ReasoningEffort>::new(),
            context_window: default_window,
            context_windows: windows,
            context_window_source: None,
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "grok-app-model-windows-{}-{name}.json",
            std::process::id()
        ))
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let path = temp_path("missing");
        let _ = std::fs::remove_file(&path);
        assert!(read_from(&path).is_empty());
    }

    #[test]
    fn write_and_read_round_trip_and_clear() {
        let path = temp_path("roundtrip");
        let _ = std::fs::remove_file(&path);
        let mut map = BTreeMap::new();
        map.insert("grok-4.7".to_string(), 256_000);
        write_to(&path, &map).expect("write");
        assert_eq!(read_from(&path), map);

        let mut cleared = map.clone();
        cleared.remove("grok-4.7");
        write_to(&path, &cleared).expect("clear");
        assert!(read_from(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn normalize_drops_blank_and_zero_entries() {
        let mut raw = BTreeMap::new();
        raw.insert("  grok-4.7  ".into(), 256_000);
        raw.insert("".into(), 500_000);
        raw.insert("grok-mini".into(), 0);
        raw.insert("bad\nid".into(), 1_000_000);
        let out = normalize(raw);
        assert_eq!(out.len(), 1);
        assert_eq!(out.get("grok-4.7"), Some(&256_000));
    }

    #[test]
    fn apply_uses_only_advertised_windows() {
        let mut models = vec![model("grok-4.7", Some(256_000), vec![256_000, 500_000])];
        let mut overrides = BTreeMap::new();
        overrides.insert("grok-4.7".into(), 500_000);
        apply_overrides(&mut models, &overrides);
        assert_eq!(models[0].context_window, Some(500_000));
        assert_eq!(
            models[0].context_window_source.as_deref(),
            Some(SOURCE_USER)
        );

        overrides.insert("grok-4.7".into(), 128_000);
        apply_overrides(&mut models, &overrides);
        assert_eq!(models[0].context_window, Some(500_000));
        assert_eq!(
            models[0].context_window_source.as_deref(),
            Some(SOURCE_CATALOG)
        );
    }

    #[test]
    fn apply_marks_catalog_source_without_override() {
        let mut models = vec![model("grok-4.7", Some(256_000), vec![256_000])];
        apply_overrides(&mut models, &BTreeMap::new());
        assert_eq!(
            models[0].context_window_source.as_deref(),
            Some(SOURCE_CATALOG)
        );
    }

    #[test]
    fn corrupt_file_reads_empty() {
        let path = temp_path("corrupt");
        std::fs::write(&path, "{not json").expect("seed");
        assert!(read_from(&path).is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
