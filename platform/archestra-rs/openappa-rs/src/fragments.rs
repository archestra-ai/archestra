//! The approvers a variant line adds to the saved policy: stock `approve` authorities under
//! reserved names, computed from the composed policy as the engine reads it and checked
//! with it as one document, so the planner cap and every load check judge the whole line.
use crate::lines::Variant;
use appa_engine::{
    authority::{Attends, Authority},
    contract::{HistoryRequirement, ToolDeclaration},
    registry::Registry,
};
use appa_runtime::{
    api::Runtime,
    config::{Config, Implementation, IncludeResolution, source_registrations_of},
};
use std::collections::{BTreeMap, BTreeSet};

/// The Observe approver's name. A saved policy cannot declare it.
pub(crate) const OBSERVE_APPROVER: &str = "archestra-observe";
/// Every person approver's name starts with this. A saved policy cannot declare one.
const PERSON_APPROVER_PREFIX: &str = "archestra-person-approval-";
/// The tag that keeps a tool's trust, audience and history gaps out of every injected approver.
const ENFORCED_TAG: &str = "enforced";
const HITL_BUILTIN: &str = "hitl";
const APPROVE_BUILTIN: &str = "approve";

fn reserved(name: &str) -> bool {
    name == OBSERVE_APPROVER || name.starts_with(PERSON_APPROVER_PREFIX)
}

fn authority_entries(document: &toml::Table) -> &[toml::Value] {
    crate::policy::policy_entries(document, "authority")
}

/// Refuse a document that declares an authority under a name the host injects.
pub(crate) fn refuse_reserved_authorities(document: &toml::Table) -> Result<(), String> {
    match authority_entries(document)
        .iter()
        .filter_map(|entry| entry.get("name").and_then(toml::Value::as_str))
        .find(|name| reserved(name))
    {
        Some(name) => Err(format!(
            "authority {name:?} uses a name Archestra reserves for the approvers it adds"
        )),
        None => Ok(()),
    }
}

/// The document `variant`'s line serves: the saved composition with that variant's
/// approvers. An error says why the line cannot be served, and the caller serves the
/// saved composition instead.
pub(crate) fn compose(
    content: &str,
    variant: Variant,
    enforced_marks: &BTreeSet<String>,
) -> Result<String, String> {
    if variant == Variant::Enforce {
        return Ok(content.to_owned());
    }
    let mut document: toml::Table = toml::from_str(content).map_err(|error| error.to_string())?;
    refuse_reserved_authorities(&document)?;
    let read = Read::of(content, &document)?;
    let registry = read.policy.engine().registry();
    let approvers = match variant {
        Variant::Enforce => Vec::new(),
        Variant::Observe => vec![observe_approver(registry, enforced_marks)],
        Variant::EnforceApproved => {
            person_approvers(registry, &read.implementations, &document, enforced_marks)
        }
    };
    if approvers.is_empty() {
        return Ok(content.to_owned());
    }
    for approver in approvers {
        approver.insert_into(&mut document)?;
    }
    let composed = toml::to_string(&document).map_err(|error| error.to_string())?;
    let config = Config::hosted_included_deferred(&composed, crate::policy::defaults(), |_| {
        Err(IncludeResolution::Unknown)
    })
    .map_err(|error| error.to_string())?;
    Runtime::check_hosted(config, None, crate::adapter::adapter())
        .map_err(|error| error.to_string())?;
    Ok(composed)
}

/// The saved composition as the engine reads it, with each authority's implementation.
struct Read {
    policy: appa_policy::Config,
    implementations: BTreeMap<String, Implementation>,
}

impl Read {
    fn of(content: &str, document: &toml::Table) -> Result<Read, String> {
        let config = Config::hosted_included_deferred(content, crate::policy::defaults(), |_| {
            Err(IncludeResolution::Unknown)
        })
        .map_err(|error| error.to_string())?;
        let sources = source_registrations_of(&toml::Value::Table(document.clone()))
            .map_err(|error| error.to_string())?;
        let policy_text =
            toml::to_string(config.policy_file().value()).map_err(|error| error.to_string())?;
        let policy =
            appa_policy::Config::from_toml_str_routed(&policy_text, BTreeMap::new(), sources)
                .map_err(|error| error.to_string())?;
        Ok(Read {
            policy,
            implementations: config.externals.authorities,
        })
    }
}

/// One injected stock `approve` authority, as policy spells it.
#[derive(Debug, PartialEq)]
struct Approver {
    name: String,
    tags: Vec<String>,
    except_tags: Vec<String>,
    permits: toml::Table,
}

impl Approver {
    fn insert_into(self, document: &mut toml::Table) -> Result<(), String> {
        let mut authority = toml::Table::new();
        authority.insert("name".into(), self.name.clone().into());
        if !self.tags.is_empty() {
            authority.insert("tags".into(), self.tags.into());
        }
        if !self.except_tags.is_empty() {
            authority.insert("except_tags".into(), self.except_tags.into());
        }
        authority.insert("permits".into(), self.permits.into());
        table_entry(document, "policy")?
            .entry("authority")
            .or_insert_with(|| toml::Value::Array(Vec::new()))
            .as_array_mut()
            .ok_or("`policy.authority` is not a list")?
            .push(authority.into());
        let mut implementation = toml::Table::new();
        implementation.insert("builtin".into(), APPROVE_BUILTIN.into());
        let authorities = table_entry(table_entry(document, "externals")?, "authorities")?;
        authorities.insert(self.name, implementation.into());
        Ok(())
    }
}

fn table_entry<'a>(table: &'a mut toml::Table, key: &str) -> Result<&'a mut toml::Table, String> {
    table
        .entry(key)
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or_else(|| format!("`{key}` is not a table"))
}

fn strings<'a>(names: impl IntoIterator<Item = &'a str>) -> toml::Value {
    names
        .into_iter()
        .map(|name| toml::Value::String(name.to_owned()))
        .collect::<Vec<_>>()
        .into()
}

/// `["enforced"]` when some tool carries the tag; an exception nothing carries is noise.
fn enforced_exception(registry: &Registry) -> Vec<String> {
    let tagged = registry
        .tools()
        .any(|tool| tool.tags().iter().any(|tag| tag.as_str() == ENFORCED_TAG));
    match tagged {
        true => vec![ENFORCED_TAG.to_owned()],
        false => Vec::new(),
    }
}

/// The marks an injected approver may attend: the given ones, never `blocked` or an
/// enforced mark.
fn attendable<'a>(
    marks: impl IntoIterator<Item = &'a str>,
    enforced_marks: &'a BTreeSet<String>,
) -> BTreeSet<&'a str> {
    marks
        .into_iter()
        .filter(|mark| *mark != appa_engine::names::MarkName::BLOCKED)
        .filter(|mark| !enforced_marks.contains(*mark))
        .collect()
}

/// Every mark an authority's mandate attends, its catch-all expanded to the policy's marks.
fn attended<'a>(registry: &'a Registry, authority: &'a Authority) -> BTreeSet<&'a str> {
    match &authority.mandate.attends {
        Attends::Any => registry
            .attention_marks()
            .filter(|mark| !mark.is_blocked())
            .map(|mark| mark.as_str())
            .collect(),
        Attends::Named(marks) => marks.iter().map(|mark| mark.as_str()).collect(),
    }
}

/// Every effect kind the policy names: emitted, required before or after, or answered.
fn effect_kinds(registry: &Registry) -> BTreeSet<&str> {
    let tools = registry.tools().flat_map(|tool| match tool {
        ToolDeclaration::Declared(annotation) => annotation
            .emits
            .iter()
            .chain(
                annotation
                    .requires
                    .history
                    .iter()
                    .map(|requirement| match requirement {
                        HistoryRequirement::Prior(kind) | HistoryRequirement::NoPrior(kind) => kind,
                    }),
            )
            .map(|kind| kind.as_str())
            .collect::<Vec<_>>(),
        ToolDeclaration::Annotated { .. } => Vec::new(),
    });
    let annotators = registry
        .annotators()
        .flat_map(|(_, mandate)| mandate.effects().map(|kind| kind.as_str()));
    tools.chain(annotators).collect()
}

/// The Observe approver: trust and audience over everything, every `no_prior` waiver, and
/// every mark but `blocked` and the enforced ones. The `enforced` tag keeps its tools' trust,
/// audience and history gaps out; attention never reads tags.
fn observe_approver(registry: &Registry, enforced_marks: &BTreeSet<String>) -> Approver {
    let mut permits = toml::Table::new();
    if let Some(top) = registry.trust_chain().names().last() {
        permits.insert("trust_below".into(), top.into());
    }
    permits.insert("audience_missing".into(), strings(["public"]));
    let effects = effect_kinds(registry);
    if !effects.is_empty() {
        permits.insert("effects_containing".into(), strings(effects));
    }
    let marks = attendable(
        registry.attention_marks().map(|mark| mark.as_str()),
        enforced_marks,
    );
    if !marks.is_empty() {
        permits.insert("attention".into(), strings(marks));
    }
    Approver {
        name: OBSERVE_APPROVER.to_owned(),
        tags: Vec::new(),
        except_tags: enforced_exception(registry),
        permits,
    }
}

/// How an authority's ruling is reached.
#[derive(PartialEq)]
enum Route {
    /// It asks a person.
    Person,
    /// It is stock `approve`: its plans are applied without anyone.
    Stock,
    /// An agent or a service rules: a model, a command or an endpoint.
    Agent,
}

fn route(implementations: &BTreeMap<String, Implementation>, authority: &Authority) -> Route {
    match implementations.get(authority.name.as_str()) {
        Some(Implementation::Builtin(builtin)) if builtin == HITL_BUILTIN => Route::Person,
        Some(Implementation::Builtin(builtin)) if builtin == APPROVE_BUILTIN => Route::Stock,
        _ => Route::Agent,
    }
}

/// Whether some tool lies in both authorities' jurisdiction, ignoring their exceptions.
fn overlap(one: &Authority, other: &Authority) -> bool {
    one.scope.is_unscoped()
        || other.scope.is_unscoped()
        || one
            .scope
            .tags
            .iter()
            .any(|tag| other.scope.tags.contains(tag))
}

/// One person approver per person-asking authority, covering what only a person would have
/// been asked. Marks and waivers drop whatever an agent authority also covers. A trust or
/// audience permit is dropped whole when an overlapping agent authority declares one, since
/// a mandate cannot spell a ceiling with a floor: such gaps still ask a person (under-cover).
fn person_approvers(
    registry: &Registry,
    implementations: &BTreeMap<String, Implementation>,
    document: &toml::Table,
    enforced_marks: &BTreeSet<String>,
) -> Vec<Approver> {
    let authorities = registry.authorities();
    let agents: Vec<&Authority> = authorities
        .iter()
        .filter(|authority| route(implementations, authority) == Route::Agent)
        .collect();
    let agent_marks: BTreeSet<&str> = agents
        .iter()
        .flat_map(|agent| attended(registry, agent))
        .collect();
    let except = enforced_exception(registry);
    authorities
        .iter()
        .filter(|authority| route(implementations, authority) == Route::Person)
        .filter_map(|person| {
            let overlapping: Vec<&&Authority> = agents
                .iter()
                .filter(|agent| overlap(person, agent))
                .collect();
            let written = written_permits(document, person.name.as_str());
            let mut permits = toml::Table::new();
            let dimensions = [
                (
                    "trust_below",
                    person.mandate.trust_ceiling.is_some(),
                    overlapping
                        .iter()
                        .any(|agent| agent.mandate.trust_ceiling.is_some()),
                ),
                (
                    "audience_missing",
                    person.mandate.reader_ceiling.is_some(),
                    overlapping
                        .iter()
                        .any(|agent| agent.mandate.reader_ceiling.is_some()),
                ),
            ];
            for (key, declared, shared) in dimensions {
                if let (true, false, Some(value)) = (declared, shared, written.get(key)) {
                    permits.insert(key.into(), value.clone());
                }
            }
            let agent_waivers: BTreeSet<&str> = overlapping
                .iter()
                .flat_map(|agent| agent.mandate.waivers.iter().map(|kind| kind.as_str()))
                .collect();
            let waivers: BTreeSet<&str> = person
                .mandate
                .waivers
                .iter()
                .map(|kind| kind.as_str())
                .filter(|kind| !agent_waivers.contains(kind))
                .collect();
            if !waivers.is_empty() {
                permits.insert("effects_containing".into(), strings(waivers));
            }
            let marks: BTreeSet<&str> = attendable(attended(registry, person), enforced_marks)
                .into_iter()
                .filter(|mark| !agent_marks.contains(mark))
                .collect();
            if !marks.is_empty() {
                permits.insert("attention".into(), strings(marks));
            }
            if permits.is_empty() {
                return None;
            }
            let except_tags = person
                .except
                .iter()
                .map(|tag| tag.as_str().to_owned())
                .chain(except.iter().cloned())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            Some(Approver {
                name: format!("{PERSON_APPROVER_PREFIX}{}", person.name.as_str()),
                tags: person
                    .scope
                    .tags
                    .iter()
                    .map(|tag| tag.as_str().to_owned())
                    .collect(),
                except_tags,
                permits,
            })
        })
        .collect()
}

/// The `permits` table the document writes for the authority `name`.
fn written_permits(document: &toml::Table, name: &str) -> toml::Table {
    authority_entries(document)
        .iter()
        .find(|entry| entry.get("name").and_then(toml::Value::as_str) == Some(name))
        .and_then(|entry| entry.get("permits"))
        .and_then(toml::Value::as_table)
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HITL: &str = r#"[policy]
version = 2

[[policy.tool]]
name = "host/archestra/review"
delta = {}
requires = { attention = ["review"] }

[[policy.tool]]
name = "host/archestra/export"
delta = {}
requires = { attention = ["pii"], effects = { excludes = ["finance.spend"] } }

[[policy.tool]]
name = "host/archestra/wipe"
delta = {}
requires = { attention = ["blocked"] }

[[policy.tool]]
name = "host/archestra/pay"
delta = {}
effects = ["finance.spend"]
requires = { trust = "trusted" }

[[policy.authority]]
name = "human-approval"

[policy.authority.permits]
trust_below = "trusted"
audience_missing = ["public"]
attention = ["*"]

[externals.authorities.human-approval]
builtin = "hitl"
"#;

    fn enforced(marks: &[&str]) -> BTreeSet<String> {
        marks.iter().map(|mark| (*mark).to_owned()).collect()
    }

    fn composed(content: &str, variant: Variant, marks: &[&str]) -> toml::Table {
        let text = compose(content, variant, &enforced(marks)).expect("the line composes");
        toml::from_str(&text).expect("a composed line is TOML")
    }

    /// The authority `name` the composed document declares.
    fn authority(document: &toml::Table, name: &str) -> Option<toml::Table> {
        authority_entries(document)
            .iter()
            .find(|entry| entry.get("name").and_then(toml::Value::as_str) == Some(name))
            .and_then(toml::Value::as_table)
            .cloned()
    }

    fn list(table: &toml::Table, key: &str) -> Option<Vec<String>> {
        table
            .get(key)
            .and_then(toml::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
    }

    fn permits(authority: &toml::Table) -> toml::Table {
        authority
            .get("permits")
            .and_then(toml::Value::as_table)
            .cloned()
            .expect("an approver permits something")
    }

    fn implementation(document: &toml::Table, name: &str) -> Option<String> {
        document
            .get("externals")?
            .get("authorities")?
            .get(name)?
            .get("builtin")?
            .as_str()
            .map(str::to_owned)
    }

    #[test]
    fn the_enforce_line_serves_the_saved_document_unchanged() {
        assert_eq!(
            compose(HITL, Variant::Enforce, &enforced(&["pii"])).unwrap(),
            HITL
        );
    }

    #[test]
    fn the_observe_approver_attends_every_declared_mark_but_blocked_and_the_enforced_ones() {
        let document = composed(HITL, Variant::Observe, &["pii"]);
        let observe = authority(&document, OBSERVE_APPROVER).expect("the observe approver");
        let permits = permits(&observe);
        assert_eq!(list(&permits, "attention"), Some(vec!["review".to_owned()]));
        assert_eq!(
            permits.get("trust_below").and_then(toml::Value::as_str),
            Some("trusted")
        );
        assert_eq!(
            list(&permits, "audience_missing"),
            Some(vec!["public".to_owned()])
        );
        assert_eq!(
            list(&permits, "effects_containing"),
            Some(vec!["finance.spend".to_owned()])
        );
        assert_eq!(
            implementation(&document, OBSERVE_APPROVER).as_deref(),
            Some("approve")
        );
        assert_eq!(
            list(&observe, "except_tags"),
            None,
            "no tool carries the enforced tag"
        );
    }

    #[test]
    fn the_enforced_tag_is_excepted_only_when_some_tool_carries_it() {
        let tagged = HITL.replace(
            "name = \"host/archestra/pay\"\n",
            "name = \"host/archestra/pay\"\ntags = [\"enforced\"]\n",
        );
        let document = composed(&tagged, Variant::Observe, &[]);
        let observe = authority(&document, OBSERVE_APPROVER).expect("the observe approver");
        assert_eq!(
            list(&observe, "except_tags"),
            Some(vec!["enforced".to_owned()])
        );
        let document = composed(&tagged, Variant::EnforceApproved, &[]);
        let person = authority(&document, "archestra-person-approval-human-approval")
            .expect("the person approver");
        assert_eq!(
            list(&person, "except_tags"),
            Some(vec!["enforced".to_owned()])
        );
    }

    #[test]
    fn a_saved_policy_cannot_use_a_reserved_approver_name() {
        for name in [OBSERVE_APPROVER, "archestra-person-approval-x"] {
            let saved = HITL
                .replace("name = \"human-approval\"", &format!("name = \"{name}\""))
                .replace(
                    "authorities.human-approval]",
                    &format!("authorities.{name}]"),
                );
            assert!(
                crate::policy::validate_hosted(&saved).is_err(),
                "{name} is refused at save"
            );
            assert!(compose(&saved, Variant::Observe, &BTreeSet::new()).is_err());
        }
        assert!(crate::policy::validate_hosted(HITL).is_ok());
    }

    #[test]
    fn the_person_approver_covers_what_only_a_person_is_asked() {
        let with_agent = format!(
            "{HITL}\n[[policy.authority]]\nname = \"judge\"\n\n[policy.authority.permits]\ntrust_below = \"trusted\"\nattention = [\"review\"]\n\n[externals.authorities.judge]\nurl = \"https://judge.example/rule\"\n"
        );
        let document = composed(&with_agent, Variant::EnforceApproved, &["pii"]);
        assert!(authority(&document, OBSERVE_APPROVER).is_none());
        let person = authority(&document, "archestra-person-approval-human-approval")
            .expect("the person approver");
        let permits = permits(&person);
        assert_eq!(
            list(&permits, "attention"),
            None,
            "review routes to the judge too, pii is enforced, blocked is never attended"
        );
        assert!(
            permits.get("trust_below").is_none(),
            "the judge also vouches trust, so trust gaps keep asking a person"
        );
        assert_eq!(
            list(&permits, "audience_missing"),
            Some(vec!["public".to_owned()])
        );
        assert_eq!(
            implementation(&document, "archestra-person-approval-human-approval").as_deref(),
            Some("approve")
        );
    }

    #[test]
    fn without_a_person_asking_authority_the_approved_line_adds_nothing() {
        let none = HITL.replace("builtin = \"hitl\"", "builtin = \"approve\"");
        assert_eq!(
            compose(&none, Variant::EnforceApproved, &BTreeSet::new()).unwrap(),
            none
        );
    }

    #[test]
    fn a_line_over_the_planner_cap_does_not_compose() {
        let capped = |cap: u64| {
            HITL.replace(
                "[policy]\nversion = 2\n",
                &format!("[policy]\nversion = 2\n\n[policy.limits]\nplanner_cap = {cap}\n"),
            )
        };
        assert!(
            crate::policy::validate_hosted(&capped(1)).is_ok(),
            "the saved policy alone fits the cap"
        );
        assert!(
            compose(&capped(1), Variant::Observe, &BTreeSet::new()).is_err(),
            "a second competent authority exceeds the cap"
        );
        assert!(compose(&capped(2), Variant::Observe, &BTreeSet::new()).is_ok());
    }
}
