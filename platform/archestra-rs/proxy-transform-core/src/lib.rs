//! Pure tool-result transformation kernel for the LLM proxy: unwrap the text-block
//! wrapper some clients (n8n, Vercel AI SDK) add around tool results, parse the
//! JSON, and encode it as TOON (spec v3, official `toon-format` crate).
//!
//! Node-free; the NAPI adapter lives in `proxy_transform_rs`. Per-item processing
//! is infallible: content that is not parseable JSON yields `encoded: None` and the
//! adapter keeps the original payload (fail-open, exactly like the TS path today).

use serde_json::Value;

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

/// The transformation output for one item. `normalized` is the unwrapped string
/// when unwrapping was requested and matched, else the original `raw_content`
/// (adapters tokenize it for accounting). `encoded` is the TOON encoding, or
/// `None` when the content is not parseable JSON.
///
/// `use_nullable` makes `encoded: None` cross the boundary as an explicit JS
/// `null` (typed `string | null`) instead of an omitted key.
#[derive(Clone, Debug)]
#[cfg_attr(feature = "napi", napi_derive::napi(object, use_nullable = true))]
pub struct ToonEncodeResult {
    pub normalized: String,
    pub encoded: Option<String>,
}

/// Transform a batch of tool results. Positional contract: the output has the
/// same length and order as the input. Never panics on any input.
pub fn toon_encode_tool_results(items: Vec<ToonEncodeItem>) -> Vec<ToonEncodeResult> {
    items.into_iter().map(encode_item).collect()
}

fn encode_item(item: ToonEncodeItem) -> ToonEncodeResult {
    let normalized = if item.unwrap {
        unwrap_tool_content(item.raw_content)
    } else {
        item.raw_content
    };
    let encoded = serde_json::from_str::<Value>(&normalized)
        .ok()
        .and_then(|value| toon_format::encode_default(&value).ok());
    ToonEncodeResult {
        normalized,
        encoded,
    }
}

/// Port of `platform/backend/src/routes/proxy/utils/unwrap-tool-content.ts`:
/// if `content` parses as a JSON array whose FIRST element is
/// `{"type": "text", "text": <string>, ...}`, return that text; otherwise return
/// `content` unchanged. First-element-only is deliberate (pinned TS behavior) —
/// extra wrapper elements are dropped from the encoding input.
///
/// Divergence from JS `JSON.parse` (within the approved migration envelope):
/// `serde_json` rejects escaped lone surrogates (e.g. `"\ud800"`) and
/// out-of-range number literals (e.g. `1e400`, `Infinity` in JS) that JS
/// parses, so wrappers containing them are NOT unwrapped here — the content
/// falls through unchanged and later fails to encode (`encoded: None`), i.e.
/// the original payload is conservatively kept.
fn unwrap_tool_content(content: String) -> String {
    let Ok(Value::Array(elements)) = serde_json::from_str(&content) else {
        return content;
    };
    let Some(Value::Object(mut first)) = elements.into_iter().next() else {
        return content;
    };
    let is_text_block = first.get("type").and_then(Value::as_str) == Some("text");
    match (is_text_block, first.remove("text")) {
        (true, Some(Value::String(text))) => text,
        _ => content,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_one(raw_content: &str, unwrap: bool) -> ToonEncodeResult {
        let results = toon_encode_tool_results(vec![ToonEncodeItem {
            id: "t1".to_string(),
            raw_content: raw_content.to_string(),
            unwrap,
        }]);
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
        let results = toon_encode_tool_results(items);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].encoded.as_deref(), Some("a: 1"));
        assert_eq!(results[1].encoded, None);
        assert_eq!(results[2].encoded.as_deref(), Some("c: 3"));
    }

    #[test]
    fn empty_batch_returns_empty() {
        assert!(toon_encode_tool_results(Vec::new()).is_empty());
    }
}
