pub mod audit_log;
pub mod interaction_settlement;
mod labels;
pub mod llm_usage_rollup;
mod managed_auth;
pub mod mcp_agent;
pub mod mcp_agent_skill_policy;
pub mod mcp_agent_tools;
pub mod mcp_apps;
pub mod mcp_catalog;
pub mod mcp_hooks;
pub mod mcp_interaction;
pub mod mcp_knowledge;
pub mod mcp_limits;
pub mod mcp_models;
pub mod mcp_projects;
pub mod mcp_reload;
pub mod mcp_schedule_runs;
pub mod mcp_sessions;
pub mod mcp_teams;
pub mod mcp_transcript;
pub mod mcp_usage;
pub mod minute_spend;
mod pool;
pub mod site_notification;
pub mod tasks;
pub mod throughput_admission;
mod throughput_counter;

use diesel_async::RunQueryDsl;
pub use pool::{PgPool, pilot_pool};
use time::{
    Duration as TimeDuration, OffsetDateTime, error::Parse, format_description::well_known::Rfc3339,
};

pub async fn is_ready(pool: &PgPool) -> bool {
    let Ok(mut connection) = pool.get().await else {
        return false;
    };
    diesel::sql_query("SELECT 1")
        .execute(&mut connection)
        .await
        .is_ok()
}

/// Public route dates have JavaScript Date's millisecond precision.
pub fn parse_api_datetime(value: &str) -> Result<OffsetDateTime, Parse> {
    let date = OffsetDateTime::parse(value, &Rfc3339)?;
    Ok(date - TimeDuration::nanoseconds(i64::from(date.nanosecond() % 1_000_000)))
}
