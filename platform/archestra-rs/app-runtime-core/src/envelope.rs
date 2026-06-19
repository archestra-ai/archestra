use std::sync::LazyLock;

use regex::Regex;

use crate::contract;

// The exact set the original JS regex `\s` matched (ECMAScript WhiteSpace +
// LineTerminator). Spelled out because Rust's Unicode-aware `\s` differs at the
// edges — it excludes U+FEFF and includes U+0085 — which would anchor exotic
// `<head…>`/`<html…>` tags differently than the TypeScript original did.
const JS_WS: &str = r"[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

// Anchors tolerate attributes (`<head lang="en">`) but never a longer tag name
// (the `(JS_WS[^>]*)?` requires whitespace-or-`>` right after the name, so
// `<header>` is not a head anchor). Case-insensitive, matching the TS original.
static HEAD_ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)<head({JS_WS}[^>]*)?>")).expect("static head anchor regex")
});
static HTML_ANCHOR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)<html({JS_WS}[^>]*)?>")).expect("static html anchor regex")
});
static DOCTYPE_ANCHOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<!DOCTYPE[^>]*>").expect("static doctype anchor regex"));

// A `</script`/`</style` anywhere in an inlined asset (only ever inside a JS/CSS
// string or comment, since neither is valid syntax otherwise) would close the
// element early; case-insensitive to match the HTML tokenizer.
static SCRIPT_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</script").expect("static script-close regex"));
static STYLE_CLOSE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)</style").expect("static style-close regex"));

/// Trusted, platform-controlled assets the connector embeds directly into the
/// resource for a strict foreign host (claude.ai) whose sandbox CSP refuses any
/// cross-origin `<script src>`/`<link href>`. `None` keeps the linked form
/// (Archestra's own render, where the host CSP allows the platform origin).
pub struct InlineAssets<'a> {
    /// The ext-apps guest bundle as an IIFE that publishes the View SDK on
    /// `window.__ARCHESTRA_EXT_APPS__`; the injected Apps SDK reads that global.
    pub ext_apps_global: &'a str,
    /// The Apps SDK microframework (same bytes served at `APP_SDK_PATH`).
    pub shim: &'a str,
    /// The platform baseline stylesheet (same bytes served at `APP_BASE_CSS_PATH`).
    pub base_css: &'a str,
}

/// Inject the platform CSP, baseline stylesheet, per-viewer bootstrap, and the
/// Apps SDK into an owned app's HTML, at the start of `<head>`, in that order,
/// linking the SDK/stylesheet from `base_origin`. See
/// [`prepare_app_envelope_with_assets`] for the inline variant.
pub fn prepare_app_envelope(
    html: &str,
    context_json: &str,
    base_origin: &str,
    csp_content: &str,
) -> String {
    prepare_app_envelope_with_assets(html, context_json, base_origin, csp_content, None)
}

/// Inject the platform CSP, baseline stylesheet, per-viewer bootstrap, and the
/// Apps SDK into an owned app's HTML, at the start of `<head>`, in that order.
///
/// `context_json` is the per-viewer context the caller has already serialized
/// to JSON (identity + assigned-tool descriptors). It is treated as opaque,
/// pre-serialized JSON text and embedded inside an inline `<script>` after
/// inline-script-safe escaping — the serialization byte format is the caller's
/// contract (the TypeScript backend uses `JSON.stringify`), so this function
/// never re-serializes it and cannot drift from that format.
///
/// `base_origin` is prefixed onto the served asset URLs (SDK script, baseline
/// stylesheet) so they resolve from an opaque-origin iframe in a foreign MCP
/// host; an empty string keeps them path-relative (same-origin only).
/// `csp_content` is the pre-built Content-Security-Policy the caller pins for
/// the app; an empty string omits the CSP `<meta>` (the host supplies one). Both
/// are the caller's contract — this function never derives them.
///
/// `inline`, when `Some`, embeds the stylesheet and SDK in the document instead
/// of linking them from `base_origin` — for a foreign host that blocks
/// cross-origin subresources. `base_origin` is then unused for the assets.
pub fn prepare_app_envelope_with_assets(
    html: &str,
    context_json: &str,
    base_origin: &str,
    csp_content: &str,
    inline: Option<InlineAssets>,
) -> String {
    let injection = build_injection(
        &escape_inline_script(context_json),
        base_origin,
        csp_content,
        inline.as_ref(),
    );

    // First matching anchor wins; injection is spliced in literally (no JS-style
    // `$&`/`$'` replacement-pattern expansion to corrupt the escaped context).
    if let Some(m) = HEAD_ANCHOR.find(html) {
        return splice(html, m.end(), &injection);
    }
    if let Some(m) = HTML_ANCHOR.find(html) {
        return splice(html, m.end(), &format!("<head>{injection}</head>"));
    }
    if let Some(m) = DOCTYPE_ANCHOR.find(html) {
        return splice(html, m.end(), &format!("<head>{injection}</head>"));
    }
    format!("{injection}{html}")
}

fn build_injection(
    escaped_context: &str,
    base_origin: &str,
    csp_content: &str,
    inline: Option<&InlineAssets>,
) -> String {
    // The CSP meta must precede the resources it governs (it only applies to
    // fetches after it in document order), then the baseline stylesheet leads
    // the cascade (first `<link>`/`<style>`), the bootstrap must precede the SDK
    // script (the SDK reads the context global at parse time), and the SDK runs
    // last. In inline mode the ext-apps bundle sits between the bootstrap and the
    // SDK — it publishes the guest-SDK global the SDK reads.
    let csp = if csp_content.is_empty() {
        String::new()
    } else {
        format!(
            r#"<meta http-equiv="Content-Security-Policy" content="{}">"#,
            escape_attribute(csp_content),
        )
    };
    let bootstrap = format!(
        "<script {}>window.{}={};</script>",
        contract::APP_BOOTSTRAP_MARKER,
        contract::APP_CONTEXT_GLOBAL,
        escaped_context,
    );
    match inline {
        None => {
            let base_css = format!(
                r#"<link rel="stylesheet" href="{base_origin}{}" {}>"#,
                contract::APP_BASE_CSS_PATH,
                contract::APP_BASE_CSS_MARKER,
            );
            let sdk = format!(
                r#"<script {} src="{base_origin}{}"></script>"#,
                contract::APP_SDK_MARKER,
                contract::APP_SDK_PATH,
            );
            format!("{csp}{base_css}{bootstrap}{sdk}")
        }
        Some(assets) => {
            let style = format!(
                "<style {}>{}</style>",
                contract::APP_BASE_CSS_MARKER,
                escape_inline_style(assets.base_css),
            );
            let ext_apps = format!(
                "<script>{}</script>",
                escape_inline_script_body(assets.ext_apps_global),
            );
            let sdk = format!(
                "<script {}>{}</script>",
                contract::APP_SDK_MARKER,
                escape_inline_script_body(assets.shim),
            );
            format!("{csp}{style}{bootstrap}{ext_apps}{sdk}")
        }
    }
}

fn splice(html: &str, at: usize, insert: &str) -> String {
    let mut out = String::with_capacity(html.len() + insert.len());
    out.push_str(&html[..at]);
    out.push_str(insert);
    out.push_str(&html[at..]);
    out
}

/// Escape a value for a double-quoted HTML attribute. The CSP content is
/// caller-built from a config-derived origin; escaping `&`/`"` (order matters)
/// keeps a stray quote from breaking out of the `content="…"` attribute.
fn escape_attribute(value: &str) -> String {
    value.replace('&', "&amp;").replace('"', "&quot;")
}

/// Escape a JSON string for embedding inside an inline `<script>`. `JSON`
/// alone is not enough: attacker-controlled text containing `</script>` would
/// terminate the element, so `<`/`>` become JS unicode escapes (U+2028/U+2029
/// likewise — they are line terminators in JS string literals).
fn escape_inline_script(json: &str) -> String {
    json.replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// Neutralise a `</script` end-tag inside a trusted, platform-built JS bundle so
/// it can't terminate the inline `<script>` early. Unlike [`escape_inline_script`]
/// (for the user-influenced context JSON), this cannot escape every `<`/`>` —
/// those are operators in real code — so it inserts a `\` that is inert in the
/// string/regex literal contexts where `</script` legitimately appears in valid
/// JS, preserving the original casing. `<!--` is intentionally left alone: it does
/// not terminate a `<script>` (only `</script` does), and a `<\!--` rewrite would
/// be invalid JS wherever `<!--` is the `< ! --` operator sequence.
fn escape_inline_script_body(js: &str) -> String {
    SCRIPT_CLOSE
        .replace_all(js, |c: &regex::Captures| format!("<\\{}", &c[0][1..]))
        .into_owned()
}

/// Neutralise a `</style` close sequence inside a trusted, platform-built
/// stylesheet (the inserted `\` is an inert CSS escape of `/`).
fn escape_inline_style(css: &str) -> String {
    STYLE_CLOSE
        .replace_all(css, |c: &regex::Captures| format!("<\\{}", &c[0][1..]))
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors `services/apps/app-sdk-injection.test.ts`. `context_json` values
    // are exactly what `JSON.stringify` produces for that test's contexts.
    const COMPLETE_DOC: &str =
        "<!DOCTYPE html><html><head><title>x</title></head><body></body></html>";
    const CONTEXT_JSON: &str = r#"{"user":{"id":"u1","name":"Alice"},"tools":[{"name":"hf__paper_search","description":"search","inputSchema":{}}]}"#;
    const BASE_CSS_LINK: &str = r#"<link rel="stylesheet" href="/_sandbox/archestra-app-base.css" data-archestra-app-base-css>"#;
    const BOOTSTRAP_MARKER: &str = "data-archestra-app-bootstrap";
    const SDK_MARKER: &str = "data-archestra-app-sdk";
    const BASE_CSS_MARKER: &str = "data-archestra-app-base-css";

    fn count(haystack: &str, needle: &str) -> usize {
        haystack.matches(needle).count()
    }

    #[test]
    fn injects_base_then_bootstrap_then_sdk_each_once() {
        let result = prepare_app_envelope(COMPLETE_DOC, CONTEXT_JSON, "", "");
        assert!(result.contains(&format!("<head>{BASE_CSS_LINK}<script {BOOTSTRAP_MARKER}>")));
        assert_eq!(count(&result, BASE_CSS_MARKER), 1);
        assert_eq!(count(&result, BOOTSTRAP_MARKER), 1);
        assert_eq!(count(&result, SDK_MARKER), 1);
        let base = result.find(BASE_CSS_MARKER).unwrap();
        let boot = result.find(BOOTSTRAP_MARKER).unwrap();
        let sdk = result.find(SDK_MARKER).unwrap();
        assert!(base < boot);
        assert!(boot < sdk);
        assert!(result.contains(r#"src="/_sandbox/archestra-app-sdk.js""#));
    }

    #[test]
    fn embeds_viewer_identity_and_tool_descriptors() {
        let result = prepare_app_envelope(COMPLETE_DOC, CONTEXT_JSON, "", "");
        assert!(result.contains(r#""user":{"id":"u1","name":"Alice"}"#));
        assert!(result.contains(r#""hf__paper_search""#));
    }

    #[test]
    fn display_name_cannot_break_out_of_the_inline_script() {
        let context =
            r#"{"user":{"id":"u1","name":"</script><script>alert(\"pwn\")</script>"},"tools":[]}"#;
        let result = prepare_app_envelope(COMPLETE_DOC, context, "", "");
        assert!(!result.contains(r#"</script><script>alert("pwn")</script>"#));
        assert!(result.contains("\\u003c/script\\u003e"));
    }

    #[test]
    fn replace_substitution_patterns_in_content_are_inert() {
        let context = r#"{"user":{"id":"u1","name":"$& $' $$ $`"},"tools":[{"name":"t","description":"costs $$$ &c.","inputSchema":{}}]}"#;
        let result = prepare_app_envelope(COMPLETE_DOC, context, "", "");
        assert!(result.contains(r#""name":"$& $' $$ $`""#));
        assert!(result.contains(r#""costs $$$ &c.""#));
        assert_eq!(count(&result, "<head>"), 1);
    }

    #[test]
    fn injects_after_uppercase_head() {
        let result =
            prepare_app_envelope("<HTML><HEAD></HEAD><BODY/></HTML>", CONTEXT_JSON, "", "");
        assert!(result.contains(&format!("<HEAD>{BASE_CSS_LINK}<script {BOOTSTRAP_MARKER}>")));
    }

    #[test]
    fn injects_after_attribute_bearing_head_without_duplicate() {
        let result = prepare_app_envelope(
            r#"<html lang="en"><head lang="en"></head><body/></html>"#,
            CONTEXT_JSON,
            "",
            "",
        );
        assert!(result.contains(&format!(
            r#"<head lang="en">{BASE_CSS_LINK}<script {BOOTSTRAP_MARKER}>"#
        )));
        assert_eq!(count(&result, "<head"), 1);
    }

    #[test]
    fn header_tag_is_not_a_head_anchor() {
        let result =
            prepare_app_envelope("<header>nav</header><p>fragment</p>", CONTEXT_JSON, "", "");
        assert!(result.starts_with(BASE_CSS_LINK));
    }

    #[test]
    fn creates_a_head_when_only_html_exists() {
        let result = prepare_app_envelope("<html><body>hi</body></html>", CONTEXT_JSON, "", "");
        assert!(result.contains(&format!(
            "<html><head>{BASE_CSS_LINK}<script {BOOTSTRAP_MARKER}>"
        )));
        assert!(result.contains("</script></head>"));
    }

    #[test]
    fn anchors_on_doctype_when_no_html_or_head() {
        let result = prepare_app_envelope("<!DOCTYPE html><p>bare</p>", CONTEXT_JSON, "", "");
        assert!(result.starts_with(&format!("<!DOCTYPE html><head>{BASE_CSS_LINK}<script ")));
        assert!(result.ends_with("<p>bare</p>"));
    }

    #[test]
    fn prepends_to_fragment_documents() {
        let result = prepare_app_envelope("<p>fragment</p>", CONTEXT_JSON, "", "");
        assert!(result.starts_with(BASE_CSS_LINK));
        assert!(result.ends_with("<p>fragment</p>"));
    }

    #[test]
    fn body_text_mention_of_the_marker_does_not_suppress_injection() {
        let result = prepare_app_envelope(
            &format!("<html><head></head><body><p>{BOOTSTRAP_MARKER}</p></body></html>"),
            CONTEXT_JSON,
            "",
            "",
        );
        assert_eq!(count(&result, BOOTSTRAP_MARKER), 2);
        assert!(result.contains(&format!("<head>{BASE_CSS_LINK}<script {BOOTSTRAP_MARKER}>")));
    }

    #[test]
    fn only_the_first_head_is_targeted() {
        let result = prepare_app_envelope(
            "<html><head></head><body><p>&lt;head&gt;</p></body></html>",
            CONTEXT_JSON,
            "",
            "",
        );
        assert_eq!(count(&result, BOOTSTRAP_MARKER), 1);
    }

    // The anchor whitespace class must match ECMAScript `\s`, not Rust's
    // Unicode-aware `\s` (which excludes U+FEFF and includes U+0085). These pin
    // the two edge code points where they disagree.
    #[test]
    fn feff_after_head_name_is_an_attribute_separator_like_js() {
        // U+FEFF is whitespace in JS `\s`, so `<head\u{FEFF}x>` anchors as head.
        let result = prepare_app_envelope("<head\u{FEFF}x></head>", CONTEXT_JSON, "", "");
        assert!(result.contains(&format!("<head\u{FEFF}x>{BASE_CSS_LINK}")));
    }

    #[test]
    fn nel_after_head_name_is_not_whitespace_like_js() {
        // U+0085 (NEL) is NOT whitespace in JS `\s`, so `<head\u{0085}x>` is not
        // a head anchor; with no html/doctype the injection prepends.
        let result = prepare_app_envelope("<head\u{0085}x></head>", CONTEXT_JSON, "", "");
        assert!(result.starts_with(BASE_CSS_LINK));
    }

    #[test]
    fn base_origin_makes_asset_urls_absolute() {
        let result = prepare_app_envelope(
            COMPLETE_DOC,
            CONTEXT_JSON,
            "https://archestra.example.com",
            "",
        );
        assert!(
            result.contains(
                r#"href="https://archestra.example.com/_sandbox/archestra-app-base.css""#
            )
        );
        assert!(
            result.contains(r#"src="https://archestra.example.com/_sandbox/archestra-app-sdk.js""#)
        );
    }

    #[test]
    fn csp_content_is_injected_as_a_meta_before_the_assets() {
        let csp = "default-src 'none'; script-src 'unsafe-inline'";
        let result = prepare_app_envelope(COMPLETE_DOC, CONTEXT_JSON, "https://h.example.com", csp);
        assert!(result.contains(&format!(
            r#"<head><meta http-equiv="Content-Security-Policy" content="{csp}">"#
        )));
        // The CSP must precede the stylesheet/script it governs.
        let meta = result.find("Content-Security-Policy").unwrap();
        let css = result.find(BASE_CSS_MARKER).unwrap();
        let sdk = result.find(SDK_MARKER).unwrap();
        assert!(meta < css);
        assert!(meta < sdk);
    }

    #[test]
    fn empty_csp_omits_the_meta() {
        let result = prepare_app_envelope(COMPLETE_DOC, CONTEXT_JSON, "", "");
        assert!(!result.contains("Content-Security-Policy"));
    }

    #[test]
    fn csp_content_cannot_break_out_of_the_attribute() {
        let result = prepare_app_envelope(
            COMPLETE_DOC,
            CONTEXT_JSON,
            "",
            r#"default-src 'none'; "><script>alert(1)</script>"#,
        );
        // The stray quote is escaped, so the injected markup stays inside the
        // attribute value (inert) rather than closing it.
        assert!(!result.contains(r#""><script"#));
        assert!(result.contains("&quot;><script"));
    }

    fn inline_assets() -> InlineAssets<'static> {
        InlineAssets {
            ext_apps_global: "globalThis.__ARCHESTRA_EXT_APPS__={App:1};",
            shim: "window.archestra={ready:1};",
            base_css: "body{color:red}",
        }
    }

    #[test]
    fn inline_mode_embeds_assets_with_no_cross_origin_subresource() {
        let result = prepare_app_envelope_with_assets(
            COMPLETE_DOC,
            CONTEXT_JSON,
            "https://archestra.example.com",
            "",
            Some(inline_assets()),
        );
        // Asset bytes are in the document, not linked.
        assert!(result.contains("<style data-archestra-app-base-css>body{color:red}</style>"));
        assert!(result.contains("globalThis.__ARCHESTRA_EXT_APPS__={App:1};"));
        assert!(
            result.contains("<script data-archestra-app-sdk>window.archestra={ready:1};</script>")
        );
        // No external script/style fetch a strict host CSP would refuse — even
        // though base_origin was supplied, inline mode ignores it for assets.
        assert!(!result.contains("src=\"https://archestra.example.com"));
        assert!(!result.contains("<link"));
        assert!(!result.contains("/_sandbox/"));
    }

    #[test]
    fn inline_mode_orders_style_bootstrap_extapps_then_shim() {
        let result = prepare_app_envelope_with_assets(
            COMPLETE_DOC,
            CONTEXT_JSON,
            "",
            "",
            Some(inline_assets()),
        );
        let style = result.find(BASE_CSS_MARKER).unwrap();
        let boot = result.find(BOOTSTRAP_MARKER).unwrap();
        let ext = result.find("__ARCHESTRA_EXT_APPS__").unwrap();
        let shim = result.find(SDK_MARKER).unwrap();
        // Bootstrap context and the ext-apps global must both precede the shim
        // (which reads them); style leads the cascade.
        assert!(style < boot);
        assert!(boot < ext);
        assert!(ext < shim);
    }

    #[test]
    fn inline_mode_neutralises_a_script_close_in_an_asset() {
        let assets = InlineAssets {
            ext_apps_global: "var s=\"</SCRIPT><script>alert(1)</script>\";",
            shim: "window.archestra={};",
            base_css: "a{}",
        };
        let result =
            prepare_app_envelope_with_assets(COMPLETE_DOC, CONTEXT_JSON, "", "", Some(assets));
        // The close sequence is broken (case preserved) so it can't terminate the
        // inline element; the verbatim attacker markup never appears.
        assert!(!result.contains("</SCRIPT><script>alert(1)</script>"));
        assert!(result.contains("<\\/SCRIPT><script>alert(1)<\\/script>"));
    }

    #[test]
    fn inline_mode_neutralises_a_style_close_in_the_stylesheet() {
        let assets = InlineAssets {
            ext_apps_global: "var x=1;",
            shim: "window.archestra={};",
            base_css: "a{content:\"</style><script>alert(1)</script>\"}",
        };
        let result =
            prepare_app_envelope_with_assets(COMPLETE_DOC, CONTEXT_JSON, "", "", Some(assets));
        assert!(!result.contains("</style><script>alert(1)"));
        assert!(result.contains("<\\/style>"));
    }
}
