//! What a parent is told about a subagent's answer whose return was deferred.

use std::panic::AssertUnwindSafe;

use appa_runtime::api::{EmbeddedPeerError, EmbeddedPresentationOptions};
use futures_util::FutureExt;
use napi_derive::napi;

use crate::{
    Sql, State,
    admin_api::{ContentEncryption, DispatchPolicy},
    child_returns::spawn_operation_id,
    deployments,
    errors::{Failure, failure, invalid_input, panicked, storage},
    initialized, on_deployment,
    operations::expected_actor,
    session::SessionKey,
};
use appa_runtime_api::RefusalClass;

#[napi(object)]
#[derive(Clone)]
pub struct DeferredReturnLookup {
    pub organization_id: String,
    /// The session that proposed the spawn.
    pub session_id: String,
    /// The provider's id of the spawn's tool call.
    pub spawn_call_id: String,
    /// The control tool and reporting tool, spelled the way this session's model calls them.
    pub control_tool: String,
    pub supports_delegation: bool,
    pub yell_tool: Option<String>,
}

#[napi(object)]
pub struct DeferredReturn {
    /// The text the spawn's tool result carries in place of the subagent's answer.
    pub notice: String,
    /// What the session's control call quotes to take the answer, and to drop it.
    pub accept: String,
    pub discard: String,
}

/// The deferral notice of one spawn, from the stop that deferred its subagent's answer on,
/// before and after the session decides. `None` for a spawn with no deferred return and for
/// a session that never started.
#[napi(js_name = "loadDeferredReturn")]
pub async fn load_deferred_return(
    lookup: DeferredReturnLookup,
    policy: DispatchPolicy,
    encryption: Option<ContentEncryption>,
) -> napi::Result<Option<DeferredReturn>> {
    for (name, value, limit) in [
        ("organization identity", &lookup.organization_id, 512),
        ("session identity", &lookup.session_id, 1024),
        ("spawn call id", &lookup.spawn_call_id, 1024),
    ] {
        if value.is_empty() || value.len() > limit || value.chars().any(char::is_control) {
            return Err(invalid_input(format!("invalid {name}")));
        }
    }
    let policy: deployments::HostedPolicy = policy.try_into()?;
    let result = AssertUnwindSafe(async move {
        let state = initialized().await?.encrypted(encryption)?;
        let key = SessionKey::new(&lookup.organization_id, &lookup.session_id);
        let root = crate::session::recorded_root(&Sql(&state.store), &key)?;
        let line = crate::lines::Line {
            organization_id: lookup.organization_id.clone(),
            variant: state.variant_of(&lookup.organization_id, root.as_deref())?,
        };
        on_deployment(&state, &line, &policy, |pinned| {
            deferred_return(pinned, lookup.clone())
        })
        .await
    })
    .catch_unwind()
    .await;
    match result {
        Ok(result) => result,
        Err(_) => Err(panicked(
            "OpenAPPA panicked while reading a deferred return",
        )),
    }
}

async fn deferred_return(
    state: State,
    lookup: DeferredReturnLookup,
) -> napi::Result<Option<DeferredReturn>> {
    let leased = state.lease().await?;
    tokio::task::spawn_blocking(move || {
        let key = SessionKey::new(&lookup.organization_id, &lookup.session_id);
        let session = Sql(&leased.state.store).with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT root, parent_id FROM openappa_sessions WHERE organization_id = $1 AND actor = $2",
                    &[&key.organization_id, &key.actor],
                )?
                .map(|row| (row.get::<_, String>(0), row.get::<_, Option<String>>(1))))
        })?;
        let Some((root, parent_id)) = session else {
            return Ok(None);
        };
        let actor = expected_actor(&root, &lookup.session_id, parent_id.as_deref());
        let presentation = EmbeddedPresentationOptions {
            control_tool: lookup.control_tool,
            supports_delegation: lookup.supports_delegation,
            include_display_plan: true,
            yell_tool: lookup.yell_tool,
        };
        let notice = leased
            .state
            .runtime
            .deferred_return(
                &actor,
                &spawn_operation_id(&lookup.spawn_call_id),
                &presentation,
            )
            .map_err(read_failure)?;
        Ok(notice.map(|notice| DeferredReturn {
            notice: notice.feedback,
            accept: notice.accept.as_str().to_owned(),
            discard: notice.discard.as_str().to_owned(),
        }))
    })
    .await
    .map_err(panicked)?
}

pub(crate) fn read_failure(read: EmbeddedPeerError) -> napi::Error {
    match read {
        EmbeddedPeerError::Storage(detail) => {
            storage(format!("OpenAPPA deferred return read failed: {detail}"))
        }
        EmbeddedPeerError::Refused(detail) => {
            failure(Failure::Refused(RefusalClass::Trajectory), detail)
        }
    }
}
