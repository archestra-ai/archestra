//! The Archestra adapter: the derivation the runtime applies to every call the LLM
//! proxy hands it. Pure — no policy, no state, no runtime calls.
//!
//! There is no client-side codec and no wire. Archestra embeds the runtime in its
//! own process and builds each `HookEvent` itself, so it derives every call through
//! [`adapter`] before handing the event over, the way the wire derives a served
//! host's calls: the canonical identity comes from the raw spelling alone, and the
//! runtime spells a tool back to the model through the derivation's inverse.
//!
//! Archestra names a tool `<catalog>__<tool>`: the slug of the MCP catalog the tool
//! was installed from, two underscores, the tool's own name. Its parser splits at
//! the *last* `__`, because a catalog slug may itself contain one, and this adapter
//! splits the same way. The mapping onto canonical identity, a bijection over the
//! spellings it accepts:
//!
//! | raw spelling | canonical |
//! |---|---|
//! | `archestra__execute_remedy_plan` | `appa/execute_remedy_plan`, the runtime's control tool |
//! | `<catalog>__<tool>`, split at the last `__`, catalog without `__` | `mcp/<catalog>/<tool>` |
//! | any other `[A-Za-z0-9_.-]+` | `host/archestra/<name>` |
//!
//! The third row also takes a name whose catalog segment would contain `__` —
//! `my__cat__tool` — so such a call is still an identity a root rule can name by
//! its raw spelling, while no battery rule under `mcp/` reaches it. A character
//! outside the segment grammar is refused and the call blocks.
//!
//! Archestra's delegation is its own: a child trajectory binds to its spawn through
//! the event the host names it in, never through an argument the parent spells, so
//! [`names_children`] is always empty and no raw spelling derives as the spawn.

use appa_runtime::yell::HarnessName;
use appa_runtime_api::{
    Actor, Adapter, AdapterName, CanonicalTool, Derived, ParseRefusal, ProposedCall, TrajectoryId,
};

/// The derivation the runtime applies to every Archestra call. The wildcard covers a
/// spawn, since Archestra delegates under contracts it writes itself, and a spelled
/// name with `__` already names its catalog.
pub(crate) fn adapter() -> Adapter {
    Adapter {
        name: AdapterName::Embedded,
        derive,
        names_children,
        spell,
        wildcard_covers_spawn: true,
        spells_server: |name| name.contains(SEPARATOR),
    }
}

/// The name the reporting receiver files Archestra's yells under.
pub(crate) const HARNESS: &str = "archestra";

/// The name this host files its reports under.
pub(crate) fn harness() -> HarnessName {
    HarnessName::parse(HARNESS).expect("the harness name is spelled as a package name")
}

/// The control tool as Archestra advertises it to the model.
pub(crate) const CONTROL_TOOL_RAW: &str = "archestra__execute_remedy_plan";

const SEPARATOR: &str = "__";
const HOST_NAMESPACE: &str = "archestra";

fn derive(raw: &str) -> Result<Derived, ParseRefusal> {
    Ok(Derived {
        canonical: canonical(raw)?,
        spawn: false,
    })
}

/// The mapping table: the control spelling, then `<catalog>__<tool>` split at the last
/// `__` where that names a catalog, then `host/archestra/<name>`. `CanonicalTool::of`
/// refuses an empty segment, a catalog containing `__` and a character outside the
/// grammar; the first two fall through to the host family, the last is the refusal.
fn canonical(raw: &str) -> Result<CanonicalTool, ParseRefusal> {
    if raw == CONTROL_TOOL_RAW {
        return Ok(CanonicalTool::control());
    }
    if let Some((catalog, tool)) = raw.rsplit_once(SEPARATOR)
        && let Ok(identity) = CanonicalTool::of("mcp", catalog, tool)
    {
        return Ok(identity);
    }
    CanonicalTool::of("host", HOST_NAMESPACE, raw).map_err(|error| ParseRefusal::Malformed {
        detail: format!("tool {raw:?} is outside the Archestra adapter's domain: {error}"),
    })
}

/// The inverse of [`canonical`] over its range: the name Archestra dispatches for one
/// canonical identity, which is what the runtime says wherever it tells this model to
/// run something. Every answer is checked against [`canonical`], so a spelling this
/// returns derives back to the identity it was asked about; a canonical id outside the
/// range — another host's namespace, the `agent` family, `mcp/<catalog>/<tool>` whose
/// tool contains `__`, or `host/archestra/<name>` whose name is itself a catalog
/// spelling — answers `None`, and the caller says the canonical id instead.
fn spell(tool: &CanonicalTool) -> Option<String> {
    if tool.is_control() {
        return Some(CONTROL_TOOL_RAW.to_string());
    }
    let mut segments = tool.as_str().split('/');
    let raw = match (segments.next()?, segments.next()?, segments.next()?) {
        ("mcp", catalog, name) => format!("{catalog}{SEPARATOR}{name}"),
        ("host", HOST_NAMESPACE, name) => name.to_string(),
        _ => return None,
    };
    (canonical(&raw).as_ref() == Ok(tool)).then_some(raw)
}

/// No Archestra call names a family child by its arguments, so nothing here scans them.
fn names_children(_: &Actor, _: &ProposedCall) -> Vec<TrajectoryId> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn derived(raw: &str) -> Result<Derived, ParseRefusal> {
        (adapter().derive)(raw)
    }

    #[test]
    fn the_adapter_embeds_the_runtime() {
        assert_eq!(adapter().name, AdapterName::Embedded);
        assert!((adapter().spells_server)("github__get_file_contents"));
        assert!(!(adapter().spells_server)("get_weather"));
    }

    #[test]
    fn each_raw_spelling_maps_onto_its_canonical_identity_and_back() {
        for (raw, expected) in [
            ("github__get_file_contents", "mcp/github/get_file_contents"),
            (
                "github_prod__get_file_contents",
                "mcp/github_prod/get_file_contents",
            ),
            ("archestra__list_agents", "mcp/archestra/list_agents"),
            ("a.b-c__T.o-o_l", "mcp/a.b-c/T.o-o_l"),
            ("get_weather", "host/archestra/get_weather"),
            ("my__cat__tool", "host/archestra/my__cat__tool"),
            ("trailing__", "host/archestra/trailing__"),
            ("__leading", "host/archestra/__leading"),
            (CONTROL_TOOL_RAW, appa_runtime_api::CONTROL_TOOL),
        ] {
            let derived = derived(raw).unwrap_or_else(|refusal| panic!("{raw} maps: {refusal:?}"));
            assert_eq!(derived.canonical.as_str(), expected, "{raw}");
            assert!(!derived.spawn, "{raw}");
            assert_eq!(
                (adapter().spell)(&derived.canonical).as_deref(),
                Some(raw),
                "the inverse spells {expected} back as the name Archestra dispatches"
            );
        }
    }

    #[test]
    fn a_spelling_outside_the_grammar_is_refused() {
        for raw in [
            "",
            "github__",
            "with space",
            "github/get",
            "a__b__",
            "mcp:github/x",
        ] {
            let outcome = derived(raw);
            match raw {
                // An empty tool segment falls through to the host family, where the whole
                // spelling is one segment the grammar admits.
                "github__" | "a__b__" => assert!(outcome.is_ok(), "{raw:?}"),
                _ => assert!(
                    matches!(outcome, Err(ParseRefusal::Malformed { .. })),
                    "{raw:?} must be refused, got {outcome:?}"
                ),
            }
        }
    }

    /// A canonical id no Archestra spelling derives to has no Archestra spelling: the
    /// runtime names it canonically instead of inventing a name that dispatches elsewhere.
    #[test]
    fn a_canonical_id_outside_the_range_has_no_host_spelling() {
        for name in [
            "host/claude-code/Bash",
            "agent/kagent/log-analyst",
            "mcp/github/do__thing",
            "host/archestra/github__get_file_contents",
            "mcp/archestra/execute_remedy_plan",
        ] {
            let tool = CanonicalTool::parse(name).expect(name);
            assert_eq!((adapter().spell)(&tool), None, "{name}");
        }
    }

    #[test]
    fn no_call_names_children() {
        let actor = Actor {
            root: TrajectoryId("archestra:s1".into()),
            child: None,
        };
        let call = ProposedCall {
            tool: "github__get_file_contents".into(),
            arguments: serde_json::value::RawValue::from_string(
                r#"{"path":"tasks/a1.output"}"#.into(),
            )
            .unwrap(),
        };
        assert!((adapter().names_children)(&actor, &call).is_empty());
    }

    mod properties {
        use super::*;
        use proptest::prelude::*;

        fn segment() -> impl Strategy<Value = String> {
            "[A-Za-z0-9_.-]{1,12}"
        }

        proptest! {
            /// Every spelling in the grammar derives, and its spelling back is itself.
            #[test]
            fn derive_then_spell_is_the_identity(raw in "[A-Za-z0-9_.-]{1,24}") {
                let derived = derived(&raw).expect("in the grammar");
                prop_assert_eq!((adapter().spell)(&derived.canonical), Some(raw));
            }

            /// Every catalog tool the platform can install has the mcp identity of its parts.
            /// A tool starting with `_` is the one spelling the platform's own parser splits
            /// elsewhere (`a___a` is catalog `a_`), and this adapter follows that parser.
            #[test]
            fn a_catalog_tool_derives_to_its_parts(catalog in "[a-z0-9]([a-z0-9_-]*[a-z0-9])?", tool in segment()) {
                prop_assume!(!catalog.contains("__") && !tool.contains("__") && !tool.starts_with('_'));
                let raw = format!("{catalog}__{tool}");
                let derived = derived(&raw).expect("in the grammar");
                prop_assert_eq!(derived.canonical.as_str(), format!("mcp/{catalog}/{tool}"));
            }
        }
    }
}
