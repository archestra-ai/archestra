//! Authoring-time lint of an owned app's HTML for the `validate_app` MCP tool.
//! Ported from the regex helpers in `services/apps/app-ui-policy.ts`; the
//! companion save-gate scan lives in `app_html`.
//!
//! Everything here is a soft hint for the author, never a rejection: hosts the
//! pinned CSP will block at render time, browser storage APIs the sandbox's
//! opaque origin breaks, and `window.archestra` members the injected SDK does
//! not expose. The caller supplies the policy inputs (CDN allowlist, SDK
//! surface) and composes the user-facing messages; this module only reports
//! structured findings. The lint stays lexical inside script text: aliasing
//! (`const s = archestra.storage; s.get()`), computed access
//! (`archestra["storage"]`), and dynamic names are out of scope by design.
//!
//! Unlike the TS predecessor (raw-text regexes), tags are read from the same
//! `tl` DOM the scan parses: `src` is read on `<script>` and `href` on
//! `<link>` as real attributes, and markup inside HTML comments is not
//! scanned — matching what the browser resolves at render time. Unquoted URL
//! attribute values stay a blind spot (`tl` drops such tags; the TS regex
//! required quotes). If the HTML does not parse, the findings are empty: the
//! scan already fails closed with an `unparseable` rejection, and lexical
//! hints on unparseable input are noise.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

use crate::app_html::attr;

/// Policy inputs for the lint, owned by the TypeScript caller (single source of
/// truth for the CDN allowlist and the injected-SDK surface lives there).
#[derive(Clone, Debug)]
pub struct LintConfig {
    /// Bare hostnames `<script src>`/`<link href>` may point at (exact match,
    /// mirroring CSP host-source semantics).
    pub resource_host_allowlist: Vec<String>,
    /// Members the injected `window.archestra` exposes at the top level.
    pub sdk_top_level_members: Vec<String>,
    /// Partitions of `archestra.storage` (methods hang off a partition).
    pub sdk_storage_partitions: Vec<String>,
}

/// Structured lint findings. Every list is deduplicated in first-seen document
/// order; the caller turns each non-empty list into one user-facing warning.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LintFindings {
    /// Hosts referenced by `<script src>`/`<link href>` outside the allowlist.
    pub off_allowlist_hosts: Vec<String>,
    /// Browser storage APIs (`localStorage`, …) referenced in script text.
    pub browser_storage_apis: Vec<String>,
    /// `archestra.storage.<member>` accesses where `<member>` is no partition,
    /// as full references (`archestra.storage.get`).
    pub storage_misuse: Vec<String>,
    /// `archestra.<member>` accesses the SDK does not expose, as full
    /// references (`archestra.tool`).
    pub unknown_top_level: Vec<String>,
}

/// Lint authored app HTML against the supplied policy. See module docs.
pub fn lint_app_html(html: &str, config: &LintConfig) -> LintFindings {
    let Ok(dom) = tl::parse(html, tl::ParserOptions::default()) else {
        return LintFindings::default();
    };
    let parser = dom.parser();
    let mut findings = LintFindings::default();

    for tag in dom.nodes().iter().filter_map(|node| node.as_tag()) {
        let name = tag.name().as_utf8_str();
        if name.eq_ignore_ascii_case("script") {
            lint_script_text(&tag.inner_text(parser), config, &mut findings);
            if let Some(src) = attr(tag, "src") {
                flag_off_allowlist_host(&src, config, &mut findings);
            }
        } else if name.eq_ignore_ascii_case("link")
            && let Some(href) = attr(tag, "href")
        {
            flag_off_allowlist_host(&href, config, &mut findings);
        }
    }
    findings
}

// `\b`-anchored so `myarchestra.x` is not matched; `window.archestra.<member>`
// still matches via its `archestra.<member>` substring. Member names use the
// ASCII identifier class the TS predecessor used.
static ARCHESTRA_TOP_LEVEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\barchestra\.([A-Za-z_$][0-9A-Za-z_$]*)").expect("static archestra member regex")
});
static ARCHESTRA_STORAGE_MEMBER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\barchestra\.storage\.([A-Za-z_$][0-9A-Za-z_$]*)")
        .expect("static archestra storage member regex")
});
static BROWSER_STORAGE_API: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(localStorage|sessionStorage|indexedDB)\b")
        .expect("static browser storage regex")
});
static JS_BLOCK_COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)/\*.*?\*/").expect("static block comment regex"));
static JS_LINE_COMMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"//[^\n]*").expect("static line comment regex"));

// One script block's text against the storage-API and SDK-member lints. The
// storage scan sees the raw text (a commented-out `localStorage` still warns,
// as in the TS predecessor); the SDK-member scan is comment-stripped so a
// documented counter-example (`// use archestra.storage.user.get, not .get`)
// does not warn.
fn lint_script_text(script: &str, config: &LintConfig, findings: &mut LintFindings) {
    for capture in BROWSER_STORAGE_API.captures_iter(script) {
        push_unique(&mut findings.browser_storage_apis, &capture[1]);
    }
    let stripped = strip_js_comments(script);
    for capture in ARCHESTRA_TOP_LEVEL.captures_iter(&stripped) {
        let member = &capture[1];
        if !config.sdk_top_level_members.iter().any(|m| m == member) {
            push_unique(
                &mut findings.unknown_top_level,
                &format!("archestra.{member}"),
            );
        }
    }
    for capture in ARCHESTRA_STORAGE_MEMBER.captures_iter(&stripped) {
        let member = &capture[1];
        if !config.sdk_storage_partitions.iter().any(|m| m == member) {
            push_unique(
                &mut findings.storage_misuse,
                &format!("archestra.storage.{member}"),
            );
        }
    }
}

// Drop // line and /* */ block comments. Block comments collapse to a space so
// a comment between tokens can never fuse two identifiers into a spurious
// `archestra.*`. Only ever deletes spans, so it can miss a call literally
// inside a comment-shaped string, never invent one; string literals are left
// as-is (lexically unsafe to strip).
fn strip_js_comments(script: &str) -> String {
    let without_blocks = JS_BLOCK_COMMENT.replace_all(script, " ");
    JS_LINE_COMMENT
        .replace_all(&without_blocks, "")
        .into_owned()
}

fn flag_off_allowlist_host(reference: &str, config: &LintConfig, findings: &mut LintFindings) {
    let Some(host) = external_host(reference) else {
        return;
    };
    if !config.resource_host_allowlist.contains(&host) {
        push_unique(&mut findings.off_allowlist_hosts, &host);
    }
}

// The host of an absolute or protocol-relative http(s) URL; `None` for
// relative, data:, blob:, or otherwise host-less refs (which the resource CSP
// ignores). The scheme is checked before parsing because `Url::parse` would
// also accept slashless forms (`https:foo`) the CSP lint never meant to cover.
fn external_host(reference: &str) -> Option<String> {
    let normalized = if reference.starts_with("//") {
        format!("https:{reference}")
    } else {
        reference.to_string()
    };
    let has_http_scheme = normalized
        .get(..7)
        .is_some_and(|p| p.eq_ignore_ascii_case("http://"))
        || normalized
            .get(..8)
            .is_some_and(|p| p.eq_ignore_ascii_case("https://"));
    if !has_http_scheme {
        return None;
    }
    Url::parse(&normalized).ok()?.host_str().map(str::to_owned)
}

// Findings lists are tiny (a handful of entries), so a linear scan beats a set.
fn push_unique(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|existing| existing == value) {
        list.push(value.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> LintConfig {
        LintConfig {
            resource_host_allowlist: vec![
                "cdn.jsdelivr.net".to_string(),
                "fonts.googleapis.com".to_string(),
            ],
            sdk_top_level_members: vec![
                "ready", "user", "context", "storage", "llm", "tools", "ui",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
            sdk_storage_partitions: vec!["user".to_string(), "shared".to_string()],
        }
    }

    fn lint(html: &str) -> LintFindings {
        lint_app_html(html, &config())
    }

    #[test]
    fn clean_document_yields_no_findings() {
        let findings = lint(
            r#"<html><head><script src="https://cdn.jsdelivr.net/npm/x.js"></script><script>
                await archestra.ready;
                const v = await archestra.storage.user.get("k");
                await archestra.storage.shared.set("k", 1);
                await archestra.tools.call("github__x", {});
            </script></head><body/></html>"#,
        );
        assert_eq!(findings, LintFindings::default());
    }

    // --- off-allowlist resource hosts ---

    #[test]
    fn off_allowlist_script_host_is_flagged() {
        let findings = lint(
            r#"<html><head><script src="https://evil.example.com/a.js"></script></head></html>"#,
        );
        assert_eq!(findings.off_allowlist_hosts, vec!["evil.example.com"]);
    }

    #[test]
    fn protocol_relative_host_is_flagged_once_across_refs() {
        let findings = lint(
            r#"<html><head><link href="//assets.example.org/x.css"><link href="//assets.example.org/y.css"></head></html>"#,
        );
        assert_eq!(findings.off_allowlist_hosts, vec!["assets.example.org"]);
    }

    #[test]
    fn allowlisted_relative_and_hostless_refs_are_ignored() {
        let findings = lint(
            r#"<html><head>
                <script src="https://cdn.jsdelivr.net/npm/x.js"></script>
                <link href="https://fonts.googleapis.com/css">
                <script src="/local.js"></script>
                <link href="styles.css">
                <script src="data:text/javascript,1"></script>
                <link href="blob:abc">
                <script src="ftp://files.example.com/x.js"></script>
            </head></html>"#,
        );
        assert_eq!(findings.off_allowlist_hosts, Vec::<String>::new());
    }

    #[test]
    fn unquoted_url_attribute_is_a_shared_blind_spot() {
        // `tl` drops a tag whose unquoted attribute value contains `/`, so an
        // unquoted URL ref is not seen — the same blind spot the TS regex had
        // (it required a quoted value). Pinned so a `tl` upgrade that starts
        // parsing these shows up as a deliberate behavior change.
        let findings =
            lint("<html><head><script src=https://evil.example.com/a.js></script></head></html>");
        assert_eq!(findings.off_allowlist_hosts, Vec::<String>::new());
    }

    #[test]
    fn refs_inside_html_comments_are_not_scanned() {
        // Behavior delta vs the TS regex: a commented-out tag never loads, so
        // it does not warn.
        let findings = lint(
            r#"<html><head><!-- <script src="https://evil.example.com/a.js"></script> --></head></html>"#,
        );
        assert_eq!(findings, LintFindings::default());
    }

    #[test]
    fn src_on_link_and_href_on_script_do_not_match() {
        // Behavior delta vs the tag-agnostic TS regex: only the attribute the
        // browser reads on each tag counts.
        let findings = lint(
            r#"<html><head><link src="https://evil.example.com/a.css"><script href="https://evil.example.com/b.js"></script></head></html>"#,
        );
        assert_eq!(findings.off_allowlist_hosts, Vec::<String>::new());
    }

    #[test]
    fn host_comparison_uses_url_normalization() {
        // Mixed-case hosts normalize to lowercase (so the allowlist matches);
        // IDNA hosts normalize to punycode; IPv6 literals keep their brackets
        // and a trailing-dot host stays distinct — none of those three match a
        // bare-hostname allowlist.
        let findings = lint(
            r#"<html><head>
                <script src="https://CDN.JSDELIVR.NET/npm/x.js"></script>
                <script src="https://münchen.example/x.js"></script>
                <script src="https://[::1]/x.js"></script>
                <script src="https://cdn.jsdelivr.net./x.js"></script>
            </head></html>"#,
        );
        assert_eq!(
            findings.off_allowlist_hosts,
            vec!["xn--mnchen-3ya.example", "[::1]", "cdn.jsdelivr.net."]
        );
    }

    #[test]
    fn unparsable_urls_and_slashless_schemes_are_ignored() {
        let findings = lint(
            r#"<html><head><script src="https://exa mple.com/x.js"></script><script src="https:evil.example.com/x.js"></script></head></html>"#,
        );
        assert_eq!(findings.off_allowlist_hosts, Vec::<String>::new());
    }

    // --- browser storage APIs ---

    #[test]
    fn browser_storage_in_script_is_flagged_prose_is_not() {
        let findings = lint(
            r#"<html><head><script>window.localStorage.getItem("k");</script></head><body><p>This app does not use sessionStorage.</p></body></html>"#,
        );
        assert_eq!(findings.browser_storage_apis, vec!["localStorage"]);
    }

    #[test]
    fn browser_storage_apis_dedup_in_first_seen_order() {
        let findings = lint(
            "<html><head><script>indexedDB.open(1); localStorage.x; localStorage.y; sessionStorage.z;</script></head></html>",
        );
        assert_eq!(
            findings.browser_storage_apis,
            vec!["indexedDB", "localStorage", "sessionStorage"]
        );
    }

    #[test]
    fn browser_storage_scan_does_not_strip_js_comments() {
        // Parity with the TS predecessor: the storage hint fires even on
        // commented-out usage (only the SDK-member lint strips comments).
        let findings = lint(
            "<html><head><script>// localStorage.getItem\nconst x = 1;</script></head></html>",
        );
        assert_eq!(findings.browser_storage_apis, vec!["localStorage"]);
    }

    // --- archestra SDK members ---

    #[test]
    fn storage_method_on_the_store_is_misuse() {
        let findings = lint(
            r#"<html><head><script>const x = await archestra.storage.get("k");</script></head></html>"#,
        );
        assert_eq!(findings.storage_misuse, vec!["archestra.storage.get"]);
        // `storage` itself is a valid top-level member, so no top-level finding.
        assert_eq!(findings.unknown_top_level, Vec::<String>::new());
    }

    #[test]
    fn unknown_top_level_member_is_flagged() {
        let findings = lint("<html><head><script>archestra.tool.call('x');</script></head></html>");
        assert_eq!(findings.unknown_top_level, vec!["archestra.tool"]);
    }

    #[test]
    fn members_dedup_per_category_in_first_seen_order() {
        let findings = lint(
            r#"<html><head><script>
                archestra.storage.get("a"); archestra.storage.get("b"); archestra.storage.delete("c");
                archestra.tool.call(); archestra.tool.list();
            </script></head></html>"#,
        );
        assert_eq!(
            findings.storage_misuse,
            vec!["archestra.storage.get", "archestra.storage.delete"]
        );
        assert_eq!(findings.unknown_top_level, vec!["archestra.tool"]);
    }

    #[test]
    fn sdk_members_in_js_comments_do_not_warn() {
        let findings = lint(
            "<html><head><script>\n// use archestra.storage.user.get, not archestra.storage.get\n/* archestra.tool.call is also wrong */\nconst x = 1;\n</script></head></html>",
        );
        assert_eq!(findings, LintFindings::default());
    }

    #[test]
    fn block_comment_between_tokens_cannot_fuse_identifiers() {
        // `archestra/* */.tool` must not become `archestra.tool` after stripping.
        let findings = lint("<html><head><script>archestra/* x */.tool;</script></head></html>");
        assert_eq!(findings.unknown_top_level, Vec::<String>::new());
    }

    #[test]
    fn prefixed_identifier_is_not_matched() {
        let findings =
            lint("<html><head><script>myarchestra.everything.is.fine;</script></head></html>");
        assert_eq!(findings, LintFindings::default());
    }

    #[test]
    fn window_prefixed_access_is_matched() {
        let findings =
            lint("<html><head><script>window.archestra.tool.call();</script></head></html>");
        assert_eq!(findings.unknown_top_level, vec!["archestra.tool"]);
    }

    #[test]
    fn sdk_member_in_prose_does_not_warn() {
        let findings = lint(
            "<html><head></head><body><p>Do not call archestra.storage.get directly.</p></body></html>",
        );
        assert_eq!(findings, LintFindings::default());
    }
}
