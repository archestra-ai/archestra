//! One published deployment per organization, pinned to each of its dispatches.
//!
//! The runtime is shared by every organization, so no dispatch reloads it: each one
//! runs through a view pinned to its organization's deployment line, which its
//! consults, decisions and new roots read whatever another organization dispatches
//! meanwhile. Each organization's line is named by its id. A deployment is compiled
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
use appa_eventlog::{DeploymentName, LogStore};
use appa_runtime::api::{PreparedDeployment, PublishedDeployment, Runtime};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex, PoisonError},
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
}

/// Why no deployment serves a dispatch.
pub(crate) enum DeploymentError {
    /// The dispatch carries a policy the organization has since recomposed, and the
    /// line's head names another one: publishing it would roll the line back.
    Superseded,
    Failed(String),
}

impl From<String> for DeploymentError {
    fn from(reason: String) -> Self {
        DeploymentError::Failed(reason)
    }
}

/// The deployment an organization's dispatches are pinned to, and what it was
/// compiled from.
#[derive(Clone)]
struct Pinned {
    content: Arc<str>,
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
    fn serves(&self, policy: &HostedPolicy) -> bool {
        *self.content == *policy.content
            && answers_digest(
                self.variables
                    .iter()
                    .map(|var| (var.as_str(), policy.credentials.lookup(var))),
            ) == self.answers
    }
}

/// The latest deployment of every organization that dispatched, by organization id.
/// Only an organization's latest policy is served, so an entry is replaced when that
/// policy or its credentials change, and the map holds one entry per organization.
#[derive(Default)]
pub(crate) struct Deployments {
    by_organization: Mutex<HashMap<String, Pinned>>,
    /// One preparation at a time per organization: concurrent dispatches that miss
    /// wait for the one preparing and then reuse its deployment.
    preparing: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
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
        organization_id: &str,
        policy: &HostedPolicy,
        agent_yell: bool,
    ) -> Result<PublishedDeployment, DeploymentError> {
        Ok(self
            .pinned(runtime, store, organization_id, policy, agent_yell)
            .await?
            .published)
    }

    /// After a dispatch pinned to `stale` found that its line moved on: the
    /// organization's deployment pinned at the line's head when the head names the
    /// same policy file, or `None` when it names another one.
    ///
    /// Only the same file is pinned again. Another file at the head was published
    /// by a process that read the organization's policy after this dispatch did, so
    /// this process forgets its deployment instead of publishing its own bytes over
    /// that head; the host's retry reads the policy again and publishes from that.
    ///
    /// The head read and the publish are synchronous PostgreSQL round trips, so they
    /// run on a blocking thread.
    pub(crate) async fn repin(
        &self,
        runtime: &Arc<Runtime>,
        store: &Arc<LogStore>,
        organization_id: &str,
        stale: &PublishedDeployment,
    ) -> Result<Option<PublishedDeployment>, String> {
        let Some(pinned) = self
            .held(organization_id)
            .filter(|pinned| pinned.published.revision() == stale.revision())
        else {
            // A concurrent dispatch already moved this organization's deployment on.
            return Ok(self.held(organization_id).map(|pinned| pinned.published));
        };
        let (runtime, store) = (runtime.clone(), store.clone());
        let line = DeploymentName::new(organization_id);
        let (key, prepared) = (pinned.key.clone(), pinned.prepared.clone());
        let head = tokio::task::spawn_blocking(move || -> Result<_, String> {
            let head = store.head(&line).map_err(|error| error.to_string())?;
            if head.is_none_or(|head| head.key.as_str() != &*key) {
                return Ok(None);
            }
            runtime
                .publish(&line, &prepared)
                .map(Some)
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())??;
        let Some(published) = head else {
            self.forget(organization_id, &pinned);
            return Ok(None);
        };
        self.by_organization
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(
                organization_id.to_owned(),
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
        organization_id: &str,
        policy: &HostedPolicy,
        agent_yell: bool,
    ) -> Result<Pinned, DeploymentError> {
        if let Some(pinned) = self.serving(organization_id, policy) {
            return Ok(pinned);
        }
        let gate = self
            .preparing
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(organization_id.to_owned())
            .or_default()
            .clone();
        let _preparing = gate.lock().await;
        if let Some(pinned) = self.serving(organization_id, policy) {
            return Ok(pinned);
        }
        let (runtime, store) = (runtime.clone(), store.clone());
        let (organization, policy) = (organization_id.to_owned(), policy.clone());
        let pinned = tokio::task::spawn_blocking(move || {
            prepare(&runtime, &store, &organization, &policy, agent_yell)
        })
        .await
        .map_err(|error| DeploymentError::Failed(error.to_string()))??;
        self.by_organization
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(organization_id.to_owned(), pinned.clone());
        Ok(pinned)
    }

    /// The deployment held for this organization when it still serves `policy`.
    fn serving(&self, organization_id: &str, policy: &HostedPolicy) -> Option<Pinned> {
        self.held(organization_id)
            .filter(|pinned| pinned.serves(policy))
    }

    /// Drop the organization's deployment when it is still `pinned`, so the next
    /// dispatch prepares and publishes from the policy it carries.
    fn forget(&self, organization_id: &str, pinned: &Pinned) {
        let mut held = self
            .by_organization
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if held.get(organization_id).is_some_and(|current| {
            current.published.revision() == pinned.published.revision()
                && Arc::ptr_eq(&current.content, &pinned.content)
        }) {
            held.remove(organization_id);
        }
    }

    fn held(&self, organization_id: &str) -> Option<Pinned> {
        self.by_organization
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(organization_id)
            .cloned()
    }
}

/// Compiles `policy` with the credential values it looks up, prepares it, and
/// publishes it as the head of the organization's line. Synchronous: the head read
/// and the publish are PostgreSQL round trips, so callers run it on a blocking
/// thread.
fn prepare(
    runtime: &Runtime,
    store: &LogStore,
    organization_id: &str,
    policy: &HostedPolicy,
    agent_yell: bool,
) -> Result<Pinned, DeploymentError> {
    let asked = RefCell::new(Vec::<(String, Option<String>)>::new());
    let mut config = crate::policy::compile(&policy.content, |var| {
        let answer = policy.credentials.lookup(var);
        asked.borrow_mut().push((var.to_owned(), answer.clone()));
        answer
    })?;
    config.reporting.agent_yell = agent_yell;
    let key = policy_file_key(config.policy_file().bytes());
    let prepared = runtime
        .prepare_deployment(config)
        .map_err(|error| error.to_string())?;
    let line = DeploymentName::new(organization_id);
    if let Some(composition) = &policy.composition {
        let head = store.head(&line).map_err(|error| error.to_string())?;
        let publishes = head.is_none_or(|head| head.key.as_str() != key);
        if publishes && !stored_composition(store, organization_id, composition)? {
            return Err(DeploymentError::Superseded);
        }
    }
    let published = runtime
        .publish(&line, &prepared)
        .map_err(|error| error.to_string())?;
    let asked = asked.into_inner();
    let pinned = Pinned {
        content: policy.content.as_str().into(),
        answers: answers_digest(
            asked
                .iter()
                .map(|(var, answer)| (var.as_str(), answer.clone())),
        ),
        variables: asked.into_iter().map(|(var, _)| var).collect(),
        key: key.into(),
        prepared,
        published,
    };
    Ok(pinned)
}

/// Whether `composition` is the content hash of the organization's stored
/// composition. An organization with none stored has nothing newer to protect.
fn stored_composition(
    store: &LogStore,
    organization_id: &str,
    composition: &str,
) -> Result<bool, String> {
    let organization_id = organization_id.to_owned();
    let stored = crate::Sql(store)
        .with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT content_hash FROM openappa_effective_policies WHERE organization_id = $1",
                    &[&organization_id],
                )?
                .map(|row| row.get::<_, String>(0)))
        })
        .map_err(|error| error.to_string())?;
    Ok(stored.is_none_or(|stored| stored == composition))
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
    use appa_eventlog::{Backend, LogStore};

    const KEY: &str = "APPA_OPENAPPA_RS_TEST_JEV_KEY";
    const JEV: &str = "[policy]\nversion = 2\n[[policy.annotator]]\nname = \"jev.tool-call\"\nbuiltin = \"jev\"\nranks = [\"suspicious\", \"trusted\"]\naudiences = [\"self\", \"internal\"]\nmarks = []\n[externals.jev]\ntoken_env = \"APPA_OPENAPPA_RS_TEST_JEV_KEY\"\n";

    fn runtime() -> Arc<Runtime> {
        on_store(Arc::new(LogStore::open(Backend::Memory).unwrap()))
    }

    /// A runtime over `store`: two of them over one store are two processes sharing
    /// one database.
    fn on_store(store: Arc<LogStore>) -> Arc<Runtime> {
        let config = crate::policy::compile("[policy]\nversion = 2\n", |_| None).unwrap();
        Arc::new(crate::policy::open(config, store).unwrap())
    }

    /// Runs `future` to completion on a runtime of its own, as a dispatch would.
    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn policy(content: &str, key: Option<&str>) -> HostedPolicy {
        HostedPolicy {
            content: content.to_owned(),
            credentials: HostCredentials::new(key.map(|key| (KEY.to_owned(), key.to_owned()))),
            composition: None,
        }
    }

    /// Serves `policy` for `organization` and answers whether that prepared a
    /// deployment rather than reusing the one held.
    fn prepares(
        deployments: &Deployments,
        runtime: &Arc<Runtime>,
        organization: &str,
        policy: &HostedPolicy,
    ) -> bool {
        let before = deployments.held(organization);
        serve(deployments, runtime, organization, policy).expect("the policy compiles");
        let after = deployments
            .held(organization)
            .expect("a deployment is held");
        before.is_none_or(|before| !Arc::ptr_eq(&before.content, &after.content))
    }

    fn serve(
        deployments: &Deployments,
        runtime: &Arc<Runtime>,
        organization: &str,
        policy: &HostedPolicy,
    ) -> Result<PublishedDeployment, String> {
        // No test policy names a stored composition, so this store is never read.
        let store = Arc::new(LogStore::open(Backend::Memory).unwrap());
        block_on(deployments.deployment(runtime, &store, organization, policy, false)).map_err(
            |error| match error {
                DeploymentError::Superseded => "superseded".to_owned(),
                DeploymentError::Failed(reason) => reason,
            },
        )
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
                                    &Arc::new(LogStore::open(Backend::Memory).unwrap()),
                                    "org-a",
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
        assert_eq!(deployments.by_organization.lock().unwrap().len(), 2);
    }

    /// `content` with one more tool rule: a change to the bytes the policy compiles to,
    /// which a comment is not.
    fn edited(content: &str, tool: &str) -> String {
        format!("{content}[[policy.tool]]\nname = \"host/archestra/{tool}\"\ndelta = {{}}\n")
    }

    fn revision(
        deployments: &Deployments,
        runtime: &Arc<Runtime>,
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
            block_on(ones.repin(&one, &store, "org-a", &first))
                .unwrap()
                .is_none(),
            "another policy at the head is not published over"
        );
        assert!(
            ones.held("org-a").is_none(),
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
        let head = block_on(ones.repin(&one, &store, "org-a", &second))
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
