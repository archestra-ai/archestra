//! Save-time security scan of an owned app's authored HTML. Ported from the
//! cheerio-based `validateAppHtml` in `services/apps/app-ui-policy.ts`.
//!
//! The app may not bootstrap the MCP App SDK itself, nor load the platform's
//! own SDK/stylesheet assets — the platform injects those at serve time (see
//! the envelope module). A scan is pure: it never mutates the HTML, it only
//! reports the first disqualifying construct (rejection) plus soft warnings.
//! Parsing failures fail closed (a rejection), never a silent pass.
//!
//! Script text is extracted lexically from the raw input, not the `tl` DOM
//! (`tl` has no RAWTEXT mode; a bare `<` in ordinary JS would hide a marker
//! from the gate). This also reads script blocks inside HTML comments —
//! fail-closed for a gate. Attribute refs come from the DOM (see
//! `resource_ref`), with a lexical fallback for tag shapes `tl` drops.

use std::sync::LazyLock;

use regex::Regex;

// SDK self-bootstrap markers, matched inside <script> element TEXT only. Prose
// that merely mentions a marker (docs rendered as text) must scan clean.
const SDK_BOOTSTRAP_MARKERS: [&str; 3] = [
    "__ARCHESTRA_APP_SDK_URL__",
    "__ARCHESTRA_APP_CONTEXT__",
    "PostMessageTransport",
];

// Platform-served scripts an app must not load itself (matched in <script src>).
const PLATFORM_SCRIPT_SRC_MARKERS: [&str; 2] = ["archestra-app-sdk", "ext-apps-app"];

// The platform baseline stylesheet an app must not <link> itself.
const PLATFORM_BASE_CSS_MARKER: &str = "archestra-app-base";

const NO_DOCUMENT_ROOT_WARNING: &str = "html has no <head> or <html> element; provide a complete HTML document (the injected runtime is prepended as a fallback).";

static HEAD_OR_HTML: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)<(head|html)[\s>]").expect("static head/html probe regex"));

// Exact script/link open tags with a browser-recognized tag-name boundary.
// This backstops the DOM loops for tag shapes `tl` drops without treating
// custom or namespace-like elements as native resource tags.
static RESOURCE_TAG_FALLBACK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<(?i-u:(script|link))([\x20\t\n\x0c\r/][^>]*|>)")
        .expect("static resource tag fallback regex")
});

// A src/href ref inside the bounded opening-tag tail, quoted (group 2) or
// unquoted (group 3). The attribute name must follow a whitespace, solidus, or
// quote boundary so `data-src` does not count. Deliberately regex-grade:
// crafted markup (decoy `src=` in another attribute's value, mixed quotes,
// entity-spliced markers) can still slip it — the render-time CSP stays the
// real security boundary.
static RESOURCE_ATTR_FALLBACK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)[\s/"'](?i-u:(src|href))\s*=\s*(?:["']([^"']*)["']|([^\s>"']+))"#)
        .expect("static resource attribute fallback regex")
});

/// Why a scan disqualified the HTML. Carries the offending value so the caller
/// can build a precise user-facing message (kept on the TypeScript side).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RejectionKind {
    /// A `<script>` bootstraps the SDK itself. `offender` is the marker found.
    SdkBootstrap,
    /// A `<script src>` loads a platform script. `offender` is the src.
    PlatformScriptSrc,
    /// A `<link href>` loads the platform stylesheet. `offender` is the href.
    PlatformBaseCss,
    /// The HTML could not be parsed at all — fail closed. `offender` is empty.
    Unparseable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rejection {
    pub kind: RejectionKind,
    pub offender: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct ScanResult {
    /// The first disqualifying construct, if any. `None` ⇒ the save may proceed.
    pub rejection: Option<Rejection>,
    /// Soft structural issues; the save succeeds but the author should see them.
    pub warnings: Vec<String>,
}

/// Scan authored app HTML for save-time policy violations. See module docs.
pub fn scan_app_html(html: &str) -> ScanResult {
    let Ok(dom) = tl::parse(html, tl::ParserOptions::default()) else {
        return ScanResult {
            rejection: Some(Rejection {
                kind: RejectionKind::Unparseable,
                offender: String::new(),
            }),
            warnings: Vec::new(),
        };
    };

    let tags = || dom.nodes().iter().filter_map(|node| node.as_tag());

    // 1. SDK self-bootstrap inside <script> text. Markers are tested in list
    //    order over the concatenated blocks (mirrors the TS precedence).
    let script_text: String = SCRIPT_BLOCK
        .captures_iter(html)
        .map(|block| block[1].to_string())
        .collect::<Vec<_>>()
        .join("\n");
    for marker in SDK_BOOTSTRAP_MARKERS {
        if script_text.contains(marker) {
            return reject(RejectionKind::SdkBootstrap, marker.to_string());
        }
    }

    // 2. Platform script self-load via <script src>, document order.
    for tag in tags().filter(|tag| exact_resource_tag_is(tag, "script")) {
        if let Some(src) = resource_ref(tag, "src") {
            let normalized = normalize_resource_ref(&src);
            if PLATFORM_SCRIPT_SRC_MARKERS
                .iter()
                .any(|marker| normalized.contains(marker))
            {
                return reject(RejectionKind::PlatformScriptSrc, src);
            }
        }
    }

    // 3. Platform stylesheet self-load via <link href>.
    for tag in tags().filter(|tag| exact_resource_tag_is(tag, "link")) {
        if let Some(href) = resource_ref(tag, "href")
            && normalize_resource_ref(&href).contains(PLATFORM_BASE_CSS_MARKER)
        {
            return reject(RejectionKind::PlatformBaseCss, href);
        }
    }

    // 4. Lexical fallback for self-load refs in tag shapes `tl` drops
    //    entirely (`<script /src=…>`, unquoted URL values with `/`). Extra
    //    matches this can add (e.g. inside HTML comments) are fail-closed.
    for tag_capture in RESOURCE_TAG_FALLBACK.captures_iter(html) {
        let tag_name = &tag_capture[1];
        let Some(attr_capture) = RESOURCE_ATTR_FALLBACK.captures(&tag_capture[2]) else {
            continue;
        };
        let attr_name = &attr_capture[1];
        let value = attr_capture
            .get(2)
            .or_else(|| attr_capture.get(3))
            .map_or("", |matched| matched.as_str());
        let normalized = normalize_resource_ref(value);
        if tag_name.eq_ignore_ascii_case("script") && attr_name.eq_ignore_ascii_case("src") {
            if PLATFORM_SCRIPT_SRC_MARKERS
                .iter()
                .any(|marker| normalized.contains(marker))
            {
                return reject(RejectionKind::PlatformScriptSrc, value.to_string());
            }
        } else if tag_name.eq_ignore_ascii_case("link")
            && attr_name.eq_ignore_ascii_case("href")
            && normalized.contains(PLATFORM_BASE_CSS_MARKER)
        {
            return reject(RejectionKind::PlatformBaseCss, value.to_string());
        }
    }

    // 5. Soft warning: no document root. Probed on the raw input (a parser
    //    normalizes fragments away), mirroring the TS regex.
    let mut warnings = Vec::new();
    if !HEAD_OR_HTML.is_match(html) {
        warnings.push(NO_DOCUMENT_ROOT_WARNING.to_string());
    }
    ScanResult {
        rejection: None,
        warnings,
    }
}

// A `<script>` block's raw text, up to the next `</script>` — the closest
// lexical approximation of the browser's RAWTEXT tokenization. Shared with
// the authoring lint (`app_html_lint`), like the tag helpers below.
pub(crate) static SCRIPT_BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)<script\b[^>]*>(.*?)</script>").expect("static script block regex")
});

// Tag-name match tolerant of `tl`'s solidus fusing: `<script/src=…>` is a
// script element to the browser, but `tl` parses the name as `script/src` —
// compare only the part before the first solidus.
pub(crate) fn tag_is(tag: &tl::HTMLTag, expected: &str) -> bool {
    let name = tag.name().as_utf8_str();
    name.split('/')
        .next()
        .unwrap_or(&name)
        .eq_ignore_ascii_case(expected)
}

// An attribute ref, recovering the solidus-fused shape `tag_is` matches on
// (`tl` leaves the value under an empty attribute key there). `<script /src=…>`
// makes `tl` drop the tag entirely — the save gate's lexical fallback covers
// that; the authoring lint deliberately leaves it a blind spot.
pub(crate) fn resource_ref(tag: &tl::HTMLTag, attr_name: &str) -> Option<String> {
    if let Some(value) = attr(tag, attr_name) {
        return Some(value);
    }
    let name = tag.name().as_utf8_str();
    let (_, fused) = name.split_once('/')?;
    if fused
        .trim_start_matches('/')
        .eq_ignore_ascii_case(attr_name)
    {
        return attr(tag, "");
    }
    None
}

// HTML attribute names are case-insensitive, but `tl`'s `Attributes::get` is an
// exact-case lookup — so we iterate and compare keys with `eq_ignore_ascii_case`
// (cheerio's `.attr()` matched `SRC`/`HREF` too). A valueless attribute yields
// `None`, i.e. nothing to scan.
fn attr(tag: &tl::HTMLTag, name: &str) -> Option<String> {
    tag.attributes()
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value)
        .map(|value| value.into_owned())
}

fn exact_resource_tag_is(tag: &tl::HTMLTag, expected: &str) -> bool {
    if !tag_is(tag, expected) {
        return false;
    }
    let raw = tag.raw().as_utf8_str();
    RESOURCE_TAG_FALLBACK
        .captures(raw.as_ref())
        .is_some_and(|capture| {
            capture.get(0).is_some_and(|matched| matched.start() == 0)
                && capture[1].eq_ignore_ascii_case(expected)
        })
}

fn normalize_resource_ref(reference: &str) -> String {
    reference
        .chars()
        .filter(|character| !matches!(character, '\t' | '\n' | '\r'))
        .collect()
}

fn reject(kind: RejectionKind, offender: String) -> ScanResult {
    ScanResult {
        rejection: Some(Rejection { kind, offender }),
        warnings: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMPLETE_DOC: &str =
        "<!DOCTYPE html><html><head><title>x</title></head><body><p>hi</p></body></html>";

    #[test]
    fn clean_complete_document_passes_with_no_warnings() {
        let result = scan_app_html(COMPLETE_DOC);
        assert_eq!(result.rejection, None);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn rejects_sdk_bootstrap_marker_in_script() {
        for marker in SDK_BOOTSTRAP_MARKERS {
            let html = format!("<html><head><script>const u = {marker};</script></head></html>");
            let result = scan_app_html(&html);
            let rejection = result.rejection.expect("should reject");
            assert_eq!(rejection.kind, RejectionKind::SdkBootstrap);
            assert_eq!(rejection.offender, marker);
        }
    }

    #[test]
    fn marker_in_prose_outside_script_does_not_reject() {
        let html =
            "<html><head></head><body><p>Use PostMessageTransport like this</p></body></html>";
        assert_eq!(scan_app_html(html).rejection, None);
    }

    #[test]
    fn rejects_platform_script_self_load() {
        let html =
            r#"<html><head><script src="/_sandbox/archestra-app-sdk.js"></script></head></html>"#;
        let rejection = scan_app_html(html).rejection.expect("should reject");
        assert_eq!(rejection.kind, RejectionKind::PlatformScriptSrc);
        assert_eq!(rejection.offender, "/_sandbox/archestra-app-sdk.js");
    }

    #[test]
    fn rejects_platform_base_css_self_load() {
        let html = r#"<html><head><link rel="stylesheet" href="/_sandbox/archestra-app-base.css"></head></html>"#;
        let rejection = scan_app_html(html).rejection.expect("should reject");
        assert_eq!(rejection.kind, RejectionKind::PlatformBaseCss);
        assert_eq!(rejection.offender, "/_sandbox/archestra-app-base.css");
    }

    #[test]
    fn whitespace_spliced_href_cannot_slip_the_self_link_past() {
        let html = "<html><head><link href=\"/_sandbox/archestra-app-\n\tbase.css\"></head></html>";
        let rejection = scan_app_html(html).rejection.expect("should reject");
        assert_eq!(rejection.kind, RejectionKind::PlatformBaseCss);
    }

    #[test]
    fn unrelated_stylesheet_link_is_allowed() {
        let html = r#"<html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/normalize.css"></head></html>"#;
        assert_eq!(scan_app_html(html).rejection, None);
    }

    #[test]
    fn uppercase_script_tag_is_matched() {
        let html =
            "<HTML><HEAD><SCRIPT>const u = __ARCHESTRA_APP_CONTEXT__;</SCRIPT></HEAD></HTML>";
        assert_eq!(
            scan_app_html(html).rejection.expect("should reject").kind,
            RejectionKind::SdkBootstrap
        );
    }

    #[test]
    fn uppercase_attribute_names_are_matched() {
        // HTML attribute names are case-insensitive — `SRC`/`HREF` must be caught
        // like `src`/`href` (cheerio's `.attr()` did).
        let script_upper =
            r#"<html><head><SCRIPT SRC="/_sandbox/archestra-app-sdk.js"></SCRIPT></head></html>"#;
        assert_eq!(
            scan_app_html(script_upper).rejection.expect("reject").kind,
            RejectionKind::PlatformScriptSrc
        );
        let link_upper =
            r#"<html><head><LINK HREF="/_sandbox/archestra-app-base.css"></head></html>"#;
        assert_eq!(
            scan_app_html(link_upper).rejection.expect("reject").kind,
            RejectionKind::PlatformBaseCss
        );
    }

    #[test]
    fn warns_on_fragment_without_document_root() {
        let result = scan_app_html("<p>just a fragment</p>");
        assert_eq!(result.rejection, None);
        assert_eq!(result.warnings, vec![NO_DOCUMENT_ROOT_WARNING.to_string()]);
    }

    #[test]
    fn bare_less_than_before_a_marker_cannot_evade_the_bootstrap_rejection() {
        // A `<` comparison splinters the script element in `tl`'s DOM; the
        // lexical extraction must still see the marker.
        let html = "<html><head><script>if (a < b) { const u = window.__ARCHESTRA_APP_SDK_URL__; }</script></head></html>";
        assert_eq!(
            scan_app_html(html).rejection.expect("should reject").kind,
            RejectionKind::SdkBootstrap
        );
    }

    #[test]
    fn commented_out_bootstrap_script_fails_closed() {
        // The lexical extraction reads script blocks inside HTML comments too.
        let html = "<html><head><!-- <script>PostMessageTransport</script> --></head></html>";
        assert_eq!(
            scan_app_html(html).rejection.expect("should reject").kind,
            RejectionKind::SdkBootstrap
        );
    }

    #[test]
    fn solidus_fused_platform_self_loads_are_rejected() {
        let script =
            r#"<html><head><script/src="/_sandbox/archestra-app-sdk.js"></script></head></html>"#;
        let rejection = scan_app_html(script).rejection.expect("should reject");
        assert_eq!(rejection.kind, RejectionKind::PlatformScriptSrc);
        assert_eq!(rejection.offender, "/_sandbox/archestra-app-sdk.js");
        let link = r#"<html><head><link/href="/_sandbox/archestra-app-base.css"></head></html>"#;
        assert_eq!(
            scan_app_html(link).rejection.expect("should reject").kind,
            RejectionKind::PlatformBaseCss
        );
    }

    #[test]
    fn space_solidus_self_loads_are_rejected_via_the_lexical_fallback() {
        // `tl` drops these tags entirely; browsers load them.
        let script =
            r#"<html><head><script /src="/_sandbox/archestra-app-sdk.js"></script></head></html>"#;
        let rejection = scan_app_html(script).rejection.expect("should reject");
        assert_eq!(rejection.kind, RejectionKind::PlatformScriptSrc);
        assert_eq!(rejection.offender, "/_sandbox/archestra-app-sdk.js");
        let link = r#"<html><head><link /href="/_sandbox/archestra-app-base.css"></head></html>"#;
        assert_eq!(
            scan_app_html(link).rejection.expect("should reject").kind,
            RejectionKind::PlatformBaseCss
        );
    }

    #[test]
    fn unquoted_self_load_src_is_rejected_via_the_lexical_fallback() {
        // Unquoted URL values containing `/` also make `tl` drop the tag.
        let html = "<html><head><script src=/_sandbox/archestra-app-sdk.js></script></head></html>";
        assert_eq!(
            scan_app_html(html).rejection.expect("should reject").kind,
            RejectionKind::PlatformScriptSrc
        );
    }

    #[test]
    fn data_src_metadata_is_not_treated_as_a_self_load() {
        // The browser never loads `data-src`; the fallback's attribute
        // boundary must not read it as a real `src`.
        let html = r#"<html><head><script data-src="/_sandbox/archestra-app-sdk.js"></script></head></html>"#;
        assert_eq!(scan_app_html(html).rejection, None);
    }

    #[test]
    fn fallback_does_not_treat_non_native_names_as_resource_tags() {
        let cases = [
            r#"<html><head><script-widget src="/_sandbox/archestra-app-sdk.js"></script-widget></head></html>"#,
            r#"<html><head><link-widget href="/_sandbox/archestra-app-base.css"></head></html>"#,
            r#"<html><head><script:widget src="/_sandbox/archestra-app-sdk.js"></script:widget></head></html>"#,
            "<html><head><link\u{00a0}href=\"/_sandbox/archestra-app-base.css\"></head></html>",
            "<html><head><ſcript src=\"/_sandbox/archestra-app-sdk.js\"></ſcript></head></html>",
            "<html><head><linK href=\"/_sandbox/archestra-app-base.css\"></head></html>",
        ];
        for html in cases {
            assert_eq!(scan_app_html(html).rejection, None, "{html}");
        }
    }

    #[test]
    fn fallback_preserves_browser_effective_resource_attributes() {
        let cases = [
            r#"<html><head><script src="safe.js" src="/_sandbox/archestra-app-sdk.js"></script></head></html>"#,
            r#"<html><head><link href="safe.css" href="/_sandbox/archestra-app-base.css"></head></html>"#,
            r#"<html><head><script href="safe" data-note="src=/_sandbox/archestra-app-sdk.js"></script></head></html>"#,
            r#"<html><head><link src="safe" data-note="href=/_sandbox/archestra-app-base.css"></head></html>"#,
        ];
        for html in cases {
            assert_eq!(scan_app_html(html).rejection, None, "{html}");
        }
    }

    #[test]
    fn native_resource_tags_accept_only_html_tag_name_boundaries() {
        for boundary in [" ", "\t", "\n", "\u{000c}", "\r", "/"] {
            let script = format!(
                "<html><head><script{boundary}src=/_sandbox/archestra-app-sdk.js></script></head></html>"
            );
            assert_eq!(
                scan_app_html(&script)
                    .rejection
                    .expect("should reject")
                    .kind,
                RejectionKind::PlatformScriptSrc,
                "{script}"
            );

            let link = format!(
                "<html><head><link{boundary}href=/_sandbox/archestra-app-base.css></head></html>"
            );
            assert_eq!(
                scan_app_html(&link).rejection.expect("should reject").kind,
                RejectionKind::PlatformBaseCss,
                "{link}"
            );
        }
    }

    #[test]
    fn ignored_url_controls_cannot_splice_platform_resource_markers() {
        for control in ["\t", "\n", "\r"] {
            let script_ref = format!("/_sandbox/archestra-app-{control}sdk.js");
            for html in [
                format!(r#"<html><head><script src="{script_ref}"></script></head></html>"#),
                format!(r#"<html><head><script /src="{script_ref}"></script></head></html>"#),
            ] {
                let rejection = scan_app_html(&html).rejection.expect("should reject");
                assert_eq!(rejection.kind, RejectionKind::PlatformScriptSrc);
                assert_eq!(rejection.offender, script_ref);
            }

            let stylesheet_ref = format!("/_sandbox/archestra-app-{control}base.css");
            for html in [
                format!(r#"<html><head><link href="{stylesheet_ref}"></head></html>"#),
                format!(r#"<html><head><link /href="{stylesheet_ref}"></head></html>"#),
            ] {
                let rejection = scan_app_html(&html).rejection.expect("should reject");
                assert_eq!(rejection.kind, RejectionKind::PlatformBaseCss);
                assert_eq!(rejection.offender, stylesheet_ref);
            }
        }
    }

    #[test]
    fn non_ignored_url_characters_do_not_reconstruct_platform_resource_markers() {
        for preserved in [" ", "\u{000c}", "\u{feff}"] {
            let script_ref = format!("/_sandbox/archestra-app-{preserved}sdk.js");
            let stylesheet_ref = format!("/_sandbox/archestra-app-{preserved}base.css");
            for html in [
                format!(r#"<html><head><script src="{script_ref}"></script></head></html>"#),
                format!(r#"<html><head><script /src="{script_ref}"></script></head></html>"#),
                format!(r#"<html><head><link href="{stylesheet_ref}"></head></html>"#),
                format!(r#"<html><head><link /href="{stylesheet_ref}"></head></html>"#),
            ] {
                assert_eq!(scan_app_html(&html).rejection, None, "{html}");
            }
        }
    }

    #[test]
    fn marker_after_a_gt_inside_a_script_attribute_fails_closed() {
        // The lexical extraction ends the open tag at the first `>` even
        // inside a quoted attribute. Deliberate: a quote-aware pattern would
        // go fail-open on unterminated quotes, which is worse for a gate.
        let html =
            r#"<html><head><script data-note=">PostMessageTransport"></script></head></html>"#;
        assert_eq!(
            scan_app_html(html).rejection.expect("should reject").kind,
            RejectionKind::SdkBootstrap
        );
    }

    #[test]
    fn sdk_bootstrap_takes_precedence_over_self_load() {
        // Both a bootstrap marker and a platform self-load present: the bootstrap
        // wins (TS checks script text before script src).
        let html = r#"<html><head><script>PostMessageTransport</script><script src="/x/ext-apps-app.js"></script></head></html>"#;
        assert_eq!(
            scan_app_html(html).rejection.expect("should reject").kind,
            RejectionKind::SdkBootstrap
        );
    }
}
