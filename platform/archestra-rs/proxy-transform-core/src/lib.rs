//! Pure tool-result transformation kernel for the LLM proxy: unwrap the text-block
//! wrapper some clients (n8n, Vercel AI SDK) add around tool results, parse the
//! JSON, and encode it as TOON (spec v3, own linear encoder in [`encode`],
//! byte-compatible with the `toon-format` crate, which remains the test oracle).
//!
//! Node-free; the NAPI adapter lives in `proxy_transform_rs`. Per-item processing
//! is infallible: content that is not parseable JSON yields `encoded: None` and the
//! adapter keeps the original payload (fail-open, exactly like the TS path today).
//!
//! Anti-amplification limits (all fail-open to `encoded: None`): a per-item
//! output budget (see [`encode`] module docs), an aggregate batch output budget
//! (see [`toon_encode_tool_results`]), and a per-item input size cap
//! ([`MAX_ITEM_INPUT_BYTES`]).

mod encode;
mod json;
mod tokenize;

use json::JsonValue;

/// One tool result to transform. `id` is the provider tool id, carried for
/// logging only — it is not unique across items (Anthropic reuses one
/// `tool_use_id` across blocks), so results are matched to inputs by position.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "napi", napi_derive::napi(object))]
pub struct ToonEncodeItem {
    pub id: String,
    #[cfg_attr(feature = "napi", napi(js_name = "rawContent"))]
    pub raw_content: String,
    pub unwrap: bool,
}

/// Which string an adapter tokenizes as the pre-compression baseline, selecting
/// the fused token counting (see [`toon_encode_tool_results`]). Passing `None`
/// there skips counting entirely (Anthropic and Bedrock keep their own JS
/// tokenizer); the two variants below cover the tiktoken-family adapters.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "napi", napi_derive::napi(string_enum))]
pub enum BeforeSource {
    /// Count the original `raw_content` (pre-unwrap) as the baseline — Gemini,
    /// which tokenizes its serialized response, not the unwrapped inner text.
    Raw,
    /// Count the `normalized` (post-unwrap) content — every other tiktoken
    /// adapter (OpenAI family, Cohere, ZhipuAI, MiniMax).
    Normalized,
}

/// The transformation output for one item. `normalized` is the unwrapped string
/// when unwrapping was requested and matched, else the original `raw_content`
/// (adapters tokenize it for accounting). `encoded` is the TOON encoding, or
/// `None` when the content is not parseable JSON — or when encoding would
/// exceed the anti-amplification output budget (see `encode` module docs);
/// adapters keep the original payload either way.
///
/// `before_tokens`/`encoded_tokens` are the cl100k counts of the baseline and
/// the compressed candidate, populated only when a [`BeforeSource`] is passed
/// AND `encoded` is `Some` (an unencodable item is never tokenized, matching
/// the adapters). Both `None` otherwise.
///
/// `use_nullable` makes `None` fields cross the boundary as an explicit JS
/// `null` (typed `string | null` / `number | null`) instead of an omitted key.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, use_nullable = true))]
pub struct ToonEncodeResult {
    pub normalized: String,
    pub encoded: Option<String>,
    #[cfg_attr(feature = "napi", napi(js_name = "beforeTokens"))]
    pub before_tokens: Option<u32>,
    #[cfg_attr(feature = "napi", napi(js_name = "encodedTokens"))]
    pub encoded_tokens: Option<u32>,
}

/// Items whose raw content exceeds this many bytes are not parsed or encoded
/// at all (`encoded: None`, content kept verbatim, unwrap skipped too).
/// Rationale: multi-MB tool results gain nothing from TOON compression, and
/// the parser DOM expands to roughly 12-24x the input bytes — without the cap
/// a single large item could allocation-abort the host process before any
/// encoder output budget applies. The cap bounds parser memory per item (and
/// so per AsyncTask) to ~cap x expansion.
pub const MAX_ITEM_INPUT_BYTES: usize = 10 * 1024 * 1024;

/// Transform a batch of tool results. Positional contract: the output has the
/// same length and order as the input. Never panics on any input.
///
/// Aggregate anti-amplification budget: per-item output budgets have a 16KiB
/// floor, which many small exponent-heavy items could otherwise sum into
/// unbounded retained output (200k tiny items x ~16KiB each). The batch's
/// total produced output is capped at `2 x total input bytes + one floor`;
/// once the running total exceeds it, remaining items are not encoded
/// (`encoded: None`, fail-open like the per-item budget, unwrap still applied).
///
/// When `count` is `Some`, the cl100k token counts that gate each adapter's
/// keep/reject decision are computed here, in the same off-thread pass, instead
/// of by a synchronous WASM tokenizer on the Node event loop. `None` leaves
/// `before_tokens`/`encoded_tokens` unset (Anthropic/Bedrock count with their
/// own tokenizer).
pub fn toon_encode_tool_results(
    items: Vec<ToonEncodeItem>,
    count: Option<BeforeSource>,
) -> Vec<ToonEncodeResult> {
    let total_input: usize = items
        .iter()
        .map(|item| item.raw_content.len())
        .fold(0usize, usize::saturating_add);
    let batch_budget = total_input
        .saturating_mul(2)
        .saturating_add(encode::OUTPUT_BUDGET_FLOOR);
    let mut produced: usize = 0;
    items
        .into_iter()
        .map(|item| {
            let result = encode_item(item, produced <= batch_budget, count);
            if let Some(encoded) = &result.encoded {
                produced = produced.saturating_add(encoded.len());
            }
            result
        })
        .collect()
}

/// The item outcome computed while the parsed DOM still borrows `raw_content`.
enum ItemOutcome {
    /// Content was not parseable JSON (or was JSON but exceeded encode limits).
    Encoded(Option<String>),
    /// The unwrap wrapper matched; the extracted text replaces `raw_content`.
    Unwrapped(String),
}

fn encode_item(
    item: ToonEncodeItem,
    encode_enabled: bool,
    count: Option<BeforeSource>,
) -> ToonEncodeResult {
    // Input size cap: see MAX_ITEM_INPUT_BYTES. Checked before any parse.
    if item.raw_content.len() > MAX_ITEM_INPUT_BYTES {
        return ToonEncodeResult {
            normalized: item.raw_content,
            encoded: None,
            before_tokens: None,
            encoded_tokens: None,
        };
    }
    // Single DOM parse per item: the unwrap check reuses the parsed value
    // instead of parsing the content once to inspect the wrapper and a second
    // time to encode. Only a matched wrapper needs the extra inner parse (its
    // payload is a JSON string, not a subtree). The DOM borrows from
    // `raw_content`, so the outcome is computed before `raw_content` moves.
    // When the aggregate batch budget is exhausted (`encode_enabled` false),
    // unwrap semantics are preserved but no encoding is produced.
    let outcome = match json::parse_json(&item.raw_content) {
        None => ItemOutcome::Encoded(None),
        Some(value) => {
            if item.unwrap {
                match take_wrapper_text(value) {
                    Ok(text) => ItemOutcome::Unwrapped(text),
                    Err(value) => ItemOutcome::Encoded(encode_value(
                        &value,
                        item.raw_content.len(),
                        encode_enabled,
                    )),
                }
            } else {
                ItemOutcome::Encoded(encode_value(&value, item.raw_content.len(), encode_enabled))
            }
        }
    };
    match outcome {
        ItemOutcome::Encoded(encoded) => {
            // normalized == raw_content on this path, so Raw and Normalized
            // select the same string.
            let (before_tokens, encoded_tokens) = counts(
                count,
                &item.raw_content,
                &item.raw_content,
                encoded.as_deref(),
            );
            ToonEncodeResult {
                normalized: item.raw_content,
                encoded,
                before_tokens,
                encoded_tokens,
            }
        }
        ItemOutcome::Unwrapped(text) => {
            let encoded = if encode_enabled {
                json::parse_json(&text)
                    .and_then(|value| encode::encode_to_toon(&value, text.len()).ok())
            } else {
                None
            };
            let (before_tokens, encoded_tokens) =
                counts(count, &item.raw_content, &text, encoded.as_deref());
            ToonEncodeResult {
                normalized: text,
                encoded,
                before_tokens,
                encoded_tokens,
            }
        }
    }
}

/// cl100k token counts for the keep/reject decision. Computed only for
/// encodable items (`encoded` is `Some`) — every adapter skips tokenizing a
/// result it cannot compress, so counting one here would be wasted work and a
/// meaningless "before". `before` follows the adapter's semantics via
/// [`BeforeSource`]. A `None` from the tokenizer (encoder init failed) is
/// propagated so the binding can fail open rather than report a bogus zero.
fn counts(
    count: Option<BeforeSource>,
    raw: &str,
    normalized: &str,
    encoded: Option<&str>,
) -> (Option<u32>, Option<u32>) {
    match (count, encoded) {
        (Some(source), Some(encoded)) => {
            let before = match source {
                BeforeSource::Raw => raw,
                BeforeSource::Normalized => normalized,
            };
            (
                tokenize::count_user_tokens(before),
                tokenize::count_user_tokens(encoded),
            )
        }
        _ => (None, None),
    }
}

fn encode_value(value: &JsonValue<'_>, input_len: usize, enabled: bool) -> Option<String> {
    if !enabled {
        return None;
    }
    encode::encode_to_toon(value, input_len).ok()
}

/// Port of `platform/backend/src/routes/proxy/utils/unwrap-tool-content.ts`:
/// if the parsed content is a JSON array whose FIRST element is
/// `{"type": "text", "text": <string>, ...}`, return that text; otherwise give
/// the value back unchanged. First-element-only is deliberate (pinned TS
/// behavior) — extra wrapper elements are dropped from the encoding input.
///
/// Divergence from JS `JSON.parse` (within the approved migration envelope):
/// `serde_json` rejects escaped lone surrogates (e.g. `"\ud800"`) and
/// out-of-range number literals (e.g. `1e400`, `Infinity` in JS) that JS
/// parses, so wrappers containing them are NOT unwrapped here — the content
/// falls through unchanged and later fails to encode (`encoded: None`), i.e.
/// the original payload is conservatively kept.
fn take_wrapper_text(value: JsonValue<'_>) -> Result<String, JsonValue<'_>> {
    let JsonValue::Array(mut elements) = value else {
        return Err(value);
    };
    let text = match elements.first_mut() {
        Some(JsonValue::Object(first))
            if first.get("type").and_then(JsonValue::as_str) == Some("text") =>
        {
            match first.get_mut("text") {
                // The wrapper array is discarded on this path, so taking the
                // text out of it costs at most one copy (borrowed -> owned).
                Some(JsonValue::String(text)) => Some(std::mem::take(text).into_owned()),
                _ => None,
            }
        }
        _ => None,
    };
    match text {
        Some(text) => Ok(text),
        None => Err(JsonValue::Array(elements)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_one(raw_content: &str, unwrap: bool) -> ToonEncodeResult {
        let results = toon_encode_tool_results(
            vec![ToonEncodeItem {
                id: "t1".to_string(),
                raw_content: raw_content.to_string(),
                unwrap,
            }],
            None,
        );
        assert_eq!(results.len(), 1);
        results.into_iter().next().expect("one result")
    }

    const INNER: &str = r#"{"data":[{"id":1,"v":"a"},{"id":2,"v":"b"}],"ok":true}"#;
    const INNER_TOON: &str = "data[2]{id,v}:\n  1,a\n  2,b\nok: true";

    #[test]
    fn unwrap_single_text_wrapper() {
        let wrapped = serde_json::to_string(&serde_json::json!([{"type": "text", "text": INNER}]))
            .expect("serialize fixture");
        let result = encode_one(&wrapped, true);
        assert_eq!(result.normalized, INNER);
        assert_eq!(result.encoded.as_deref(), Some(INNER_TOON));
    }

    #[test]
    fn unwrap_multi_element_wrapper_uses_first_text_only() {
        let wrapped = serde_json::to_string(&serde_json::json!([
            {"type": "text", "text": INNER},
            {"type": "text", "text": r#"{"second":"ignored"}"#},
        ]))
        .expect("serialize fixture");
        let result = encode_one(&wrapped, true);
        assert_eq!(result.normalized, INNER);
        assert_eq!(result.encoded.as_deref(), Some(INNER_TOON));
    }

    #[test]
    fn unwrap_first_block_not_text_returns_content_unchanged() {
        let wrapped = serde_json::to_string(&serde_json::json!([
            {"type": "image", "url": "http://x"},
            {"type": "text", "text": INNER},
        ]))
        .expect("serialize fixture");
        let result = encode_one(&wrapped, true);
        // Not unwrapped: the whole wrapper array is what gets encoded.
        assert_eq!(result.normalized, wrapped);
        assert!(result.encoded.is_some());
        assert_ne!(result.encoded.as_deref(), Some(INNER_TOON));
    }

    #[test]
    fn unwrap_text_field_not_a_string_returns_content_unchanged() {
        let wrapped = r#"[{"type":"text","text":42}]"#;
        let result = encode_one(wrapped, true);
        assert_eq!(result.normalized, wrapped);
    }

    #[test]
    fn unwrap_non_array_json_returns_content_unchanged() {
        let result = encode_one(INNER, true);
        assert_eq!(result.normalized, INNER);
        assert_eq!(result.encoded.as_deref(), Some(INNER_TOON));
    }

    #[test]
    fn unwrap_empty_array_returns_content_unchanged() {
        let result = encode_one("[]", true);
        assert_eq!(result.normalized, "[]");
        assert!(result.encoded.is_some());
    }

    #[test]
    fn unwrap_first_element_not_an_object_returns_content_unchanged() {
        let raw = r#"["text",{"type":"text","text":"x"}]"#;
        let result = encode_one(raw, true);
        assert_eq!(result.normalized, raw);
    }

    #[test]
    fn unwrap_invalid_json_returns_content_unchanged() {
        let raw = "not json at all";
        let result = encode_one(raw, true);
        assert_eq!(result.normalized, raw);
        assert_eq!(result.encoded, None);
    }

    #[test]
    fn unwrap_false_skips_unwrapping_even_for_wrapper_shape() {
        let wrapped = serde_json::to_string(&serde_json::json!([{"type": "text", "text": INNER}]))
            .expect("serialize fixture");
        let result = encode_one(&wrapped, false);
        assert_eq!(result.normalized, wrapped);
        assert_ne!(result.encoded.as_deref(), Some(INNER_TOON));
    }

    #[test]
    fn wrapper_with_escaped_lone_surrogate_falls_through_unchanged() {
        // JS `JSON.parse` accepts this wrapper and would unwrap it; serde_json
        // rejects the escaped lone surrogate, so the content is kept as-is and
        // nothing is encoded (approved JS→Rust migration divergence).
        let wrapped = r#"[{"type":"text","text":"\ud800"}]"#;
        let result = encode_one(wrapped, true);
        assert_eq!(result.normalized, wrapped);
        assert_eq!(result.encoded, None);
    }

    #[test]
    fn wrapper_containing_invalid_json_text_yields_no_encoding() {
        let wrapped = r#"[{"type":"text","text":"plain prose result"}]"#;
        let result = encode_one(wrapped, true);
        assert_eq!(result.normalized, "plain prose result");
        assert_eq!(result.encoded, None);
    }

    #[test]
    fn malformed_json_yields_none_with_raw_normalized() {
        for raw in [
            r#"{"a": [1, 2"#,
            "Tool run 42 output",
            "{'a': 1}",
            r#"{"x": NaN}"#,
            "",
        ] {
            let result = encode_one(raw, true);
            assert_eq!(result.normalized, raw);
            assert_eq!(result.encoded, None, "raw content: {raw:?}");
        }
    }

    #[test]
    fn non_object_roots_encode() {
        for (raw, expected) in [
            ("42", "42"),
            (r#""just a string""#, "just a string"),
            ("true", "true"),
            ("null", "null"),
            ("[1,2,3,4,5]", "[5]: 1,2,3,4,5"),
            ("{}", ""),
            ("[]", "[0]:"),
        ] {
            let result = encode_one(raw, false);
            assert_eq!(result.encoded.as_deref(), Some(expected), "raw: {raw}");
        }
    }

    #[test]
    fn boundary_numbers_encode_exactly() {
        for (raw, expected) in [
            (r#"{"n":9007199254740991}"#, "n: 9007199254740991"), // 2^53 - 1
            (r#"{"n":9007199254740992}"#, "n: 9007199254740992"), // 2^53
            (r#"{"n":9007199254740993}"#, "n: 9007199254740993"), // 2^53 + 1 (JS would coerce)
            (r#"{"n":9223372036854775807}"#, "n: 9223372036854775807"), // i64::MAX
            (r#"{"n":-9223372036854775808}"#, "n: -9223372036854775808"), // i64::MIN
            (r#"{"n":18446744073709551615}"#, "n: 18446744073709551615"), // u64::MAX
            (r#"{"x":-0}"#, "x: 0"),
            (r#"{"x":1e-7}"#, "x: 0.0000001"),
        ] {
            let result = encode_one(raw, true);
            assert_eq!(result.encoded.as_deref(), Some(expected), "raw: {raw}");
        }
        // 1e300 expands to the full decimal literal; pin its shape, not 300 zeros.
        let huge = encode_one(r#"{"x":1e300}"#, true)
            .encoded
            .expect("1e300 encodes");
        assert!(huge.starts_with("x: 1"));
        assert_eq!(huge.len(), "x: ".len() + 301);
    }

    #[test]
    fn aggregate_batch_budget_caps_total_retained_output() {
        // Each item is ~301B of exponent-form numbers encoding to ~15.1KB —
        // under its own per-item 16KiB floor, so 40 of them would retain
        // ~600KB from ~12KB of input without the aggregate cap. Batch budget
        // = 2 x 12040 + 16384 = 40464 bytes: items 0-2 encode (45315 bytes
        // produced), everything after is skipped.
        let raw = format!("[{}]", vec!["1e300"; 50].join(","));
        let items: Vec<ToonEncodeItem> = (0..40)
            .map(|i| ToonEncodeItem {
                id: format!("i{i}"),
                raw_content: raw.clone(),
                unwrap: false,
            })
            .collect();
        let total_input = raw.len() * 40;
        let batch_budget = 2 * total_input + 16 * 1024;

        let results = toon_encode_tool_results(items, None);
        assert_eq!(results.len(), 40);
        let encoded_count = results.iter().filter(|r| r.encoded.is_some()).count();
        assert_eq!(encoded_count, 3, "first items encode, tail is skipped");
        assert!(results[0].encoded.is_some());
        assert!(results.last().expect("40 results").encoded.is_none());
        let produced: usize = results
            .iter()
            .filter_map(|r| r.encoded.as_ref().map(String::len))
            .sum();
        // Bounded: the budget plus at most one crossing item's output.
        assert!(
            produced <= batch_budget + 16 * 1024,
            "retained output {produced} exceeds bound"
        );
        assert!(results.iter().all(|r| r.normalized == raw));
    }

    #[test]
    fn input_cap_skips_oversized_items_without_parsing() {
        // Just over the cap: skipped entirely — no parse, no unwrap, content
        // kept verbatim.
        let over = format!(r#"["{}"]"#, "a".repeat(MAX_ITEM_INPUT_BYTES));
        assert!(over.len() > MAX_ITEM_INPUT_BYTES);
        let result = encode_one(&over, true);
        assert_eq!(result.normalized, over);
        assert_eq!(result.encoded, None);

        // At the cap boundary: still parsed and encoded normally.
        let under = format!(r#"["{}"]"#, "a".repeat(MAX_ITEM_INPUT_BYTES - 4));
        assert_eq!(under.len(), MAX_ITEM_INPUT_BYTES);
        let result = encode_one(&under, true);
        assert!(result.encoded.is_some());
    }

    #[test]
    fn budget_exceeded_yields_none_and_keeps_original() {
        // ~24KB of exponent-form numbers would expand ~60x past the 2x output
        // budget; the item fails open: `encoded: None`, original payload kept.
        // This pins the behavior change for adapters that apply compression
        // unconditionally (Bedrock/MiniMax): a pathologically-expanding payload
        // is now skipped instead of hugely inflated — closer to the old npm
        // path, which emitted compact exponent forms.
        let raw = format!("[{}]", vec!["1e300"; 4096].join(","));
        let result = encode_one(&raw, true);
        assert_eq!(result.normalized, raw);
        assert_eq!(result.encoded, None);
    }

    #[test]
    fn batch_is_positional_and_same_length() {
        let items = vec![
            ToonEncodeItem {
                id: "a".to_string(),
                raw_content: r#"{"a":1}"#.to_string(),
                unwrap: true,
            },
            ToonEncodeItem {
                id: "a".to_string(), // duplicate id: results are positional
                raw_content: "not json".to_string(),
                unwrap: true,
            },
            ToonEncodeItem {
                id: "c".to_string(),
                raw_content: r#"{"c":3}"#.to_string(),
                unwrap: false,
            },
        ];
        let results = toon_encode_tool_results(items, None);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].encoded.as_deref(), Some("a: 1"));
        assert_eq!(results[1].encoded, None);
        assert_eq!(results[2].encoded.as_deref(), Some("c: 3"));
    }

    #[test]
    fn empty_batch_returns_empty() {
        assert!(toon_encode_tool_results(Vec::new(), None).is_empty());
    }

    fn count_one(raw_content: &str, unwrap: bool, count: BeforeSource) -> ToonEncodeResult {
        let results = toon_encode_tool_results(
            vec![ToonEncodeItem {
                id: "t1".to_string(),
                raw_content: raw_content.to_string(),
                unwrap,
            }],
            Some(count),
        );
        results.into_iter().next().expect("one result")
    }

    #[test]
    fn no_count_leaves_token_fields_unset() {
        let result = encode_one(INNER, true);
        assert!(result.encoded.is_some());
        assert_eq!(result.before_tokens, None);
        assert_eq!(result.encoded_tokens, None);
    }

    #[test]
    fn count_populates_both_token_fields_for_encoded_items() {
        let result = count_one(INNER, false, BeforeSource::Normalized);
        let before = result.before_tokens.expect("before counted");
        let after = result.encoded_tokens.expect("encoded counted");
        assert!(before > 0 && after > 0);
        // The whole point: the TOON encoding of a uniform object is smaller.
        assert!(after < before, "before={before} after={after}");
    }

    #[test]
    fn count_skips_unencodable_items() {
        // Not JSON -> encoded None -> no "before" to compare, nothing counted.
        let result = count_one("plain prose, not json", true, BeforeSource::Normalized);
        assert_eq!(result.encoded, None);
        assert_eq!(result.before_tokens, None);
        assert_eq!(result.encoded_tokens, None);
    }

    #[test]
    fn before_source_selects_raw_vs_normalized_when_they_differ() {
        // A wrapped payload: normalized (inner INNER) differs from raw (the
        // whole wrapper array). Raw counts more tokens than Normalized.
        let wrapped = serde_json::to_string(&serde_json::json!([{"type": "text", "text": INNER}]))
            .expect("serialize fixture");
        let normalized = count_one(&wrapped, true, BeforeSource::Normalized)
            .before_tokens
            .expect("normalized before");
        let raw = count_one(&wrapped, true, BeforeSource::Raw)
            .before_tokens
            .expect("raw before");
        assert!(raw > normalized, "raw={raw} normalized={normalized}");
    }
}
