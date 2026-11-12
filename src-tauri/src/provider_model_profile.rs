//! Read/write contract for the App-managed per-model catalog (`app_models`).
//!
//! One provider section owns a list of selectable models. The stable identity
//! of a choice is `(provider section id, model id)`: display names and channel
//! fields may change without changing which upstream request id is sent.
//!
//! Compatibility rules:
//! - Field missing, blank, or not a JSON array → legacy provider. Its channel
//!   `model` is the only selectable row (providers written before `app_models`).
//! - A well-formed JSON array is authoritative. An explicit empty array means
//!   the user cleared the catalog; it must not be re-seeded from `model`.
//! - Rows are normalized: trimmed ids, blank names fall back to the id,
//!   duplicates keep the first row, and `0` context windows are empty values.

use crate::providers::{normalize_provider_models, ProviderModelEntry};

/// Result of reading one provider's `app_models` field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelCatalogRead {
    /// No usable App catalog on disk: synthesize the channel model row.
    LegacyChannel,
    /// A parsed catalog, including an explicitly empty one.
    Stored(Vec<ProviderModelEntry>),
}

/// Read `app_models` without deciding how legacy providers are materialized.
pub fn read_model_catalog(raw: Option<&str>) -> ModelCatalogRead {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return ModelCatalogRead::LegacyChannel;
    };
    match serde_json::from_str::<Vec<ProviderModelEntry>>(raw) {
        Ok(rows) => ModelCatalogRead::Stored(normalize_provider_models(&rows)),
        Err(_) => ModelCatalogRead::LegacyChannel,
    }
}

/// Selectable rows for one provider, preserving explicit empty catalogs.
pub fn resolve_model_catalog(
    raw: Option<&str>,
    fallback_model: &str,
    fallback_display: &str,
) -> Vec<ProviderModelEntry> {
    match read_model_catalog(raw) {
        ModelCatalogRead::Stored(rows) => rows,
        ModelCatalogRead::LegacyChannel => legacy_model_catalog(fallback_model, fallback_display),
    }
}

/// Single-row catalog synthesized for providers written before `app_models`.
pub fn legacy_model_catalog(
    fallback_model: &str,
    fallback_display: &str,
) -> Vec<ProviderModelEntry> {
    let id = fallback_model.trim();
    if id.is_empty() {
        return Vec::new();
    }
    let display = fallback_display.trim();
    vec![ProviderModelEntry::named(
        id,
        if display.is_empty() { id } else { display },
    )]
}

/// Serialize rows in declaration order so save → read is stable.
pub fn encode_model_catalog(models: &[ProviderModelEntry]) -> String {
    serde_json::to_string(models).unwrap_or_else(|_| "[]".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderEffortEntry;

    #[test]
    fn missing_field_falls_back_to_the_channel_model() {
        let rows = resolve_model_catalog(None, " relay-model ", "Relay");
        assert_eq!(
            rows,
            vec![ProviderModelEntry::named("relay-model", "Relay")]
        );
    }

    #[test]
    fn explicit_empty_catalog_stays_empty() {
        assert_eq!(
            read_model_catalog(Some("[]")),
            ModelCatalogRead::Stored(Vec::new())
        );
        assert!(resolve_model_catalog(Some("[]"), "relay-model", "Relay").is_empty());
    }

    #[test]
    fn malformed_payload_is_read_as_a_legacy_provider() {
        for raw in [Some(""), Some("null"), Some("{}"), Some("not json")] {
            assert_eq!(read_model_catalog(raw), ModelCatalogRead::LegacyChannel);
        }
    }

    #[test]
    fn row_values_roundtrip_without_changing_identity() {
        let rows = normalize_provider_models(&[
            ProviderModelEntry {
                id: " deepseek-v4-pro ".into(),
                name: String::new(),
                context_window: Some(1_000_000),
                supports_vision: Some(false),
                supports_video: None,
                efforts: vec![ProviderEffortEntry {
                    id: "max".into(),
                    name: "Max".into(),
                    is_default: true,
                }],
            },
            ProviderModelEntry::named("deepseek-v4-pro", "Duplicate"),
        ]);
        let encoded = encode_model_catalog(&rows);
        assert_eq!(
            resolve_model_catalog(Some(&encoded), "fallback", "Fallback"),
            rows
        );
        assert_eq!(rows.len(), 1, "duplicate request ids collapse to one row");
        assert_eq!(rows[0].id, "deepseek-v4-pro");
        assert_eq!(rows[0].name, "deepseek-v4-pro");
    }
}
