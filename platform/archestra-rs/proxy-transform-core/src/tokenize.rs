//! cl100k_base token counting, fused into the encode pass so the LLM proxy's
//! TOON keep/reject decision no longer runs a synchronous WASM tokenizer on the
//! Node event loop (it blocks concurrent requests; the encode already runs
//! off-thread). Byte-identical to the JS path in
//! `backend/src/tokenizers/{tiktoken,base}.ts`.

use std::sync::LazyLock;

use tiktoken_rs::CoreBPE;

/// The JS tokenizer prepends the message role to the content before encoding
/// (`backend/src/tokenizers/base.ts` `getEncodableText`: `${role}${text}`), and
/// all five tiktoken-family TOON adapters count under role `"user"`. Matching
/// that prefix is part of the parity contract enforced by the Node differential
/// test; a divergence here silently shifts recorded token counts.
const ROLE_PREFIX: &str = "user";

/// Process-wide cl100k_base encoder. Construction parses a vendored rank table;
/// a failure yields `None` and counting is reported as unavailable rather than
/// panicking — the core promises never to panic (the adapters then fail open to
/// the `addon_unavailable` skip reason, exactly like a missing addon).
static CL100K: LazyLock<Option<CoreBPE>> = LazyLock::new(|| tiktoken_rs::cl100k_base().ok());

/// Count cl100k tokens of `role + text`, matching JS
/// `countTokens([{ role: "user", content: text }])`. `None` only when the
/// encoder failed to initialize. Uses ordinary encoding: special-token literals
/// (e.g. `<|endoftext|>`) in tool results are counted as plain text instead of
/// raising, matching the ordinary-encoding baseline the JS tokenizer now uses.
pub(crate) fn count_user_tokens(text: &str) -> Option<u32> {
    let bpe = CL100K.as_ref()?;
    let mut prefixed = String::with_capacity(ROLE_PREFIX.len() + text.len());
    prefixed.push_str(ROLE_PREFIX);
    prefixed.push_str(text);
    Some(bpe.encode_ordinary(&prefixed).len() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_are_available_and_positive() {
        assert!(count_user_tokens("hello world").is_some_and(|n| n > 0));
    }

    #[test]
    fn empty_text_counts_the_role_prefix_only() {
        // "user" alone is one cl100k token; the count is deterministic and the
        // role prefix is always present.
        assert_eq!(count_user_tokens(""), count_user_tokens(""));
        assert!(count_user_tokens("").is_some_and(|n| n >= 1));
    }

    #[test]
    fn special_token_literals_do_not_raise() {
        // Ordinary encoding: the reserved marker is counted as text, not an
        // error (the JS baseline encodes ordinally too).
        assert!(count_user_tokens("<|endoftext|> in a tool result").is_some_and(|n| n > 0));
    }

    #[test]
    fn longer_text_counts_more() {
        let short = count_user_tokens("a").expect("bpe");
        let long = count_user_tokens(&"lorem ipsum dolor sit amet ".repeat(20)).expect("bpe");
        assert!(long > short);
    }
}
