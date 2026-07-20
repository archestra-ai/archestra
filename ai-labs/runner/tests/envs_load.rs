//! The repo's real `envs/` + `tasks/` must load with the current schema — a task.toml or env toml
//! that drifts from the parser fails here instead of at run start.
use std::path::Path;

#[test]
fn repo_envs_and_tasks_load() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("envs");
    let envs = archestra_bench::config::load_envs(&root).expect("repo envs must load");
    let basic = &envs["basic"];
    let ticket = basic
        .tasks
        .iter()
        .find(|t| t.id == "it-ticket-status")
        .expect("it-ticket-status is a basic task");
    let prompt = ticket
        .agent_system_prompt
        .as_deref()
        .expect("it-ticket-status overrides the agent prompt");
    assert!(
        prompt.contains("acme_it__ticket_lookup"),
        "override must carry the stale tool name"
    );
    // Every other basic task stays on the env's shared agent.
    assert!(
        basic
            .tasks
            .iter()
            .all(|t| t.id == "it-ticket-status" || t.agent_system_prompt.is_none()),
        "unexpected agent override in basic"
    );
}
