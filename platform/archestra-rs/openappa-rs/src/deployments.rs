//! One prepared deployment per organization, pinned to each of its dispatches.
//!
//! The runtime is shared by every organization, so no dispatch reloads it: each one
//! runs through a view pinned to its organization's deployment, which its consults,
//! decisions and new roots read whatever another organization dispatches meanwhile.
//! A deployment is compiled from the organization's effective policy with the
//! credential values the host resolved for it, and is reused while both still
//! answer the same: a new policy, or a rotated, removed or rebound credential,
//! prepares a new one in its place.
use appa_runtime::api::{PreparedDeployment, Runtime};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex, PoisonError},
};

/// The credential values the host resolved for one organization's policy, variable →
/// value. Secrets: nothing here is logged or formatted.
#[derive(Default)]
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
pub(crate) struct HostedPolicy {
    pub content: String,
    pub credentials: HostCredentials,
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
    prepared: PreparedDeployment,
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
    /// now when the one held for it no longer compiles from the same inputs.
    pub(crate) async fn deployment(
        &self,
        runtime: &Runtime,
        organization_id: &str,
        policy: &HostedPolicy,
        agent_yell: bool,
    ) -> Result<PreparedDeployment, String> {
        Ok(self
            .pinned(runtime, organization_id, policy, agent_yell)
            .await?
            .prepared)
    }

    async fn pinned(
        &self,
        runtime: &Runtime,
        organization_id: &str,
        policy: &HostedPolicy,
        agent_yell: bool,
    ) -> Result<Pinned, String> {
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
        let asked = RefCell::new(Vec::<(String, Option<String>)>::new());
        let mut config = crate::policy::compile(&policy.content, |var| {
            let answer = policy.credentials.lookup(var);
            asked.borrow_mut().push((var.to_owned(), answer.clone()));
            answer
        })?;
        config.reporting.agent_yell = agent_yell;
        let prepared = runtime
            .prepare_deployment(config)
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
            prepared,
        };
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

    fn held(&self, organization_id: &str) -> Option<Pinned> {
        self.by_organization
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(organization_id)
            .cloned()
    }
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

    fn runtime() -> Runtime {
        let config = crate::policy::compile("[policy]\nversion = 2\n", |_| None).unwrap();
        crate::policy::open(config, Arc::new(LogStore::open(Backend::Memory).unwrap())).unwrap()
    }

    fn policy(content: &str, key: Option<&str>) -> HostedPolicy {
        HostedPolicy {
            content: content.to_owned(),
            credentials: HostCredentials::new(key.map(|key| (KEY.to_owned(), key.to_owned()))),
        }
    }

    /// Serves `policy` for `organization` and answers whether that prepared a
    /// deployment rather than reusing the one held.
    fn prepares(
        deployments: &Deployments,
        runtime: &Runtime,
        organization: &str,
        policy: &HostedPolicy,
    ) -> bool {
        let before = deployments.held(organization);
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(deployments.deployment(runtime, organization, policy, false))
            .expect("the policy compiles");
        let after = deployments
            .held(organization)
            .expect("a deployment is held");
        before.is_none_or(|before| !Arc::ptr_eq(&before.content, &after.content))
    }

    #[test]
    fn a_deployment_is_reused_until_its_policy_or_a_looked_up_credential_changes() {
        let runtime = runtime();
        let deployments = Deployments::default();
        let serve =
            |content: &str, key| prepares(&deployments, &runtime, "org-a", &policy(content, key));
        assert!(serve(JEV, Some("one")));
        assert!(
            !serve(JEV, Some("one")),
            "the same inputs reuse the deployment"
        );
        assert!(serve(JEV, Some("two")), "a rotated key prepares anew");
        assert!(serve(JEV, None), "a removed key prepares anew");
        assert!(!serve(JEV, None));
        assert!(
            serve(&format!("{JEV}# edited\n"), None),
            "an edited policy prepares anew"
        );
    }

    #[test]
    fn concurrent_misses_for_one_organization_prepare_once() {
        const DISPATCHES: usize = 8;
        let runtime = Arc::new(runtime());
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
                                .pinned(&runtime, "org-a", &policy(JEV, Some("one")), false)
                                .await
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
