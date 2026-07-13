//! Minimal borrowed JSON DOM for the TOON kernel. `serde_json::Value` was the
//! hot spot of the pipeline (per-key IndexMap hashing plus an owned `String`
//! per key and string); this DOM parses ~3x faster by borrowing every
//! escape-free string/key from the input buffer and storing object entries in
//! insertion order in a plain `Vec`.
//!
//! Parity contract (the encoder's byte-parity oracle parses with
//! `serde_json::Value`, so this DOM must be observationally identical):
//! - numbers keep `serde_json`'s exact typing — the deserializer picks
//!   `visit_u64`/`visit_i64`/`visit_f64` and we store what it hands us;
//! - duplicate object keys replicate `IndexMap::insert`, which JS `JSON.parse`
//!   also matches: the key keeps its first position, the value is replaced;
//! - `parse_json` fails on trailing content (like `serde_json::from_str`) and
//!   inherits `serde_json`'s 128-level recursion limit.
//!
//! Memory bound: strings and keys containing escapes force owned `Cow`
//! allocations (an input of millions of tiny escaped strings means millions of
//! tiny allocations), and every enum slot costs DOM overhead. Both are bounded
//! by the pipeline's per-item input cap (`MAX_ITEM_INPUT_BYTES` in `lib.rs`):
//! oversized items are never parsed at all.

use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::fmt;

use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum JsonValue<'a> {
    Null,
    Bool(bool),
    /// Non-negative integer literal (`visit_u64`).
    PosInt(u64),
    /// Negative integer literal (`visit_i64`).
    NegInt(i64),
    /// Everything else, always finite (`visit_f64`).
    Float(f64),
    String(Cow<'a, str>),
    Array(Vec<JsonValue<'a>>),
    Object(JsonObject<'a>),
}

impl<'a> JsonValue<'a> {
    pub(crate) fn as_object(&self) -> Option<&JsonObject<'a>> {
        match self {
            JsonValue::Object(obj) => Some(obj),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            JsonValue::String(text) => Some(text),
            _ => None,
        }
    }
}

/// Object entries in first-occurrence order.
#[derive(Clone, Debug, PartialEq, Default)]
pub(crate) struct JsonObject<'a> {
    entries: Vec<(Cow<'a, str>, JsonValue<'a>)>,
}

impl<'a> JsonObject<'a> {
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub(crate) fn iter(&self) -> impl ExactSizeIterator<Item = (&str, &JsonValue<'a>)> {
        self.entries
            .iter()
            .map(|(key, value)| (key.as_ref(), value))
    }

    /// Linear-scan lookup: only used on cold paths (wrapper detection on a
    /// first element, reordered tabular rows), never per-key on hot loops.
    pub(crate) fn get(&self, key: &str) -> Option<&JsonValue<'a>> {
        self.entries
            .iter()
            .find(|(entry_key, _)| entry_key == key)
            .map(|(_, value)| value)
    }

    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut JsonValue<'a>> {
        self.entries
            .iter_mut()
            .find(|(entry_key, _)| entry_key == key)
            .map(|(_, value)| value)
    }

    /// Direct entry construction for tests that need values deeper than the
    /// parser's recursion limit. Skips duplicate handling.
    #[cfg(test)]
    pub(crate) fn push_for_tests(&mut self, key: &'a str, value: JsonValue<'a>) {
        self.entries.push((Cow::Borrowed(key), value));
    }
}

/// Parse a complete JSON document, rejecting trailing content — the same
/// accept set as `serde_json::from_str::<serde_json::Value>`.
pub(crate) fn parse_json(input: &str) -> Option<JsonValue<'_>> {
    let mut deserializer = serde_json::Deserializer::from_str(input);
    let value = ValueSeed.deserialize(&mut deserializer).ok()?;
    deserializer.end().ok()?;
    Some(value)
}

// === parsing internals ===

struct ValueSeed;

impl<'de> DeserializeSeed<'de> for ValueSeed {
    type Value = JsonValue<'de>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_any(ValueSeed)
    }
}

impl<'de> Visitor<'de> for ValueSeed {
    type Value = JsonValue<'de>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_unit<E>(self) -> Result<Self::Value, E> {
        Ok(JsonValue::Null)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
        Ok(JsonValue::Bool(value))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(JsonValue::PosInt(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(JsonValue::NegInt(value))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
        Ok(JsonValue::Float(value))
    }

    fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E> {
        Ok(JsonValue::String(Cow::Borrowed(value)))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(JsonValue::String(Cow::Owned(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(JsonValue::String(Cow::Owned(value)))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element_seed(ValueSeed)? {
            items.push(item);
        }
        Ok(JsonValue::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut builder = ObjectBuilder::default();
        while let Some(key) = map.next_key_seed(KeySeed)? {
            let value = map.next_value_seed(ValueSeed)?;
            builder.insert(key, value);
        }
        Ok(JsonValue::Object(JsonObject {
            entries: builder.entries,
        }))
    }
}

struct KeySeed;

impl<'de> DeserializeSeed<'de> for KeySeed {
    type Value = Cow<'de, str>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_str(KeySeed)
    }
}

impl<'de> Visitor<'de> for KeySeed {
    type Value = Cow<'de, str>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("an object key")
    }

    fn visit_borrowed_str<E>(self, value: &'de str) -> Result<Self::Value, E> {
        Ok(Cow::Borrowed(value))
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(Cow::Owned(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(Cow::Owned(value))
    }
}

/// Above this size, duplicate detection switches from a linear scan to a lazy
/// hash index so pathological many-key objects stay O(n).
const LINEAR_DEDUP_MAX: usize = 32;

#[derive(Default)]
struct ObjectBuilder<'a> {
    entries: Vec<(Cow<'a, str>, JsonValue<'a>)>,
    /// Key → entry index, built lazily for large objects. SipHash (std
    /// default) keeps adversarial key sets collision-resistant. Map keys are
    /// clones of the entry keys: free for borrowed keys (the common case),
    /// one String copy for escaped ones.
    index: Option<HashMap<Cow<'a, str>, usize>>,
}

impl<'a> ObjectBuilder<'a> {
    /// `IndexMap::insert` semantics: an existing key keeps its position and
    /// gets the new value; a new key is appended.
    fn insert(&mut self, key: Cow<'a, str>, value: JsonValue<'a>) {
        if self.index.is_none() && self.entries.len() >= LINEAR_DEDUP_MAX {
            self.index = Some(
                self.entries
                    .iter()
                    .enumerate()
                    .map(|(i, (existing, _))| (existing.clone(), i))
                    .collect(),
            );
        }
        match &mut self.index {
            Some(index) => match index.entry(key.clone()) {
                Entry::Occupied(slot) => {
                    self.entries[*slot.get()].1 = value;
                }
                Entry::Vacant(slot) => {
                    slot.insert(self.entries.len());
                    self.entries.push((key, value));
                }
            },
            None => {
                if let Some(entry) = self
                    .entries
                    .iter_mut()
                    .find(|(existing, _)| *existing == key)
                {
                    entry.1 = value;
                    return;
                }
                self.entries.push((key, value));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_value_kinds() {
        let value = parse_json(r#"{"a":null,"b":true,"c":18446744073709551615,"d":-3,"e":1.5,"f":"x\ny","g":[1],"h":{}}"#)
            .expect("parses");
        let JsonValue::Object(obj) = value else {
            panic!("expected object");
        };
        assert_eq!(obj.get("a"), Some(&JsonValue::Null));
        assert_eq!(obj.get("b"), Some(&JsonValue::Bool(true)));
        assert_eq!(obj.get("c"), Some(&JsonValue::PosInt(u64::MAX)));
        assert_eq!(obj.get("d"), Some(&JsonValue::NegInt(-3)));
        assert_eq!(obj.get("e"), Some(&JsonValue::Float(1.5)));
        assert_eq!(
            obj.get("f"),
            Some(&JsonValue::String(Cow::Owned("x\ny".to_string())))
        );
        assert_eq!(
            obj.get("g"),
            Some(&JsonValue::Array(vec![JsonValue::PosInt(1)]))
        );
        assert_eq!(
            obj.get("h"),
            Some(&JsonValue::Object(JsonObject::default()))
        );
    }

    #[test]
    fn escape_free_strings_borrow_from_input() {
        let input = r#"{"key":"plain value"}"#;
        let value = parse_json(input).expect("parses");
        let JsonValue::Object(obj) = value else {
            panic!("expected object");
        };
        let Some(JsonValue::String(text)) = obj.get("key") else {
            panic!("expected string");
        };
        assert!(matches!(text, Cow::Borrowed(_)));
    }

    #[test]
    fn duplicate_keys_keep_first_position_and_last_value() {
        // Same semantics as serde_json's preserve_order IndexMap and JS
        // JSON.parse: first position wins, last value wins.
        let value = parse_json(r#"{"a":1,"b":2,"a":3}"#).expect("parses");
        let JsonValue::Object(obj) = value else {
            panic!("expected object");
        };
        let entries: Vec<_> = obj.iter().collect();
        assert_eq!(
            entries,
            vec![("a", &JsonValue::PosInt(3)), ("b", &JsonValue::PosInt(2))]
        );
    }

    #[test]
    fn duplicate_keys_dedup_in_large_objects() {
        let mut input = String::from("{");
        for i in 0..100 {
            input.push_str(&format!(r#""k{i}":{i},"#));
        }
        input.push_str(r#""k7":777}"#);
        let value = parse_json(&input).expect("parses");
        let JsonValue::Object(obj) = value else {
            panic!("expected object");
        };
        assert_eq!(obj.len(), 100);
        assert_eq!(obj.get("k7"), Some(&JsonValue::PosInt(777)));
        assert_eq!(obj.iter().nth(7), Some(("k7", &JsonValue::PosInt(777))));
    }

    #[test]
    fn rejects_trailing_content_and_invalid_json() {
        for bad in [
            "{} garbage",
            "[1,2] 3",
            "",
            "{'a':1}",
            "[1,",
            "NaN",
            "1e400",
        ] {
            assert!(parse_json(bad).is_none(), "expected reject: {bad:?}");
        }
    }

    #[test]
    fn respects_serde_json_recursion_limit() {
        let deep_ok = format!("{}1{}", "[".repeat(127), "]".repeat(127));
        assert!(parse_json(&deep_ok).is_some());
        let too_deep = format!("{}1{}", "[".repeat(129), "]".repeat(129));
        assert!(parse_json(&too_deep).is_none());
    }
}
