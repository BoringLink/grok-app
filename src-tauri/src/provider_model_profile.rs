//! Read/write contract for the App-managed per-model catalog (`app_models`).
//!
//! One provider section owns a list of selectable models. The stable identity
//! of a choice is `(provider section id, model id)`: display names and channel
//! fields may change without changing which upstream request id is sent.
//!
//! Compatibility rules:
//! - Field missing, blank, or non-array JSON → legacy provider. Its channel
//!   `model` is the only selectable row (providers written before `app_models`).
//! - A well-formed JSON array is authoritative. An explicit empty array means
//!   the user cleared the catalog; it must not be re-seeded from `model`.
//! - Rows are normalized: trimmed ids, blank names fall back to the id,
//!   duplicates keep the first row, and `0` context windows are empty values.
//! - Invalid JSON, or a non-empty array whose rows all normalize away, is
//!   reported as [`ModelCatalogRead::Corrupt`]. Read paths still fall back to
//!   the legacy row, but writes must keep the original text instead of
//!   replacing it with `[]`.

use crate::providers::{normalize_provider_models, ProviderModelEntry};

/// Result of reading one provider's `app_models` field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelCatalogRead {
    /// No usable App catalog on disk: synthesize the channel model row.
    LegacyChannel,
    /// A parsed catalog, including an explicitly empty one.
    Stored(Vec<ProviderModelEntry>),
    /// Non-blank JSON that is not a usable catalog. Keeping `raw` lets an edit
    /// that omits `models` preserve whatever is on disk.
    Corrupt(ModelCatalogCorruption),
}

/// Why `app_models` could not be read, plus the original text for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelCatalogCorruption {
    pub raw: String,
    pub detail: String,
}

/// Read `app_models` without deciding how legacy providers are materialized.
pub fn read_model_catalog(raw: Option<&str>) -> ModelCatalogRead {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return ModelCatalogRead::LegacyChannel;
    };
    match serde_json::from_str::<serde_json::Value>(value) {
        Err(error) => ModelCatalogRead::Corrupt(ModelCatalogCorruption {
            raw: value.to_string(),
            detail: format!("invalid JSON: {error}"),
        }),
        Ok(serde_json::Value::Array(items)) => {
            if items.is_empty() {
                return ModelCatalogRead::Stored(Vec::new());
            }
            match serde_json::from_value::<Vec<ProviderModelEntry>>(serde_json::Value::Array(items))
            {
                Ok(rows) => {
                    let rows = normalize_provider_models(&rows);
                    if rows.is_empty() {
                        ModelCatalogRead::Corrupt(ModelCatalogCorruption {
                            raw: value.to_string(),
                            detail: "array has no usable model rows".into(),
                        })
                    } else {
                        ModelCatalogRead::Stored(rows)
                    }
                }
                Err(error) => ModelCatalogRead::Corrupt(ModelCatalogCorruption {
                    raw: value.to_string(),
                    detail: format!("invalid model rows: {error}"),
                }),
            }
        }
        Ok(_) => ModelCatalogRead::LegacyChannel,
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
        ModelCatalogRead::LegacyChannel | ModelCatalogRead::Corrupt(_) => {
            legacy_model_catalog(fallback_model, fallback_display)
        }
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
///
/// Every field is a plain JSON value (`String`, `u64`, `bool`, or `Vec` of the
/// same), so a real row cannot fail serialization. An error therefore means a
/// serializer regression and must surface: falling back to `[]` would turn a
/// bug into an explicit catalog clear.
pub fn encode_model_catalog(models: &[ProviderModelEntry]) -> Result<String, serde_json::Error> {
    serde_json::to_string(models)
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
    fn missing_or_non_array_payload_is_read_as_a_legacy_provider() {
        for raw in [None, Some(""), Some("null"), Some("{}"), Some("\"m1\"")] {
            assert_eq!(read_model_catalog(raw), ModelCatalogRead::LegacyChannel);
        }
    }

    #[test]
    fn invalid_json_is_reported_as_corrupt_not_as_an_empty_catalog() {
        for raw in ["not json", r#"{"id":"m1""#] {
            match read_model_catalog(Some(raw)) {
                ModelCatalogRead::Corrupt(defect) => {
                    assert_eq!(defect.raw, raw);
                    assert!(!defect.detail.is_empty(), "diagnostic context for {raw}");
                }
                other => panic!("expected corrupt read for {raw}: {other:?}"),
            }
        }
    }

    #[test]
    fn non_empty_array_without_usable_rows_is_corrupt() {
        for raw in [r#"[{"id":""}]"#, r#"[{"id":"   "}]"#, r#"[{}]"#, "[null]"] {
            match read_model_catalog(Some(raw)) {
                ModelCatalogRead::Corrupt(defect) => {
                    assert_eq!(defect.raw, raw);
                    assert!(!defect.detail.is_empty(), "diagnostic context for {raw}");
                }
                other => panic!("expected corrupt read for {raw}: {other:?}"),
            }
        }
        assert_eq!(
            read_model_catalog(Some("[]")),
            ModelCatalogRead::Stored(Vec::new()),
            "only a literal empty array is an explicit clear"
        );
    }

    #[test]
    fn corrupt_catalog_still_materializes_the_legacy_row_for_reads() {
        assert_eq!(
            resolve_model_catalog(Some("not json"), "relay-model", "Relay"),
            vec![ProviderModelEntry::named("relay-model", "Relay")]
        );
        assert_eq!(
            resolve_model_catalog(Some(r#"[{"id":""}]"#), "relay-model", "Relay"),
            vec![ProviderModelEntry::named("relay-model", "Relay")]
        );
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
        let encoded = encode_model_catalog(&rows).expect("catalog rows are plain JSON values");
        assert_eq!(
            resolve_model_catalog(Some(&encoded), "fallback", "Fallback"),
            rows
        );
        assert_eq!(rows.len(), 1, "duplicate request ids collapse to one row");
        assert_eq!(rows[0].id, "deepseek-v4-pro");
        assert_eq!(rows[0].name, "deepseek-v4-pro");
    }
}
