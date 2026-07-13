//! TOON (spec v3) encoder, byte-compatible with `toon-format` 0.5.0
//! `encode_default` (2-space indent, comma delimiter, key folding off), but
//! linear-time and low-allocation: a single pass over the borrowed
//! [`JsonValue`] DOM writing into one output buffer. The upstream crate stays
//! as a dev-dependency and is the parity oracle: the committed golden corpus
//! plus the differential property test in `tests/roundtrip_property.rs` pin
//! byte equality.
//!
//! Trust boundary: input values come from [`crate::json::parse_json`], so
//! floats are always finite — the crate's NaN/Infinity→null normalization is
//! unreachable here and not replicated. Its -0.0→0 normalization falls out of
//! the integer-collapse float path below.
//!
//! Deliberate divergence from the crate — the OUTPUT BUDGET: TOON expands
//! exponent-form numbers to full decimal literals (`1e300`, 5 JSON bytes,
//! becomes 301 output bytes), so a legal payload of such numbers amplifies
//! ~60x and a large tool result could force multi-GiB allocations (Rust
//! aborts the host process on allocation failure — `catch_unwind` cannot stop
//! that). Encoding therefore aborts with [`EncodeError::OutputBudgetExceeded`]
//! once the output would exceed `max(2 x input bytes, 16KiB)`; the pipeline
//! maps that to `encoded: None` (fail-open, original payload kept).
//! Semantically safe: an encoding at >= 2x the input bytes can never win the
//! downstream token comparison, and skipping is closer to the old npm path,
//! which emitted compact exponent forms instead of expanding. Scalar writes
//! are pre-checked with their exact size (the crossing write is refused
//! outright, so the buffer cannot double its capacity past the budget); loop
//! bodies keep a post-write check as backstop for small structural output.
//! The pipeline adds two more anti-amplification layers on top of this
//! per-item budget: an aggregate batch budget and a per-item input size cap
//! (see `lib.rs`).

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use crate::json::{JsonObject, JsonValue};

/// Mirrors `toon-format`'s `MAX_DEPTH`. Note the crate's depth counter is not
/// "one per nesting level": list-item object fields jump it by 2-3, so deeply
/// nested list shapes can exceed it and must fail exactly like the crate.
const MAX_DEPTH: usize = 256;

/// Output budget floor (see module docs): small inputs may legitimately expand
/// past 2x (indentation, `[N]` markers), so the cap only starts binding above
/// this many output bytes. Also reused by the batch-level aggregate budget in
/// `lib.rs`.
pub(crate) const OUTPUT_BUDGET_FLOOR: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EncodeError {
    /// The depth counter exceeded [`MAX_DEPTH`] (crate: `InvalidStructure`).
    MaxDepthExceeded,
    /// The output would exceed `max(2 x input bytes, 16KiB)` — deliberate
    /// anti-amplification divergence from the crate (see module docs).
    OutputBudgetExceeded,
    /// std `Display` produced exponent notation for a float. Unreachable
    /// (verified: Display always expands), but emitting it verbatim would
    /// break byte parity with the crate's expansion, so it fails closed.
    ExponentFloatFormat,
    /// A container reached a primitive-only position. Unreachable — every call
    /// site pre-checks — kept so a future bug fails closed like the crate's
    /// `InvalidInput` instead of emitting corrupt output.
    NonPrimitive,
}

/// Encode a parsed JSON value as TOON, byte-identical to
/// `toon_format::encode_default` for every output within the anti-amplification
/// budget derived from `input_len` (the JSON text length; also used to presize
/// the output buffer). Scalar writes are pre-checked with their exact size, so
/// the accept set is precisely "final output length <= budget".
pub(crate) fn encode_to_toon(
    value: &JsonValue<'_>,
    input_len: usize,
) -> Result<String, EncodeError> {
    let budget = OUTPUT_BUDGET_FLOOR.max(input_len.saturating_mul(2));
    let mut encoder = Encoder {
        out: String::with_capacity(input_len),
        budget,
        float_scratch: String::new(),
    };
    encoder.value(value)?;
    Ok(encoder.out)
}

struct Encoder {
    out: String,
    /// Maximum output length; a write that would grow past it aborts the encode.
    budget: usize,
    /// Reused staging buffer for float formatting (exact-size budget pre-check
    /// and trailing-zero trim happen here before the text reaches `out`).
    float_scratch: String,
}

impl Encoder {
    fn value(&mut self, value: &JsonValue<'_>) -> Result<(), EncodeError> {
        match value {
            JsonValue::Array(arr) => self.array(None, arr, 0),
            JsonValue::Object(obj) => self.object(obj, 0),
            primitive => self.primitive(primitive),
        }
    }

    fn object(&mut self, obj: &JsonObject<'_>, depth: usize) -> Result<(), EncodeError> {
        check_depth(depth)?;
        for (i, (key, value)) in obj.iter().enumerate() {
            if i > 0 {
                self.out.push('\n');
            }
            match value {
                JsonValue::Array(arr) => self.array(Some(key), arr, depth)?,
                JsonValue::Object(nested) => {
                    self.indent(depth);
                    self.key(key)?;
                    self.out.push(':');
                    if !nested.is_empty() {
                        self.out.push('\n');
                        self.object(nested, depth + 1)?;
                    }
                }
                primitive => {
                    self.indent(depth);
                    self.key(key)?;
                    self.out.push_str(": ");
                    self.primitive(primitive)?;
                }
            }
            self.check_budget()?;
        }
        Ok(())
    }

    fn array(
        &mut self,
        key: Option<&str>,
        arr: &[JsonValue<'_>],
        depth: usize,
    ) -> Result<(), EncodeError> {
        check_depth(depth)?;
        if arr.is_empty() {
            self.array_header(key, 0, None, depth)?;
            return Ok(());
        }
        if let Some(fields) = tabular_fields(arr) {
            self.array_header(key, arr.len(), Some(&fields), depth)?;
            self.out.push('\n');
            self.tabular_rows(arr, &fields, depth + 1)
        } else if arr.iter().all(is_primitive) {
            self.primitive_array(key, arr, depth)
        } else {
            self.list_array(key, arr, depth)
        }
    }

    fn primitive_array(
        &mut self,
        key: Option<&str>,
        arr: &[JsonValue<'_>],
        depth: usize,
    ) -> Result<(), EncodeError> {
        self.array_header(key, arr.len(), None, depth)?;
        self.out.push(' ');
        for (i, value) in arr.iter().enumerate() {
            if i > 0 {
                self.out.push(',');
            }
            self.primitive(value)?;
        }
        Ok(())
    }

    /// One tabular row per array element, indented at `row_depth`. Rows almost
    /// always repeat the header's key order, so the fast path writes values in
    /// storage order. Set-equal-but-reordered rows go through a field→column
    /// index built once per array (rows x fields hash lookups, the crate's own
    /// complexity — a per-cell linear key search would be rows x fields^2).
    fn tabular_rows(
        &mut self,
        arr: &[JsonValue<'_>],
        fields: &[&str],
        row_depth: usize,
    ) -> Result<(), EncodeError> {
        let mut field_columns: Option<HashMap<&str, usize>> = None;
        let mut row_cells: Vec<Option<&JsonValue>> = Vec::new();
        for (i, row) in arr.iter().enumerate() {
            // Guaranteed an object by `tabular_fields`; skip mirrors the crate.
            let Some(obj) = row.as_object() else { continue };
            self.indent(row_depth);
            if obj.iter().map(|(key, _)| key).eq(fields.iter().copied()) {
                for (j, (_, value)) in obj.iter().enumerate() {
                    if j > 0 {
                        self.out.push(',');
                    }
                    self.primitive(value)?;
                }
            } else {
                let columns = field_columns.get_or_insert_with(|| {
                    fields
                        .iter()
                        .enumerate()
                        .map(|(column, &field)| (field, column))
                        .collect()
                });
                row_cells.clear();
                row_cells.resize(fields.len(), None);
                for (key, value) in obj.iter() {
                    if let Some(&column) = columns.get(key) {
                        row_cells[column] = Some(value);
                    }
                }
                for (j, cell) in row_cells.iter().enumerate() {
                    if j > 0 {
                        self.out.push(',');
                    }
                    match cell {
                        Some(value) => self.primitive(value)?,
                        // Unreachable (detection verified every field), but the
                        // crate writes null for missing cells.
                        None => self.push_checked("null")?,
                    }
                }
            }
            if i < arr.len() - 1 {
                self.out.push('\n');
            }
            self.check_budget()?;
        }
        Ok(())
    }

    /// List layout (`- item` lines) for arrays that are neither tabular nor
    /// all-primitive.
    fn list_array(
        &mut self,
        key: Option<&str>,
        arr: &[JsonValue<'_>],
        depth: usize,
    ) -> Result<(), EncodeError> {
        self.array_header(key, arr.len(), None, depth)?;
        self.out.push('\n');
        for (i, item) in arr.iter().enumerate() {
            self.indent(depth + 1);
            self.out.push('-');
            match item {
                JsonValue::Array(inner) => {
                    self.out.push(' ');
                    self.array(None, inner, depth + 1)?;
                }
                JsonValue::Object(obj) => self.list_item_object(obj, depth)?,
                primitive => {
                    self.out.push(' ');
                    self.primitive(primitive)?;
                }
            }
            if i < arr.len() - 1 {
                self.out.push('\n');
            }
            self.check_budget()?;
        }
        Ok(())
    }

    /// Object as a list item: first field on the hyphen line, remaining fields
    /// two levels below it; empty objects are a bare hyphen. The uneven depth
    /// jumps (+2/+3) replicate the crate's layout exactly.
    fn list_item_object(&mut self, obj: &JsonObject<'_>, depth: usize) -> Result<(), EncodeError> {
        let mut entries = obj.iter();
        let Some((first_key, first_value)) = entries.next() else {
            return Ok(());
        };
        self.out.push(' ');
        match first_value {
            JsonValue::Array(arr) => {
                self.key(first_key)?;
                if let Some(fields) = tabular_fields(arr) {
                    // Tabular rows of a first-field array sit at depth + 3
                    // relative to this list's header (crate quirk, no depth
                    // check on this path).
                    self.array_header(None, arr.len(), Some(&fields), 0)?;
                    self.out.push('\n');
                    self.tabular_rows(arr, &fields, depth + 3)?;
                } else {
                    self.array(None, arr, depth + 2)?;
                }
            }
            JsonValue::Object(nested) => {
                self.key(first_key)?;
                self.out.push(':');
                if !nested.is_empty() {
                    self.out.push('\n');
                    self.object(nested, depth + 3)?;
                }
            }
            primitive => {
                self.key(first_key)?;
                self.out.push_str(": ");
                self.primitive(primitive)?;
            }
        }
        for (key, value) in entries {
            self.out.push('\n');
            self.indent(depth + 2);
            match value {
                JsonValue::Array(arr) => {
                    self.key(key)?;
                    self.array(None, arr, depth + 2)?;
                }
                JsonValue::Object(nested) => {
                    self.key(key)?;
                    self.out.push(':');
                    if !nested.is_empty() {
                        self.out.push('\n');
                        self.object(nested, depth + 3)?;
                    }
                }
                primitive => {
                    self.key(key)?;
                    self.out.push_str(": ");
                    self.primitive(primitive)?;
                }
            }
            self.check_budget()?;
        }
        Ok(())
    }

    /// `key[N]:`, `[N]:` or `key[N]{f1,f2}:`. Indent is written only when a
    /// key is present (crate behavior — keyless headers are always inline).
    fn array_header(
        &mut self,
        key: Option<&str>,
        len: usize,
        fields: Option<&[&str]>,
        depth: usize,
    ) -> Result<(), EncodeError> {
        if let Some(key) = key {
            self.indent(depth);
            self.key(key)?;
        }
        self.out.push('[');
        self.write_int(len)?;
        self.out.push(']');
        if let Some(fields) = fields {
            self.out.push('{');
            for (i, &field) in fields.iter().enumerate() {
                if i > 0 {
                    self.out.push(',');
                }
                self.key(field)?;
            }
            self.out.push('}');
        }
        self.out.push(':');
        Ok(())
    }

    fn primitive(&mut self, value: &JsonValue<'_>) -> Result<(), EncodeError> {
        match value {
            JsonValue::Null => self.push_checked("null"),
            JsonValue::Bool(true) => self.push_checked("true"),
            JsonValue::Bool(false) => self.push_checked("false"),
            // Integer typing follows the parse (see crate::json); formatting
            // matches the crate's as_i64 → as_u64 fallback digit-for-digit.
            JsonValue::PosInt(u) => self.write_int(*u),
            JsonValue::NegInt(i) => self.write_int(*i),
            JsonValue::Float(f) => self.f64_canonical(*f),
            JsonValue::String(s) => self.string_value(s),
            JsonValue::Array(_) | JsonValue::Object(_) => Err(EncodeError::NonPrimitive),
        }
    }

    /// Append `text` only if the result stays within the output budget; the
    /// crossing write is refused BEFORE it lands, so the buffer never grows
    /// (or reallocates) past the budget on a scalar. `len + text.len() >
    /// budget` is exactly the post-write condition, so the accept set is
    /// unchanged versus checking afterwards.
    fn push_checked(&mut self, text: &str) -> Result<(), EncodeError> {
        if self.out.len() + text.len() > self.budget {
            return Err(EncodeError::OutputBudgetExceeded);
        }
        self.out.push_str(text);
        Ok(())
    }

    /// Backstop for the small structural output (indent, punctuation, `- `)
    /// that is not routed through [`Self::push_checked`]. Called at the end of
    /// every object entry / array row / list item.
    fn check_budget(&self) -> Result<(), EncodeError> {
        if self.out.len() > self.budget {
            return Err(EncodeError::OutputBudgetExceeded);
        }
        Ok(())
    }

    /// Canonical TOON float formatting, mirroring the crate's
    /// `format_canonical_number` for `Number::Float`:
    /// 1. integer-valued floats in i64/u64 range print as integers (this also
    ///    turns -0.0 into "0", covering the crate's normalize step). Note the
    ///    crate's `as_i64` saturating-cast check has no `i64::MAX` exclusion,
    ///    so the float 2^63 prints as 9223372036854775807 (and, via the same
    ///    saturation in `as_u64`, 2^64 prints as u64::MAX) — replicated, the
    ///    boundary parity test pins it;
    /// 2. everything else is std `Display` (shortest repr, and — verified —
    ///    never exponent notation, so the crate's exponent-expansion fallback
    ///    is unreachable) with the crate's trailing-zero trim applied.
    fn f64_canonical(&mut self, f: f64) -> Result<(), EncodeError> {
        let i = f as i64;
        if i as f64 == f {
            return self.write_int(i);
        }
        if f >= 0.0 {
            let u = f as u64;
            if u as f64 == f {
                return self.write_int(u);
            }
        }
        // Stage the Display text in the reused scratch buffer so the budget
        // pre-check sees the exact final size.
        let mut scratch = std::mem::take(&mut self.float_scratch);
        scratch.clear();
        let _ = write!(scratch, "{f}");
        // Fail closed if std Display ever produced exponent notation: the
        // crate expands exponents, so emitting this verbatim would break byte
        // parity, and the trim below would mangle it. Unreachable today
        // (verified empirically), guarded at runtime so a release build
        // returns None instead of corrupt bytes.
        let result = if scratch.contains(['e', 'E']) {
            Err(EncodeError::ExponentFloatFormat)
        } else {
            trim_trailing_zeros(&mut scratch);
            self.push_checked(&scratch)
        };
        self.float_scratch = scratch;
        result
    }

    fn string_value(&mut self, s: &str) -> Result<(), EncodeError> {
        if needs_quoting(s) {
            self.quoted(s)
        } else {
            self.push_checked(s)
        }
    }

    fn key(&mut self, key: &str) -> Result<(), EncodeError> {
        if is_valid_unquoted_key(key) {
            self.push_checked(key)
        } else {
            self.quoted(key)
        }
    }

    /// Quoted string: only `\n \r \t " \` are escaped; every other character
    /// (including other control characters) passes through raw. The exact
    /// escaped size (each escape adds one byte, plus two quotes) is checked
    /// against the budget before anything is written.
    fn quoted(&mut self, s: &str) -> Result<(), EncodeError> {
        let escapes = s
            .bytes()
            .filter(|b| matches!(b, b'\n' | b'\r' | b'\t' | b'"' | b'\\'))
            .count();
        if self.out.len() + s.len() + escapes + 2 > self.budget {
            return Err(EncodeError::OutputBudgetExceeded);
        }
        self.out.push('"');
        let mut plain_from = 0;
        for (i, b) in s.bytes().enumerate() {
            let escaped = match b {
                b'\n' => "\\n",
                b'\r' => "\\r",
                b'\t' => "\\t",
                b'"' => "\\\"",
                b'\\' => "\\\\",
                _ => continue,
            };
            self.out.push_str(&s[plain_from..i]);
            self.out.push_str(escaped);
            plain_from = i + 1;
        }
        self.out.push_str(&s[plain_from..]);
        self.out.push('"');
        Ok(())
    }

    fn indent(&mut self, depth: usize) {
        const CHUNK: &str = "                                "; // 32 spaces
        let mut remaining = depth * 2;
        while remaining >= CHUNK.len() {
            self.out.push_str(CHUNK);
            remaining -= CHUNK.len();
        }
        self.out.push_str(&CHUNK[..remaining]);
    }

    fn write_int(&mut self, value: impl itoa::Integer) -> Result<(), EncodeError> {
        let mut buf = itoa::Buffer::new();
        self.push_checked(buf.format(value))
    }
}

/// Crate's `remove_trailing_zeros`: trim trailing zeros after a single decimal
/// point, dropping the point when the fraction empties. (Shortest-repr Display
/// output makes this a no-op, but the crate applies it to every non-integer
/// float, so we mirror it.)
fn trim_trailing_zeros(text: &mut String) {
    let end = {
        let bytes = text.as_bytes();
        let Some(dot) = bytes.iter().position(|&b| b == b'.') else {
            return;
        };
        if bytes[dot + 1..].contains(&b'.') {
            return; // multiple dots: crate returns the string unchanged
        }
        let mut end = bytes.len();
        while end > dot + 1 && bytes[end - 1] == b'0' {
            end -= 1;
        }
        if end == dot + 1 { dot } else { end }
    };
    text.truncate(end);
}

fn check_depth(depth: usize) -> Result<(), EncodeError> {
    if depth > MAX_DEPTH {
        return Err(EncodeError::MaxDepthExceeded);
    }
    Ok(())
}

fn is_primitive(value: &JsonValue<'_>) -> bool {
    !matches!(value, JsonValue::Array(_) | JsonValue::Object(_))
}

/// Tabular detection: every element is an object with only primitive values,
/// the same field count as the first element, and (order-insensitively) the
/// first element's field set. Returns the first element's fields in order.
///
/// Order-insensitive comparison is O(total fields): a field set is built once
/// per array (lazily, on the first out-of-order row) and each row's keys are
/// checked against it. Row keys are unique (the parser deduplicates) and the
/// counts match, so "every row key is a header field" is exactly the crate's
/// "every header field is present in the row".
fn tabular_fields<'v>(arr: &'v [JsonValue<'_>]) -> Option<Vec<&'v str>> {
    let first = arr.first()?.as_object()?;
    if !first.iter().all(|(_, value)| is_primitive(value)) {
        return None;
    }
    let fields: Vec<&str> = first.iter().map(|(key, _)| key).collect();
    let mut field_set: Option<HashSet<&str>> = None;
    for row in &arr[1..] {
        let obj = row.as_object()?;
        if obj.len() != fields.len() {
            return None;
        }
        // Fast path: identical field order; otherwise compare key sets.
        if !obj.iter().map(|(key, _)| key).eq(fields.iter().copied()) {
            let set = field_set.get_or_insert_with(|| fields.iter().copied().collect());
            if !obj.iter().all(|(key, _)| set.contains(key)) {
                return None;
            }
        }
        if !obj.iter().all(|(_, value)| is_primitive(value)) {
            return None;
        }
    }
    Some(fields)
}

/// A string value can stay unquoted only if it cannot be misread as a literal,
/// a number, or structure. Comma is the only delimiter we emit, so the crate's
/// object/array quoting contexts collapse into one predicate.
fn needs_quoting(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    if matches!(s, "null" | "true" | "false") {
        return true;
    }
    if is_numeric_like(s) {
        return true;
    }
    // Structural chars (note: '-' anywhere), escapes, delimiter, escaped
    // whitespace — all single ASCII bytes, so a byte scan is exact on UTF-8.
    if s.bytes().any(|b| {
        matches!(
            b,
            b'[' | b']' | b'{' | b'}' | b':' | b'-' | b'\\' | b'"' | b',' | b'\n' | b'\r' | b'\t'
        )
    }) {
        return true;
    }
    if s.starts_with(char::is_whitespace) || s.ends_with(char::is_whitespace) {
        return true;
    }
    // Leading zero followed by a digit reads as a malformed number.
    s.starts_with('0') && s[1..].starts_with(|c: char| c.is_ascii_digit())
}

/// Crate's `is_numeric_like`: optional leading '-', then a digit (no leading
/// zeros), then only `[0-9.eE+-]`. Byte-level scan is exact: every significant
/// character is ASCII and multi-byte UTF-8 units never match ASCII patterns.
fn is_numeric_like(s: &str) -> bool {
    let digits = s.strip_prefix('-').unwrap_or(s).as_bytes();
    let Some(&first) = digits.first() else {
        return false;
    };
    if !first.is_ascii_digit() {
        return false;
    }
    if first == b'0' && digits.get(1).is_some_and(u8::is_ascii_digit) {
        return false;
    }
    digits
        .iter()
        .all(|&b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
}

/// Unquoted keys: alphabetic (Unicode) or '_' first, then alphanumeric
/// (Unicode), '_' or '.'.
fn is_valid_unquoted_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_alphabetic() && first != '_' {
        return false;
    }
    chars.all(|c| c.is_alphanumeric() || c == '_' || c == '.')
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use crate::json::parse_json;

    use super::*;

    fn encode(raw: &str) -> String {
        let value = parse_json(raw).expect("test input parses");
        encode_to_toon(&value, raw.len()).expect("encodes")
    }

    #[test]
    fn quoting_rules() {
        for quoted in [
            "", "null", "true", "false", "123", "0", "-5", "3.14", "1e10", "0.5", "07", "a-b",
            "-x", "a,b", "a:b", "a[b", "a]b", "a{b", "a}b", "a\"b", "a\\b", "a\nb", "a\rb", "a\tb",
            " x", "x ", "\u{a0}x", "x\u{a0}", "1.2.3",
        ] {
            assert!(needs_quoting(quoted), "expected quoting for {quoted:?}");
        }
        for unquoted in ["hello", "hello world", "0x", "+5", "1a2", "a.b", "x0", "é"] {
            assert!(
                !needs_quoting(unquoted),
                "expected no quoting for {unquoted:?}"
            );
        }
    }

    #[test]
    fn key_rules() {
        for ok in ["a", "_", "key.name.sub", "key.", "Ключ", "k1_2.x"] {
            assert!(is_valid_unquoted_key(ok), "expected unquoted key {ok:?}");
        }
        for quoted in ["", "1a", ".a", "a-b", "a b", "a:b", "a[b]"] {
            assert!(
                !is_valid_unquoted_key(quoted),
                "expected quoted key {quoted:?}"
            );
        }
    }

    #[test]
    fn float_formatting_matches_canonical_rules() {
        for (raw, expected) in [
            (r#"{"x": 1.0}"#, "x: 1"),
            (r#"{"x": -0.0}"#, "x: 0"),
            (r#"{"x": -0}"#, "x: 0"),
            (r#"{"x": 0.1}"#, "x: 0.1"),
            (r#"{"x": 1e-7}"#, "x: 0.0000001"),
            (r#"{"x": 1.5}"#, "x: 1.5"),
            // 2^63: the crate's saturating as_i64 cast prints i64::MAX here
            // (documented parity quirk, see f64_canonical).
            (r#"{"x": 9.223372036854776e18}"#, "x: 9223372036854775807"),
            (r#"{"x": -9.223372036854776e18}"#, "x: -9223372036854775808"),
        ] {
            assert_eq!(encode(raw), expected, "raw: {raw}");
        }
        let huge = encode(r#"{"x": 1e300}"#);
        assert!(huge.starts_with("x: 1"));
        assert_eq!(huge.len(), "x: ".len() + 301);
    }

    #[test]
    fn empty_object_array_quirk() {
        assert_eq!(encode("[{}, {}]"), "[2]{}:\n  \n  ");
        assert_eq!(encode(r#"{"a": [{}]}"#), "a[1]{}:\n  ");
    }

    #[test]
    fn structure_layouts() {
        assert_eq!(encode("{}"), "");
        assert_eq!(encode("[]"), "[0]:");
        assert_eq!(encode(r#"{"a": {}}"#), "a:");
        assert_eq!(encode(r#"[1, "two", null]"#), "[3]: 1,two,null");
        assert_eq!(
            encode(r#"{"users": [{"id": 1, "n": "a"}, {"id": 2, "n": "b"}]}"#),
            "users[2]{id,n}:\n  1,a\n  2,b"
        );
        assert_eq!(
            encode(r#"[{"rows": [{"id": 1}], "total": 1}, "tail"]"#),
            "[2]:\n  - rows[1]{id}:\n      1\n    total: 1\n  - tail"
        );
        assert_eq!(
            encode(r#"[[1, 2], {"a": {"b": 1}}]"#),
            "[2]:\n  - [2]: 1,2\n  - a:\n      b: 1"
        );
    }

    #[test]
    fn reordered_tabular_rows_use_header_field_order() {
        assert_eq!(
            encode(r#"[{"a": 1, "b": 2}, {"b": 4, "a": 3}]"#),
            "[2]{a,b}:\n  1,2\n  3,4"
        );
    }

    /// Adversarial reordered-tabular shape (10k rows x 30 keys, odd rows in
    /// reversed key order): output must match the crate byte-for-byte, and the
    /// field→column index keeps it rows x keys instead of rows x keys^2.
    #[test]
    fn reordered_tabular_rows_match_crate_at_scale() {
        const ROWS: usize = 10_000;
        const KEYS: usize = 30;
        let mut json = String::from("[");
        for row in 0..ROWS {
            if row > 0 {
                json.push(',');
            }
            json.push('{');
            let order: Vec<usize> = if row % 2 == 0 {
                (0..KEYS).collect()
            } else {
                (0..KEYS).rev().collect()
            };
            for (j, k) in order.into_iter().enumerate() {
                if j > 0 {
                    json.push(',');
                }
                let _ = write!(json, r#""k{k:02}":{}"#, row * 31 + k);
            }
            json.push('}');
        }
        json.push(']');

        let ours = encode(&json);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("oracle parse");
        let expected = toon_format::encode_default(&parsed).expect("oracle encodes");
        assert_eq!(ours, expected);
    }

    /// Detection stress: 2 rows x 5k keys with the second row fully reversed.
    /// Set-based detection must stay O(total fields) — a per-field linear
    /// lookup would be 25M comparisons here — and the wide objects also
    /// exercise the parser's large-object duplicate index.
    #[test]
    fn wide_reversed_tabular_detection_matches_crate() {
        const KEYS: usize = 5_000;
        let mut json = String::from("[{");
        for k in 0..KEYS {
            if k > 0 {
                json.push(',');
            }
            let _ = write!(json, r#""k{k:04}":{k}"#);
        }
        json.push_str("},{");
        for (j, k) in (0..KEYS).rev().enumerate() {
            if j > 0 {
                json.push(',');
            }
            let _ = write!(json, r#""k{k:04}":{k}"#);
        }
        json.push_str("}]");

        let ours = encode(&json);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("oracle parse");
        let expected = toon_format::encode_default(&parsed).expect("oracle encodes");
        assert_eq!(ours, expected);
    }

    /// Targeted i64/u64/f64 boundary parity against the crate.
    #[test]
    fn boundary_number_parity_with_crate() {
        for raw in [
            "-9223372036854775808",    // i64::MIN
            "9223372036854775807",     // i64::MAX
            "18446744073709551615",    // u64::MAX
            "9007199254740991",        // 2^53 - 1
            "9007199254740992",        // 2^53
            "9007199254740993",        // 2^53 + 1 (exact as i64)
            "9007199254740993.0",      // 2^53 + 1 as float (rounds to 2^53)
            "9223372036854775808.0",   // 2^63 as float (crate as_i64 saturation)
            "18446744073709551616.0",  // 2^64 as float (crate as_u64 saturation)
            "-9223372036854775808.0",  // -2^63 as float (i64 path)
            "5e-324",                  // smallest subnormal
            "2.2250738585072014e-308", // smallest normal
            "1.7976931348623157e308",  // f64::MAX
            "-0.0",
            "-0",
            "0.1",
            "1e-7",
            "1e300",
            "-1e300",
            "1.0",
            "-1.0",
            "3.141592653589793",
        ] {
            let ours = encode(raw);
            let parsed: serde_json::Value = serde_json::from_str(raw).expect("oracle parse");
            let expected = toon_format::encode_default(&parsed).expect("oracle encodes");
            assert_eq!(ours, expected, "raw: {raw}");
        }
    }

    #[test]
    fn exponent_amplification_aborts_within_budget() {
        // ~72KB of exponent-form numbers would expand ~50x (each 1e300 is 5
        // JSON bytes but 301 output bytes); the encode must abort instead.
        let large = format!("[{}]", vec!["1e300"; 12_000].join(","));
        let value = parse_json(&large).expect("parses");
        assert_eq!(
            encode_to_toon(&value, large.len()),
            Err(EncodeError::OutputBudgetExceeded)
        );
    }

    #[test]
    fn output_budget_boundary_encodes_below_and_aborts_above() {
        // Small inputs bind at the 16KiB floor: 50 x 1e300 -> ~15.1KB output
        // (still byte-identical to the crate), 60 x -> ~18.1KB trips it.
        let under = format!("[{}]", vec!["1e300"; 50].join(","));
        let parsed: serde_json::Value = serde_json::from_str(&under).expect("oracle parse");
        assert_eq!(
            encode(&under),
            toon_format::encode_default(&parsed).expect("oracle encodes")
        );

        let over = format!("[{}]", vec!["1e300"; 60].join(","));
        let value = parse_json(&over).expect("parses");
        assert_eq!(
            encode_to_toon(&value, over.len()),
            Err(EncodeError::OutputBudgetExceeded)
        );
        let parsed: serde_json::Value = serde_json::from_str(&over).expect("oracle parse");
        let crate_len = toon_format::encode_default(&parsed)
            .expect("oracle encodes")
            .len();
        assert!(
            crate_len > OUTPUT_BUDGET_FLOOR.max(2 * over.len()),
            "the skipped output must genuinely exceed the budget"
        );
    }

    #[test]
    fn budget_abort_keeps_buffer_bounded() {
        // 100k exponent floats would expand to ~30MB; the encoder must stop
        // at the budget instead of building the whole string. Scalar writes
        // are pre-checked, so the length never exceeds the budget at all, and
        // capacity growth (amortized doubling) stays within 2x of it.
        let numbers = vec![JsonValue::Float(1e300); 100_000];
        let mut encoder = Encoder {
            out: String::new(),
            budget: OUTPUT_BUDGET_FLOOR,
            float_scratch: String::new(),
        };
        assert_eq!(
            encoder.array(None, &numbers, 0),
            Err(EncodeError::OutputBudgetExceeded)
        );
        assert!(
            encoder.out.len() <= OUTPUT_BUDGET_FLOOR,
            "len={}",
            encoder.out.len()
        );
        assert!(
            encoder.out.capacity() <= 2 * OUTPUT_BUDGET_FLOOR,
            "capacity={}",
            encoder.out.capacity()
        );
    }

    #[test]
    fn deep_list_nesting_exceeds_max_depth() {
        // Built by hand: through `parse_json` the serde_json 128-level
        // recursion limit rejects the document first, so encode-side depth
        // failure only guards manually constructed values — exactly like the
        // crate, which we assert as the oracle.
        let mut value = JsonValue::String("leaf".into());
        let mut oracle = serde_json::json!("leaf");
        for _ in 0..200 {
            let mut obj = JsonObject::default();
            obj.push_for_tests("first", JsonValue::PosInt(1));
            obj.push_for_tests("k", value);
            value = JsonValue::Array(vec![JsonValue::Object(obj)]);
            oracle = serde_json::json!([{ "first": 1, "k": oracle }]);
        }
        // Large input_len: the output budget must not fire before the depth
        // check does (there is no real input text for a hand-built DOM).
        assert_eq!(
            encode_to_toon(&value, 1 << 20),
            Err(EncodeError::MaxDepthExceeded)
        );
        assert!(
            toon_format::encode_default(&oracle).is_err(),
            "oracle must reject the same depth"
        );
    }
}
