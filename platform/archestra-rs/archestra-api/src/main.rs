mod audit_log;
mod interaction_settlement;
mod mcp_agent;
mod mcp_agent_skill_policy;
mod mcp_agent_tools;
mod mcp_apps;
mod mcp_catalog;
mod mcp_discover;
mod mcp_dispatch;
mod mcp_hooks;
mod mcp_interaction;
mod mcp_knowledge;
mod mcp_limits;
mod mcp_models;
mod mcp_projects;
mod mcp_remote;
mod mcp_schedule_runs;
mod mcp_subscription;
mod mcp_teams;
mod mcp_transcript;
mod mcp_usage;
mod mcp_whoami;
mod openai_delegation;
mod openai_runtime_proof;
mod openai_sse;
mod openai_stream;
mod openai_tool_release;
mod site_notification;
mod transcript_condensation;

use std::{
    error::Error,
    fs, io,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use axum::{
    Router,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    routing::post,
};
use tokio::{
    net::UnixListener,
    signal::unix::{SignalKind, signal},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let socket = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("usage: archestra-api <absolute Unix socket path>"))?;
    let database_url =
        std::env::var("ARCHESTRA_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"))?;
    let pool = archestra_db::pilot_pool(&database_url).await?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    let (listener, _socket) = bind_private(&socket)?;
    let mut app = Router::new()
        .route("/internal/v1/ready", post(ready))
        .route("/internal/v1/audit-logs/list", post(audit_log::list))
        .route("/internal/v1/mcp/discover", post(mcp_discover::discover))
        .route("/internal/v1/mcp/tools/whoami", post(mcp_whoami::execute))
        .route("/internal/v1/mcp/tools/list-teams", post(mcp_teams::list))
        .route(
            "/internal/v1/mcp/tools/create-team",
            post(mcp_teams::create),
        )
        .route("/internal/v1/mcp/tools/edit-team", post(mcp_teams::edit))
        .route(
            "/internal/v1/mcp/tools/delete-team",
            post(mcp_teams::delete),
        )
        .route(
            "/internal/v1/mcp/tools/add-team-member",
            post(mcp_teams::add_member),
        )
        .route(
            "/internal/v1/mcp/tools/update-team-member-role",
            post(mcp_teams::update_member_role),
        )
        .route(
            "/internal/v1/mcp/tools/remove-team-member",
            post(mcp_teams::remove_member),
        )
        .route("/internal/v1/mcp/tools/get-limits", post(mcp_limits::list))
        .route(
            "/internal/v1/mcp/tools/create-limit",
            post(mcp_limits::create),
        )
        .route(
            "/internal/v1/mcp/tools/update-limit",
            post(mcp_limits::update),
        )
        .route(
            "/internal/v1/mcp/tools/delete-limit",
            post(mcp_limits::delete),
        )
        .route("/internal/v1/mcp/tools/list-hooks", post(mcp_hooks::list))
        .route(
            "/internal/v1/mcp/tools/create-hook",
            post(mcp_hooks::create),
        )
        .route(
            "/internal/v1/mcp/tools/update-hook",
            post(mcp_hooks::update),
        )
        .route(
            "/internal/v1/mcp/tools/delete-hook",
            post(mcp_hooks::delete),
        )
        .route("/internal/v1/mcp/tools/get-agent", post(mcp_agent::read))
        .route(
            "/internal/v1/mcp/tools/assign-agent-tool",
            post(mcp_agent_tools::assign),
        )
        .route(
            "/internal/v1/mcp/tools/remove-agent-tool",
            post(mcp_agent_tools::remove),
        )
        .route(
            "/internal/v1/mcp/tools/patch-agent-skill-policy",
            post(mcp_agent_skill_policy::patch).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/set-app-lock",
            post(mcp_apps::set_lock),
        )
        .route(
            "/internal/v1/mcp/tools/set-app-tools",
            post(mcp_apps::replace_tools),
        )
        .route(
            "/internal/v1/mcp/tools/delete-app",
            post(mcp_apps::delete_app),
        )
        .route(
            "/internal/v1/mcp/tools/set-app-labels",
            post(mcp_apps::replace_labels).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/scaffold-app",
            post(mcp_apps::scaffold).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/edit-app",
            post(mcp_apps::edit_app).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/refine-app",
            post(mcp_apps::refine_app).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/publish-app",
            post(mcp_apps::publish_app),
        )
        .route(
            "/internal/v1/mcp/tools/edit-mcp-description",
            post(mcp_catalog::edit_description).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/edit-mcp-config",
            post(mcp_catalog::edit_config).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/create-mcp-server",
            post(mcp_catalog::create).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/deploy-mcp-server",
            post(mcp_catalog::deploy),
        )
        .route(
            "/internal/v1/mcp/tools/reload-mcp-server-tools",
            post(mcp_catalog::reload_write).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/create-agent",
            post(mcp_agent::create_agent).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/create-gateway",
            post(mcp_agent::create_gateway),
        )
        .route(
            "/internal/v1/mcp/tools/gateway-version",
            post(mcp_agent::persist_gateway_version),
        )
        .route(
            "/internal/v1/mcp/tools/enable-gateway-all-tools",
            post(mcp_agent::enable_gateway_all_tools),
        )
        .route(
            "/internal/v1/mcp/tools/edit-gateway",
            post(mcp_agent::edit_gateway),
        )
        .route(
            "/internal/v1/mcp/tools/edit-agent",
            post(mcp_agent::edit_agent).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/edit-gateway-assignments",
            post(mcp_agent::replace_gateway_assignments),
        )
        .route(
            "/internal/v1/mcp/tools/assign-gateway-delegation",
            post(mcp_agent::assign_gateway_delegation),
        )
        .route(
            "/internal/v1/mcp/tools/get-agent-by-name",
            post(mcp_agent::find_name).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/get-project",
            post(mcp_projects::read),
        )
        .route(
            "/internal/v1/mcp/tools/link-project-app",
            post(mcp_projects::link_app),
        )
        .route(
            "/internal/v1/mcp/tools/unlink-project-app",
            post(mcp_projects::unlink_app),
        )
        .route(
            "/internal/v1/mcp/tools/list-projects",
            post(mcp_projects::list).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/get-llm-interaction",
            post(mcp_interaction::read),
        )
        .route(
            "/internal/v1/mcp/tools/list-llm-interactions",
            post(mcp_interaction::list),
        )
        .route(
            "/internal/v1/mcp/tools/list-llm-sessions",
            post(mcp_interaction::sessions),
        )
        .route(
            "/internal/v1/mcp/tools/get-llm-session-logs",
            post(mcp_interaction::session_logs),
        )
        .route(
            "/internal/v1/mcp/tools/get-schedule-trigger-run-transcript",
            post(mcp_transcript::select),
        )
        .route(
            "/internal/v1/mcp/tools/list-llm-models",
            post(mcp_models::list),
        )
        .route(
            "/internal/v1/mcp/tools/get-knowledge-base",
            post(mcp_knowledge::read),
        )
        .route(
            "/internal/v1/mcp/tools/delete-knowledge-base",
            post(mcp_knowledge::delete),
        )
        .route(
            "/internal/v1/mcp/tools/update-knowledge-base",
            post(mcp_knowledge::update),
        )
        .route(
            "/internal/v1/mcp/tools/create-knowledge-base",
            post(mcp_knowledge::create),
        )
        .route(
            "/internal/v1/mcp/tools/get-knowledge-connector",
            post(mcp_knowledge::connector),
        )
        .route(
            "/internal/v1/mcp/tools/delete-knowledge-connector",
            post(mcp_knowledge::delete_connector),
        )
        .route(
            "/internal/v1/mcp/tools/update-knowledge-connector",
            post(mcp_knowledge::update_connector),
        )
        .route(
            "/internal/v1/mcp/tools/create-knowledge-connector",
            post(mcp_knowledge::create_connector),
        )
        .route(
            "/internal/v1/mcp/tools/assign-connector-to-knowledge-base",
            post(mcp_knowledge::assign_connector),
        )
        .route(
            "/internal/v1/mcp/tools/unassign-connector-from-knowledge-base",
            post(mcp_knowledge::unassign_connector),
        )
        .route(
            "/internal/v1/mcp/tools/assign-knowledge-base-to-agent",
            post(mcp_knowledge::assign_knowledge_base_to_agent),
        )
        .route(
            "/internal/v1/mcp/tools/unassign-knowledge-base-from-agent",
            post(mcp_knowledge::unassign_knowledge_base_from_agent),
        )
        .route(
            "/internal/v1/mcp/tools/assign-connector-to-agent",
            post(mcp_knowledge::assign_connector_to_agent),
        )
        .route(
            "/internal/v1/mcp/tools/unassign-connector-from-agent",
            post(mcp_knowledge::unassign_connector_from_agent),
        )
        .route(
            "/internal/v1/mcp/tools/get-knowledge-connectors",
            post(mcp_knowledge::connectors).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/get-knowledge-bases",
            post(mcp_knowledge::list).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/mcp/tools/get-schedule-trigger",
            post(mcp_schedule_runs::trigger),
        )
        .route(
            "/internal/v1/mcp/tools/create-schedule-trigger",
            post(mcp_schedule_runs::create_trigger),
        )
        .route(
            "/internal/v1/mcp/tools/update-schedule-trigger",
            post(mcp_schedule_runs::update_trigger),
        )
        .route(
            "/internal/v1/mcp/tools/delete-schedule-trigger",
            post(mcp_schedule_runs::delete_trigger),
        )
        .route(
            "/internal/v1/mcp/tools/create-manual-schedule-run",
            post(mcp_schedule_runs::create_manual_run),
        )
        .route(
            "/internal/v1/mcp/tools/list-schedule-triggers",
            post(mcp_schedule_runs::triggers),
        )
        .route(
            "/internal/v1/mcp/tools/get-schedule-trigger-run",
            post(mcp_schedule_runs::read),
        )
        .route(
            "/internal/v1/mcp/tools/list-schedule-trigger-runs",
            post(mcp_schedule_runs::list),
        )
        .route(
            "/internal/v1/mcp/tools/list-team-members",
            post(mcp_teams::members),
        )
        .route(
            "/internal/v1/mcp/tools/list-team-external-groups",
            post(mcp_teams::external_groups),
        )
        .route(
            "/internal/v1/mcp/tools/add-team-external-group",
            post(mcp_teams::add_external_group),
        )
        .route(
            "/internal/v1/mcp/tools/remove-team-external-group",
            post(mcp_teams::remove_external_group),
        )
        .route(
            "/internal/v1/mcp/tools/agent-token-usage",
            post(mcp_usage::read),
        )
        .route(
            "/internal/v1/mcp/subscription",
            post(mcp_subscription::subscribe),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .route(
            "/internal/v1/mcp/dispatch",
            post(mcp_dispatch::dispatch).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/site-notification/replace",
            post(site_notification::replace).layer(DefaultBodyLimit::max(72 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/interactions/settle",
            post(interaction_settlement::settle).layer(DefaultBodyLimit::max(144 * 1024 * 1024)),
        )
        .route(
            "/internal/v1/interactions/settle-minute-spend",
            post(interaction_settlement::minute_spend),
        )
        .route(
            "/internal/v1/interactions/reconcile-tokens",
            post(interaction_settlement::reconcile_tokens),
        )
        .route(
            "/internal/v1/interactions/refund-unsent",
            post(interaction_settlement::refund_unsent),
        )
        .route(
            "/internal/v1/interactions/admit-throughput",
            post(interaction_settlement::admit_throughput),
        )
        .route(
            "/internal/v1/interactions/link-session-titles",
            post(interaction_settlement::link_session_titles),
        )
        .route(
            "/internal/v1/interactions/stamp-agent-use",
            post(interaction_settlement::stamp_agent_use),
        )
        .route(
            "/internal/v1/interactions/record-legacy-usage",
            post(interaction_settlement::record_legacy_usage),
        )
        .route(
            "/internal/v1/interactions/mark-pool-attempt-failed-over",
            post(interaction_settlement::mark_pool_attempt_failed_over),
        )
        .with_state(pool);
    app = app
        .merge(mcp_remote::router()?)
        .merge(transcript_condensation::router());
    if let Some(upstream) = openai_stream::Upstream::from_env()? {
        app = app
            .merge(openai_stream::router(upstream))
            .merge(openai_runtime_proof::router())
            .merge(openai_delegation::router())
            .merge(openai_tool_release::router());
    }
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = terminate.recv() => {},
                _ = interrupt.recv() => {},
            }
        })
        .await?;
    Ok(())
}

async fn ready(State(pool): State<archestra_db::PgPool>) -> StatusCode {
    if archestra_db::is_ready(&pool).await {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

fn bind_private(path: &Path) -> io::Result<(UnixListener, SocketCleanup)> {
    let parent = path
        .parent()
        .filter(|_| path.is_absolute())
        .ok_or_else(|| io::Error::other("expected an absolute socket path"))?;
    let metadata = fs::symlink_metadata(parent)?;
    if !metadata.is_dir() || metadata.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::other("socket directory must be private (0700)"));
    }
    let listener = UnixListener::bind(path)?;
    let cleanup = SocketCleanup(path.to_owned());
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok((listener, cleanup))
}

struct SocketCleanup(PathBuf);

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn audit_socket_requires_a_private_directory_and_is_removed_on_shutdown() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("audit.sock");
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(bind_private(&path).is_err());
        assert!(!path.exists());

        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let (_listener, cleanup) = bind_private(&path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(bind_private(&path).is_err());
        drop(cleanup);
        assert!(!path.exists());
    }
}
