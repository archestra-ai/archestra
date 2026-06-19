use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use archestra_bench_core::slug;
use chrono::Utc;
use futures::StreamExt;
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;
use tokio::time::{Duration, timeout};
use tracing::{error, info, warn};

use crate::chat_stream::{ChatRecordKind, ChatRunResult, ChatStreamRecord, apply_chat_event};
use crate::client::{AgentCreate, EvalClient, FilePart};
use crate::config::types::{EnvConfig, Stage, Task, ToolExposureMode};
use crate::config::{Lane, load_envs, load_lanes};
use crate::lifecycle::Instance;
use crate::mcp_lock;
use crate::mcp_server::{BenchmarkMcp, Submission};
use crate::results::{Outcome, RunResult, render_markdown};
use crate::seeding::{
    ResolvedModel, ensure_provider_and_models, register_remote_mcp, seed_mcp_fixtures,
    seed_skill_ref, tool_name,
};
use crate::verify::{VerifyOutcome, run_verifier};

// Model-visible MCP server name (tools surface as `<name>[-<token>]__submit_result`). Kept neutral so
// the agent is not cued that it is being evaluated, which can shift model behavior.
// The name must never encode lane/model identity or position. Shared-backend envs append an opaque
// random token (registry names must be unique per backend, and tool auto-assignment is disabled so a
// lane only ever discovers its own server); isolated lanes own their backend and use the bare name.
const BENCH_MCP_NAME: &str = "final_answer";
const SUBMIT_TOOL_SUFFIX: &str = "__submit_result";
// Appended to every user message. Kept short and tool-agnostic: it nudges submission without naming
// the search/run meta-tools (Archestra's stock prompt already explains discovery), so a model that
// solves the task still closes the loop by finding and calling its submit tool instead of replying in
// prose.
const SUBMIT_INSTRUCTION: &str = "When you are done, find a tool to submit your final result -- replying in chat does not submit it.";
// One-shot follow-up sent when a lane ends its turn without submitting. drive_stage still appends
// SUBMIT_INSTRUCTION, so this only has to call out the omission.
const SUBMIT_NUDGE: &str = "You ended your turn without submitting a result. The task is not complete until you submit it.";
const STATE_NAME: &str = "state.json";
const MAX_WORKERS_CAP: usize = 4;
// Last-resort net for a wedged backend: if the chat stream emits nothing for this long, give up on
// the stage. Set above the backend's 10-min stale-run reaper so that backstop wins in the normal
// case and this only fires when the backend stops emitting entirely.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

const REQUIRED_TOOL_SHORT_NAMES: &[&str] = &[
    "artifact_write",
    "todo_write",
    "run_command",
    "upload_file",
    "download_file",
    "list_skills",
    "load_skill",
];
const MUTATING_SKILL_TOOL_SHORT_NAMES: &[&str] = &["create_skill", "update_skill"];

#[derive(Debug, Clone)]
pub struct EnvPlan {
    pub env: EnvConfig,
    pub tasks: Vec<Task>,
    pub lanes: Vec<Lane>,
}

impl EnvPlan {
    pub fn share_backend(&self) -> bool {
        self.env.share_backend
    }
}

#[derive(Debug, Clone)]
pub struct RunCtx {
    pub root_run_dir: PathBuf,
    pub run_id: String,
    pub api_keys: HashMap<String, String>,
    /// Where `envs/<id>.toml` and their `*.mcp.lock` siblings live, for the MCP tool-surface pin.
    pub envs_dir: PathBuf,
    /// Rewrite each env's `*.mcp.lock` from the observed surface instead of enforcing it.
    pub update_mcp_lock: bool,
}

/// What a completed [`run`] produced: the per-rollout results plus the run directory they were written
/// to, so a caller like the `full` CLI can hand the dir straight to the analyzer.
pub struct RunOutcome {
    pub results: Vec<RunResult>,
    pub run_dir: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("config error: {0}")]
    Config(String),
    #[error("client error: {0}")]
    Client(#[from] crate::client::ClientError),
    #[error("lifecycle error: {0}")]
    Lifecycle(#[from] crate::lifecycle::LifecycleError),
    #[error("seeding error: {0}")]
    Seeding(#[from] crate::seeding::SeedingError),
    #[error("verify error: {0}")]
    Verify(#[from] crate::verify::VerifyError),
    #[error("MCP error: {0}")]
    Mcp(String),
    #[error("artifact directory already exists: {0}")]
    ArtifactExists(PathBuf),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

pub async fn run(
    bench_dir: &Path,
    env_filter: Option<&str>,
    task_filter: Option<&str>,
    lanes_filter: Option<&str>,
    lanes_file: Option<&Path>,
    out: Option<&Path>,
    run_dir: Option<&Path>,
    max_workers: Option<usize>,
    update_mcp_lock: bool,
) -> Result<RunOutcome, RunError> {
    let envs_dir = bench_dir.join("envs");
    let envs = load_envs(&envs_dir).map_err(|e| RunError::Config(e.to_string()))?;
    let default_lanes_path = bench_dir.join("lanes.toml");
    let lanes_path = lanes_file.unwrap_or(&default_lanes_path);
    let lane_list =
        load_lanes(lanes_path, lanes_filter).map_err(|e| RunError::Config(e.to_string()))?;
    let workers = resolve_workers(max_workers, lane_list.len());
    let api_keys = lane_api_keys(&lane_list)?;

    // An explicit `--run-dir` is reused (create_dir_all); an auto dir must be brand-new — the base name
    // is seconds-granular, so two runs started in the same second would otherwise share a root and
    // overwrite each other's config.json/aggregate.json.
    let (root_run_dir, run_id) = match run_dir {
        Some(p) => {
            fs::create_dir_all(p).await?;
            (p.to_path_buf(), run_id())
        }
        None => create_fresh_run_dir(bench_dir).await?,
    };

    let selected = select_envs(&envs, env_filter, task_filter)?;
    let plan = build_run_plan(selected, lane_list);

    write_run_config(&root_run_dir, &run_id, &plan, workers).await?;

    let ctx = RunCtx {
        root_run_dir,
        run_id,
        api_keys,
        envs_dir,
        update_mcp_lock,
    };

    let results = execute_plan(plan, ctx.clone(), workers).await;

    let results = crate::results::build_report(results).map_err(RunError::Config)?;
    let report = render_markdown(&results);
    write_report(&report, out).await?;

    let aggregate = crate::results::aggregate(&results);
    let aggregate_path = ctx.root_run_dir.join("aggregate.json");
    fs::write(
        &aggregate_path,
        serde_json::to_string_pretty(&aggregate.to_json()).unwrap_or_default() + "\n",
    )
    .await?;

    Ok(RunOutcome {
        results,
        run_dir: ctx.root_run_dir,
    })
}

fn resolve_workers(requested: Option<usize>, lane_count: usize) -> usize {
    match requested {
        Some(n) => n.max(1),
        None => lane_count.clamp(1, MAX_WORKERS_CAP),
    }
}

fn lane_api_keys(lanes: &[Lane]) -> Result<HashMap<String, String>, RunError> {
    let mut keys = HashMap::new();
    for lane in lanes {
        let key = std::env::var(lane.key_env()).map_err(|_| {
            RunError::Config(format!(
                "set {} to seed lane {:?} ({})",
                lane.key_env(),
                lane.name,
                lane.provider
            ))
        })?;
        keys.insert(lane.name.clone(), key);
    }
    Ok(keys)
}

fn build_run_plan(selected: Vec<(EnvConfig, Vec<Task>)>, lanes: Vec<Lane>) -> Vec<EnvPlan> {
    selected
        .into_iter()
        .map(|(env, tasks)| EnvPlan {
            env,
            tasks,
            lanes: lanes.clone(),
        })
        .collect()
}

/// Scheduling skeleton for the lane-grouped executor: per distinct lane, the plan-ordered list of
/// `(env index, env shares a backend)` it must run. Lanes are global (every `EnvPlan` carries the same
/// list), taken from the first env; an env contributes a stop only for the lanes it actually carries.
fn lane_stop_plan(plan: &[EnvPlan]) -> Vec<(Lane, Vec<(usize, bool)>)> {
    let lanes = plan.first().map(|p| p.lanes.clone()).unwrap_or_default();
    lanes
        .into_iter()
        .map(|lane| {
            let stops = plan
                .iter()
                .enumerate()
                .filter(|(_, ep)| ep.lanes.iter().any(|l| l.name == lane.name))
                .map(|(i, ep)| (i, ep.share_backend()))
                .collect();
            (lane, stops)
        })
        .collect()
}

fn select_envs(
    envs: &HashMap<String, EnvConfig>,
    env_filter: Option<&str>,
    task_filter: Option<&str>,
) -> Result<Vec<(EnvConfig, Vec<Task>)>, RunError> {
    let env_names = archestra_bench_core::split_names(env_filter);
    let chosen: Vec<EnvConfig> = match env_names {
        None => {
            let mut names: Vec<_> = envs.keys().cloned().collect();
            names.sort();
            names.into_iter().map(|n| envs[&n].clone()).collect()
        }
        Some(names) => {
            let mut unknown = Vec::new();
            let mut chosen = Vec::new();
            for name in names {
                match envs.get(&name) {
                    Some(env) => chosen.push(env.clone()),
                    None => unknown.push(name),
                }
            }
            if !unknown.is_empty() {
                return Err(RunError::Config(format!(
                    "unknown env(s) {:?}; choose from {:?}",
                    unknown,
                    envs.keys().collect::<Vec<_>>()
                )));
            }
            chosen
        }
    };

    let task_names = archestra_bench_core::split_names(task_filter);
    let mut selected = Vec::new();
    let mut matched = HashSet::new();
    for env in chosen {
        let tasks: Vec<Task> = match &task_names {
            None => env.tasks.clone(),
            Some(names) => {
                let tasks: Vec<_> = env
                    .tasks
                    .iter()
                    .filter(|t| names.contains(&t.id))
                    .cloned()
                    .collect();
                matched.extend(tasks.iter().map(|t| t.id.clone()));
                tasks
            }
        };
        if !tasks.is_empty() {
            selected.push((env, tasks));
        }
    }

    if let Some(names) = task_names {
        let unknown_tasks: Vec<_> = names.into_iter().filter(|n| !matched.contains(n)).collect();
        if !unknown_tasks.is_empty() {
            return Err(RunError::Config(format!(
                "task(s) {:?} not found in the selected env(s)",
                unknown_tasks
            )));
        }
    }
    if selected.is_empty() {
        return Err(RunError::Config(
            "no tasks selected; check the --env/--task filters".to_string(),
        ));
    }
    Ok(selected)
}

/// A shared-backend env's per-lane agent + MCP, prepared up front so a lane worker can run that env's
/// tasks against the already-booted shared backend.
struct SharedLaneSetup {
    client: EvalClient,
    agent_id: String,
    submit_tool: String,
    mcp: BenchmarkMcp,
    resolved: ResolvedModel,
}

/// One unit of work for a lane: that lane's tasks against a single env. A lane drains its stops serially.
enum EnvStop {
    Shared {
        env: EnvConfig,
        tasks: Vec<Task>,
        // Boxed: SharedLaneSetup is far larger than the Isolated variant (clippy::large_enum_variant).
        setup: Box<SharedLaneSetup>,
    },
    Isolated {
        env: EnvConfig,
        tasks: Vec<Task>,
    },
}

async fn execute_plan(plan: Vec<EnvPlan>, ctx: RunCtx, max_workers: usize) -> Vec<RunResult> {
    let total_rollouts: usize = plan.iter().map(|p| p.tasks.len() * p.lanes.len()).sum();
    let distinct_lanes = plan.first().map(|p| p.lanes.len()).unwrap_or(0);
    let mp = MultiProgress::new();
    note(
        &mp,
        format!("● {total_rollouts} rollouts · {distinct_lanes} lanes · {max_workers} workers\n"),
    );
    let progress = mp.add(ProgressBar::new(total_rollouts as u64));
    progress.set_style(
        ProgressStyle::with_template(
            "  run     {bar:30.cyan/blue} {pos}/{len} [{elapsed_precise}<{eta_precise}] {msg}",
        )
        .expect("static progress template")
        .progress_chars("━━─"),
    );

    // Lane-grouped scheduling: one serial worker per distinct lane, draining that lane's work across
    // every env in plan order. A given model therefore never runs two rollouts at once (rate-limit safety),
    // and there is no env barrier. `lane_stop_plan` is the ordering authority.
    let skeleton = lane_stop_plan(&plan);

    // Setup phase (serial, up front): boot + seed every shared-env backend and keep it alive for the
    // whole run. Isolated lanes boot their own backend lazily inside the worker. A shared env that fails
    // setup is reported as a whole-env infra failure and contributes no stops.
    let mut shared_setups: Vec<Option<HashMap<String, SharedLaneSetup>>> =
        plan.iter().map(|_| None).collect();
    let mut shared_instances: Vec<Instance> = Vec::new();
    let mut infra: Vec<RunResult> = Vec::new();
    for (i, env_plan) in plan.iter().enumerate() {
        if env_plan.share_backend() {
            match setup_shared_env(env_plan, &ctx).await {
                Ok((instance, setups)) => {
                    shared_instances.push(instance);
                    shared_setups[i] = Some(setups);
                }
                Err(e) => infra.extend(infra_results(env_plan, &ctx, &progress, &e)),
            }
        }
    }

    // Build each lane's owned stop list from the skeleton + live setups (serial — no contention).
    let mut lane_work: Vec<(Lane, Vec<EnvStop>)> = Vec::new();
    for (lane, stops) in skeleton {
        let mut owned = Vec::new();
        for (env_idx, shared) in stops {
            let env_plan = &plan[env_idx];
            if shared {
                if let Some(setup) = shared_setups[env_idx]
                    .as_mut()
                    .and_then(|m| m.remove(&lane.name))
                {
                    owned.push(EnvStop::Shared {
                        env: env_plan.env.clone(),
                        tasks: env_plan.tasks.clone(),
                        setup: Box::new(setup),
                    });
                }
            } else {
                owned.push(EnvStop::Isolated {
                    env: env_plan.env.clone(),
                    tasks: env_plan.tasks.clone(),
                });
            }
        }
        lane_work.push((lane, owned));
    }

    // Fan out over lanes; each lane owns its stop list and drains it serially.
    let lane_futures = lane_work.into_iter().map(|(lane, stops)| {
        let ctx = ctx.clone();
        let progress = progress.clone();
        async move {
            let mut out = Vec::new();
            for stop in stops {
                match stop {
                    EnvStop::Shared { env, tasks, setup } => {
                        let setup = *setup;
                        let client = setup.client.sibling().await;
                        out.extend(
                            run_lane(
                                client,
                                env,
                                tasks,
                                lane.clone(),
                                setup.mcp,
                                setup.submit_tool,
                                setup.agent_id,
                                ctx.root_run_dir.clone(),
                                setup.resolved,
                                progress.clone(),
                            )
                            .await,
                        );
                    }
                    EnvStop::Isolated { env, tasks } => {
                        out.extend(
                            run_isolated_lane(
                                env,
                                tasks,
                                lane.clone(),
                                ctx.clone(),
                                progress.clone(),
                            )
                            .await,
                        );
                    }
                }
            }
            out
        }
    });

    let lane_results: Vec<Vec<RunResult>> = futures::stream::iter(lane_futures)
        .buffer_unordered(max_workers)
        .collect()
        .await;

    for instance in &shared_instances {
        let _ = instance.shutdown().await;
    }

    progress.finish_and_clear();
    infra
        .into_iter()
        .chain(lane_results.into_iter().flatten())
        .collect()
}

/// Persistent status line that survives a non-TTY target (piped/CI/`NO_COLOR`), where
/// `MultiProgress::println` is a no-op — fall back to stderr there so operators still see it.
fn note(mp: &MultiProgress, msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    if mp.is_hidden() {
        eprintln!("{msg}");
    } else {
        let _ = mp.println(msg);
    }
}

/// Cancel the in-process server task of every prepared benchmark MCP — called on a setup-error path so a
/// partially-prepared env doesn't leak listener tasks for the rest of the run.
async fn stop_mcps(setups: &[(Lane, String, String, BenchmarkMcp)]) {
    for (_, _, _, mcp) in setups {
        mcp.stop().await;
    }
}

/// Boot + seed one shared backend for the env (serial, up front), creating a per-lane agent + benchmark
/// MCP. Returns the live `Instance` (the caller keeps it alive for the whole run and tears it down at the
/// end) plus the per-lane setup map. On any setup error the instance is torn down and the whole env is
/// reported as an infra failure by the caller. `resolve_lanes` and `warm_user_token` stay here, before
/// any lane future runs: model-resolution failure is whole-env-infra-fail, and the warm call pre-creates
/// the shared gateway token once so concurrent lanes don't race the insert.
async fn setup_shared_env(
    env_plan: &EnvPlan,
    ctx: &RunCtx,
) -> Result<(Instance, HashMap<String, SharedLaneSetup>), String> {
    let env = &env_plan.env;
    let log_path = ctx
        .root_run_dir
        .join(format!("{}.backend.log", slug(&env.id)));
    let mut instance = Instance::new(repo_root(), format!("{}-{}", ctx.run_id, env.id), log_path);
    instance.start().await.map_err(|e| e.to_string())?;

    let client = instance.client.clone();
    let resolved = match resolve_lanes(&client, &env_plan.lanes, ctx).await {
        Ok(r) => r,
        Err(e) => {
            let _ = instance.shutdown().await;
            return Err(e.to_string());
        }
    };

    if let Err(e) = client.enable_skill_defaults().await {
        let _ = instance.shutdown().await;
        return Err(e.to_string());
    }

    if let Err(e) = client.disable_tool_auto_assignment().await {
        let _ = instance.shutdown().await;
        return Err(e.to_string());
    }

    for sref in &env.skills {
        if let Err(e) = seed_skill_ref(
            &client,
            &sref.repo,
            sref.path.as_deref(),
            &sref.ref_,
            sref.cap,
            "org",
        )
        .await
        {
            let _ = instance.shutdown().await;
            return Err(e.to_string());
        }
    }

    let mut setups: Vec<(Lane, String, String, BenchmarkMcp)> = Vec::new();
    for lane in &env_plan.lanes {
        let token = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let mcp = match BenchmarkMcp::start(format!("{BENCH_MCP_NAME}-{token}")).await {
            Ok(m) => m,
            Err(e) => {
                stop_mcps(&setups).await;
                let _ = instance.shutdown().await;
                return Err(e.to_string());
            }
        };
        match setup_lane_agent(&client, env, lane, &mcp).await {
            Ok((agent_id, submit_tool)) => setups.push((lane.clone(), agent_id, submit_tool, mcp)),
            Err(e) => {
                mcp.stop().await;
                stop_mcps(&setups).await;
                let _ = instance.shutdown().await;
                return Err(e.to_string());
            }
        }
    }

    if !env.mcps.is_empty() {
        let agent_ids: Vec<String> = setups.iter().map(|(_, id, _, _)| id.clone()).collect();
        let registered = match seed_mcp_fixtures(&client, &env.mcps, "org", Some(&agent_ids)).await
        {
            Ok(registered) => registered,
            Err(e) => {
                stop_mcps(&setups).await;
                let _ = instance.shutdown().await;
                return Err(e.to_string());
            }
        };
        if let Err(e) = mcp_lock::enforce(
            &ctx.envs_dir,
            &env.id,
            &env.mcps,
            &registered,
            ctx.update_mcp_lock,
        ) {
            stop_mcps(&setups).await;
            let _ = instance.shutdown().await;
            return Err(e);
        }
    }

    if let Err(e) = client.warm_user_token().await {
        warn!("warm_user_token failed; lanes may race gateway-token insert (non-fatal): {e}");
    }

    let lane_setups = setups
        .into_iter()
        .map(|(lane, agent_id, submit_tool, mcp)| {
            let resolved = resolved[&lane.name].clone();
            (
                lane.name.clone(),
                SharedLaneSetup {
                    client: client.clone(),
                    agent_id,
                    submit_tool,
                    mcp,
                    resolved,
                },
            )
        })
        .collect();

    Ok((instance, lane_setups))
}

async fn run_isolated_lane(
    env: EnvConfig,
    tasks: Vec<Task>,
    lane: Lane,
    ctx: RunCtx,
    progress: ProgressBar,
) -> Vec<RunResult> {
    let log_path = ctx
        .root_run_dir
        .join(format!("{}__{}.backend.log", slug(&env.id), lane.slug()));
    let mut instance = Instance::new(
        repo_root(),
        format!("{}-{}-{}", ctx.run_id, env.id, lane.name),
        log_path,
    );
    if let Err(e) = instance.start().await {
        return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e.to_string());
    }

    let client = instance.client.clone();
    let resolved = match resolve_lanes(&client, std::slice::from_ref(&lane), &ctx).await {
        Ok(mut r) => r.remove(&lane.name).unwrap(),
        Err(e) => {
            let _ = instance.shutdown().await;
            return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e.to_string());
        }
    };

    if let Err(e) = client.enable_skill_defaults().await {
        let _ = instance.shutdown().await;
        return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e.to_string());
    }

    if let Err(e) = client.disable_tool_auto_assignment().await {
        let _ = instance.shutdown().await;
        return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e.to_string());
    }

    for sref in &env.skills {
        if let Err(e) = seed_skill_ref(
            &client,
            &sref.repo,
            sref.path.as_deref(),
            &sref.ref_,
            sref.cap,
            "org",
        )
        .await
        {
            let _ = instance.shutdown().await;
            return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e.to_string());
        }
    }

    let mcp = match BenchmarkMcp::start(BENCH_MCP_NAME).await {
        Ok(m) => m,
        Err(e) => {
            let _ = instance.shutdown().await;
            return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e.to_string());
        }
    };

    let (agent_id, submit_tool) = match setup_lane_agent(&client, &env, &lane, &mcp).await {
        Ok(s) => s,
        Err(e) => {
            mcp.stop().await;
            let _ = instance.shutdown().await;
            return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e.to_string());
        }
    };

    if !env.mcps.is_empty() {
        let registered = match seed_mcp_fixtures(
            &client,
            &env.mcps,
            "org",
            Some(std::slice::from_ref(&agent_id)),
        )
        .await
        {
            Ok(registered) => registered,
            Err(e) => {
                mcp.stop().await;
                let _ = instance.shutdown().await;
                return infra_results_for_lane(
                    &env,
                    &tasks,
                    &lane,
                    &ctx,
                    &progress,
                    &e.to_string(),
                );
            }
        };
        if let Err(e) = mcp_lock::enforce(
            &ctx.envs_dir,
            &env.id,
            &env.mcps,
            &registered,
            ctx.update_mcp_lock,
        ) {
            mcp.stop().await;
            let _ = instance.shutdown().await;
            return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e);
        }
    }

    let results = run_lane(
        client,
        env,
        tasks,
        lane,
        mcp,
        submit_tool,
        agent_id,
        ctx.root_run_dir.clone(),
        resolved,
        progress,
    )
    .await;
    let _ = instance.shutdown().await;
    results
}

fn infra_results(
    env_plan: &EnvPlan,
    ctx: &RunCtx,
    progress: &ProgressBar,
    error: &str,
) -> Vec<RunResult> {
    let mut results = Vec::new();
    for lane in &env_plan.lanes {
        results.extend(infra_results_for_lane(
            &env_plan.env,
            &env_plan.tasks,
            lane,
            ctx,
            progress,
            error,
        ));
    }
    results
}

fn infra_results_for_lane(
    env: &EnvConfig,
    tasks: &[Task],
    lane: &Lane,
    ctx: &RunCtx,
    progress: &ProgressBar,
    error: &str,
) -> Vec<RunResult> {
    let stamp = timestamp();
    let mut results = Vec::new();
    for task in tasks {
        let subdir = run_subdir(&env.id, &task.id, lane);
        let _ = std::fs::create_dir_all(ctx.root_run_dir.join(&subdir));
        let metadata = serde_json::json!({
            "env_id": env.id,
            "task_id": task.id,
            "lane": lane.name,
            "provider": lane.provider,
            "model": lane.model,
            "tool_exposure_mode": env.platform.tool_exposure_mode,
            "outcome": Outcome::AgentError.value(),
            "agent_error": format!("infra: {error}"),
            "finished_at": stamp,
        });
        let _ = std::fs::write(
            ctx.root_run_dir.join(&subdir).join("run.json"),
            serde_json::to_string_pretty(&metadata).unwrap_or_default() + "\n",
        );
        let _ = std::fs::write(
            ctx.root_run_dir.join(&subdir).join("trajectory.jsonl"),
            serde_json::to_string(&serde_json::json!({
                "sequence": 1,
                "timestamp": stamp,
                "kind": "infra_error",
                "error": format!("infra: {error}"),
            }))
            .unwrap_or_default()
                + "\n",
        );
        progress.inc(1);
        results.push(RunResult {
            env_id: env.id.clone(),
            task_id: task.id.clone(),
            lane: lane.name.clone(),
            provider: lane.provider.as_str().to_string(),
            model: lane.model.clone(),
            outcome: Outcome::AgentError,
            finish_reason: None,
            tool_call_count: 0,
            turn_count: 0,
            total_tokens: None,
            agent_error: Some(format!("infra: {error}")),
            stage_count: task.stages.len(),
            format_attempts: 0,
            artifact_dir: Some(ctx.root_run_dir.join(&subdir).to_string_lossy().to_string()),
        });
    }
    results
}

async fn resolve_lanes(
    client: &EvalClient,
    lanes: &[Lane],
    ctx: &RunCtx,
) -> Result<HashMap<String, ResolvedModel>, crate::seeding::SeedingError> {
    let mut resolved = HashMap::new();
    let mut seen_providers = HashSet::new();
    for lane in lanes {
        let is_primary = !seen_providers.contains(&lane.provider);
        seen_providers.insert(lane.provider);
        let models = ensure_provider_and_models(
            client,
            lane.provider.as_str(),
            &ctx.api_keys[&lane.name],
            std::slice::from_ref(&lane.model),
            lane.base_url.as_deref(),
            Some(&format!("bench-{}", lane.name)),
            is_primary,
            "personal",
            180.0,
            3.0,
        )
        .await?;
        resolved.insert(lane.name.clone(), models[&lane.model].clone());
    }
    Ok(resolved)
}

async fn setup_lane_agent(
    client: &EvalClient,
    env: &EnvConfig,
    lane: &Lane,
    mcp: &BenchmarkMcp,
) -> Result<(String, String), RunError> {
    let agent_id = ensure_agent(
        client,
        &format!("{}-{}", env.agent_name, lane.slug()),
        &env.agent_system_prompt,
        env.platform.tool_exposure_mode,
    )
    .await?;
    let submit_tool =
        setup_agent_tools(client, &agent_id, mcp.base_url(), &env.tools, mcp.name()).await?;
    Ok((agent_id, submit_tool))
}

async fn ensure_agent(
    client: &EvalClient,
    name: &str,
    system_prompt: &str,
    tool_exposure_mode: ToolExposureMode,
) -> Result<String, RunError> {
    let existing = client.list_agents(Some(name), Some("org")).await?;
    // Reuse by name is intra-run idempotency only: each run boots a fresh per-run database that
    // teardown drops (see lifecycle::Instance::start), so no agent created with a different
    // tool_exposure_mode can survive into a later run with a flipped flag.
    if let Some(agent) = existing
        .iter()
        .find(|a| a.get("name").and_then(|v| v.as_str()) == Some(name))
    {
        return Ok(agent
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string());
    }
    let created = client
        .create_agent(&AgentCreate {
            name: name.to_string(),
            scope: "org".to_string(),
            agent_type: "agent".to_string(),
            system_prompt: (!system_prompt.trim().is_empty()).then(|| system_prompt.to_string()),
            tool_exposure_mode,
        })
        .await?;
    Ok(created
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string())
}

async fn setup_agent_tools(
    client: &EvalClient,
    agent_id: &str,
    bench_url: &str,
    extra_tools: &[String],
    mcp_name: &str,
) -> Result<String, RunError> {
    let mut short_names: Vec<String> = REQUIRED_TOOL_SHORT_NAMES
        .iter()
        .map(|s| s.to_string())
        .collect();
    short_names.extend(extra_tools.iter().cloned());
    let tool_ids = resolve_tool_ids(client, &short_names).await?;
    let assignments: Vec<_> = tool_ids
        .values()
        .map(|tool_id| crate::client::ToolAssignment {
            agent_id: agent_id.to_string(),
            tool_id: tool_id.clone(),
        })
        .collect();
    let result = client.bulk_assign_tools(&assignments).await?;
    if let Some(failed) = result.get("failed").and_then(|v| v.as_array())
        && !failed.is_empty()
    {
        return Err(RunError::Config(format!(
            "failed to assign tools to the eval agent: {:?}",
            failed
        )));
    }

    let registered = register_remote_mcp(
        client,
        mcp_name,
        bench_url,
        "org",
        Some(&[agent_id.to_string()]),
    )
    .await?;
    let submit_tool = find_submit_tool(&registered.tools)?;
    let allowed: HashSet<String> = extra_tools
        .iter()
        .map(|n| format!("archestra__{n}"))
        .collect();
    strip_mutating_skill_tools(client, agent_id, &allowed).await?;
    assert_agent_tool_surface(client, agent_id, &submit_tool, &allowed).await?;
    Ok(submit_tool)
}

fn tools_to_strip(allowed: &HashSet<String>) -> HashSet<String> {
    MUTATING_SKILL_TOOL_SHORT_NAMES
        .iter()
        .map(|n| format!("archestra__{n}"))
        .filter(|full| !allowed.contains(full))
        .collect()
}

fn surface_violations(
    present: &HashSet<String>,
    required: &HashSet<String>,
    allowed: &HashSet<String>,
    submit_tool: &str,
) -> Vec<String> {
    let mut violations = Vec::new();
    let missing: Vec<_> = required
        .union(allowed)
        .filter(|n| !present.contains(*n))
        .cloned()
        .collect();
    if !missing.is_empty() {
        violations.push(format!(
            "missing required tools after assignment: {:?}",
            missing
        ));
    }
    if !present.contains(submit_tool) {
        violations.push(format!(
            "benchmark tool {:?} was not assigned/discovered",
            submit_tool
        ));
    }
    let mutating: HashSet<_> = MUTATING_SKILL_TOOL_SHORT_NAMES
        .iter()
        .map(|n| format!("archestra__{n}"))
        .collect();
    let leaked: Vec<_> = mutating
        .difference(allowed)
        .filter(|n| present.contains(*n))
        .cloned()
        .collect();
    if !leaked.is_empty() {
        violations.push(format!(
            "can mutate the skill library via {:?}; refusing a contaminated surface",
            leaked
        ));
    }
    violations
}

async fn strip_mutating_skill_tools(
    client: &EvalClient,
    agent_id: &str,
    allowed: &HashSet<String>,
) -> Result<(), RunError> {
    let strip = tools_to_strip(allowed);
    for tool in client.list_agent_tools(agent_id).await? {
        let name = tool.get("name").and_then(|v| v.as_str());
        if let Some(name) = name
            && strip.contains(name)
        {
            let tool_id = tool
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            client.unassign_tool(agent_id, &tool_id).await?;
        }
    }
    Ok(())
}

async fn resolve_tool_ids(
    client: &EvalClient,
    short_names: &[String],
) -> Result<HashMap<String, String>, RunError> {
    let mut resolved = HashMap::new();
    for short_name in short_names {
        let exact = format!("archestra__{short_name}");
        let tools = client.list_tools(Some(&exact)).await?;
        let matches: Vec<_> = tools
            .into_iter()
            .filter(|t| t.get("name").and_then(|v| v.as_str()) == Some(&exact))
            .collect();
        if matches.len() != 1 {
            return Err(RunError::Config(format!(
                "required tool {exact:?} not found exactly once; is sandbox tooling enabled?"
            )));
        }
        let id = matches[0]
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        resolved.insert(short_name.clone(), id);
    }
    Ok(resolved)
}

async fn assert_agent_tool_surface(
    client: &EvalClient,
    agent_id: &str,
    submit_tool: &str,
    allowed: &HashSet<String>,
) -> Result<(), RunError> {
    let names: HashSet<String> = client
        .list_agent_tools(agent_id)
        .await?
        .into_iter()
        .filter_map(|t| {
            t.get("name")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .collect();
    let required: HashSet<_> = REQUIRED_TOOL_SHORT_NAMES
        .iter()
        .map(|n| format!("archestra__{n}"))
        .collect();
    let violations = surface_violations(&names, &required, allowed, submit_tool);
    if !violations.is_empty() {
        return Err(RunError::Config(format!(
            "eval agent tool surface is invalid: {}",
            violations.join("; ")
        )));
    }
    Ok(())
}

fn find_submit_tool(tools: &[HashMap<String, serde_json::Value>]) -> Result<String, RunError> {
    for tool in tools {
        if let Some(name) = tool_name(tool)
            && name.ends_with(SUBMIT_TOOL_SUFFIX)
        {
            return Ok(name.to_string());
        }
    }
    Err(RunError::Config(format!(
        "benchmark MCP exposed no {SUBMIT_TOOL_SUFFIX} tool"
    )))
}

async fn run_lane(
    client: EvalClient,
    env: EnvConfig,
    tasks: Vec<Task>,
    lane: Lane,
    mcp: BenchmarkMcp,
    submit_tool: String,
    agent_id: String,
    root_run_dir: PathBuf,
    resolved: ResolvedModel,
    progress: ProgressBar,
) -> Vec<RunResult> {
    let mut results = Vec::new();
    for task in tasks {
        let rollout = rollout_label(&task, &lane);
        progress.set_message(format!("{} {}", rollout, task.id));
        let result = run_one(
            client.clone(),
            mcp.clone(),
            &submit_tool,
            &root_run_dir,
            &env.id,
            &env.agent_system_prompt,
            env.platform.tool_exposure_mode,
            &lane,
            &agent_id,
            &task,
            &resolved,
        )
        .await;
        progress.inc(1);
        results.push(result);
    }
    mcp.stop().await;
    results
}

async fn run_one(
    client: EvalClient,
    bench_mcp: BenchmarkMcp,
    submit_tool: &str,
    root_run_dir: &Path,
    env_id: &str,
    agent_system_prompt: &str,
    tool_exposure_mode: ToolExposureMode,
    lane: &Lane,
    agent_id: &str,
    task: &Task,
    resolved: &ResolvedModel,
) -> RunResult {
    let rollout_key = format!("{env_id}/{}/{}", task.id, lane.slug());
    let artifacts =
        match RunArtifacts::new(root_run_dir.join(run_subdir(env_id, &task.id, lane))).await {
            Ok(a) => a,
            Err(e) => {
                return RunResult {
                    env_id: env_id.to_string(),
                    task_id: task.id.clone(),
                    lane: lane.name.clone(),
                    provider: lane.provider.as_str().to_string(),
                    model: lane.model.clone(),
                    outcome: Outcome::AgentError,
                    finish_reason: None,
                    tool_call_count: 0,
                    turn_count: 0,
                    total_tokens: None,
                    agent_error: Some(format!("artifact directory error: {e}")),
                    stage_count: task.stages.len(),
                    format_attempts: 0,
                    artifact_dir: None,
                };
            }
        };

    let mut metadata = serde_json::json!({
        "env_id": env_id,
        "task_id": task.id,
        "lane": lane.name,
        "provider": lane.provider,
        "model": lane.model,
        "tool_exposure_mode": tool_exposure_mode,
        "model_id": resolved.model_id,
        "chat_api_key_id": resolved.api_key_id,
        "submit_tool": submit_tool,
        "conversation_id": serde_json::Value::Null,
        "started_at": timestamp(),
        "finished_at": serde_json::Value::Null,
        "stage_count": task.stages.len(),
        "outcome": serde_json::Value::Null,
        "finish_reason": serde_json::Value::Null,
        "tool_call_count": 0,
        "turn_count": 0,
        "total_tokens": serde_json::Value::Null,
        "format_attempts": 0,
        "agent_error": serde_json::Value::Null,
        "verifier_exit_code": serde_json::Value::Null,
        "verifier_timed_out": serde_json::Value::Null,
        "artifacts": serde_json::Map::new(),
    });
    artifacts.write_run(&metadata).await;

    match grade_rollout(
        client,
        bench_mcp,
        submit_tool,
        env_id,
        agent_system_prompt,
        lane,
        agent_id,
        task,
        resolved,
        &artifacts,
        &mut metadata,
        &rollout_key,
    )
    .await
    {
        Ok(result) => result,
        Err(e) => {
            let error = format!("infra: {e}");
            agent_error_result(env_id, lane, task, &error, &artifacts, metadata, None).await
        }
    }
}

async fn grade_rollout(
    client: EvalClient,
    bench_mcp: BenchmarkMcp,
    _submit_tool: &str,
    env_id: &str,
    agent_system_prompt: &str,
    lane: &Lane,
    agent_id: &str,
    task: &Task,
    resolved: &ResolvedModel,
    artifacts: &RunArtifacts,
    metadata: &mut serde_json::Value,
    rollout_key: &str,
) -> Result<RunResult, RunError> {
    bench_mcp
        .begin_task(rollout_key, &task.result_schema, task.max_format_attempts)
        .await
        .map_err(|e| RunError::Mcp(e.to_string()))?;

    let conversation = client
        .create_conversation(
            agent_id,
            Some(rollout_key),
            Some(&resolved.model_id),
            Some(&resolved.api_key_id),
        )
        .await?;
    let conversation_id = conversation
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    metadata["conversation_id"] = serde_json::Value::String(conversation_id.clone());
    artifacts
        .append(
            "conversation_created",
            serde_json::json!({"conversation_id": conversation_id}),
        )
        .await;
    artifacts.write_run(metadata).await;

    let runtime: HashMap<String, String> = HashMap::from([
        ("cell".to_string(), rollout_token(rollout_key, &lane.model)),
        ("agent_id".to_string(), agent_id.to_string()),
    ]);

    // Capture once: the agent's configured system prompt plus the expanded stage-0 task text
    // (pre-SUBMIT_INSTRUCTION, i.e. the human-authored prompt). drive_stage appends
    // SUBMIT_INSTRUCTION when it actually sends each stage.
    let initial_user_message = task
        .stages
        .first()
        .map(|stage| expand_runtime(&stage.text, &runtime))
        .unwrap_or_default();
    artifacts
        .append(
            "prompts",
            serde_json::json!({
                "system_prompt": agent_system_prompt,
                "user_message": initial_user_message,
            }),
        )
        .await;

    let mut run = ChatRunResult::default();
    let mut stage_error: Option<String> = None;
    let final_stage = task.stages.len().saturating_sub(1);
    for (index, stage) in task.stages.iter().enumerate() {
        if index == final_stage {
            bench_mcp.allow_submission(rollout_key).await;
        }
        stage_error = drive_stage_with_retry(
            &client,
            &conversation_id,
            stage,
            task,
            &mut run,
            artifacts,
            &runtime,
            index > 0,
        )
        .await?;
        if stage_error.is_some() {
            break;
        }
        artifacts
            .append(
                "stage_complete",
                serde_json::json!({"stage": index, "finish_reason": run.finish_reason}),
            )
            .await;
    }

    // Safety net: a capable model often solves the task and reports the answer in chat, then ends its
    // turn without ever calling the submit tool. If it stopped voluntarily with nothing submitted,
    // prompt it once more. Bounded to a single extra turn, and only on a clean `stop`, so a model that
    // genuinely refuses or already hit an error/limit still terminates.
    if stage_error.is_none()
        && run.finish_reason.as_deref() == Some("stop")
        && !bench_mcp.has_submission(rollout_key).await
    {
        artifacts
            .append("submit_nudge", serde_json::json!({}))
            .await;
        let nudge = Stage {
            text: SUBMIT_NUDGE.to_string(),
            files: Vec::new(),
        };
        stage_error = drive_stage_with_retry(
            &client,
            &conversation_id,
            &nudge,
            task,
            &mut run,
            artifacts,
            &runtime,
            true,
        )
        .await?;
    }

    metadata["finish_reason"] =
        serde_json::to_value(&run.finish_reason).unwrap_or(serde_json::Value::Null);
    metadata["tool_call_count"] = serde_json::Value::Number((run.tool_calls.len() as i64).into());
    metadata["turn_count"] = serde_json::Value::Number((run.turn_count as i64).into());
    metadata["total_tokens"] =
        serde_json::to_value(run.total_tokens).unwrap_or(serde_json::Value::Null);

    let submission = bench_mcp.take_submission(rollout_key).await;
    match submission {
        Submission::FormatFailed(failed) => {
            metadata["format_errors"] = serde_json::Value::Array(
                failed
                    .errors
                    .into_iter()
                    .map(serde_json::Value::String)
                    .collect(),
            );
            return Ok(finish(
                env_id,
                lane,
                task,
                Outcome::FormatFailed,
                Some(&run),
                artifacts,
                metadata,
                failed.attempts,
                None,
            )
            .await);
        }
        Submission::None => {
            if let Some(error) = stage_error {
                return Ok(agent_error_result(
                    env_id,
                    lane,
                    task,
                    &error,
                    artifacts,
                    metadata.clone(),
                    Some(&run),
                )
                .await);
            }
            return Ok(finish(
                env_id,
                lane,
                task,
                Outcome::NoSubmission,
                Some(&run),
                artifacts,
                metadata,
                0,
                None,
            )
            .await);
        }
        Submission::Accepted(accepted) => {
            metadata["format_attempts"] =
                serde_json::Value::Number((accepted.attempts as i64).into());
            metadata["result"] =
                serde_json::from_slice(&accepted.payload_bytes).unwrap_or(serde_json::Value::Null);
            let report_path = artifacts
                .write_bytes("submission.json", &accepted.payload_bytes)
                .await;
            if let serde_json::Value::Object(map) = metadata
                && let serde_json::Value::Object(artifacts_map) = map.get_mut("artifacts").unwrap()
            {
                artifacts_map.insert(
                    "submission".to_string(),
                    serde_json::Value::String(report_path.to_string_lossy().to_string()),
                );
            }

            let artifact_bytes = if task.artifact_key.is_some() {
                match resolve_artifact(
                    &client,
                    &conversation_id,
                    task,
                    &accepted.payload_bytes,
                    artifacts,
                    metadata,
                )
                .await
                {
                    Ok(b) => b,
                    Err(e) => {
                        return Ok(agent_error_result(
                            env_id,
                            lane,
                            task,
                            &format!("artifact retrieval failed: {e}"),
                            artifacts,
                            metadata.clone(),
                            Some(&run),
                        )
                        .await);
                    }
                }
            } else {
                None
            };

            let state_bytes = if !task.state_rest.is_empty() {
                match capture_state(
                    &client,
                    task,
                    &runtime,
                    &run.tool_invocations,
                    artifacts,
                    metadata,
                )
                .await
                {
                    Ok(b) => Some(b),
                    Err(e) => {
                        return Ok(agent_error_result(
                            env_id,
                            lane,
                            task,
                            &format!("state capture failed: {e}"),
                            artifacts,
                            metadata.clone(),
                            Some(&run),
                        )
                        .await);
                    }
                }
            } else {
                None
            };

            let outcome = run_verifier(
                task,
                &accepted.payload_bytes,
                artifact_bytes.as_deref(),
                state_bytes.as_deref(),
                900.0,
            )
            .await?;
            save_verifier_artifacts(artifacts, metadata, &outcome).await;
            let passed = outcome.passed;
            if !passed {
                metadata["verifier_summary"] =
                    serde_json::Value::String(verifier_summary(&outcome));
            }
            return Ok(finish(
                env_id,
                lane,
                task,
                if passed {
                    Outcome::Passed
                } else {
                    Outcome::Failed
                },
                Some(&run),
                artifacts,
                metadata,
                accepted.attempts,
                None,
            )
            .await);
        }
    }
}

/// Drive a stage, retrying it once when the backend reports a retryable error
/// (e.g. an incomplete tool call). Such a failure on a single turn would
/// otherwise end the whole rollout; one clean re-attempt recovers the common
/// transient cases. Parse/idle errors are not backend-classified and are never
/// retried.
///
/// The retry must look exactly like the first attempt, never an accumulation of
/// it: (1) prior history is fetched once and reused, so the retry does not pick
/// up the failed attempt's own just-persisted user turn; (2) the user turn id is
/// fixed, so a re-sent turn is deduped backend-side instead of duplicated; and
/// (3) `run` is snapshotted and restored before retrying, so the failed
/// attempt's partial text / tool calls / turn count / tokens never leak into the
/// rollout metrics.
async fn drive_stage_with_retry(
    client: &EvalClient,
    conversation_id: &str,
    stage: &crate::config::types::Stage,
    task: &Task,
    run: &mut ChatRunResult,
    artifacts: &RunArtifacts,
    runtime: &HashMap<String, String>,
    expect_prior_history: bool,
) -> Result<Option<String>, RunError> {
    // Resend prior turns so the agent keeps task context across stages and submit-nudges; the
    // platform builds LLM context from the request body only. The first turn has no history yet;
    // a later turn that fetches an empty history means the prior turn failed to persist, so fail
    // the rollout loudly rather than silently run the agent on contextless history.
    let prior_messages = if expect_prior_history {
        let messages = client.get_conversation_messages(conversation_id).await?;
        if messages.is_empty() {
            return Ok(Some(
                "conversation history empty on a follow-up turn; the prior turn likely failed to \
                 persist — refusing to continue on contextless history"
                    .to_string(),
            ));
        }
        messages
    } else {
        Vec::new()
    };
    let turn_id = uuid::Uuid::new_v4().to_string();

    let snapshot = run.clone();
    let first = drive_stage(
        client,
        conversation_id,
        stage,
        task,
        run,
        artifacts,
        runtime,
        &prior_messages,
        &turn_id,
    )
    .await?;
    let Some(error) = first else {
        return Ok(None);
    };
    if !stage_error_is_retryable(&error) {
        return Ok(Some(error));
    }
    artifacts
        .append("stage_retry", serde_json::json!({ "error": error }))
        .await;
    *run = snapshot;
    drive_stage(
        client,
        conversation_id,
        stage,
        task,
        run,
        artifacts,
        runtime,
        &prior_messages,
        &turn_id,
    )
    .await
}

/// True when a stage-error string is the backend's JSON error payload carrying
/// `isRetryable: true`. A combined or non-JSON error (parse error, idle
/// timeout, or a stream error merged with one) does not parse and is treated as
/// non-retryable — only a clean backend classification triggers a re-attempt.
fn stage_error_is_retryable(error: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(error)
        .ok()
        .and_then(|v| v.get("isRetryable").and_then(|r| r.as_bool()))
        .unwrap_or(false)
}

async fn drive_stage(
    client: &EvalClient,
    conversation_id: &str,
    stage: &crate::config::types::Stage,
    task: &Task,
    run: &mut ChatRunResult,
    artifacts: &RunArtifacts,
    runtime: &HashMap<String, String>,
    prior_messages: &[serde_json::Value],
    turn_id: &str,
) -> Result<Option<String>, RunError> {
    let files: Vec<FilePart> = stage
        .files
        .iter()
        .map(|f| FilePart {
            filename: Path::new(&f.dest)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            mime_type: f.mime_type.clone(),
            data: std::fs::read(task.inputs_dir().join(&f.src)).unwrap_or_default(),
        })
        .collect();
    let text = format!(
        "{}\n\n{SUBMIT_INSTRUCTION}",
        expand_runtime(&stage.text, runtime)
    );
    let mut stream_parse_error: Option<String> = None;
    let mut coalescer = StreamCoalescer::new(artifacts);
    run.stage_tokens = None;

    let mut stream = client
        .stream_chat_records(conversation_id, prior_messages, &text, &files, turn_id)
        .await?;
    loop {
        let record = match timeout(STREAM_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(record)) => record,
            Ok(None) => break,
            Err(_) => {
                if stream_parse_error.is_none() {
                    stream_parse_error = Some(format!(
                        "chat stream idle for {}s",
                        STREAM_IDLE_TIMEOUT.as_secs()
                    ));
                }
                break;
            }
        };
        coalescer.feed(&record).await;
        match record.kind {
            ChatRecordKind::Event if record.event.is_some() => {
                apply_chat_event(run, &record.event.unwrap());
            }
            ChatRecordKind::ParseError if stream_parse_error.is_none() => {
                stream_parse_error = Some(record.reason.unwrap_or_else(|| {
                    record
                        .raw
                        .unwrap_or_else(|| "malformed chat stream data".to_string())
                }));
            }
            _ => {}
        }
    }
    coalescer.flush().await;
    if let Some(stage_tokens) = run.stage_tokens {
        run.total_tokens = Some(run.total_tokens.unwrap_or(0) + stage_tokens);
    }

    Ok(combine_errors(run.stream_error.clone(), stream_parse_error))
}

fn combine_errors(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (None, None) => None,
        (Some(a), None) | (None, Some(a)) => Some(a),
        (Some(a), Some(b)) => Some(format!("{a}; {b}")),
    }
}

async fn resolve_artifact(
    client: &EvalClient,
    conversation_id: &str,
    task: &Task,
    payload_bytes: &[u8],
    artifacts: &RunArtifacts,
    metadata: &mut serde_json::Value,
) -> Result<Option<Vec<u8>>, RunError> {
    let artifact_key = task.artifact_key.as_ref().unwrap();
    let result: serde_json::Value =
        serde_json::from_slice(payload_bytes).unwrap_or(serde_json::Value::Null);
    let filename = result
        .get(artifact_key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let filename = match filename {
        Some(f) if !f.is_empty() => f,
        _ => {
            artifacts
                .append_error(
                    "artifact_missing",
                    &format!("submission has no string {artifact_key:?}"),
                )
                .await;
            return Ok(None);
        }
    };

    let files = client.list_conversation_files(conversation_id).await?;
    let generated = files
        .get("generated")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let matches: Vec<_> = generated
        .into_iter()
        .filter(|g| g.get("name").and_then(|v| v.as_str()) == Some(&filename))
        .collect();
    if matches.len() != 1 {
        artifacts
            .append_error(
                "artifact_missing",
                &format!(
                    "expected exactly one generated artifact named {filename:?}, found {}",
                    matches.len()
                ),
            )
            .await;
        return Ok(None);
    }
    let content_url = matches[0]
        .get("contentUrl")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let content_url = match content_url {
        Some(u) => u,
        None => {
            artifacts
                .append_error(
                    "artifact_missing",
                    &format!("generated artifact {filename:?} has no contentUrl"),
                )
                .await;
            return Ok(None);
        }
    };

    let data = client.download_file_bytes(&content_url, 120.0).await?;
    let path = artifacts.write_bytes("artifact.bin", &data).await;
    if let serde_json::Value::Object(map) = metadata
        && let serde_json::Value::Object(artifacts_map) = map.get_mut("artifacts").unwrap()
    {
        artifacts_map.insert(
            "artifact".to_string(),
            serde_json::Value::String(path.to_string_lossy().to_string()),
        );
    }
    Ok(Some(data))
}

async fn capture_state(
    client: &EvalClient,
    task: &Task,
    runtime: &HashMap<String, String>,
    tool_invocations: &[HashMap<String, serde_json::Value>],
    artifacts: &RunArtifacts,
    metadata: &mut serde_json::Value,
) -> Result<Vec<u8>, RunError> {
    let mut rest = serde_json::Map::new();
    for template in &task.state_rest {
        let path = expand_runtime(template, runtime);
        let value = client.get_json(&path).await?;
        rest.insert(path, value);
    }
    let bundle = serde_json::json!({
        "rest": rest,
        "tool_calls": tool_invocations,
    });
    let data = serde_json::to_vec(&bundle)?;
    let path = artifacts.write_bytes(STATE_NAME, &data).await;
    if let serde_json::Value::Object(map) = metadata
        && let serde_json::Value::Object(artifacts_map) = map.get_mut("artifacts").unwrap()
    {
        artifacts_map.insert(
            "state".to_string(),
            serde_json::Value::String(path.to_string_lossy().to_string()),
        );
    }
    Ok(data)
}

async fn save_verifier_artifacts(
    artifacts: &RunArtifacts,
    metadata: &mut serde_json::Value,
    outcome: &VerifyOutcome,
) {
    let stdout_path = artifacts
        .write_text("verifier.stdout.txt", &outcome.stdout)
        .await;
    let stderr_path = artifacts
        .write_text("verifier.stderr.txt", &outcome.stderr)
        .await;
    if let serde_json::Value::Object(map) = metadata {
        if let serde_json::Value::Object(artifacts_map) = map.get_mut("artifacts").unwrap() {
            artifacts_map.insert(
                "verifier_stdout".to_string(),
                serde_json::Value::String(stdout_path.to_string_lossy().to_string()),
            );
            artifacts_map.insert(
                "verifier_stderr".to_string(),
                serde_json::Value::String(stderr_path.to_string_lossy().to_string()),
            );
        }
        map["verifier_exit_code"] = serde_json::Value::Number(outcome.exit_code.into());
        map["verifier_timed_out"] = serde_json::Value::Bool(outcome.timed_out);
    }
}

fn verifier_summary(outcome: &VerifyOutcome) -> String {
    let lines: Vec<String> = outcome
        .stdout
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut highlights: Vec<String> = lines
        .iter()
        .filter(|ln| ln.starts_with("E ") || ln.starts_with("FAILED"))
        .cloned()
        .collect();
    if highlights.is_empty() {
        let stderr_lines: Vec<String> = outcome
            .stderr
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        highlights = if !stderr_lines.is_empty() {
            stderr_lines.into_iter().rev().take(3).collect()
        } else {
            lines.into_iter().rev().take(3).collect()
        };
        highlights.reverse();
    }
    if outcome.timed_out {
        highlights.insert(0, "verifier timed out".to_string());
    }
    let text = highlights.join(" | ");
    text.chars().take(500).collect()
}

async fn finish(
    env_id: &str,
    lane: &Lane,
    task: &Task,
    outcome: Outcome,
    run: Option<&ChatRunResult>,
    artifacts: &RunArtifacts,
    metadata: &mut serde_json::Value,
    format_attempts: usize,
    agent_error: Option<String>,
) -> RunResult {
    if let serde_json::Value::Object(map) = metadata {
        map["finished_at"] = serde_json::Value::String(timestamp());
        map["outcome"] = serde_json::Value::String(outcome.value().to_string());
        map["agent_error"] = serde_json::to_value(&agent_error).unwrap_or(serde_json::Value::Null);
        map["format_attempts"] = serde_json::Value::Number((format_attempts as i64).into());
    }
    artifacts.write_run(metadata).await;
    RunResult {
        env_id: env_id.to_string(),
        task_id: task.id.clone(),
        lane: lane.name.clone(),
        provider: lane.provider.as_str().to_string(),
        model: lane.model.clone(),
        outcome,
        finish_reason: run.and_then(|r| r.finish_reason.clone()),
        tool_call_count: run.map(|r| r.tool_calls.len()).unwrap_or(0),
        turn_count: run.map(|r| r.turn_count).unwrap_or(0),
        total_tokens: run.and_then(|r| r.total_tokens),
        agent_error,
        stage_count: task.stages.len(),
        format_attempts,
        artifact_dir: Some(artifacts.path.to_string_lossy().to_string()),
    }
}

async fn agent_error_result(
    env_id: &str,
    lane: &Lane,
    task: &Task,
    error: &str,
    artifacts: &RunArtifacts,
    metadata: serde_json::Value,
    run: Option<&ChatRunResult>,
) -> RunResult {
    artifacts.append_error("agent_error", error).await;
    let mut metadata = metadata;
    finish(
        env_id,
        lane,
        task,
        Outcome::AgentError,
        run,
        artifacts,
        &mut metadata,
        0,
        Some(error.to_string()),
    )
    .await
}

struct RunArtifacts {
    path: PathBuf,
    sequence: Arc<Mutex<usize>>,
}

impl RunArtifacts {
    async fn new(path: PathBuf) -> Result<Self, RunError> {
        // Create the parent env dir(s) if needed, but the leaf rollout dir must be created fresh:
        // an existing rollout dir is a rerun collision (no clobbering a prior run's artifacts).
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.map_err(RunError::Io)?;
        }
        match fs::create_dir(&path).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(RunError::ArtifactExists(path));
            }
            Err(e) => return Err(RunError::Io(e)),
        }
        Ok(Self {
            path,
            sequence: Arc::new(Mutex::new(0)),
        })
    }

    async fn append(&self, kind: &str, data: serde_json::Value) {
        let mut seq = self.sequence.lock().await;
        *seq += 1;
        let mut record = serde_json::Map::new();
        record.insert(
            "sequence".to_string(),
            serde_json::Value::Number((*seq as i64).into()),
        );
        record.insert(
            "timestamp".to_string(),
            serde_json::Value::String(timestamp()),
        );
        record.insert(
            "kind".to_string(),
            serde_json::Value::String(kind.to_string()),
        );
        if let serde_json::Value::Object(map) = data {
            for (k, v) in map {
                record.insert(k, v);
            }
        } else {
            record.insert("data".to_string(), data);
        }
        let line = match serde_json::to_string(&serde_json::Value::Object(record)) {
            Ok(l) => l,
            Err(e) => {
                error!("failed to serialize trajectory record: {e}");
                return;
            }
        };
        if let Err(e) = async {
            let mut f: tokio::fs::File = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.path.join("trajectory.jsonl"))
                .await?;
            f.write_all(line.as_bytes()).await?;
            f.write_all(b"\n").await?;
            Ok::<(), std::io::Error>(())
        }
        .await
        {
            error!("failed to append trajectory record: {e}");
        }
    }

    async fn append_error(&self, kind: &str, message: &str) {
        self.append(kind, serde_json::json!({"error": message}))
            .await;
    }

    async fn write_run(&self, metadata: &serde_json::Value) {
        let tmp = self.path.join("run.json.tmp");
        let data = serde_json::to_string_pretty(metadata).unwrap_or_default() + "\n";
        if let Err(e) = fs::write(&tmp, data).await {
            error!("failed to write run.json.tmp: {e}");
            return;
        }
        if let Err(e) = fs::rename(&tmp, self.path.join("run.json")).await {
            error!("failed to rename run.json: {e}");
        }
    }

    async fn write_bytes(&self, filename: &str, data: &[u8]) -> PathBuf {
        let path = self.path.join(filename);
        if let Err(e) = fs::write(&path, data).await {
            error!("failed to write {}: {e}", path.display());
        }
        path
    }

    async fn write_text(&self, filename: &str, text: &str) -> PathBuf {
        self.write_bytes(filename, text.as_bytes()).await
    }
}

struct StreamCoalescer<'a> {
    artifacts: &'a RunArtifacts,
    text: HashMap<String, String>,
    tool_input: HashMap<String, PartialToolCall>,
}

#[derive(Default)]
struct PartialToolCall {
    name: Option<String>,
    text: String,
}

impl<'a> StreamCoalescer<'a> {
    fn new(artifacts: &'a RunArtifacts) -> Self {
        Self {
            artifacts,
            text: HashMap::new(),
            tool_input: HashMap::new(),
        }
    }

    async fn feed(&mut self, record: &ChatStreamRecord) {
        match record.kind {
            ChatRecordKind::ParseError => {
                self.artifacts
                    .append(
                        "parse_error",
                        serde_json::json!({
                            "raw": record.raw,
                            "reason": record.reason,
                        }),
                    )
                    .await;
            }
            ChatRecordKind::Ignored => {}
            ChatRecordKind::Event => {
                if let Some(ref event) = record.event {
                    self.feed_event(event).await;
                }
            }
        }
    }

    async fn feed_event(&mut self, event: &HashMap<String, serde_json::Value>) {
        match event.get("type").and_then(|v| v.as_str()) {
            Some("text-start") => {
                self.text.insert(text_block_id(event), String::new());
            }
            Some("text-delta") => {
                let delta = event
                    .get("delta")
                    .and_then(|v| v.as_str())
                    .or_else(|| event.get("text").and_then(|v| v.as_str()));
                if let Some(delta) = delta {
                    let id = text_block_id(event);
                    self.text.entry(id).or_default().push_str(delta);
                }
            }
            Some("text-end") => {
                let id = text_block_id(event);
                if let Some(text) = self.text.remove(&id)
                    && !text.is_empty()
                {
                    self.artifacts
                        .append(
                            "assistant_text",
                            serde_json::json!({"id": id, "text": text}),
                        )
                        .await;
                }
            }
            Some("tool-input-start") => {
                if let Some(call_id) = event.get("toolCallId").and_then(|v| v.as_str()) {
                    let name = event
                        .get("toolName")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    self.tool_input.insert(
                        call_id.to_string(),
                        PartialToolCall {
                            name,
                            text: String::new(),
                        },
                    );
                }
            }
            Some("tool-input-delta") => {
                if let (Some(call_id), Some(fragment)) = (
                    event.get("toolCallId").and_then(|v| v.as_str()),
                    event.get("inputTextDelta").and_then(|v| v.as_str()),
                ) {
                    self.tool_input
                        .entry(call_id.to_string())
                        .or_default()
                        .text
                        .push_str(fragment);
                }
            }
            Some("tool-input-available") | Some("tool-call") => {
                if let Some(call_id) = event.get("toolCallId").and_then(|v| v.as_str()) {
                    self.tool_input.remove(call_id);
                }
                if let Some(name) = event.get("toolName").and_then(|v| v.as_str()) {
                    self.artifacts
                        .append(
                            "tool_call",
                            serde_json::json!({
                                "tool_call_id": event.get("toolCallId"),
                                "tool_name": name,
                                "input": event.get("input"),
                            }),
                        )
                        .await;
                } else {
                    self.artifacts
                        .append("chat_stream", serde_json::json!({"event": event}))
                        .await;
                }
            }
            Some("tool-output-available") => {
                self.artifacts
                    .append(
                        "tool_output",
                        serde_json::json!({
                            "tool_call_id": event.get("toolCallId"),
                            "output": event.get("output"),
                        }),
                    )
                    .await;
            }
            Some("finish") | Some("finish-step") => {
                if let Some(reason) = event.get("finishReason").and_then(|v| v.as_str()) {
                    self.artifacts
                        .append("finish", serde_json::json!({"finish_reason": reason}))
                        .await;
                }
            }
            Some("data-token-usage") => {
                if let Some(data) = event.get("data").and_then(|v| v.as_object())
                    && let Some(total) = data.get("totalTokens").and_then(|v| v.as_i64())
                {
                    self.artifacts
                        .append("token_usage", serde_json::json!({"total_tokens": total}))
                        .await;
                }
            }
            Some("error") => {
                self.flush_text().await;
                let text = event
                    .get("errorText")
                    .or_else(|| event.get("error"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| serde_json::to_string(event).unwrap_or_default());
                self.artifacts
                    .append("error", serde_json::json!({"error": text}))
                    .await;
            }
            Some("start")
            | Some("start-step")
            | Some("data-heartbeat")
            | Some("data-context-window-estimate") => {}
            _ => {
                self.artifacts
                    .append("chat_stream", serde_json::json!({"event": event}))
                    .await;
            }
        }
    }

    async fn flush_text(&mut self) {
        for (id, text) in self.text.drain() {
            if !text.is_empty() {
                self.artifacts
                    .append(
                        "assistant_text",
                        serde_json::json!({"id": id, "text": text}),
                    )
                    .await;
            }
        }
    }

    async fn flush(&mut self) {
        self.flush_text().await;
        for (call_id, partial) in self.tool_input.drain() {
            self.artifacts
                .append(
                    "tool_call_partial",
                    serde_json::json!({
                        "tool_call_id": call_id,
                        "tool_name": partial.name,
                        "partial_input": partial.text,
                    }),
                )
                .await;
        }
    }
}

fn text_block_id(event: &HashMap<String, serde_json::Value>) -> String {
    event
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn expand_runtime(text: &str, mapping: &HashMap<String, String>) -> String {
    let re = regex::Regex::new(r"\{\{(cell|agent_id)\}\}").expect("valid regex");
    re.replace_all(text, |caps: &regex::Captures| {
        mapping.get(caps[1].trim()).cloned().unwrap_or_default()
    })
    .to_string()
}

fn rollout_token(rollout_key: &str, model_name: &str) -> String {
    let slug: String = model_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    let slug = if slug.is_empty() {
        "model".to_string()
    } else {
        slug
    };
    let digest = format!("{:x}", Sha256::digest(rollout_key.as_bytes()))[..8].to_string();
    format!("{slug}-{digest}")
}

fn run_subdir(env_id: &str, task_id: &str, lane: &Lane) -> String {
    // The `<env>/<task>__<lane>` layout is owned by the shared contract crate so the harness writer
    // and the analyzer reader cannot drift (this is what broke before).
    archestra_bench_core::rollout_dir(env_id, task_id, &lane.name)
}

fn rollout_label(task: &Task, lane: &Lane) -> String {
    format!("{}/{}", lane.slug(), task.id)
}

fn run_id() -> String {
    Utc::now().format("%Y%m%d_%H%M%S").to_string()
}

fn default_run_dir(bench_dir: &Path, run_id: &str) -> PathBuf {
    bench_dir.join("experiments").join(run_id)
}

/// Allocate a brand-new auto run directory under `experiments/`, guaranteeing it did not pre-exist.
/// `run_id()` is seconds-granular, so exclusive create + a numeric suffix is what keeps two runs
/// started in the same second from colliding. Returns the dir and the run id (its basename).
async fn create_fresh_run_dir(bench_dir: &Path) -> Result<(PathBuf, String), RunError> {
    let base_id = run_id();
    fs::create_dir_all(bench_dir.join("experiments")).await?;
    for attempt in 0..1000 {
        let id = if attempt == 0 {
            base_id.clone()
        } else {
            format!("{base_id}-{attempt}")
        };
        let dir = default_run_dir(bench_dir, &id);
        match fs::create_dir(&dir).await {
            Ok(()) => return Ok((dir, id)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(RunError::Io(e)),
        }
    }
    Err(RunError::Config(format!(
        "could not allocate a fresh run dir under experiments/ for {base_id} after 1000 attempts"
    )))
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn timestamp() -> String {
    Utc::now()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        .replace("+00:00", "Z")
}

async fn write_run_config(
    run_dir: &Path,
    run_id: &str,
    plan: &[EnvPlan],
    max_workers: usize,
) -> Result<(), RunError> {
    let environments: Vec<serde_json::Value> = plan
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p.env.id,
                "tasks": p.tasks.iter().map(|t| &t.id).collect::<Vec<_>>(),
                "share_backend": p.share_backend(),
                "tool_exposure_mode": p.env.platform.tool_exposure_mode,
            })
        })
        .collect();
    // Every EnvPlan carries the same selected lane set (build_run_plan fans lanes over envs), so list
    // each lane once — de-dup by name preserving declaration order (matches Python, which writes the
    // selected lane list a single time).
    let mut seen_lanes: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let lanes: Vec<serde_json::Value> = plan
        .iter()
        .flat_map(|p| &p.lanes)
        .filter(|l| seen_lanes.insert(l.name.as_str()))
        .map(|l| {
            serde_json::json!({
                "name": l.name,
                "provider": l.provider,
                "model": l.model,
                "base_url": l.base_url,
            })
        })
        .collect();
    let git_commit = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(repo_root())
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                String::from_utf8(out.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        });
    let config = serde_json::json!({
        "run_id": run_id,
        "started_at": timestamp(),
        "environments": environments,
        "lanes": lanes,
        "max_workers": max_workers,
        "git_commit": git_commit,
        "temperature": crate::client::BENCH_TEMPERATURE,
    });
    fs::write(
        run_dir.join("config.json"),
        serde_json::to_string_pretty(&config).unwrap_or_default() + "\n",
    )
    .await?;
    Ok(())
}

async fn write_report(report: &str, out: Option<&Path>) -> Result<(), RunError> {
    match out {
        Some(path) => {
            fs::write(path, report).await?;
            info!("wrote report to {}", path.display());
        }
        None => {
            println!("{}", report);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stage_error_is_retryable() {
        // Backend error JSON with the flag set → retry.
        assert!(stage_error_is_retryable(
            r#"{"code":"incomplete_tool_call","message":"...","isRetryable":true}"#
        ));
        // Flag explicitly false → no retry.
        assert!(!stage_error_is_retryable(
            r#"{"code":"authentication","isRetryable":false}"#
        ));
        // Non-JSON (idle timeout / parse error) → no retry.
        assert!(!stage_error_is_retryable("chat stream idle for 120s"));
        // Stream error merged with a parse error is no longer valid JSON → no retry.
        assert!(!stage_error_is_retryable(
            r#"{"isRetryable":true}; malformed chat stream data"#
        ));
        // Missing flag → no retry.
        assert!(!stage_error_is_retryable(r#"{"code":"unknown"}"#));
    }

    #[test]
    fn test_rollout_token() {
        let token = rollout_token("basic/t1/openai/gpt-4", "gpt-4-turbo");
        assert!(token.starts_with("gpt-4-turbo-"));
    }

    #[test]
    fn test_expand_runtime() {
        let mut map = HashMap::new();
        map.insert("cell".to_string(), "abc".to_string());
        map.insert("agent_id".to_string(), "agent-1".to_string());
        assert_eq!(expand_runtime("{{cell}} {{agent_id}}", &map), "abc agent-1");
    }

    #[test]
    fn test_surface_violations() {
        let present: HashSet<String> = ["archestra__todo_write", "archestra__submit_result"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let required: HashSet<String> = ["archestra__todo_write"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let allowed: HashSet<String> = HashSet::new();
        let v = surface_violations(&present, &required, &allowed, "archestra__submit_result");
        assert!(v.is_empty());
    }

    #[test]
    fn test_resolve_workers() {
        assert_eq!(resolve_workers(Some(0), 1), 1);
        assert_eq!(resolve_workers(Some(8), 1), 8);
        assert_eq!(resolve_workers(None, 2), 2);
        assert_eq!(resolve_workers(None, 10), 4);
        assert_eq!(resolve_workers(None, 0), 1);
    }

    fn dummy_task(id: &str) -> Task {
        Task {
            id: id.to_string(),
            dir: PathBuf::from("/tmp"),
            stages: vec![],
            result_schema: serde_json::Value::Null,
            verifier: crate::config::types::Verifier {
                deps: vec![],
                test_file: "verifier.py".to_string(),
                env: vec![],
            },
            artifact_key: None,
            max_format_attempts: 3,
            state_rest: vec![],
        }
    }

    fn dummy_env(id: &str, tasks: Vec<Task>) -> EnvConfig {
        EnvConfig {
            id: id.to_string(),
            name: id.to_string(),
            agent_name: format!("agent-{id}"),
            agent_system_prompt: "test".to_string(),
            skills: vec![],
            mcps: vec![],
            tasks,
            tools: vec![],
            share_backend: false,
            platform: crate::config::types::PlatformConfig::default(),
        }
    }

    fn dummy_lane(name: &str) -> Lane {
        Lane {
            name: name.to_string(),
            provider: archestra_bench_core::Provider::Openai,
            model: "gpt-4".to_string(),
            base_url: None,
            api_key_env: None,
        }
    }

    #[test]
    fn test_select_envs_all() {
        let envs = HashMap::from([
            ("a".to_string(), dummy_env("a", vec![dummy_task("t1")])),
            ("b".to_string(), dummy_env("b", vec![dummy_task("t2")])),
        ]);
        let selected = select_envs(&envs, None, None).unwrap();
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].0.id, "a");
        assert_eq!(selected[1].0.id, "b");
    }

    #[test]
    fn test_select_envs_filter() {
        let envs = HashMap::from([
            ("a".to_string(), dummy_env("a", vec![dummy_task("t1")])),
            ("b".to_string(), dummy_env("b", vec![dummy_task("t2")])),
        ]);
        let selected = select_envs(&envs, Some("b"), None).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].0.id, "b");
    }

    #[test]
    fn test_select_envs_task_filter() {
        let envs = HashMap::from([(
            "a".to_string(),
            dummy_env("a", vec![dummy_task("t1"), dummy_task("t2")]),
        )]);
        let selected = select_envs(&envs, None, Some("t2")).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].1.len(), 1);
        assert_eq!(selected[0].1[0].id, "t2");
    }

    #[test]
    fn test_select_envs_unknown() {
        let envs = HashMap::from([("a".to_string(), dummy_env("a", vec![dummy_task("t1")]))]);
        assert!(select_envs(&envs, Some("x"), None).is_err());
        assert!(select_envs(&envs, None, Some("x")).is_err());
    }

    #[test]
    fn test_build_run_plan() {
        let envs = vec![
            (
                dummy_env("a", vec![dummy_task("t1")]),
                vec![dummy_task("t1")],
            ),
            (dummy_env("b", vec![]), vec![dummy_task("t2")]),
        ];
        let lanes = vec![dummy_lane("l1"), dummy_lane("l2")];
        let plan = build_run_plan(envs, lanes);
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].lanes.len(), 2);
        assert_eq!(plan[1].lanes.len(), 2);
    }

    #[test]
    fn test_lane_stop_plan_groups_by_lane_in_plan_order() {
        let mut shared = dummy_env("basic", vec![dummy_task("t1")]);
        shared.share_backend = true;
        let isolated = dummy_env("api", vec![dummy_task("t2")]); // share_backend defaults false
        let plan = build_run_plan(
            vec![
                (shared, vec![dummy_task("t1")]),
                (isolated, vec![dummy_task("t2")]),
            ],
            vec![dummy_lane("l1"), dummy_lane("l2")],
        );

        let schedule = lane_stop_plan(&plan);

        // One entry per distinct lane, in lane (file) order.
        let lane_names: Vec<&str> = schedule.iter().map(|(l, _)| l.name.as_str()).collect();
        assert_eq!(lane_names, vec!["l1", "l2"]);
        // Each lane visits both envs in plan order: env 0 shared, env 1 isolated.
        for (_, stops) in &schedule {
            assert_eq!(stops, &vec![(0usize, true), (1usize, false)]);
        }
    }

    #[test]
    fn test_run_subdir() {
        let lane = dummy_lane("openai-gpt-4");
        let s = run_subdir("basic", "median-salary", &lane);
        // <env>/<task>__<lane> — the analyzer's expected layout, no intermediate task level.
        assert_eq!(s, "basic/median-salary__openai-gpt-4");
    }

    #[test]
    fn test_run_json_and_trajectory_satisfy_core_contract() {
        // The harness writes run.json/trajectory.jsonl; the analyzer reads them via archestra-bench-core.
        // Pin that the field names + outcome strings the runner commits to deserialize into the shared
        // contract types, so a writer change that breaks the reader fails here.
        let run_json = serde_json::json!({
            "env_id": "basic",
            "task_id": "median-salary",
            "lane": "kimi",
            "provider": "openrouter",
            "model": "m",
            "outcome": Outcome::Passed.value(),
            "tool_call_count": 3,
            "verifier_exit_code": 0,
        });
        let meta: archestra_bench_core::RunMeta = serde_json::from_value(run_json).unwrap();
        assert!(meta.is_pass());
        assert_eq!(meta.rollout_id().to_string(), "basic/median-salary__kimi");
        assert_eq!(
            meta.rollout_id().to_string(),
            run_subdir("basic", "median-salary", &dummy_lane("kimi"))
        );

        let line = serde_json::json!({
            "sequence": 1, "timestamp": "t", "kind": "tool_call",
            "tool_call_id": "x", "tool_name": "run_command", "input": {"cmd": "ls"},
        });
        let event: archestra_bench_core::Event = serde_json::from_value(line).unwrap();
        assert!(matches!(
            event,
            archestra_bench_core::Event::ToolCall { .. }
        ));
    }

    #[tokio::test]
    async fn test_config_json_lists_each_lane_once_across_envs() {
        let envs = vec![
            (
                dummy_env("a", vec![dummy_task("t1")]),
                vec![dummy_task("t1")],
            ),
            (
                dummy_env("b", vec![dummy_task("t2")]),
                vec![dummy_task("t2")],
            ),
        ];
        let lanes = vec![dummy_lane("l1"), dummy_lane("l2")];
        let plan = build_run_plan(envs, lanes);
        let tmp = tempfile::tempdir().unwrap();
        write_run_config(tmp.path(), "rid", &plan, 2).await.unwrap();
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(tmp.path().join("config.json")).unwrap())
                .unwrap();
        let names: Vec<&str> = config["lanes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["name"].as_str().unwrap())
            .collect();
        // two envs, but each lane listed exactly once and in declaration order.
        assert_eq!(names, ["l1", "l2"]);
        // each env records its active tool exposure mode (default here) for reproducibility.
        assert_eq!(
            config["environments"][0]["tool_exposure_mode"],
            "search_and_run_only"
        );
    }

    #[test]
    fn infra_failure_run_json_records_tool_exposure_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = RunCtx {
            root_run_dir: tmp.path().to_path_buf(),
            run_id: "rid".to_string(),
            api_keys: std::collections::HashMap::new(),
            envs_dir: tmp.path().to_path_buf(),
            update_mcp_lock: false,
        };
        let mut env = dummy_env("e", vec![dummy_task("t1")]);
        env.platform.tool_exposure_mode = crate::config::types::ToolExposureMode::Full;
        let lane = dummy_lane("l1");
        let progress = ProgressBar::hidden();
        // Setup failed before any agent existed -- the env's configured flag must still land in
        // run.json, since that is where the analyzer reads it (RunMeta).
        infra_results_for_lane(&env, &env.tasks, &lane, &ctx, &progress, "boom");
        let run_json = tmp
            .path()
            .join(run_subdir("e", "t1", &lane))
            .join("run.json");
        let meta: serde_json::Value =
            serde_json::from_slice(&std::fs::read(run_json).unwrap()).unwrap();
        assert_eq!(meta["tool_exposure_mode"], "full");
        assert_eq!(meta["outcome"], Outcome::AgentError.value());
    }

    #[tokio::test]
    async fn create_fresh_run_dir_suffixes_on_same_second_collision() {
        let tmp = tempfile::tempdir().unwrap();
        // Two allocations within the same test share a seconds-granular run id, so the second must
        // land in a distinct, suffixed dir rather than reuse the first (which `full` relies on to
        // never overwrite a sibling run's config.json/aggregate.json).
        let (d1, id1) = create_fresh_run_dir(tmp.path()).await.unwrap();
        let (d2, id2) = create_fresh_run_dir(tmp.path()).await.unwrap();
        assert!(d1.is_dir() && d2.is_dir());
        assert_ne!(d1, d2);
        assert_ne!(id1, id2);
        assert!(id2.ends_with("-1"), "second dir should be suffixed: {id2}");
    }

    #[tokio::test]
    async fn test_run_artifacts_creates_parents_and_rejects_existing_leaf() {
        let tmp = tempfile::tempdir().unwrap();
        let lane = dummy_lane("openai-gpt-4");
        let rollout = tmp.path().join(run_subdir("basic", "median-salary", &lane));
        // parent (env dir) does not exist yet — new() must create it.
        RunArtifacts::new(rollout.clone()).await.unwrap();
        assert!(rollout.is_dir());
        assert!(rollout.parent().unwrap().is_dir());
        // a second attempt at the same leaf is a rerun collision.
        match RunArtifacts::new(rollout.clone()).await {
            Err(RunError::ArtifactExists(p)) => assert_eq!(p, rollout),
            Err(e) => panic!("expected ArtifactExists, got error {e:?}"),
            Ok(_) => panic!("expected ArtifactExists, but creation succeeded"),
        }
    }
}
