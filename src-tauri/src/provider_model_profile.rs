//! Read/write contract for the App-managed per-model catalog (`app_models`).
//!
//! One provider section owns a list of selectable models. The stable identity
//! of a choice is `(provider section id, model id)`: display names and channel
//! fields may change without changing which upstream request id is sent.
//!
//! Compatibility rules:
//! - Field missing or blank → legacy provider. Its channel `model` is the only
//!   selectable row (providers written before `app_models`).
//! - A well-formed JSON array is authoritative. An explicit empty array means
//!   the user cleared the catalog; it must not be re-seeded from `model`.
//! - Rows are normalized: trimmed ids, blank names fall back to the id,
//!   duplicates keep the first row, and `0` context windows are empty values.
//! - Anything else with content — `null`, object, string, number, invalid JSON,
//!   or a non-empty array whose rows all normalize away — is
//!   [`ModelCatalogRead::Corrupt`]. The only writer of this field is
//!   [`encode_model_catalog`], which always emits an array, so a non-array value
//!   never means a legacy provider. Read paths still fall back to the legacy
//!   row, but writes must keep the original text instead of replacing it with
//!   `[]` or a guessed row.
//! - An array with at least one row that does not match the row shape stays
//!   corrupt, but its other rows remain readable: their bounded identity and
//!   metadata fields are recovered row by row for display. Recovered rows are
//!   never written back; only an explicit catalog edit replaces the raw text.

use crate::providers::{normalize_provider_models, ProviderEffortEntry, ProviderModelEntry};

/// Fixed reason category for an unreadable `app_models` value.
///
/// Logs and diagnostics may show this label; they must never show the stored
/// text or a `serde_json::Error`, whose `Display` can quote input values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelCatalogDefectKind {
    /// The field is not valid JSON.
    MalformedJson,
    /// JSON array whose rows do not match the row shape.
    InvalidRowShape,
    /// Valid JSON that is not an array (`null`, object, string, number, bool).
    UnsupportedJsonType,
    /// Non-empty array whose rows all normalize away (blank ids).
    NoUsableRows,
}

impl ModelCatalogDefectKind {
    /// Stable, value-free category label safe for logs and diagnostics.
    pub fn label(self) -> &'static str {
        match self {
            Self::MalformedJson => "malformed JSON",
            Self::InvalidRowShape => "invalid row shape",
            Self::UnsupportedJsonType => "unsupported JSON type",
            Self::NoUsableRows => "no usable rows",
        }
    }
}

impl std::fmt::Display for ModelCatalogDefectKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.label())
    }
}

/// Result of reading one provider's `app_models` field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelCatalogRead {
    /// No usable App catalog on disk: synthesize the channel model row.
    LegacyChannel,
    /// A parsed catalog, including an explicitly empty one.
    Stored(Vec<ProviderModelEntry>),
    /// Non-blank JSON that is not a usable catalog. Keeping `raw` verbatim,
    /// including any surrounding whitespace, lets an edit that omits `models`
    /// preserve whatever is on disk. An array may still expose its readable
    /// rows in `recovered_rows` for display.
    Corrupt(ModelCatalogCorruption),
}

/// Why `app_models` could not be read, plus the original text for persistence.
///
/// `raw` is host-internal: it is written back verbatim when an edit omits the
/// catalog. It must not reach logs, diagnostics, IPC payloads, or `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct ModelCatalogCorruption {
    pub(crate) raw: String,
    pub kind: ModelCatalogDefectKind,
    /// Rows whose identity and bounded metadata were still readable in an
    /// otherwise invalid array. Display-only: `raw` stays authoritative until
    /// the user explicitly edits the catalog.
    pub(crate) recovered_rows: Vec<ProviderModelEntry>,
}

impl std::fmt::Debug for ModelCatalogCorruption {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelCatalogCorruption")
            .field("raw", &"<redacted>")
            .field("kind", &self.kind)
            .finish()
    }
}

impl ModelCatalogCorruption {
    fn new(raw: &str, kind: ModelCatalogDefectKind) -> Self {
        Self {
            raw: raw.to_string(),
            kind,
            recovered_rows: Vec::new(),
        }
    }
}

/// Read the bounded identity and metadata of rows that survive an array whose
/// full [`ProviderModelEntry`] shape does not.
///
/// Each row is inspected through [`serde_json::Value::get`], which returns
/// `None` for missing keys and non-object values instead of panicking. Unknown
/// fields and values of the wrong type are ignored rather than repaired; the
/// corrupt read still writes `raw` back verbatim.
fn recover_catalog_rows(items: &[serde_json::Value]) -> Vec<ProviderModelEntry> {
    let rows: Vec<ProviderModelEntry> = items
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            Some(ProviderModelEntry {
                id: id.to_string(),
                name: item
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                context_window: item
                    .get("contextWindow")
                    .and_then(serde_json::Value::as_u64)
                    .filter(|tokens| *tokens > 0),
                context_window_source: item
                    .get("contextWindowSource")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                supports_vision: item
                    .get("supportsVision")
                    .and_then(serde_json::Value::as_bool),
                supports_video: item
                    .get("supportsVideo")
                    .and_then(serde_json::Value::as_bool),
                efforts: item
                    .get("efforts")
                    .and_then(|value| {
                        serde_json::from_value::<Vec<ProviderEffortEntry>>(value.clone()).ok()
                    })
                    .unwrap_or_default(),
                efforts_source: item
                    .get("effortsSource")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
                supports_reasoning_effort: item
                    .get("supportsReasoningEffort")
                    .and_then(serde_json::Value::as_bool),
                supports_reasoning_effort_source: item
                    .get("supportsReasoningEffortSource")
                    .and_then(serde_json::Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_string),
            })
        })
        .collect();
    normalize_provider_models(&rows)
}

/// Read `app_models` without deciding how legacy providers are materialized.
pub fn read_model_catalog(raw: Option<&str>) -> ModelCatalogRead {
    let Some(original) = raw.filter(|value| !value.trim().is_empty()) else {
        return ModelCatalogRead::LegacyChannel;
    };
    let value = original.trim();
    match serde_json::from_str::<serde_json::Value>(value) {
        Err(_) => ModelCatalogRead::Corrupt(ModelCatalogCorruption::new(
            original,
            ModelCatalogDefectKind::MalformedJson,
        )),
        Ok(serde_json::Value::Array(items)) => {
            if items.is_empty() {
                return ModelCatalogRead::Stored(Vec::new());
            }
            match serde_json::from_value::<Vec<ProviderModelEntry>>(serde_json::Value::Array(
                items.clone(),
            )) {
                Ok(rows) => {
                    let rows = normalize_provider_models(&rows);
                    if rows.is_empty() {
                        ModelCatalogRead::Corrupt(ModelCatalogCorruption::new(
                            original,
                            ModelCatalogDefectKind::NoUsableRows,
                        ))
                    } else {
                        ModelCatalogRead::Stored(rows)
                    }
                }
                Err(_) => ModelCatalogRead::Corrupt(ModelCatalogCorruption {
                    recovered_rows: recover_catalog_rows(&items),
                    ..ModelCatalogCorruption::new(original, ModelCatalogDefectKind::InvalidRowShape)
                }),
            }
        }
        Ok(_) => ModelCatalogRead::Corrupt(ModelCatalogCorruption::new(
            original,
            ModelCatalogDefectKind::UnsupportedJsonType,
        )),
    }
}

/// Selectable rows for one provider, preserving explicit empty catalogs.
///
/// A corrupt array still exposes its recoverable rows; only a value with no
/// readable row identity falls back to the legacy channel row.
pub fn resolve_model_catalog(
    raw: Option<&str>,
    fallback_model: &str,
    fallback_display: &str,
) -> Vec<ProviderModelEntry> {
    resolve_catalog_rows(&read_model_catalog(raw), fallback_model, fallback_display)
}

/// Selectable rows for an already-read catalog; same rules as
/// [`resolve_model_catalog`].
pub fn resolve_catalog_rows(
    catalog: &ModelCatalogRead,
    fallback_model: &str,
    fallback_display: &str,
) -> Vec<ProviderModelEntry> {
    match catalog {
        ModelCatalogRead::Stored(rows) => rows.clone(),
        ModelCatalogRead::Corrupt(defect) if !defect.recovered_rows.is_empty() => {
            defect.recovered_rows.clone()
        }
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
    fn only_a_missing_or_blank_field_is_read_as_a_legacy_provider() {
        for raw in [None, Some(""), Some("   "), Some("\n\t")] {
            assert_eq!(read_model_catalog(raw), ModelCatalogRead::LegacyChannel);
        }
    }

    #[test]
    fn a_json_array_is_read_as_a_stored_catalog() {
        assert_eq!(
            read_model_catalog(Some(r#"[{"id":" m1 ","name":"M1"}]"#)),
            ModelCatalogRead::Stored(vec![ProviderModelEntry::named("m1", "M1")])
        );
    }

    #[test]
    fn surrounding_whitespace_does_not_change_a_valid_catalog() {
        assert_eq!(
            read_model_catalog(Some("\n  []\t")),
            ModelCatalogRead::Stored(Vec::new())
        );
        assert_eq!(
            read_model_catalog(Some("  [{\"id\":\" m1 \"}]  ")),
            ModelCatalogRead::Stored(vec![ProviderModelEntry::named("m1", "m1")])
        );
    }

    #[test]
    fn corrupt_catalog_keeps_the_original_text_including_surrounding_whitespace() {
        for (raw, expected) in [
            ("  not json\n", ModelCatalogDefectKind::MalformedJson),
            ("\t{}\t", ModelCatalogDefectKind::UnsupportedJsonType),
            (
                "  [{\"id\":\"m1\",\"contextWindow\":\"big\"}]  ",
                ModelCatalogDefectKind::InvalidRowShape,
            ),
            (
                "\n[{\"id\":\"   \"}]\n",
                ModelCatalogDefectKind::NoUsableRows,
            ),
        ] {
            match read_model_catalog(Some(raw)) {
                ModelCatalogRead::Corrupt(defect) => {
                    assert_eq!(defect.raw, raw, "raw must keep surrounding whitespace");
                    assert_eq!(defect.kind, expected, "category for {raw:?}");
                }
                other => panic!("expected corrupt read for {raw:?}: {other:?}"),
            }
        }
    }

    #[test]
    fn non_array_json_is_corrupt_not_a_legacy_provider() {
        for (raw, expected) in [
            ("null", ModelCatalogDefectKind::UnsupportedJsonType),
            ("true", ModelCatalogDefectKind::UnsupportedJsonType),
            ("1", ModelCatalogDefectKind::UnsupportedJsonType),
            ("1.5", ModelCatalogDefectKind::UnsupportedJsonType),
            ("\"m1\"", ModelCatalogDefectKind::UnsupportedJsonType),
            ("{}", ModelCatalogDefectKind::UnsupportedJsonType),
            (
                r#"{"id":"m1"}"#,
                ModelCatalogDefectKind::UnsupportedJsonType,
            ),
            (
                "[{\"id\":\"m1\"}] junk",
                ModelCatalogDefectKind::MalformedJson,
            ),
        ] {
            match read_model_catalog(Some(raw)) {
                ModelCatalogRead::Corrupt(defect) => {
                    assert_eq!(defect.raw, raw);
                    assert_eq!(defect.kind, expected, "category for {raw}");
                }
                other => panic!("expected corrupt read for {raw}: {other:?}"),
            }
        }
    }

    #[test]
    fn invalid_json_is_reported_as_corrupt_not_as_an_empty_catalog() {
        for raw in ["not json", r#"{"id":"m1""#] {
            match read_model_catalog(Some(raw)) {
                ModelCatalogRead::Corrupt(defect) => {
                    assert_eq!(defect.raw, raw);
                    assert_eq!(defect.kind, ModelCatalogDefectKind::MalformedJson);
                }
                other => panic!("expected corrupt read for {raw}: {other:?}"),
            }
        }
    }

    #[test]
    fn non_empty_array_without_usable_rows_is_corrupt() {
        for (raw, expected) in [
            (r#"[{"id":""}]"#, ModelCatalogDefectKind::NoUsableRows),
            (r#"[{"id":"   "}]"#, ModelCatalogDefectKind::NoUsableRows),
            (r#"[{}]"#, ModelCatalogDefectKind::InvalidRowShape),
            ("[null]", ModelCatalogDefectKind::InvalidRowShape),
        ] {
            match read_model_catalog(Some(raw)) {
                ModelCatalogRead::Corrupt(defect) => {
                    assert_eq!(defect.raw, raw);
                    assert_eq!(defect.kind, expected, "category for {raw}");
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
    fn corrupt_catalog_debug_redacts_stored_text_and_category_is_fixed() {
        const MARKER: &str = "sk-CANARY-LEAK-7f3a";
        for (raw, expected) in [
            (
                format!("not json {MARKER}"),
                ModelCatalogDefectKind::MalformedJson,
            ),
            (
                format!("{{\"id\":\"{MARKER}\""),
                ModelCatalogDefectKind::MalformedJson,
            ),
            (
                format!("\"{MARKER}\""),
                ModelCatalogDefectKind::UnsupportedJsonType,
            ),
            (
                format!(r#"[{{"id":"m1","contextWindow":"{MARKER}"}}]"#),
                ModelCatalogDefectKind::InvalidRowShape,
            ),
            (
                format!(r#"[{{"id":"  ","name":"{MARKER}"}}]"#),
                ModelCatalogDefectKind::NoUsableRows,
            ),
        ] {
            let read = read_model_catalog(Some(&raw));
            let debug = format!("{read:?}");
            assert!(
                !debug.contains(MARKER),
                "debug leaked the stored value: {debug}"
            );
            assert!(
                !debug.contains("invalid type"),
                "debug leaked a serde error: {debug}"
            );
            assert!(
                debug.contains("<redacted>"),
                "debug must mark the redaction: {debug}"
            );
            match read {
                ModelCatalogRead::Corrupt(defect) => {
                    assert_eq!(defect.kind, expected, "category for {raw}");
                    assert!(!defect.kind.label().contains(MARKER));
                }
                other => panic!("expected corrupt read for {raw}: {other:?}"),
            }
        }
    }

    #[test]
    fn partially_invalid_array_keeps_readable_rows_and_stays_corrupt() {
        let raw = "  [\
            {\"id\":\" m1 \",\"name\":\"M1\",\"contextWindow\":128000,\
             \"supportsVision\":true,\"supportsVideo\":false,\
             \"efforts\":[{\"id\":\"high\",\"name\":\"High\",\"isDefault\":true}]},\
            {\"id\":\"m2\",\"name\":\"M2\",\"contextWindow\":\"big\"}\
        ]  ";
        let expected = vec![
            ProviderModelEntry {
                id: "m1".into(),
                name: "M1".into(),
                context_window: Some(128_000),
                context_window_source: Some("user".into()),
                supports_vision: Some(true),
                supports_video: Some(false),
                efforts: vec![ProviderEffortEntry {
                    id: "high".into(),
                    name: "High".into(),
                    is_default: true,
                }],
                efforts_source: Some("user".into()),
                ..Default::default()
            },
            ProviderModelEntry::named("m2", "M2"),
        ];
        match read_model_catalog(Some(raw)) {
            ModelCatalogRead::Corrupt(defect) => {
                assert_eq!(defect.raw, raw, "the original text stays authoritative");
                assert_eq!(defect.kind, ModelCatalogDefectKind::InvalidRowShape);
                assert_eq!(
                    defect.recovered_rows, expected,
                    "a bad sibling row must not hide readable identities"
                );
            }
            other => panic!("expected corrupt read: {other:?}"),
        }
        assert_eq!(
            resolve_model_catalog(Some(raw), "channel-model", "Channel"),
            expected,
            "recovered rows replace the channel fallback for reads"
        );
    }

    #[test]
    fn recovered_rows_ignore_wrong_typed_values_instead_of_failing() {
        let raw = r#"[{"id":"m1","name":7,"contextWindow":-1,"supportsVision":"yes","supportsVideo":true,"efforts":[{"id":"high"},{"name":"no id"}]}]"#;
        match read_model_catalog(Some(raw)) {
            ModelCatalogRead::Corrupt(defect) => {
                assert_eq!(defect.kind, ModelCatalogDefectKind::InvalidRowShape);
                assert_eq!(
                    defect.recovered_rows,
                    vec![ProviderModelEntry {
                        id: "m1".into(),
                        name: "m1".into(),
                        context_window: None,
                        supports_vision: None,
                        supports_video: Some(true),
                        efforts: Vec::new(),
                        ..Default::default()
                    }],
                    "only correctly typed fields survive, and a ladder that does not deserialize is dropped"
                );
            }
            other => panic!("expected corrupt read: {other:?}"),
        }
    }

    #[test]
    fn arrays_without_a_readable_row_identity_keep_the_channel_fallback() {
        for raw in [
            "[5]",
            "[null]",
            "[\"m1\"]",
            "[true]",
            "[{}]",
            "[{\"id\":7}]",
            "[{\"id\":\"   \"}]",
            "[{\"name\":\"M2\"}]",
        ] {
            assert_eq!(
                resolve_model_catalog(Some(raw), "channel-model", "Channel"),
                vec![ProviderModelEntry::named("channel-model", "Channel")],
                "no readable row identity for {raw}"
            );
        }
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
        assert_eq!(
            resolve_model_catalog(Some("null"), "relay-model", "Relay"),
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
                ..Default::default()
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
