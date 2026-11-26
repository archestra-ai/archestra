//! The authority lines an organization's families follow. Each variant is a deployment
//! line of its own: a family opens on one and follows it for life, its children with
//! it, so a change to the Guardrails settings moves only families that open after it.
//! Peers pair only within one line, which keeps unattended sessions with the person
//! approver apart from attended ones.
use appa_eventlog::{DeploymentName, Fact, Log};
use appa_runtime_api::{AutoApply, LineVariant, SessionSettings};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, LazyLock, Mutex, PoisonError},
};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum GuardrailsMode {
    Observe,
    Enforce,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PersonApproval {
    Ask,
    AutoUnattended,
    AutoEverywhere,
}

/// The Guardrails settings a dispatch is decided under, as the host resolved them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Guardrails {
    pub mode: GuardrailsMode,
    pub person_approval: PersonApproval,
    /// Marks the injected approvers never attend.
    pub enforced_marks: Arc<BTreeSet<String>>,
}

impl Guardrails {
    pub(crate) fn parse(
        mode: &str,
        person_approval: &str,
        enforced_marks: Vec<String>,
    ) -> Result<Guardrails, String> {
        let mode = match mode {
            "observe" => GuardrailsMode::Observe,
            "enforce" => GuardrailsMode::Enforce,
            other => return Err(format!("unknown Guardrails mode {other:?}")),
        };
        let person_approval = match person_approval {
            "ask" => PersonApproval::Ask,
            "auto_unattended" => PersonApproval::AutoUnattended,
            "auto_everywhere" => PersonApproval::AutoEverywhere,
            other => return Err(format!("unknown person approval {other:?}")),
        };
        Ok(Guardrails {
            mode,
            person_approval,
            enforced_marks: Arc::new(enforced_marks.into_iter().collect()),
        })
    }

    /// Enforce, asking a person, with no enforced marks.
    pub(crate) fn enforce() -> Guardrails {
        Guardrails {
            mode: GuardrailsMode::Enforce,
            person_approval: PersonApproval::Ask,
            enforced_marks: Arc::default(),
        }
    }

    /// The variant a session opening now takes. `unattended`: the session is
    /// authenticated by an Agent Runtime credential.
    pub(crate) fn opening(&self, unattended: bool) -> Variant {
        match (self.mode, self.person_approval, unattended) {
            (GuardrailsMode::Observe, _, _) => Variant::Observe,
            (GuardrailsMode::Enforce, PersonApproval::AutoEverywhere, _)
            | (GuardrailsMode::Enforce, PersonApproval::AutoUnattended, true) => {
                Variant::EnforceApproved
            }
            (GuardrailsMode::Enforce, PersonApproval::Ask, _)
            | (GuardrailsMode::Enforce, PersonApproval::AutoUnattended, false) => Variant::Enforce,
        }
    }
}

/// One authority line of an organization.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Variant {
    /// The saved policy alone. Its line keeps the organization's id, so every family
    /// opened before lines had variants follows it still.
    Enforce,
    /// The saved policy with the Observe approver.
    Observe,
    /// The saved policy with the person approvers.
    EnforceApproved,
}

pub(crate) const VARIANTS: [Variant; 3] =
    [Variant::Enforce, Variant::Observe, Variant::EnforceApproved];

/// The token suffix of a family an Agent Runtime credential opened.
const UNATTENDED_SUFFIX: &str = "-unattended";

/// Each variant's token as a session pins it, attended then unattended. The tokens are
/// constant spellings of the `LineVariant` grammar, which a test pins.
static TOKENS: LazyLock<[[LineVariant; 2]; 3]> = LazyLock::new(|| {
    VARIANTS.map(|variant| {
        [
            variant.token().to_owned(),
            format!("{}{UNATTENDED_SUFFIX}", variant.token()),
        ]
        .map(|token| LineVariant::parse(&token).expect("a variant token is a line variant"))
    })
});

/// Who presents an operation on a family, as the host authenticated the request.
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Presenter {
    /// An Agent Runtime credential; a root it opens is unattended.
    Runtime,
    /// A request holding no runtime or delegated binding.
    Attended,
    /// A binding the host signed into one family: a spawned child, a peer proof.
    Delegated,
    /// A host path that cannot tell who presents it; it opens attended roots.
    Unknown,
    /// The host reading for a person who rules on a family's offers, never acting in it.
    Reviewer,
}

impl Presenter {
    pub(crate) fn opens_unattended(self) -> bool {
        self == Presenter::Runtime
    }

    /// Refuses the reviewer, who only reads offer reviews, on any other operation:
    /// each of them may prepare or publish a deployment.
    pub(crate) fn beyond_review(self) -> napi::Result<Presenter> {
        match self {
            Presenter::Reviewer => Err(crate::errors::invalid_input(
                "a reviewer only reads a family's offer reviews",
            )),
            presenter => Ok(presenter),
        }
    }

    /// The presenter a host spells across NAPI.
    pub(crate) fn parse(token: &str) -> napi::Result<Presenter> {
        serde_json::from_value(serde_json::Value::String(token.to_owned()))
            .map_err(|_| crate::errors::invalid_input(format!("unknown presenter {token:?}")))
    }
}

impl Variant {
    pub(crate) fn token(self) -> &'static str {
        match self {
            Variant::Enforce => "enforce",
            Variant::Observe => "observe",
            Variant::EnforceApproved => "enforce-approved",
        }
    }

    fn index(self) -> usize {
        match self {
            Variant::Enforce => 0,
            Variant::Observe => 1,
            Variant::EnforceApproved => 2,
        }
    }

    pub(crate) fn line(self, organization_id: &str) -> DeploymentName {
        match self {
            Variant::Enforce => DeploymentName::new(organization_id),
            variant => DeploymentName::new(format!("{organization_id}/{}", variant.token())),
        }
    }

    /// What a family opening on this line pins: its token, which also records an
    /// unattended opener, and Observe's auto-accepted narrowing.
    pub(crate) fn settings(self, unattended: bool) -> SessionSettings {
        SessionSettings {
            auto_apply: match self {
                Variant::Observe => AutoApply::RulingsAndAccept,
                Variant::Enforce | Variant::EnforceApproved => AutoApply::RulingsOnly,
            },
            line_variant: Some(TOKENS[self.index()][usize::from(unattended)].clone()),
        }
    }
}

/// One deployment line: an organization's variant.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) struct Line {
    pub organization_id: String,
    pub variant: Variant,
}

impl Line {
    pub(crate) fn name(&self) -> DeploymentName {
        self.variant.line(&self.organization_id)
    }
}

/// The line a family follows, and the settings it pinned when it opened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Family {
    pub variant: Variant,
    pub settings: SessionSettings,
}

impl Family {
    /// A family about to open on `variant`.
    pub(crate) fn opening(variant: Variant, unattended: bool) -> Family {
        Family {
            variant,
            settings: variant.settings(unattended),
        }
    }

    /// Whether an Agent Runtime credential opened the family.
    pub(crate) fn unattended(&self) -> bool {
        self.settings
            .line_variant
            .as_ref()
            .is_some_and(|token| TOKENS.iter().any(|[_, unattended]| unattended == token))
    }

    /// Whether `presenter` may act in the family: an unattended one only by its run, a
    /// binding the host signed into it, or a reviewer reading its offers, so no other
    /// request borrows the run's approvals or state.
    pub(crate) fn continued_by(&self, presenter: Presenter) -> bool {
        !self.unattended()
            || matches!(
                presenter,
                Presenter::Runtime | Presenter::Delegated | Presenter::Reviewer
            )
    }

    /// The family `log` records, or `None` when it follows a line that is none of this
    /// organization's.
    pub(crate) fn of_log(organization_id: &str, log: &Log) -> Option<Family> {
        let variant = VARIANTS
            .into_iter()
            .find(|variant| variant.line(organization_id) == *log.deployment())?;
        let settings = match log.facts().first() {
            Some(Fact::TrajectoryOpened(opening)) => opening.settings.clone(),
            _ => SessionSettings::default(),
        };
        Some(Family { variant, settings })
    }
}

/// The families this process has routed, by organization and root. A family's line and
/// settings never change once it opened, so an entry is never stale; a new family
/// past the bound replaces an arbitrary one, which is read again from its log.
#[derive(Default)]
pub(crate) struct Families(Mutex<HashMap<(String, String), Family>>);

const FAMILIES_HELD: usize = 65_536;

impl Families {
    pub(crate) fn get(&self, organization_id: &str, root: &str) -> Option<Family> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&(organization_id.to_owned(), root.to_owned()))
            .cloned()
    }

    pub(crate) fn remember(&self, organization_id: &str, root: &str, family: &Family) {
        let mut held = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let key = (organization_id.to_owned(), root.to_owned());
        if held.len() >= FAMILIES_HELD
            && !held.contains_key(&key)
            && let Some(evicted) = held.keys().next().cloned()
        {
            held.remove(&evicted);
        }
        held.insert(key, family.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guardrails(mode: &str, approval: &str) -> Guardrails {
        Guardrails::parse(mode, approval, Vec::new()).expect("known settings")
    }

    #[test]
    fn every_variant_token_is_a_line_variant_and_records_its_opener() {
        for variant in VARIANTS {
            assert_eq!(
                variant.settings(false).line_variant,
                Some(LineVariant::parse(variant.token()).expect("a variant token"))
            );
            for unattended in [false, true] {
                assert_eq!(
                    Family::opening(variant, unattended).unattended(),
                    unattended
                );
            }
        }
    }

    #[test]
    fn an_unattended_family_is_continued_only_by_its_run_or_a_binding_into_it() {
        let runtime = Family::opening(Variant::EnforceApproved, true);
        assert!(!runtime.continued_by(Presenter::Attended));
        assert!(runtime.continued_by(Presenter::Runtime));
        assert!(!runtime.continued_by(Presenter::Unknown));
        assert!(runtime.continued_by(Presenter::Delegated));
        assert!(runtime.continued_by(Presenter::Reviewer));
        assert!(Presenter::Reviewer.beyond_review().is_err());
        let attended = Family::opening(Variant::EnforceApproved, false);
        assert!(attended.continued_by(Presenter::Attended));
        assert!(attended.continued_by(Presenter::Unknown));
        let legacy = Family {
            variant: Variant::Enforce,
            settings: SessionSettings::default(),
        };
        assert!(legacy.continued_by(Presenter::Attended));
    }

    #[test]
    fn observe_auto_accepts_and_enforce_applies_rulings_only() {
        assert_eq!(
            Variant::Observe.settings(false).auto_apply,
            AutoApply::RulingsAndAccept
        );
        assert_eq!(
            Variant::Enforce.settings(false).auto_apply,
            AutoApply::RulingsOnly
        );
        assert_eq!(
            Variant::EnforceApproved.settings(true).auto_apply,
            AutoApply::RulingsOnly
        );
    }

    #[test]
    fn the_person_approver_reaches_unattended_sessions_only_under_auto_unattended() {
        let cases = [
            ("observe", "auto_everywhere", false, Variant::Observe),
            ("observe", "auto_unattended", true, Variant::Observe),
            ("enforce", "ask", true, Variant::Enforce),
            ("enforce", "auto_unattended", false, Variant::Enforce),
            ("enforce", "auto_unattended", true, Variant::EnforceApproved),
            (
                "enforce",
                "auto_everywhere",
                false,
                Variant::EnforceApproved,
            ),
            ("enforce", "auto_everywhere", true, Variant::EnforceApproved),
        ];
        for (mode, approval, unattended, expected) in cases {
            assert_eq!(
                guardrails(mode, approval).opening(unattended),
                expected,
                "{mode} {approval} unattended={unattended}"
            );
        }
    }

    #[test]
    fn each_variant_is_its_own_line_and_enforce_keeps_the_organization_id() {
        assert_eq!(Variant::Enforce.line("org").as_str(), "org");
        let lines: BTreeSet<String> = VARIANTS
            .into_iter()
            .map(|variant| variant.line("org").as_str().to_owned())
            .collect();
        assert_eq!(lines.len(), VARIANTS.len());
    }

    #[test]
    fn unknown_settings_are_refused() {
        assert!(Guardrails::parse("off", "ask", Vec::new()).is_err());
        assert!(Guardrails::parse("enforce", "block", Vec::new()).is_err());
    }
}
