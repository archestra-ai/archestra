//! One published deployment per organization, pinned to each of its dispatches.
//!
//! The runtime is shared by every organization, so no dispatch reloads it: each one
//! runs through a view pinned to its organization's deployment line, which its
//! consults, decisions and new roots read whatever another organization dispatches
//! meanwhile. An organization has one line per [`Variant`]; its Enforce line is named
//! by its id. A deployment is compiled
//! from the organization's effective policy with the credential values the host
//! resolved for it, published as the head of that line, and reused while both still
//! answer the same: a new policy, or a rotated, removed or rebound credential,
//! prepares a new one in its place. Bytes the head already names publish no new
//! revision, so a rotated credential and every process serving the same policy
//! share one revision.
//!
//! Every open conversation of an organization decides its next event under the
//! line's head. A process follows a publish it made itself; one another process
//! made surfaces as a retryable refusal until this process pins the new head
//! ([`Deployments::repin`]).
use appa_engine::profile::PolicyRevision;
use appa_eventlog::{DeploymentName, LogStore, PolicyHead};
use appa_runtime::api::{OpenError, PreparedDeployment, PublishedDeployment, Runtime};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, Mutex, PoisonError},
};

use crate::{
    errors::{BindingFailure, Fault},
    lines::Variant,
    lines::{Families, Guardrails, Line},
    policy::open_fault,
};

/// The credential values the host resolved for one organization's policy, variable →
/// value. Secrets: nothing here is logged or formatted.
#[derive(Clone, Default)]
pub(crate) struct HostCredentials(BTreeMap<String, String>);

impl HostCredentials {
    pub(crate) fn new(values: impl IntoIterator<Item = (String, String)>) -> Self {
        Self(values.into_iter().collect())
    }

    /// The value a hosted document's `token_env` names. The host's own variables come
    /// from this process's environment alone, and an organization's value never
    /// stands in for one. Any other variable is the organization's value, or absent.
    pub(crate) fn lookup(&self, var: &str) -> Option<String> {
        if var.starts_with(crate::policy::HOST_VARIABLE_PREFIX) {
            return std::env::var(var).ok();
        }
        self.0.get(var).cloned()
    }
}

/// An organization's effective policy as one dispatch carries it.
#[derive(Clone)]
pub(crate) struct HostedPolicy {
    pub content: String,
    pub credentials: HostCredentials,
    /// The content hash of the stored composition `content` was read from, when the
    /// host read it from one.
    pub composition: Option<String>,
    pub guardrails: Guardrails,
}

/// Why no deployment serves a dispatch.
pub(crate) enum DeploymentError {
    /// The dispatch carries a policy the organization has since recomposed, and the
    /// line's head names another one: publishing it would roll the line back.
    Superseded,
    /// The dispatch carries other bytes under the composition the held deployment
    /// was prepared from. One composition spells one document, so publishing them
    /// would only move the line's head and void every live offer of the organization.
    Diverged,
    Failed(Fault),
}

impl From<Fault> for DeploymentError {
    fn from(fault: Fault) -> Self {
        DeploymentError::Failed(fault)
    }
}

fn storage(error: impl ToString) -> Fault {
    Fault::binding(BindingFailure::Storage, error)
}

fn panicked(error: tokio::task::JoinError) -> Fault {
    Fault::binding(BindingFailure::Panicked, error)
}

/// The deployment an organization's dispatches are pinned to, and what it was
/// compiled from.
#[derive(Clone)]
struct Pinned {
    /// The saved composition the line's document was composed from.
    content: Arc<str>,
    /// The marks the line's approvers were composed to leave alone.
    enforced_marks: Arc<BTreeSet<String>>,
    /// Why the line serves the saved composition without its approvers. Only roots opening
    /// later move to Enforce; a family already on the line keeps it, now without approvers.
    fallback: Option<Arc<str>>,
    /// The composition hash `content` was read under, when the host named one.
    composition: Option<Arc<str>>,
    /// Every variable the compilation looked up, in order.
    variables: Arc<[String]>,
    /// The digest of what each of `variables` resolved to.
    answers: [u8; 32],
    /// The key of the policy file it publishes: the SHA-256 of its bytes, lowercase
    /// hex, as the event log keys a stored policy file.
    key: Arc<str>,
    prepared: PreparedDeployment,
    published: PublishedDeployment,
}

impl Pinned {
    /// Whether `policy` compiles to this deployment: the same document, and the same
    /// answer for every variable it looked up.
    /// Whether this is the very entry `other` was cloned from: a held `Pinned` reaches
    /// callers only through `Clone`, sharing its content allocation.
    fn is(&self, other: &Pinned) -> bool {
        self.published.revision() == other.published.revision()
            && Arc::ptr_eq(&self.content, &other.content)
    }

    /// Whether this deployment of `variant`'s line serves `policy`. The Enforce line
    /// composes no approvers, so the enforced marks do not change what it serves.
    fn serves(&self, variant: Variant, policy: &HostedPolicy) -> bool {
        *self.content == *policy.content
            && (variant == Variant::Enforce
                || self.enforced_marks == policy.guardrails.enforced_marks)
            && answers_digest(
                self.variables
                    .iter()
                    .map(|var| (var.as_str(), policy.credentials.lookup(var))),
            ) == self.answers
    }
}

struct CompiledPolicy {
    config: appa_runtime::config::Config,
    variables: Arc<[String]>,
    answers: [u8; 32],
}

/// The latest deployment of every line that dispatched: one per organization and
/// variant. Only a line's latest policy is served, so an entry is replaced when that
/// policy or its credentials change. Entries live for this process's lifetime.
#[derive(Default)]
pub(crate) struct Deployments {
    by_line: Mutex<HashMap<Line, Pinned>>,
    /// One preparation at a time per line: concurrent dispatches that miss wait for
    /// the one preparing and then reuse its deployment.
    preparing: Mutex<HashMap<Line, Arc<tokio::sync::Mutex<()>>>>,
    pub(crate) families: Families,
}

impl Deployments {
    /// The deployment `runtime` serves `policy` from for this organization, prepared
    /// and published now when the one held for it no longer compiles from the same
    /// inputs.
    ///
    /// A policy the head does not name is published only while it is still the
    /// organization's stored composition: a dispatch that read the policy before a
    /// save and reaches here after another dispatch published the saved one must not
    /// publish the text from before the save over it.
    ///
    /// Preparing, reading the line's head and publishing are synchronous, and the
    /// head read and the publish are PostgreSQL round trips, so a miss runs them on
    /// a blocking thread; a hit returns without leaving the async thread.
    pub(crate) async fn deployment(
        &self,
        runtime: &Arc<Runtime>,
        store: &Arc<LogStore>,
        line: &Line,
        policy: &HostedPolicy,
        agent_yell: bool,
    ) -> Result<PublishedDeployment, DeploymentError> {
        Ok(self
            .pinned(runtime, store, line, policy, agent_yell)
            .await?
            .published)
    }

    /// Whether `line` serves the saved composition without its approvers, which a new
    /// session meant for it takes as the reason to open on the Enforce line instead.
    pub(crate) async fn falls_back(
        &self,
        runtime: &Arc<Runtime>,
        store: &Arc<LogStore>,
        line: &Line,
        policy: &HostedPolicy,
        agent_yell: bool,
    ) -> Result<bool, DeploymentError> {
        Ok(self
            .pinned(runtime, store, line, policy, agent_yell)
            .await?
            .fallback
            .is_some())
    }

    /// After a dispatch pinned to `stale` found that its line moved on: the
    /// organization's deployment pinned at the line's head when the head names the
    /// same policy file, or `None` when it names another one or a concurrent
    /// dispatch left no held deployment for the organization.
    ///
    /// Only the same file is pinned again. Another file at the head was published
    /// by a process that read the organization's policy after this dispatch did, so
    /// this process forgets its deployment instead of publishing its own bytes over
    /// that head; the host's retry reads the policy again and publishes from that.
    ///
    /// The head and stored revision reads are synchronous PostgreSQL round trips,
    /// so they run on a blocking thread. Pinning never publishes.
    pub(crate) async fn repin(
        &self,
        runtime: &Arc<Runtime>,
        store: &Arc<LogStore>,
        line: &Line,
        policy: &HostedPolicy,
        stale: &PublishedDeployment,
    ) -> Result<Option<PublishedDeployment>, Fault> {
        // Only a deployment prepared from this dispatch's own policy and credentials,
        // never another dispatch's at the same revision.
        let Some(pinned) = self
            .serving(line, policy)
            .filter(|pinned| pinned.published.revision() == stale.revision())
        else {
            // A concurrent dispatch already moved this line's deployment on, which this
            // dispatch takes only when it serves the same policy.
            return Ok(self.serving(line, policy).map(|pinned| pinned.published));
        };
        let (runtime, store) = (runtime.clone(), store.clone());
        let name = line.name();
        let (key, prepared) = (pinned.key.clone(), pinned.prepared.clone());
        let head = tokio::task::spawn_blocking(move || -> Result<_, Fault> {
            let Some(head) = store.head(&name).map_err(storage)? else {
                return Ok(None);
            };
            if head.key.as_str() != &*key {
                return Ok(None);
            }
            pin_existing(&runtime, &name, &prepared, &head).map(Some)
        })
        .await
        .map_err(panicked)??;
        let Some(published) = head else {
            self.forget(line, &pinned);
            return Ok(None);
        };
        let mut held = self.by_line.lock().unwrap_or_else(PoisonError::into_inner);
        // Another dispatch replaced the entry during the read: its deployment stands.
        if !held.get(line).is_some_and(|current| current.is(&pinned)) {
            return Ok(None);
        }
        held.insert(
            line.clone(),
            Pinned {
                published: published.clone(),
                ..pinned
            },
        );
        Ok(Some(published))
    }

    async fn pinned(
        &self,
        runtime: &Arc<Runtime>,
        store: &Arc<LogStore>,
        line: &Line,
        policy: &HostedPolicy,
        agent_yell: bool,
    ) -> Result<Pinned, DeploymentError> {
        if let Some(pinned) = self.serving(line, policy) {
            return Ok(pinned);
        }
        let gate = self
            .preparing
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(line.clone())
            .or_default()
            .clone();
        let _preparing = gate.lock().await;
        if let Some(pinned) = self.serving(line, policy) {
            return Ok(pinned);
        }
        if let Some(held) = self.held(line)
            && let Some(composition) = &policy.composition
            && held.composition.as_deref() == Some(composition.as_str())
            && *held.content != *policy.content
        {
            eprintln!(
                "OpenAPPA: line {} dispatched a second policy document under composition {composition}; refusing to publish it",
                line.name()
            );
            return Err(DeploymentError::Diverged);
        }
        let (runtime, store) = (runtime.clone(), store.clone());
        let (owned, policy) = (line.clone(), policy.clone());
        let pinned = tokio::task::spawn_blocking(move || {
            prepare(&runtime, &store, &owned, &policy, agent_yell)
        })
        .await
        .map_err(panicked)??;
        self.by_line
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(line.clone(), pinned.clone());
        Ok(pinned)
    }

    /// The deployment held for this line when it still serves `policy`.
    fn serving(&self, line: &Line, policy: &HostedPolicy) -> Option<Pinned> {
        self.held(line)
            .filter(|pinned| pinned.serves(line.variant, policy))
    }

    /// Drop the line's deployment when it is still `pinned`, so the next
    /// dispatch prepares and publishes from the policy it carries.
    /// A held `Pinned` reaches callers only through `Clone`, sharing its content
    /// allocation. Pointer identity distinguishes that entry from a replacement
    /// with equal text, so an older dispatch cannot evict the replacement.
    fn forget(&self, line: &Line, pinned: &Pinned) {
        let mut held = self.by_line.lock().unwrap_or_else(PoisonError::into_inner);
        if held.get(line).is_some_and(|current| current.is(pinned)) {
            held.remove(line);
        }
    }

    fn held(&self, line: &Line) -> Option<Pinned> {
        self.by_line
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(line)
            .cloned()
    }
}

/// Compiles `policy` with the credential values it looks up, prepares it, and
/// publishes it as the head of the organization's line. Synchronous: the head read
/// and the publish are PostgreSQL round trips, so callers run it on a blocking
/// thread.
fn prepare(
    runtime: &Arc<Runtime>,
    store: &LogStore,
    line: &Line,
    policy: &HostedPolicy,
    agent_yell: bool,
) -> Result<Pinned, DeploymentError> {
    let document: toml::Table = toml::from_str(&policy.content)
        .map_err(|error| Fault::binding(BindingFailure::InvalidInput, error))?;
    crate::fragments::refuse_reserved_authorities(&document)
        .map_err(|error| Fault::binding(BindingFailure::InvalidInput, error))?;
    let served = crate::fragments::compose(
        &policy.content,
        line.variant,
        &policy.guardrails.enforced_marks,
    );
    let fallback = served
        .as_ref()
        .err()
        .map(|reason| Arc::<str>::from(reason.as_str()));
    if let Some(reason) = &fallback {
        eprintln!(
            "OpenAPPA: line {} serves the saved policy alone, and new sessions open on the Enforce line: {reason}",
            line.name()
        );
    }
    let CompiledPolicy {
        mut config,
        variables,
        answers,
    } = compiled(
        served.as_deref().unwrap_or(&policy.content),
        &policy.credentials,
    )?;
    config.reporting.agent_yell = agent_yell;
    let key = policy_file_key(config.policy_file().bytes());
    let prepared = runtime.prepare_deployment(config).map_err(open_fault)?;
    let name = line.name();
    let head = store.head(&name).map_err(storage)?;
    let published = match head {
        // The head already serves this file: pinning it advances nothing.
        Some(head) if head.key.as_str() == key => pin_existing(runtime, &name, &prepared, &head)?,
        head => {
            if let Some(composition) = &policy.composition
                && !stored_composition(store, &line.organization_id, composition)?
            {
                return Err(DeploymentError::Superseded);
            }
            let expected = head.map(|head| head.revision);
            // A line with approvers is also composed from the enforced marks, so it
            // publishes under the settings row's lock, which a settings write waits on,
            // and only while the stored marks are the ones it was composed from.
            match (&policy.composition, line.variant) {
                (Some(_), Variant::Observe | Variant::EnforceApproved) => publish_under_marks(
                    runtime,
                    store,
                    &name,
                    &prepared,
                    expected,
                    &policy.guardrails.enforced_marks,
                )?,
                _ => publish(runtime, &name, &prepared, expected),
            }?
        }
    };
    let pinned = Pinned {
        content: policy.content.as_str().into(),
        enforced_marks: policy.guardrails.enforced_marks.clone(),
        fallback,
        composition: policy.composition.as_deref().map(Into::into),
        answers,
        variables,
        key: key.into(),
        prepared,
        published,
    };
    Ok(pinned)
}

fn pin_existing(
    runtime: &Runtime,
    line: &DeploymentName,
    prepared: &PreparedDeployment,
    head: &PolicyHead,
) -> Result<PublishedDeployment, Fault> {
    runtime
        .at_revision(line, prepared, head.revision)
        .map_err(open_fault)
}

/// `content` compiled with the credential values it looks up, every variable it
/// looked up in order, and the digest of their answers.
fn compiled(content: &str, credentials: &HostCredentials) -> Result<CompiledPolicy, Fault> {
    let asked = RefCell::new(Vec::<(String, Option<String>)>::new());
    let config = crate::policy::compile(content, |var| {
        let answer = credentials.lookup(var);
        asked.borrow_mut().push((var.to_owned(), answer.clone()));
        answer
    })?;
    let asked = asked.into_inner();
    let answers = answers_digest(
        asked
            .iter()
            .map(|(var, answer)| (var.as_str(), answer.clone())),
    );
    Ok(CompiledPolicy {
        config,
        variables: asked.into_iter().map(|(var, _)| var).collect(),
        answers,
    })
}

/// Whether `composition` is the content hash of the organization's stored
/// composition. An organization with none stored has nothing newer to protect.
/// The host schema is in `backend/src/database/schemas/openappa-batteries.ts`
/// (`openappaEffectivePoliciesTable`).
fn stored_composition(
    store: &LogStore,
    organization_id: &str,
    composition: &str,
) -> Result<bool, Fault> {
    let organization_id = organization_id.to_owned();
    let stored = crate::Sql(store).with_client(move |client| {
        Ok(client
            .query_opt(
                "SELECT content_hash FROM openappa_effective_policies WHERE organization_id = $1",
                &[&organization_id],
            )?
            .map(|row| row.get::<_, String>(0)))
    })?;
    Ok(stored.is_none_or(|stored| stored == composition))
}

fn publish(
    runtime: &Runtime,
    name: &DeploymentName,
    prepared: &PreparedDeployment,
    expected: Option<PolicyRevision>,
) -> Result<PublishedDeployment, DeploymentError> {
    runtime
        .publish_if_head(name, prepared, expected)
        .map_err(|error| match error {
            OpenError::PolicyHeadMoved { .. } => DeploymentError::Superseded,
            error => DeploymentError::Failed(open_fault(error)),
        })
}

/// Publishes holding a share lock on the Guardrails settings row, and only while its
/// enforced marks are `enforced_marks`: a settings write then lands before or after
/// the publish, never between the check and it.
fn publish_under_marks(
    runtime: &Arc<Runtime>,
    store: &LogStore,
    name: &DeploymentName,
    prepared: &PreparedDeployment,
    expected: Option<PolicyRevision>,
    enforced_marks: &BTreeSet<String>,
) -> Result<Result<PublishedDeployment, DeploymentError>, Fault> {
    let (runtime, name, prepared, marks) = (
        runtime.clone(),
        name.clone(),
        prepared.clone(),
        enforced_marks.clone(),
    );
    Ok(crate::Sql(store).with_client(move |client| {
        let mut settings = client.transaction()?;
        let stored: BTreeSet<String> = settings
            .query_opt(
                "SELECT enforced_marks FROM guardrails_deployment LIMIT 1 FOR SHARE",
                &[],
            )?
            .and_then(|row| row.get::<_, Option<Vec<String>>>(0))
            .unwrap_or_default()
            .into_iter()
            .collect();
        if stored != marks {
            return Ok(Err(DeploymentError::Superseded));
        }
        let published = publish(&runtime, &name, &prepared, expected);
        settings.commit()?;
        Ok(published)
    })?)
}

/// The key the event log stores a policy file under: the SHA-256 of its exact bytes,
/// lowercase hex.
fn policy_file_key(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A digest over each looked-up variable and its answer, lengths included, so no two
/// sequences of answers share one.
fn answers_digest<'a>(answers: impl Iterator<Item = (&'a str, Option<String>)>) -> [u8; 32] {
    let mut digest = Sha256::new();
    for (var, answer) in answers {
        digest.update((var.len() as u64).to_be_bytes());
        digest.update(var.as_bytes());
        match answer {
            Some(value) => {
                digest.update([1]);
                digest.update((value.len() as u64).to_be_bytes());
                digest.update(value.as_bytes());
            }
            None => digest.update([0]),
        }
    }
    digest.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lines::{Family, Presenter, Variant};
    use appa_eventlog::{Backend, LogStore};
    use appa_runtime::hooks;
    use appa_runtime_api::{
        Actor, HookDecision, HookEvent, ProposedCall, RefusalClass, SessionSettings, TrajectoryId,
    };

    const KEY: &str = "APPA_OPENAPPA_RS_TEST_JEV_KEY";
    const JEV: &str = "[policy]\nversion = 2\n[[policy.annotator]]\nname = \"jev.tool-call\"\nbuiltin = \"jev\"\nranks = [\"suspicious\", \"trusted\"]\naudiences = [\"self\", \"internal\"]\nmarks = []\n[externals.jev]\ntoken_env = \"APPA_OPENAPPA_RS_TEST_JEV_KEY\"\n";

    #[derive(Clone)]
    struct TestRuntime {
        runtime: Arc<Runtime>,
        store: Arc<LogStore>,
    }

    impl std::ops::Deref for TestRuntime {
        type Target = Arc<Runtime>;

        fn deref(&self) -> &Self::Target {
            &self.runtime
        }
    }

    fn runtime() -> TestRuntime {
        on_store(Arc::new(LogStore::open(Backend::Memory).unwrap()))
    }

    /// A runtime over `store`: two of them over one store are two processes sharing
    /// one database.
    fn on_store(store: Arc<LogStore>) -> TestRuntime {
        let config = crate::policy::compile("[policy]\nversion = 2\n", |_| None).unwrap();
        TestRuntime {
            runtime: Arc::new(crate::policy::open(config, store.clone()).unwrap()),
            store,
        }
    }

    /// Runs `future` to completion on a runtime of its own, as a dispatch would.
    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn policy(content: &str, key: Option<&str>) -> HostedPolicy {
        HostedPolicy {
            content: content.to_owned(),
            credentials: HostCredentials::new(key.map(|key| (KEY.to_owned(), key.to_owned()))),
            composition: None,
            guardrails: Guardrails::enforce(),
        }
    }

    /// The organization's Enforce line, which every family opened before variants follows.
    fn enforce(organization: &str) -> Line {
        Line {
            organization_id: organization.to_owned(),
            variant: crate::lines::Variant::Enforce,
        }
    }

    /// Serves `policy` for `organization` and answers whether that prepared a
    /// deployment rather than reusing the one held.
    fn prepares(
        deployments: &Deployments,
        runtime: &TestRuntime,
        organization: &str,
        policy: &HostedPolicy,
    ) -> bool {
        let before = deployments.held(&enforce(organization));
        serve(deployments, runtime, organization, policy).expect("the policy compiles");
        let after = deployments
            .held(&enforce(organization))
            .expect("a deployment is held");
        before.is_none_or(|before| !Arc::ptr_eq(&before.content, &after.content))
    }

    fn serve(
        deployments: &Deployments,
        runtime: &TestRuntime,
        organization: &str,
        policy: &HostedPolicy,
    ) -> Result<PublishedDeployment, String> {
        block_on(deployments.deployment(
            runtime,
            &runtime.store,
            &enforce(organization),
            policy,
            false,
        ))
        .map_err(|error| match error {
            DeploymentError::Superseded => "superseded".to_owned(),
            DeploymentError::Diverged => "diverged".to_owned(),
            DeploymentError::Failed(fault) => fault.message,
        })
    }

    #[test]
    fn other_bytes_under_the_held_composition_refuse_and_publish_nothing() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let line = DeploymentName::new("org-a");
        serve(&deployments, &runtime, "org-a", &policy(JEV, Some("one")))
            .expect("the policy compiles");
        // As a host-read composition would be held; the in-memory store has no host table
        // to check a first publish against.
        deployments
            .by_line
            .lock()
            .unwrap()
            .get_mut(&enforce("org-a"))
            .expect("a deployment is held")
            .composition = Some("composition-1".into());
        let head = runtime.store.head(&line).unwrap();
        let under = |content: &str| HostedPolicy {
            composition: Some("composition-1".to_owned()),
            ..policy(content, Some("one"))
        };

        assert_eq!(
            serve(
                &deployments,
                &runtime,
                "org-a",
                &under(&format!("{JEV}# pod-local\n"))
            )
            .err()
            .as_deref(),
            Some("diverged"),
        );
        assert_eq!(
            runtime.store.head(&line).unwrap(),
            head,
            "the refusal publishes nothing"
        );
        assert!(
            serve(&deployments, &runtime, "org-a", &under(JEV)).is_ok(),
            "the composition's own bytes are still served"
        );
        assert!(
            serve(
                &deployments,
                &runtime,
                "org-a",
                &policy(&format!("{JEV}# edited\n"), Some("one"))
            )
            .is_ok(),
            "a dispatch naming no composition publishes as before"
        );
    }

    /// A call that needs a person's attention, which an authority asks a person for.
    const GATED: &str = "[policy]\nversion = 2\n[[policy.tool]]\nname = \"host/archestra/review\"\ndelta = {}\nrequires = { attention = [\"review\"] }\n[[policy.authority]]\nname = \"human-approval\"\n[policy.authority.permits]\nattention = [\"*\"]\n[externals.authorities.human-approval]\nbuiltin = \"hitl\"\n";

    fn on_line(
        deployments: &Deployments,
        runtime: &TestRuntime,
        line: &Line,
    ) -> PublishedDeployment {
        serving(deployments, runtime, line, GATED)
    }

    fn serving(
        deployments: &Deployments,
        runtime: &TestRuntime,
        line: &Line,
        content: &str,
    ) -> PublishedDeployment {
        block_on(deployments.deployment(
            runtime,
            &runtime.store,
            line,
            &policy(content, None),
            false,
        ))
        .ok()
        .expect("the line composes and publishes")
    }

    fn open(runtime: &Runtime, root: &TrajectoryId, settings: SessionSettings) -> HookDecision {
        block_on(hooks::handle(
            runtime,
            HookEvent::SessionStart {
                root: root.clone(),
                principal: None,
                address: None,
                title: None,
                start: None,
                launch: None,
                settings,
            },
        ))
    }

    fn review(runtime: &Runtime, root: &TrajectoryId) -> HookDecision {
        call(runtime, root, "host/archestra/review")
    }

    fn call(runtime: &Runtime, root: &TrajectoryId, tool: &str) -> HookDecision {
        block_on(hooks::handle(
            runtime,
            HookEvent::ToolCall {
                call_id: Some(format!("{tool}-{}", root.as_str())),
                actor: Actor {
                    root: root.clone(),
                    child: None,
                },
                call: ProposedCall {
                    tool: tool.into(),
                    arguments: serde_json::value::RawValue::from_string("{}".into()).unwrap(),
                    cwd: None,
                },
                spawn: None,
                prompt: None,
                ruling: None,
                declares: None,
            },
        ))
    }

    #[test]
    fn an_observe_family_pins_its_line_and_is_approved_where_enforce_asks_a_person() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let observe = Line {
            organization_id: "org-a".to_owned(),
            variant: Variant::Observe,
        };
        let observing = runtime.pinned(&on_line(&deployments, &runtime, &observe));
        let enforcing = runtime.pinned(&on_line(&deployments, &runtime, &enforce("org-a")));
        let (watched, enforced) = (
            TrajectoryId("observe-root".into()),
            TrajectoryId("enforce-root".into()),
        );
        assert_eq!(
            open(
                &observing,
                &watched,
                Family::opening(Variant::Observe, false).settings
            ),
            HookDecision::Ack
        );
        assert_eq!(
            open(
                &enforcing,
                &enforced,
                Family::opening(Variant::Enforce, false).settings
            ),
            HookDecision::Ack
        );

        let family = Family::of_log("org-a", &runtime.store.log(&watched).unwrap());
        assert_eq!(family, Some(Family::opening(Variant::Observe, false)));
        assert_eq!(
            family.map(|family| family.settings.auto_apply),
            Some(appa_runtime_api::AutoApply::RulingsAndAccept)
        );
        assert!(
            matches!(review(&observing, &watched), HookDecision::AllowCall { .. }),
            "the observe approver clears the attention gap"
        );
        assert!(
            !matches!(
                review(&enforcing, &enforced),
                HookDecision::AllowCall { .. }
            ),
            "enforce leaves it to the person"
        );
        assert!(
            matches!(review(&enforcing, &watched), HookDecision::Refuse { .. }),
            "an observe family is never decided on the enforce line"
        );
    }

    #[test]
    fn the_person_approver_line_clears_what_a_person_would_have_been_asked() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let approved = Line {
            organization_id: "org-a".to_owned(),
            variant: Variant::EnforceApproved,
        };
        let approving = runtime.pinned(&on_line(&deployments, &runtime, &approved));
        let root = TrajectoryId("unattended-root".into());
        let settings = Family::opening(Variant::EnforceApproved, true).settings;
        assert_eq!(
            settings.auto_apply,
            appa_runtime_api::AutoApply::RulingsOnly
        );
        assert_eq!(open(&approving, &root, settings), HookDecision::Ack);
        let family = Family::of_log("org-a", &runtime.store.log(&root).unwrap())
            .expect("the family follows the approved line");
        assert!(
            family.unattended() && !family.continued_by(Presenter::Attended),
            "a runtime-opened family is refused to a request without its binding"
        );
        assert!(matches!(
            review(&approving, &root),
            HookDecision::AllowCall { .. }
        ));
    }

    #[test]
    fn no_injected_approver_clears_a_mark_an_enforced_tool_requires() {
        let tagged = format!(
            "{GATED}[[policy.tool]]\nname = \"host/archestra/wire\"\ndelta = {{}}\ntags = [\"enforced\"]\nrequires = {{ attention = [\"review\"] }}\n[[policy.tool]]\nname = \"host/archestra/note\"\ndelta = {{}}\nrequires = {{ attention = [\"note\"] }}\n"
        );
        let runtime = runtime();
        let deployments = Deployments::default();
        for (variant, unattended) in [(Variant::Observe, false), (Variant::EnforceApproved, true)] {
            let line = Line {
                organization_id: "org-a".to_owned(),
                variant,
            };
            let pinned = runtime.pinned(&serving(&deployments, &runtime, &line, &tagged));
            let root = TrajectoryId(format!("tagged-{}", variant.token()));
            let settings = Family::opening(variant, unattended).settings;
            assert_eq!(open(&pinned, &root, settings), HookDecision::Ack);
            assert!(
                !matches!(
                    call(&pinned, &root, "host/archestra/wire"),
                    HookDecision::AllowCall { .. }
                ),
                "{variant:?} leaves the enforced tool's mark to a person"
            );
            assert!(
                matches!(
                    call(&pinned, &root, "host/archestra/note"),
                    HookDecision::AllowCall { .. }
                ),
                "{variant:?} still clears an unrelated mark"
            );
        }
    }

    /// An annotator on loopback that answers every consult requiring the `review` mark.
    fn review_annotator() -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("a loopback port");
        let address = listener.local_addr().expect("bound");
        std::thread::spawn(move || {
            const ANSWER: &str = r#"{"version":1,"answer":{"delta":{},"requires":{"history":[],"attention":["review"]},"emits":[]}}"#;
            for mut stream in listener.incoming().flatten() {
                let mut request = Vec::new();
                let mut chunk = [0u8; 8192];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&chunk[..read]),
                    }
                    let text = String::from_utf8_lossy(&request);
                    let Some(end) = text.find("\r\n\r\n") else {
                        continue;
                    };
                    let length = text[..end]
                        .lines()
                        .filter_map(|line| line.split_once(':'))
                        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{ANSWER}",
                    ANSWER.len()
                );
            }
        });
        format!("http://{address}/annotate")
    }

    #[test]
    fn no_injected_approver_clears_a_mark_an_enforced_tools_annotator_answers() {
        let url = review_annotator();
        let annotated = |marks: &str| {
            format!(
                "{GATED}[[policy.tool]]\nname = \"host/archestra/wire\"\ntags = [\"enforced\"]\nannotator = \"tagger\"\n[[policy.tool]]\nname = \"host/archestra/note\"\ndelta = {{}}\nrequires = {{ attention = [\"note\"] }}\n[[policy.annotator]]\nname = \"tagger\"\n{marks}[externals.annotators.tagger]\nurl = \"{url}\"\n"
            )
        };
        let runtime = runtime();
        let deployments = Deployments::default();
        for (organization, marks) in [("org-named", "marks = [\"review\"]\n"), ("org-omitted", "")]
        {
            let line = Line {
                organization_id: organization.to_owned(),
                variant: Variant::Observe,
            };
            let pinned = runtime.pinned(&serving(&deployments, &runtime, &line, &annotated(marks)));
            let root = TrajectoryId(format!("annotated-{organization}"));
            let settings = Family::opening(Variant::Observe, false).settings;
            assert_eq!(open(&pinned, &root, settings), HookDecision::Ack);
            let decision = call(&pinned, &root, "host/archestra/wire");
            assert!(
                !matches!(decision, HookDecision::AllowCall { .. }),
                "{organization}: the annotator's mark is left to a person: {decision:?}"
            );
            assert_eq!(
                matches!(
                    call(&pinned, &root, "host/archestra/note"),
                    HookDecision::AllowCall { .. }
                ),
                !marks.is_empty(),
                "{organization}: an omitted list withholds every declared mark"
            );
        }
    }

    #[test]
    fn a_reserved_approver_name_is_refused_on_every_line() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let reserved = GATED.replace("human-approval", "archestra-observe");
        for variant in crate::lines::VARIANTS {
            let line = Line {
                organization_id: "org-a".to_owned(),
                variant,
            };
            assert!(
                block_on(deployments.deployment(
                    &runtime,
                    &runtime.store,
                    &line,
                    &policy(&reserved, None),
                    false
                ))
                .is_err(),
                "{variant:?}"
            );
        }
    }

    #[test]
    fn only_a_line_with_approvers_is_rebuilt_when_the_enforced_marks_change() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let marked = |marks: &[&str]| HostedPolicy {
            guardrails: Guardrails::parse(
                "observe",
                "ask",
                marks.iter().map(|mark| (*mark).to_owned()).collect(),
            )
            .unwrap(),
            ..policy(GATED, None)
        };
        for variant in [Variant::Enforce, Variant::Observe] {
            let line = Line {
                organization_id: "org-a".to_owned(),
                variant,
            };
            block_on(deployments.deployment(&runtime, &runtime.store, &line, &marked(&[]), false))
                .ok()
                .expect("the line publishes");
            assert_eq!(
                deployments.serving(&line, &marked(&["review"])).is_some(),
                variant == Variant::Enforce,
                "{variant:?}"
            );
        }
    }

    #[test]
    fn an_unpinned_family_follows_the_enforce_line() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let enforcing = runtime.pinned(&on_line(&deployments, &runtime, &enforce("org-a")));
        let root = TrajectoryId("legacy-root".into());
        assert_eq!(
            open(&enforcing, &root, SessionSettings::default()),
            HookDecision::Ack
        );
        assert_eq!(
            Family::of_log("org-a", &runtime.store.log(&root).unwrap()),
            Some(Family {
                variant: Variant::Enforce,
                settings: SessionSettings::default(),
            })
        );
    }

    #[test]
    fn a_line_whose_approvers_do_not_fit_falls_back_and_says_so() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let capped = GATED.replace(
            "[policy]\nversion = 2\n",
            "[policy]\nversion = 2\n[policy.limits]\nplanner_cap = 1\n",
        );
        let observe = Line {
            organization_id: "org-a".to_owned(),
            variant: Variant::Observe,
        };
        let falls_back = |content: &str| {
            block_on(deployments.falls_back(
                &runtime,
                &runtime.store,
                &observe,
                &policy(content, None),
                false,
            ))
            .ok()
            .expect("the saved policy is served either way")
        };
        assert!(!falls_back(GATED));
        assert!(falls_back(&capped));
    }

    #[test]
    fn a_deployment_is_reused_until_its_policy_or_a_looked_up_credential_changes() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let prepares_for =
            |content: &str, key| prepares(&deployments, &runtime, "org-a", &policy(content, key));
        assert!(prepares_for(JEV, Some("one")));
        assert!(
            !prepares_for(JEV, Some("one")),
            "the same inputs reuse the deployment"
        );
        assert!(
            prepares_for(JEV, Some("two")),
            "a rotated key prepares anew"
        );
        assert!(
            serve(&deployments, &runtime, "org-a", &policy(JEV, None)).is_err(),
            "a removed key refuses rather than serving the deployment its old key opened"
        );
        assert!(
            prepares_for(&format!("{JEV}# edited\n"), Some("two")),
            "an edited policy prepares anew"
        );
    }

    #[test]
    fn concurrent_misses_for_one_organization_prepare_once() {
        const DISPATCHES: usize = 8;
        let runtime = runtime();
        let deployments = Arc::new(Deployments::default());
        let barrier = Arc::new(tokio::sync::Barrier::new(DISPATCHES));
        let served = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(4)
            .build()
            .unwrap()
            .block_on(async {
                let dispatches: Vec<_> = (0..DISPATCHES)
                    .map(|_| {
                        let (runtime, deployments, barrier) =
                            (runtime.clone(), deployments.clone(), barrier.clone());
                        tokio::spawn(async move {
                            barrier.wait().await;
                            deployments
                                .pinned(
                                    &runtime,
                                    &runtime.store,
                                    &enforce("org-a"),
                                    &policy(JEV, Some("one")),
                                    false,
                                )
                                .await
                                .ok()
                                .expect("the policy compiles")
                        })
                    })
                    .collect();
                let mut served = Vec::new();
                for dispatch in dispatches {
                    served.push(dispatch.await.unwrap());
                }
                served
            });
        assert!(
            served
                .iter()
                .all(|pinned| Arc::ptr_eq(&pinned.content, &served[0].content)),
            "every dispatch serves the one deployment prepared"
        );
    }

    #[test]
    fn a_credential_the_policy_never_looks_up_keeps_the_deployment() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let plain = "[policy]\nversion = 2\n";
        assert!(prepares(
            &deployments,
            &runtime,
            "org-a",
            &policy(plain, Some("one"))
        ));
        assert!(!prepares(
            &deployments,
            &runtime,
            "org-a",
            &policy(plain, Some("two"))
        ));
    }

    #[test]
    fn each_organization_keeps_its_own_latest_deployment() {
        let runtime = runtime();
        let deployments = Deployments::default();
        assert!(prepares(
            &deployments,
            &runtime,
            "org-a",
            &policy(JEV, Some("a-key"))
        ));
        assert!(prepares(
            &deployments,
            &runtime,
            "org-b",
            &policy(JEV, Some("b-key"))
        ));
        assert!(!prepares(
            &deployments,
            &runtime,
            "org-a",
            &policy(JEV, Some("a-key"))
        ));
        assert!(!prepares(
            &deployments,
            &runtime,
            "org-b",
            &policy(JEV, Some("b-key"))
        ));
        assert!(prepares(
            &deployments,
            &runtime,
            "org-a",
            &policy(JEV, Some("rotated"))
        ));
        assert_eq!(deployments.by_line.lock().unwrap().len(), 2);
    }

    /// `content` with one more tool rule: a change to the bytes the policy compiles to,
    /// which a comment is not.
    fn edited(content: &str, tool: &str) -> String {
        format!("{content}[[policy.tool]]\nname = \"host/archestra/{tool}\"\ndelta = {{}}\n")
    }

    fn revision(
        deployments: &Deployments,
        runtime: &TestRuntime,
        organization: &str,
        policy: &HostedPolicy,
    ) -> u64 {
        serve(deployments, runtime, organization, policy)
            .expect("the policy compiles")
            .revision()
    }

    #[test]
    fn identical_bytes_publish_no_new_revision() {
        let store = Arc::new(LogStore::open(Backend::Memory).unwrap());
        let (one, other) = (on_store(store.clone()), on_store(store.clone()));
        let (ones, others) = (Deployments::default(), Deployments::default());
        assert_eq!(revision(&ones, &one, "org-a", &policy(JEV, Some("one"))), 1);
        assert_eq!(
            revision(&others, &other, "org-a", &policy(JEV, Some("one"))),
            1,
            "a second process serving the same policy pins the same revision"
        );
        assert_eq!(
            revision(&ones, &one, "org-a", &policy(JEV, Some("rotated"))),
            1,
            "a rotated credential prepares anew but publishes nothing: the key is not in the bytes"
        );
        assert_eq!(
            revision(
                &ones,
                &one,
                "org-a",
                &policy(&edited(JEV, "edited"), Some("rotated"))
            ),
            2,
            "an edited policy is the line's next revision"
        );
    }

    #[test]
    fn each_organization_publishes_its_own_line() {
        let runtime = runtime();
        let deployments = Deployments::default();
        assert_eq!(
            revision(&deployments, &runtime, "org-a", &policy(JEV, Some("a-key"))),
            1
        );
        assert_eq!(
            revision(
                &deployments,
                &runtime,
                "org-b",
                &policy(&edited(JEV, "b"), Some("b-key"))
            ),
            1
        );
        assert_eq!(
            revision(
                &deployments,
                &runtime,
                "org-a",
                &policy(&edited(JEV, "a"), Some("a-key"))
            ),
            2,
            "a publish moves only its own organization's line"
        );
        assert_eq!(
            revision(
                &deployments,
                &runtime,
                "org-b",
                &policy(&edited(JEV, "b"), Some("b-key"))
            ),
            1
        );
    }

    #[test]
    fn a_repin_never_takes_another_dispatchs_credential_at_the_same_revision() {
        let store = Arc::new(LogStore::open(Backend::Memory).unwrap());
        let one = on_store(store.clone());
        let ones = Deployments::default();
        let first = serve(&ones, &one, "org-a", &policy(JEV, Some("one"))).unwrap();
        let rotated = serve(&ones, &one, "org-a", &policy(JEV, Some("two"))).unwrap();
        assert_eq!(first.revision(), rotated.revision());
        assert!(
            block_on(ones.repin(
                &one,
                &store,
                &enforce("org-a"),
                &policy(JEV, Some("one")),
                &first
            ))
            .unwrap()
            .is_none(),
            "the held deployment carries the rotated credential"
        );
        assert!(
            block_on(ones.repin(
                &one,
                &store,
                &enforce("org-a"),
                &policy(JEV, Some("two")),
                &rotated
            ))
            .unwrap()
            .is_some()
        );
    }

    #[test]
    fn a_stale_deployment_pins_the_head_only_when_the_head_names_its_policy() {
        let store = Arc::new(LogStore::open(Backend::Memory).unwrap());
        let (one, other) = (on_store(store.clone()), on_store(store.clone()));
        let (ones, others) = (Deployments::default(), Deployments::default());
        let edited = edited(JEV, "edited");
        let first = serve(&ones, &one, "org-a", &policy(JEV, Some("one"))).unwrap();

        assert_eq!(
            revision(&others, &other, "org-a", &policy(&edited, Some("one"))),
            2
        );
        assert!(
            block_on(ones.repin(
                &one,
                &store,
                &enforce("org-a"),
                &policy(JEV, Some("one")),
                &first
            ))
            .unwrap()
            .is_none(),
            "another policy at the head is not published over"
        );
        assert!(
            ones.held(&enforce("org-a")).is_none(),
            "the stale deployment is forgotten, so the next dispatch prepares from its own policy"
        );
        assert_eq!(
            revision(&ones, &one, "org-a", &policy(&edited, Some("one"))),
            2,
            "the next dispatch serving the head's policy pins the head"
        );

        let second = serve(&ones, &one, "org-a", &policy(&edited, Some("one"))).unwrap();
        assert_eq!(
            revision(&others, &other, "org-a", &policy(JEV, Some("one"))),
            3
        );
        assert_eq!(
            revision(&others, &other, "org-a", &policy(&edited, Some("one"))),
            4
        );
        let head = block_on(ones.repin(
            &one,
            &store,
            &enforce("org-a"),
            &policy(&edited, Some("one")),
            &second,
        ))
        .unwrap()
        .expect("the head names this deployment's policy");
        assert_eq!(head.revision(), 4);
        assert_eq!(
            revision(&ones, &one, "org-a", &policy(&edited, Some("one"))),
            4,
            "the re-pinned deployment is the one held"
        );
        assert_eq!(
            store
                .head(&DeploymentName::new("org-a"))
                .unwrap()
                .unwrap()
                .revision
                .value(),
            4
        );
    }

    #[test]
    fn read_only_pins_cannot_roll_back_a_live_publish_from_another_process() {
        const ORGANIZATION: &str = "pin-race-org";
        const BEFORE: &str =
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"before\"\ndelta = {}\n";
        const AFTER: &str =
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"after\"\ndelta = {}\n";
        let temporary = tempfile::tempdir().unwrap();
        let child_path = std::env::var_os("ARCHESTRA_OPENAPPA_PIN_RACE_STORE");
        let path = child_path
            .clone()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| temporary.path().join("race.sqlite"));
        let store = Arc::new(LogStore::open(Backend::Sqlite { path: path.clone() }).unwrap());
        let runtime = on_store(store.clone());
        let deployments = Deployments::default();
        let line = DeploymentName::new(ORGANIZATION);
        if child_path.is_some() {
            let published = block_on(deployments.deployment(
                &runtime,
                &store,
                &enforce(ORGANIZATION),
                &policy(AFTER, None),
                false,
            ))
            .ok()
            .unwrap();
            assert_eq!(published.revision(), 2);
            return;
        }
        let original = block_on(deployments.deployment(
            &runtime,
            &store,
            &enforce(ORGANIZATION),
            &policy(BEFORE, None),
            false,
        ))
        .ok()
        .unwrap();
        let root = TrajectoryId("pin-race-root".into());
        let start = || HookEvent::SessionStart {
            root: root.clone(),
            principal: None,
            address: None,
            title: None,
            start: None,
            launch: None,
            settings: Default::default(),
        };
        assert_eq!(
            block_on(hooks::handle(&runtime.pinned(&original), start())),
            HookDecision::Ack
        );
        let observed = store.head(&line).unwrap().unwrap();
        let config = compiled(BEFORE, &HostCredentials::default())
            .unwrap()
            .config;
        assert_eq!(
            policy_file_key(config.policy_file().bytes()),
            observed.key.as_str()
        );
        let prepared = runtime.prepare_deployment(config).unwrap();
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "deployments::tests::read_only_pins_cannot_roll_back_a_live_publish_from_another_process", "--nocapture"])
            .env("ARCHESTRA_OPENAPPA_PIN_RACE_STORE", &path)
            .output().unwrap();
        assert!(
            child.status.success(),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        let advanced = store.head(&line).unwrap().unwrap();
        assert_eq!(advanced.revision.value(), 2);
        let opening_facts = store.log(&root).unwrap().facts().len();
        let stale = pin_existing(&runtime, &line, &prepared, &observed).unwrap();
        assert_eq!(stale.revision(), 1, "repin pins only the observed revision");
        assert_eq!(
            store.head(&line).unwrap().unwrap(),
            advanced,
            "repin must not publish stale bytes"
        );
        let decision = block_on(hooks::handle(
            &runtime.pinned(&stale),
            HookEvent::ToolCall {
                call_id: Some("stale-repin".to_owned()),
                actor: Actor {
                    root: root.clone(),
                    child: None,
                },
                call: ProposedCall {
                    tool: "host/archestra/before".into(),
                    arguments: serde_json::value::RawValue::from_string("{}".into()).unwrap(),
                    cwd: None,
                },
                spawn: None,
                prompt: None,
                ruling: None,
                declares: None,
            },
        ));
        assert!(
            matches!(
                decision,
                HookDecision::Refuse {
                    class: RefusalClass::PolicyMoved,
                    ..
                }
            ),
            "{decision:?}"
        );
        assert_eq!(store.head(&line).unwrap().unwrap(), advanced);
        assert_eq!(store.log(&root).unwrap().facts().len(), opening_facts);
        assert!(
            block_on(deployments.repin(
                &runtime,
                &store,
                &enforce(ORGANIZATION),
                &policy(BEFORE, None),
                &original
            ))
            .unwrap()
            .is_none()
        );
        assert_eq!(store.head(&line).unwrap().unwrap(), advanced);
    }

    #[test]
    fn an_organization_variable_never_reads_the_process_environment() {
        const VAR: &str = "APPA_PROVIDER_OPENAPPA_RS_TEST_ENV_ONLY_KEY";
        // SAFETY: no other test reads or writes this variable.
        unsafe { std::env::set_var(VAR, "backend-value") };
        assert_eq!(HostCredentials::default().lookup(VAR), None);
        assert_eq!(
            HostCredentials::new([(VAR.to_owned(), "org-value".to_owned())]).lookup(VAR),
            Some("org-value".to_owned())
        );
    }

    #[test]
    fn a_host_variable_is_never_an_organizations_value() {
        let credentials = HostCredentials::new([(
            "APPA_ARCHESTRA_OPENAPPA_RS_TEST_UNSET".to_owned(),
            "forged".to_owned(),
        )]);
        assert_eq!(
            credentials.lookup("APPA_ARCHESTRA_OPENAPPA_RS_TEST_UNSET"),
            None
        );
    }
}
