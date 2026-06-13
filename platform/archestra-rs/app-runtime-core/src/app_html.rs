//! Save-time security scan of an owned app's authored HTML. Ported from the
//! cheerio-based `validateAppHtml` in `services/apps/app-ui-policy.ts`.
//!
//! The app may not bootstrap the MCP App SDK itself, nor load the platform's
//! own SDK/stylesheet assets — the platform injects those at serve time (see
//! the envelope module). A scan is pure: it never mutates the HTML, it only
//! reports the first disqualifying construct (rejection) plus soft warnings.
//! Parsing failures fail closed (a rejection), never a silent pass.

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
    let parser = dom.parser();

    let tags = || dom.nodes().iter().filter_map(|node| node.as_tag());

    // 1. SDK self-bootstrap inside <script> text. Concatenate all script text,
    //    then test markers in list order (mirrors the TS precedence).
    let script_text: String = tags()
        .filter(|tag| tag.name().as_utf8_str().eq_ignore_ascii_case("script"))
        .map(|tag| tag.inner_text(parser).into_owned())
        .collect::<Vec<_>>()
        .join("\n");
    for marker in SDK_BOOTSTRAP_MARKERS {
        if script_text.contains(marker) {
            return reject(RejectionKind::SdkBootstrap, marker.to_string());
        }
    }

    // 2. Platform script self-load via <script src>, document order.
    for tag in tags().filter(|tag| tag.name().as_utf8_str().eq_ignore_ascii_case("script")) {
        if let Some(src) = attr(tag, "src") {
            if PLATFORM_SCRIPT_SRC_MARKERS
                .iter()
                .any(|marker| src.contains(marker))
            {
                return reject(RejectionKind::PlatformScriptSrc, src);
            }
        }
    }

    // 3. Platform stylesheet self-load via <link href>. Strip whitespace the
    //    browser ignores when resolving the URL so a spliced tab/newline (or a
    //    ZWNBSP, which JS `\s` strips but Rust's `is_whitespace` does not) can't
    //    sneak the marker past.
    for tag in tags().filter(|tag| tag.name().as_utf8_str().eq_ignore_ascii_case("link")) {
        if let Some(href) = attr(tag, "href") {
            let collapsed: String = href
                .chars()
                .filter(|c| !c.is_whitespace() && *c != '\u{feff}')
                .collect();
            if collapsed.contains(PLATFORM_BASE_CSS_MARKER) {
                return reject(RejectionKind::PlatformBaseCss, href);
            }
        }
    }

    // 4. Soft warning: no document root. Probed on the raw input (a parser
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
    fn zwnbsp_spliced_href_is_still_caught() {
        let html =
            "<html><head><link href=\"/_sandbox/archestra-app-\u{feff}base.css\"></head></html>";
        assert_eq!(
            scan_app_html(html).rejection.expect("should reject").kind,
            RejectionKind::PlatformBaseCss
        );
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
