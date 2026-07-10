//! Round-trip property tests: for generated JSON documents,
//! `decode(encode(parse(raw)))` is semantically equal to `parse(raw)`. The
//! goldens pin regression; this pins encoder/decoder semantics on shapes we did
//! not enumerate by hand. The comparison baseline is the PARSED value, not the
//! generated one: serde_json's default float parse can be 1 ULP off the
//! shortest-repr literal (a disclosed JS→Rust migration difference), and that
//! parse step is part of the kernel under test, not of TOON.
//!
//! Generator constraints mirror known `toon-format` 0.5 quirks (verified in the
//! validation spike) so we do not pin upstream bugs as our own failures:
//! - no empty objects inside containers: an array of all-empty objects encodes
//!   as `[N]{}:`, which the crate's own decoder rejects (upstream issue #74);
//! - numbers stay well inside +/- 2^63 and floats moderate: integer-valued
//!   floats around 2^64 and above decode back as strings;
//! - object keys containing `.` are restricted to plain dotted identifiers
//!   (which the encoder emits unquoted): the decoder prepends a spurious NUL to
//!   QUOTED keys containing dots (e.g. `{"a":null,"...":null}` decodes the
//!   second key as `"\0..."`, and `"𝄞."`/nested `"¡."` fail the same way);
//! - in arrays that hold container elements (list layout), string elements get
//!   whitespace replaced and leading digits prefixed: the encoder emits such
//!   strings unquoted and its own decoder cannot re-parse the layout (e.g.
//!   `["a b",[]]` and `[[],"0a"]` both fail to decode);
//! - object keys are non-empty: `[{"":null}]` encodes to a tabular header
//!   `[1]{""}:` that the decoder rejects ("Field name cannot be empty");
//! - string content limits control/whitespace characters to `\n`, `\t` and
//!   space: exotic ones are emitted raw in unquoted positions and lost on
//!   decode (e.g. a vertical tab in `"A\u{b} x"` decodes as `"A x"`);
//! - a ROOT-level document that is a bare digit-leading string gets a space
//!   inserted after the digit run by the decoder (`"0¡"` decodes as `"0 ¡"`);
//!   container positions are unaffected, so only the root string is dodged.

use proptest::prelude::*;
use proxy_transform_core::{ToonEncodeItem, toon_encode_tool_results};
use serde_json::Value;

fn arb_key() -> impl Strategy<Value = String> {
    prop_oneof![
        // Any non-empty key without a dot (see module docs for the quirks).
        "[^.]+".prop_map(neutralize_exotic_whitespace),
        // Dotted identifier keys, always emitted unquoted — these round-trip.
        "[a-z][a-z0-9_]{0,5}(\\.[a-z][a-z0-9_]{0,5}){1,2}",
    ]
}

fn arb_string() -> impl Strategy<Value = String> {
    ".*".prop_map(neutralize_exotic_whitespace)
}

/// See module docs: keep `\n`, `\t` and space (verified to round-trip), map
/// other control/whitespace characters to `_`.
fn neutralize_exotic_whitespace(text: String) -> String {
    text.chars()
        .map(|c| match c {
            '\n' | '\t' | ' ' => c,
            c if c.is_control() || c.is_whitespace() => '_',
            c => c,
        })
        .collect()
}

fn arb_json() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        (-(1i64 << 62)..(1i64 << 62)).prop_map(|n| Value::Number(n.into())),
        (-1.0e15..1.0e15f64).prop_map(|f| {
            serde_json::Number::from_f64(f)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        }),
        arb_string().prop_map(Value::String),
    ];
    leaf.prop_recursive(4, 48, 8, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..8).prop_map(Value::Array),
            // Objects always carry at least one key (see module docs).
            prop::collection::btree_map(arb_key(), inner, 1..8)
                .prop_map(|map| Value::Object(map.into_iter().collect())),
        ]
    })
    .prop_map(dodge_list_layout_quirk)
    .prop_map(dodge_root_digit_string_quirk)
}

/// See module docs: only a root-level digit-leading string trips the decoder's
/// digit-run split, so prefix it the same way the list-layout dodge does.
fn dodge_root_digit_string_quirk(value: Value) -> Value {
    match value {
        Value::String(text) if text.starts_with(|c: char| c.is_ascii_digit()) => {
            Value::String(format!("_{text}"))
        }
        other => other,
    }
}

/// Unconstrained JSON generator for encode-only properties: no decoder-quirk
/// exclusions (any strings/keys incl. control chars and dots, empty objects,
/// full i64/f64 ranges) — the wrapper property never decodes TOON.
fn arb_json_encode_only() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        Just(Value::Null),
        any::<bool>().prop_map(Value::Bool),
        any::<i64>().prop_map(|n| Value::Number(n.into())),
        any::<f64>().prop_map(|f| {
            serde_json::Number::from_f64(f)
                .map(Value::Number)
                .unwrap_or(Value::Null)
        }),
        ".*".prop_map(Value::String),
    ];
    leaf.prop_recursive(4, 48, 8, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..8).prop_map(Value::Array),
            prop::collection::btree_map(".*", inner, 0..8)
                .prop_map(|map| Value::Object(map.into_iter().collect())),
        ]
    })
}

/// See module docs: keep generated shapes rich, but neutralize string elements
/// of arrays that also hold containers (whitespace, leading digits) so we do
/// not pin the encoder's unquoted-list-string / decoder disagreement as our
/// failure.
fn dodge_list_layout_quirk(value: Value) -> Value {
    match value {
        Value::Array(items) => {
            let has_container = items.iter().any(|item| item.is_array() || item.is_object());
            let items = items
                .into_iter()
                .map(|item| match item {
                    Value::String(text) if has_container => {
                        let mut text = text.replace(char::is_whitespace, "_");
                        if text.starts_with(|c: char| c.is_ascii_digit()) {
                            text.insert(0, '_');
                        }
                        Value::String(text)
                    }
                    other => dodge_list_layout_quirk(other),
                })
                .collect();
            Value::Array(items)
        }
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, dodge_list_layout_quirk(item)))
                .collect(),
        ),
        other => other,
    }
}

/// Numeric-tolerant equality: i64/u64/f64 representations of the same number
/// compare equal (the decoder may pick a different `serde_json::Number` repr).
/// Integers are compared exactly (an f64 detour would collapse distinct
/// integers above 2^53); the f64 fallback only applies when a side is a float.
fn semantically_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            if let (Some(ix), Some(iy)) = (x.as_i64(), y.as_i64()) {
                ix == iy
            } else if let (Some(ux), Some(uy)) = (x.as_u64(), y.as_u64()) {
                ux == uy
            } else if let (Some(fx), Some(fy)) = (x.as_f64(), y.as_f64()) {
                fx == fy
            } else {
                x == y
            }
        }
        (Value::Array(xs), Value::Array(ys)) => {
            xs.len() == ys.len()
                && xs
                    .iter()
                    .zip(ys.iter())
                    .all(|(x, y)| semantically_equal(x, y))
        }
        (Value::Object(xs), Value::Object(ys)) => {
            xs.len() == ys.len()
                && xs
                    .iter()
                    .all(|(key, x)| ys.get(key).is_some_and(|y| semantically_equal(x, y)))
        }
        _ => a == b,
    }
}

proptest! {
    /// Differential parity oracle: our encoder must produce byte-identical
    /// output to `toon_format::encode_default` for any parseable JSON. Uses
    /// the unconstrained generator — encode-only, so no decoder-quirk
    /// exclusions apply. The allowed divergences are the deliberate
    /// anti-amplification limits: when our encoder returns `None`, either the
    /// input exceeds the per-item cap or the crate's output must genuinely
    /// exceed `max(2 x input bytes, 16KiB)`. (The aggregate batch budget never
    /// binds here: a single-item batch is gated before any output exists.)
    #[test]
    fn encoder_matches_toon_format_crate(value in arb_json_encode_only()) {
        let raw = serde_json::to_string(&value).expect("serialize generated value");
        let parsed: Value = serde_json::from_str(&raw).expect("reparse generated document");
        let raw_len = raw.len();
        let budget = (2 * raw_len).max(16 * 1024);
        let results = toon_encode_tool_results(vec![ToonEncodeItem {
            id: "diff".to_string(),
            raw_content: raw,
            unwrap: false,
        }]);
        let expected = toon_format::encode_default(&parsed).ok();
        match (&results[0].encoded, &expected) {
            (None, Some(crate_output)) => prop_assert!(
                raw_len > proxy_transform_core::MAX_ITEM_INPUT_BYTES
                    || crate_output.len() > budget,
                "our encoder returned None but no skip condition held (input {} bytes, \
                 crate output {} bytes, budget {}) for value: {}",
                raw_len,
                crate_output.len(),
                budget,
                parsed
            ),
            (ours, expected) => prop_assert_eq!(
                ours,
                expected,
                "encoder diverged from toon-format crate for value: {}",
                parsed
            ),
        }
    }

    #[test]
    fn encode_decode_roundtrips(value in arb_json()) {
        let raw = serde_json::to_string(&value).expect("serialize generated value");
        let parsed: Value = serde_json::from_str(&raw).expect("reparse generated document");
        let results = toon_encode_tool_results(vec![ToonEncodeItem {
            id: "prop".to_string(),
            raw_content: raw,
            unwrap: false,
        }]);
        let encoded = results[0].encoded.as_ref().expect("valid JSON always encodes");
        let decoded: Value = toon_format::decode_default(encoded)
            .unwrap_or_else(|error| panic!("decode failed: {error}\nencoded:\n{encoded}"));
        prop_assert!(
            semantically_equal(&parsed, &decoded),
            "round-trip mismatch:\nparsed: {parsed}\ndecoded: {decoded}\nencoded:\n{encoded}"
        );
    }

    /// Unwrapping the `[{"type":"text","text":...}]` wrapper must yield exactly
    /// the encoding of the inner payload.
    #[test]
    fn wrapped_input_encodes_like_inner_payload(value in arb_json_encode_only()) {
        let inner = serde_json::to_string(&value).expect("serialize generated value");
        let wrapped = serde_json::to_string(&serde_json::json!([
            {"type": "text", "text": inner}
        ]))
        .expect("serialize wrapper");
        let results = toon_encode_tool_results(vec![
            ToonEncodeItem { id: "direct".to_string(), raw_content: inner.clone(), unwrap: false },
            ToonEncodeItem { id: "wrapped".to_string(), raw_content: wrapped, unwrap: true },
        ]);
        prop_assert_eq!(&results[1].normalized, &inner);
        prop_assert_eq!(&results[1].encoded, &results[0].encoded);
    }
}
