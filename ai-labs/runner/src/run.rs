use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

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
use crate::client::{AgentCreate, ContractError, EvalClient, FilePart};
use crate::config::types::{EnvConfig, Stage, Task, ToolExposureMode};
use crate::config::{Lane, load_envs, load_lanes};
use crate::fixture_mcp::{FIXTURE_MCP_NAME, FixtureMcp};
use crate::interactions::{RunUsage, extract_effective_prompts, sum_usage};
use crate::lifecycle::Instance;
use crate::mcp_lock;
use crate::mcp_server::{BenchmarkMcp, Submission};
use crate::pricing::{self, PriceBook};
use crate::results::{Outcome, RunCost, RunResult, render_markdown};
use crate::seeding::{
    ResolvedModel, ensure_provider_and_models, register_remote_mcp, seed_mcp_fixtures, seed_skill_ref, tool_name,
};
use crate::verify::{VerifyOutcome, run_verifier};

// Model-visible MCP server name (tools surface as `<name>[-<token>]__submit_result`). Kept neutral so
// the agent is not cued that it is being evaluated, which can shift model behavior.
// The name must never encode lane/model identity or position. Shared-backend envs append an opaque
// random token (registry names must be unique per backend, and tool auto-assignment is disabled so a
// lane only ever discovers its own server); isolated lanes own their backend and use the bare name.
const BENCH_MCP_NAME: &str = "final_answer";
// Per-rollout project name. Each rollout gets its own project (distinct id) so file ownership is
// isolated; the name is neutral and identical across rollouts -- like BENCH_MCP_NAME it must not
// encode lane/model/task identity or cue the agent it is being evaluated, since it can surface in a
// file-conflict message.
const PROJECT_NAME: &str = "Workspace";
const SUBMIT_TOOL_SUFFIX: &str = "__submit_result";
// Appended to a stage's user message only when submission is open (the final stage; submit_result is
// server-gated until then). Kept short and tool-agnostic: it nudges submission without naming the
// search/run meta-tools (Archestra's stock prompt already explains discovery), so a model that solves
// the task still closes the loop by finding and calling its submit tool instead of replying in prose.
const SUBMIT_INSTRUCTION: &str =
    "When you are done, find a tool to submit your final result -- replying in chat does not submit it.";
// Appended instead of SUBMIT_INSTRUCTION on a non-final stage, where submit_result is still gated.
// Deliberately says nothing about submitting: a real user does not mention the hand-in protocol until
// the final ask, so the model learns submission is required only on the final stage. Steers the model
// to do the step's work and end its turn (a chat reply, which advances the runner to the next stage)
// rather than hunting for a submit tool and looping on the "more steps" rejection.
const CONTINUE_INSTRUCTION: &str =
    "When you've finished this step, tell me where things stand and wait for my next message.";
// Follow-up sent when a lane ends its turn without submitting -- whether it solved the task and only
// reported in chat, or stopped to ask a clarifying question. Voiced as a hands-off user so the latter
// case gets an answer ("use your judgment, keep going") rather than stalling. Runs on the final stage
// (submission open), so drive_stage still appends SUBMIT_INSTRUCTION; this stays tool-agnostic.
const SUBMIT_NUDGE: &str = "I don't have anything to add -- use your best judgment, finish it however you think is best, and submit the result once it's ready.";
// Upper bound on submit-nudges before the run ends regardless, so a model that keeps asking or looping
// still terminates.
const MAX_SUBMIT_NUDGES: usize = 3;
const STATE_NAME: &str = "state.json";
const MAX_WORKERS_CAP: usize = 4;
// Last-resort net for a wedged backend: if the chat stream emits nothing for this long, give up on
// the stage. Set above the backend's 10-min stale-run reaper so that backstop wins in the normal
// case and this only fires when the backend stops emitting entirely.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

const REQUIRED_TOOL_SHORT_NAMES: &[&str] = &[
    "todo_write",
    "run_command",
    "upload_file",
    "download_file",
    "list_skills",
    "load_skill",
    "search_files",
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
    /// Platform directory override (the prod image lays the app out at `/app`); `None` → `<repo>/platform`.
    pub platform_dir: Option<PathBuf>,
    /// OpenRouter prices for per-run cost; empty when the fetch failed (every cost then reports `n/a`).
    pub prices: Arc<PriceBook>,
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
    platform_dir: Option<&Path>,
    branch: Option<&str>,
) -> Result<RunOutcome, RunError> {
    // `--branch` builds the backend from a git worktree of that ref, once per run; downstream it is
    // just another platform dir. `--branch` conflicts with `--platform-dir` (see the CLI), so when a
    // branch is set `platform_dir` is `None` and the source of the copied prereqs is `<repo>/platform`.
    let worktree = match branch {
        Some(git_ref) => {
            let source = crate::lifecycle::resolve_platform_dir(platform_dir, &repo_root());
            // Fail fast on a broken sandbox BEFORE the multi-minute build: preflight the source
            // platform dir (whose `.env` is what the worktree copies) so a down Docker/Dagger aborts
            // the run now rather than after the build. Preserves preflight's "abort before spending
            // work" property, which building first would silently defeat; the in-block preflight below
            // then hits the warmed OnceCells.
            crate::lifecycle::preflight(&repo_root(), Some(&source)).await?;
            Some(
                crate::lifecycle::prepare_branch_worktree(
                    &repo_root(),
                    &source,
                    git_ref,
                    &sanitize_slug(git_ref, &run_id()),
                )
                .await?,
            )
        }
        None => None,
    };
    let effective_platform_dir: Option<PathBuf> = worktree
        .as_ref()
        .map(|w| w.platform_dir.clone())
        .or_else(|| platform_dir.map(Path::to_path_buf));
    let backend_branch = branch.map(str::to_string);
    let backend_commit = worktree.as_ref().map(|w| w.commit.clone());

    // Everything after worktree creation runs inside this block so the worktree is removed on every
    // normal exit — success or error (`?` returns from the block, not the fn) — while the signal path
    // is covered by the registered teardown.
    let outcome: Result<RunOutcome, RunError> = async {
        let envs_dir = bench_dir.join("envs");
        let envs = load_envs(&envs_dir).map_err(|e| RunError::Config(e.to_string()))?;
        let default_lanes_path = bench_dir.join("lanes.toml");
        let lanes_path = lanes_file.unwrap_or(&default_lanes_path);
        let lane_list = load_lanes(lanes_path, lanes_filter).map_err(|e| RunError::Config(e.to_string()))?;
        let workers = resolve_workers(max_workers, lane_list.len());
        // Lane keys prefer `platform/.env` over the process env, so the same `.env` that configures the
        // backend also seeds the bench's own provider clients. The `.env` is already a hard requirement of
        // every run (preflight below also loads it).
        let platform = crate::lifecycle::resolve_platform_dir(effective_platform_dir.as_deref(), &repo_root());
        let platform_env = crate::lifecycle::load_platform_env(&platform)?;
        let api_keys = lane_api_keys(&lane_list, &platform_env)?;

        // Fetch OpenRouter prices once up front. A failure is non-fatal: every run then reports cost n/a.
        let (prices, price_status) = match pricing::fetch_price_book().await {
            Ok(book) => (book, "ok".to_string()),
            Err(e) => {
                warn!("OpenRouter price fetch failed, run costs will be n/a: {e}");
                (PriceBook::default(), format!("failed: {e}"))
            }
        };
        let prices = Arc::new(prices);

        let selected = select_envs(&envs, env_filter, task_filter)?;
        let plan = build_run_plan(selected, lane_list);

        // Preflight the sandbox once, before any artifact is written: a broken sandbox (managed bench
        // Postgres can't come up, Dagger runner host won't resolve) aborts the whole run here with a
        // single error instead of every backend boot failing the same way and fanning out one
        // agent_error per (task × lane). Warms the same OnceCells `Instance::start` reads, so a healthy
        // run pays nothing.
        crate::lifecycle::preflight(&repo_root(), effective_platform_dir.as_deref()).await?;

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

        write_run_config(
            &root_run_dir,
            &run_id,
            &plan,
            workers,
            &prices,
            &price_status,
            backend_branch.as_deref(),
            backend_commit.as_deref(),
        )
        .await?;

        // Stream the managed Dagger engine's container logs into the run dir so a future engine crash is
        // root-causeable (managed tier only; non-fatal). The host was resolved by `preflight` above.
        let dagger_compose = repo_root()
            .join("ai-labs")
            .join("dev")
            .join("docker-compose.bench-dagger.yml");
        let dagger_logs = crate::lifecycle::capture_managed_dagger_logs(&dagger_compose, &root_run_dir).await;

        let ctx = RunCtx {
            root_run_dir,
            run_id,
            api_keys,
            envs_dir,
            update_mcp_lock,
            platform_dir: effective_platform_dir.clone(),
            prices,
        };

        let results = execute_plan(plan, ctx.clone(), workers).await;

        // All sandbox work is done; stop the engine-log follower (no-op if capture was skipped). The
        // remaining report/aggregate steps touch no sandbox, so an early `?` return below cannot leak it.
        if let Some(guard) = dagger_logs {
            guard.stop().await;
        }

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
    .await;

    if let Some(w) = worktree {
        w.remove().await;
    }
    outcome
}

fn resolve_workers(requested: Option<usize>, lane_count: usize) -> usize {
    match requested {
        Some(n) => n.max(1),
        None => lane_count.clamp(1, MAX_WORKERS_CAP),
    }
}

/// Pick a lane key, preferring the `platform/.env` value over the process-env one. An empty or
/// whitespace-only value counts as unset and falls through — the same empty-as-unset rule
/// `resolve_bench_db_url` uses, though its precedence is deliberately the opposite (process env wins
/// for the bench DB URL; `platform/.env` wins for provider keys).
fn pick_key(platform: Option<&str>, process: Option<&str>) -> Option<String> {
    [platform, process]
        .into_iter()
        .flatten()
        .find(|v| !v.trim().is_empty())
        .map(str::to_string)
}

fn lane_api_keys(lanes: &[Lane], platform_env: &HashMap<String, String>) -> Result<HashMap<String, String>, RunError> {
    let mut keys = HashMap::new();
    for lane in lanes {
        let key_env = lane.key_env();
        let process = std::env::var(&key_env).ok();
        let key = pick_key(platform_env.get(&key_env).map(String::as_str), process.as_deref()).ok_or_else(|| {
            RunError::Config(format!(
                "set {} in platform/.env or the environment to seed lane {:?} ({})",
                key_env, lane.name, lane.provider
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
                let tasks: Vec<_> = env.tasks.iter().filter(|t| names.contains(&t.id)).cloned().collect();
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
    let mut shared_setups: Vec<Option<HashMap<String, SharedLaneSetup>>> = plan.iter().map(|_| None).collect();
    let mut shared_instances: Vec<Instance> = Vec::new();
    let mut shared_fixtures: Vec<FixtureMcp> = Vec::new();
    let mut infra: Vec<RunResult> = Vec::new();
    for (i, env_plan) in plan.iter().enumerate() {
        if env_plan.share_backend() {
            match setup_shared_env(env_plan, &ctx).await {
                Ok((instance, fixture, setups)) => {
                    shared_instances.push(instance);
                    if let Some(fixture) = fixture {
                        shared_fixtures.push(fixture);
                    }
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
                if let Some(setup) = shared_setups[env_idx].as_mut().and_then(|m| m.remove(&lane.name)) {
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
                                ctx.prices.clone(),
                            )
                            .await,
                        );
                    }
                    EnvStop::Isolated { env, tasks } => {
                        out.extend(run_isolated_lane(env, tasks, lane.clone(), ctx.clone(), progress.clone()).await);
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

    for fixture in &shared_fixtures {
        fixture.stop().await;
    }
    for instance in &shared_instances {
        let _ = instance.shutdown().await;
    }

    progress.finish_and_clear();
    infra.into_iter().chain(lane_results.into_iter().flatten()).collect()
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

/// Seed an env's backend-wide defaults — skill defaults on, tool auto-assignment off, the `bench`
/// team, and every env skill — shared by the shared-backend and isolated-lane setup paths. Returns
/// the team id. The error is pre-stringified so each caller can route it into its own teardown +
/// failure-reporting style without re-wrapping (preserving today's raw `e.to_string()` text).
async fn seed_backend_defaults(client: &EvalClient, env: &EnvConfig) -> Result<String, String> {
    client.enable_skill_defaults().await.map_err(|e| e.to_string())?;
    client.disable_tool_auto_assignment().await.map_err(|e| e.to_string())?;
    let team_id = client.create_team("bench").await.map_err(|e| e.to_string())?;
    for sref in &env.skills {
        seed_skill_ref(client, &sref.repo, sref.path.as_deref(), &sref.ref_, sref.cap, "org")
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(team_id)
}

/// Seed an env's remote MCPs (with lock enforcement) and, when enabled, the harness-owned synthetic
/// fixture MCP, registering all of them to `agent_ids` — every lane's agent on a shared backend, the
/// single lane's agent on an isolated one. Returns the started fixture (kept alive and torn down by
/// the caller) or `None`. On error the fixture this call started is stopped here; the caller still
/// owns benchmark-MCP and backend teardown. The error is pre-stringified to match today's text.
async fn seed_env_mcps(
    client: &EvalClient,
    env: &EnvConfig,
    ctx: &RunCtx,
    agent_ids: &[String],
) -> Result<Option<FixtureMcp>, String> {
    if !env.mcps.is_empty() {
        let registered = seed_mcp_fixtures(client, &env.mcps, "org", Some(agent_ids))
            .await
            .map_err(|e| e.to_string())?;
        mcp_lock::enforce(&ctx.envs_dir, &env.id, &env.mcps, &registered, ctx.update_mcp_lock)?;
    }

    if !env.fixture_mcp {
        return Ok(None);
    }
    let fixture = FixtureMcp::start(FIXTURE_MCP_NAME).await.map_err(|e| e.to_string())?;
    if let Err(e) = register_remote_mcp(client, fixture.name(), fixture.base_url(), "org", Some(agent_ids)).await {
        fixture.stop().await;
        return Err(e.to_string());
    }
    Ok(Some(fixture))
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
) -> Result<(Instance, Option<FixtureMcp>, HashMap<String, SharedLaneSetup>), String> {
    let env = &env_plan.env;
    let log_path = ctx.root_run_dir.join(format!("{}.backend.log", slug(&env.id)));
    let mut instance = Instance::new(
        repo_root(),
        ctx.platform_dir.clone(),
        format!("{}-{}", ctx.run_id, env.id),
        log_path,
    );
    instance.start().await.map_err(|e| e.to_string())?;

    let client = instance.client.clone();
    let resolved = match resolve_lanes(&client, &env_plan.lanes, ctx).await {
        Ok(r) => r,
        Err(e) => {
            let _ = instance.shutdown().await;
            return Err(e.to_string());
        }
    };

    let team_id = match seed_backend_defaults(&client, env).await {
        Ok(id) => id,
        Err(e) => {
            let _ = instance.shutdown().await;
            return Err(e);
        }
    };

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
        match setup_lane_agent(&client, env, lane, &mcp, &team_id).await {
            Ok((agent_id, submit_tool)) => {
                setups.push((lane.clone(), agent_id, submit_tool, mcp));
            }
            Err(e) => {
                mcp.stop().await;
                stop_mcps(&setups).await;
                let _ = instance.shutdown().await;
                return Err(e.to_string());
            }
        }
    }

    let agent_ids: Vec<String> = if env.mcps.is_empty() && !env.fixture_mcp {
        Vec::new()
    } else {
        setups.iter().map(|(_, id, _, _)| id.clone()).collect()
    };
    let fixture = match seed_env_mcps(&client, env, ctx, &agent_ids).await {
        Ok(fixture) => fixture,
        Err(e) => {
            stop_mcps(&setups).await;
            let _ = instance.shutdown().await;
            return Err(e);
        }
    };

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

    Ok((instance, fixture, lane_setups))
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
        ctx.platform_dir.clone(),
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

    let team_id = match seed_backend_defaults(&client, &env).await {
        Ok(id) => id,
        Err(e) => {
            let _ = instance.shutdown().await;
            return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e);
        }
    };

    let mcp = match BenchmarkMcp::start(BENCH_MCP_NAME).await {
        Ok(m) => m,
        Err(e) => {
            let _ = instance.shutdown().await;
            return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e.to_string());
        }
    };

    let (agent_id, submit_tool) = match setup_lane_agent(&client, &env, &lane, &mcp, &team_id).await {
        Ok(s) => s,
        Err(e) => {
            mcp.stop().await;
            let _ = instance.shutdown().await;
            return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e.to_string());
        }
    };

    let fixture_mcp = match seed_env_mcps(&client, &env, &ctx, std::slice::from_ref(&agent_id)).await {
        Ok(fixture) => fixture,
        Err(e) => {
            mcp.stop().await;
            let _ = instance.shutdown().await;
            return infra_results_for_lane(&env, &tasks, &lane, &ctx, &progress, &e);
        }
    };

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
        ctx.prices.clone(),
    )
    .await;
    if let Some(fixture) = &fixture_mcp {
        fixture.stop().await;
    }
    let _ = instance.shutdown().await;
    results
}

fn infra_results(env_plan: &EnvPlan, ctx: &RunCtx, progress: &ProgressBar, error: &str) -> Vec<RunResult> {
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
            prompt_tokens: None,
            completion_tokens: None,
            cache_read_tokens: None,
            cache_write_tokens: None,
            price_model: None,
            cost: RunCost::NoSpend,
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
    team_id: &str,
) -> Result<(String, String), RunError> {
    let agent_id = ensure_agent(
        client,
        &format!("{}-{}", env.agent_name, lane.slug()),
        &env.agent_system_prompt,
        env.platform.tool_exposure_mode,
        team_id,
    )
    .await?;
    let submit_tool = setup_agent_tools(client, &agent_id, mcp.base_url(), &env.tools, mcp.name()).await?;
    Ok((agent_id, submit_tool))
}

/// Pull a required `id` string from a platform API object. A missing or non-string `id` is a
/// broken-contract error surfaced loudly, never an empty id silently fed into downstream calls.
fn require_id(value: &HashMap<String, serde_json::Value>, what: &str) -> Result<String, RunError> {
    value
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            RunError::Client(ContractError(format!("{what}: API response missing non-empty string `id`")).into())
        })
}

async fn ensure_agent(
    client: &EvalClient,
    name: &str,
    system_prompt: &str,
    tool_exposure_mode: ToolExposureMode,
    team_id: &str,
) -> Result<String, RunError> {
    let existing = client.list_agents(Some(name), Some("org")).await?;
    // Reuse by name is intra-run idempotency only: each run boots a fresh per-run database that
    // teardown drops (see lifecycle::Instance::start), so no agent created with a different
    // tool_exposure_mode can survive into a later run with a flipped flag.
    if let Some(agent) = existing
        .iter()
        .find(|a| a.get("name").and_then(|v| v.as_str()) == Some(name))
    {
        return require_id(agent, "agent");
    }
    let created = client
        .create_agent(&AgentCreate {
            name: name.to_string(),
            scope: "org".to_string(),
            agent_type: "agent".to_string(),
            system_prompt: (!system_prompt.trim().is_empty()).then(|| system_prompt.to_string()),
            tool_exposure_mode,
            teams: vec![team_id.to_string()],
        })
        .await?;
    require_id(&created, "agent")
}

async fn setup_agent_tools(
    client: &EvalClient,
    agent_id: &str,
    bench_url: &str,
    extra_tools: &[String],
    mcp_name: &str,
) -> Result<String, RunError> {
    let mut short_names: Vec<String> = REQUIRED_TOOL_SHORT_NAMES.iter().map(|s| s.to_string()).collect();
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

    let registered = register_remote_mcp(client, mcp_name, bench_url, "org", Some(&[agent_id.to_string()])).await?;
    let submit_tool = find_submit_tool(&registered.tools)?;
    let allowed: HashSet<String> = extra_tools.iter().map(|n| format!("archestra__{n}")).collect();
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
        violations.push(format!("missing required tools after assignment: {:?}", missing));
    }
    if !present.contains(submit_tool) {
        violations.push(format!("benchmark tool {:?} was not assigned/discovered", submit_tool));
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
            let tool_id = require_id(&tool, "agent tool")?;
            client.unassign_tool(agent_id, &tool_id).await?;
        }
    }
    Ok(())
}

async fn resolve_tool_ids(client: &EvalClient, short_names: &[String]) -> Result<HashMap<String, String>, RunError> {
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
        let id = require_id(&matches[0], "tool")?;
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
        .filter_map(|t| t.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
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
    prices: Arc<PriceBook>,
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
            &prices,
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
    prices: &PriceBook,
) -> RunResult {
    let rollout_key = format!("{env_id}/{}/{}", task.id, lane.slug());
    let artifacts = match RunArtifacts::new(root_run_dir.join(run_subdir(env_id, &task.id, lane))).await {
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
                prompt_tokens: None,
                completion_tokens: None,
                cache_read_tokens: None,
                cache_write_tokens: None,
                price_model: None,
                cost: RunCost::NoSpend,
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
        prices,
    )
    .await
    {
        Ok(result) => result,
        Err(e) => {
            let error = format!("infra: {e}");
            agent_error_result(env_id, lane, task, &error, &artifacts, metadata, None, prices).await
        }
    }
}

/// Recover the effective prompt(s) the model received from the platform's persisted provider requests
/// and record them in the trajectory. Observability enrichment: every failure is surfaced as a
/// loud `effective_prompt_error` event plus a warn log, but never propagated — a capture problem must
/// not fail an otherwise-complete rollout.
async fn capture_effective_prompts(
    interactions: &[serde_json::Value],
    conversation_id: &str,
    artifacts: &RunArtifacts,
) {
    // Every emitted event carries `conversation_id` so a multi-conversation rollout's captured prompts
    // can be attributed to the conversation they came from.
    let emit_error = async |message: &str| {
        artifacts
            .append(
                "effective_prompt_error",
                serde_json::json!({"conversation_id": conversation_id, "error": message}),
            )
            .await;
    };

    let outcome = extract_effective_prompts(interactions);
    for prompt in &outcome.prompts {
        match serde_json::to_value(prompt) {
            Ok(mut value) => {
                if let serde_json::Value::Object(map) = &mut value {
                    map.insert(
                        "conversation_id".to_string(),
                        serde_json::Value::String(conversation_id.to_string()),
                    );
                }
                artifacts.append("effective_prompt", value).await
            }
            Err(e) => {
                warn!("failed to serialize effective prompt: {e}");
                emit_error(&e.to_string()).await;
            }
        }
    }
    for error in &outcome.errors {
        warn!("effective-prompt anomaly: {error}");
        emit_error(error).await;
    }
}

/// Create a conversation for the running task and record it. Used both for the task's initial
/// conversation and for each `new_conversation` stage, which opens a fresh one (same agent, project,
/// model, and key) so the agent starts from an empty sandbox and chat history.
async fn open_conversation(
    client: &EvalClient,
    agent_id: &str,
    title: &str,
    resolved: &ResolvedModel,
    project_id: &str,
    artifacts: &RunArtifacts,
) -> Result<String, RunError> {
    let conversation = client
        .create_conversation(
            agent_id,
            Some(title),
            Some(&resolved.model_id),
            Some(&resolved.api_key_id),
            Some(project_id),
        )
        .await?;
    let conversation_id = conversation
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RunError::Config("create_conversation returned no `id`".to_string()))?
        .to_string();
    artifacts
        .append(
            "conversation_created",
            serde_json::json!({"conversation_id": conversation_id}),
        )
        .await;
    Ok(conversation_id)
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
    prices: &PriceBook,
) -> Result<RunResult, RunError> {
    bench_mcp
        .begin_task(rollout_key, &task.result_schema, task.max_format_attempts)
        .await
        .map_err(|e| RunError::Mcp(e.to_string()))?;

    // One project per rollout: it is the persistent-file namespace the rollout's conversations
    // share (a `new_conversation` stage rediscovers exported files through it), and scoping it to
    // the rollout keeps other tasks' artifacts out of the agent's filename space and out of
    // artifact resolution. The full-UUID token keeps the name (and its derived slug) unique per
    // the projects `(user_id, name)` / `(org, slug)` indexes without needing collision retries --
    // all lanes share one user.
    let token = uuid::Uuid::new_v4().simple().to_string();
    let project_id = client.create_project(&format!("{PROJECT_NAME} {token}")).await?;

    let mut conversation_id =
        open_conversation(&client, agent_id, rollout_key, resolved, &project_id, artifacts).await?;
    // Every conversation this rollout drives, in order. `new_conversation` stages append to it;
    // `metadata["conversation_id"]` tracks the current one so run.json points at the conversation that
    // produced the result, and effective-prompt capture runs over all of them after the loop.
    let mut conversation_ids = vec![conversation_id.clone()];
    metadata["conversation_id"] = serde_json::Value::String(conversation_id.clone());
    artifacts.write_run(metadata).await;

    let runtime: HashMap<String, String> = HashMap::from([
        ("cell".to_string(), rollout_token(rollout_key, &lane.model)),
        ("agent_id".to_string(), agent_id.to_string()),
    ]);

    // Capture once: the agent's configured system prompt plus the expanded stage-0 task text
    // (the human-authored prompt, before any trailing instruction). drive_stage appends the trailer
    // when it sends each stage: SUBMIT_INSTRUCTION on the final stage, CONTINUE_INSTRUCTION otherwise.
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
        // A `new_conversation` stage starts a fresh conversation (empty sandbox + chat history) and
        // becomes the current one for this and later stages -- so a task can export a file in one chat
        // and rediscover it from persistent storage in the next. Rejected on the first stage at load
        // time, since the initial conversation is already created above.
        if stage.new_conversation {
            conversation_id =
                open_conversation(&client, agent_id, rollout_key, resolved, &project_id, artifacts).await?;
            conversation_ids.push(conversation_id.clone());
            metadata["conversation_id"] = serde_json::Value::String(conversation_id.clone());
        }
        // Single source of truth: the final stage both opens the server-side submission gate and gets
        // the SUBMIT_INSTRUCTION trailer (earlier stages get CONTINUE_INSTRUCTION). Binding it once
        // keeps the gate and the prompt trailer from drifting apart.
        let submission_open = index == final_stage;
        if submission_open {
            bench_mcp.allow_submission(rollout_key).await;
        }
        // Carry prior chat history only when continuing the same conversation; a freshly opened one
        // (first stage, or a `new_conversation` stage) starts empty.
        let expect_prior_history = index > 0 && !stage.new_conversation;
        stage_error = drive_stage_with_retry(
            &client,
            &conversation_id,
            stage,
            task,
            &mut run,
            artifacts,
            &runtime,
            expect_prior_history,
            submission_open,
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

    // Safety net: a capable model often solves the task and reports the answer in chat, or stops to
    // ask a clarifying question, then ends its turn without ever calling the submit tool. As long as
    // it stopped voluntarily (clean `stop`) with nothing submitted, re-prompt it as a hands-off user
    // and let it continue -- bounded to MAX_SUBMIT_NUDGES turns so a model that keeps asking or
    // refusing still terminates, and only on a clean `stop` so an error/limit still ends the run.
    let mut nudges_sent = 0usize;
    loop {
        let submitted = bench_mcp.has_submission(rollout_key).await;
        if !should_nudge(
            run.finish_reason.as_deref(),
            submitted,
            stage_error.is_some(),
            nudges_sent,
            MAX_SUBMIT_NUDGES,
        ) {
            break;
        }
        nudges_sent += 1;
        artifacts
            .append("submit_nudge", serde_json::json!({ "attempt": nudges_sent }))
            .await;
        let nudge = Stage {
            text: SUBMIT_NUDGE.to_string(),
            files: Vec::new(),
            new_conversation: false,
        };
        // The pre-nudge turn already terminated cleanly (the gate requires `stage_error.is_none()`);
        // the nudge is a best-effort extra turn to recover a missing submission. Keep its error out of
        // `stage_error` so a failed nudge -- most likely for the truncated/stuck population whose
        // resent history can provoke a provider error -- doesn't mask the rollout's clean
        // `NoSubmission` as an agent error. Record it as an artifact for triage instead.
        if let Some(nudge_error) = drive_stage_with_retry(
            &client,
            &conversation_id,
            &nudge,
            task,
            &mut run,
            artifacts,
            &runtime,
            true,
            true,
        )
        .await?
        {
            artifacts
                .append("submit_nudge_error", serde_json::json!({"error": nudge_error}))
                .await;
        }
    }

    // Source the rollout's billable usage from the persisted LLM-proxy interaction rows, summed across
    // every conversation it drove -- one row per agentic step, so the total covers all steps rather
    // than only the last one the chat SSE event reports, and includes cache-write tokens the event
    // omits. A `new_conversation` task splits its turns across several conversations; each one's
    // effective prompts are recorded too, from the same fetched rows.
    let mut usage = RunUsage::default();
    for cid in &conversation_ids {
        match client.fetch_session_interactions(cid).await {
            Ok(rows) => {
                if run.turn_count > 0 && rows.is_empty() {
                    let msg = "no interactions found despite the conversation taking turns";
                    warn!("{msg}");
                    artifacts
                        .append(
                            "effective_prompt_error",
                            serde_json::json!({"conversation_id": cid, "error": msg}),
                        )
                        .await;
                }
                capture_effective_prompts(&rows, cid, artifacts).await;
                usage.add(&sum_usage(&rows));
            }
            Err(e) => {
                // A fetch failure leaves the rollout's usage incomplete; record it so cost is reported
                // as unpriceable rather than silently under-summed.
                let msg = format!("failed to fetch interactions: {e}");
                warn!("{msg}");
                artifacts
                    .append(
                        "effective_prompt_error",
                        serde_json::json!({"conversation_id": cid, "error": msg}),
                    )
                    .await;
                run.usage_fetch_failed = true;
            }
        }
    }
    run.usage = usage;

    // Publish token totals only when the usage is reliable (complete fetch, no telemetry gap); an
    // incomplete sum is reported as no measurement, never a partial count read as complete.
    let reliable = run.reliable_usage().cloned();
    let token_meta =
        |value: Option<i64>| -> serde_json::Value { value.map_or(serde_json::Value::Null, serde_json::Value::from) };
    metadata["finish_reason"] = serde_json::to_value(&run.finish_reason).unwrap_or(serde_json::Value::Null);
    metadata["tool_call_count"] = serde_json::Value::Number((run.tool_calls.len() as i64).into());
    metadata["turn_count"] = serde_json::Value::Number((run.turn_count as i64).into());
    metadata["total_tokens"] = token_meta(reliable.as_ref().map(RunUsage::total_tokens));
    metadata["prompt_tokens"] = token_meta(reliable.as_ref().map(|u| u.prompt_tokens));
    metadata["completion_tokens"] = token_meta(reliable.as_ref().map(|u| u.completion_tokens));
    metadata["cache_read_tokens"] = token_meta(reliable.as_ref().map(|u| u.cache_read_tokens));
    metadata["cache_write_tokens"] = token_meta(reliable.as_ref().map(|u| u.cache_write_tokens));

    let submission = bench_mcp.take_submission(rollout_key).await;
    match submission {
        Submission::FormatFailed(failed) => {
            metadata["format_errors"] =
                serde_json::Value::Array(failed.errors.into_iter().map(serde_json::Value::String).collect());
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
                prices,
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
                    prices,
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
                prices,
            )
            .await);
        }
        Submission::Accepted(accepted) => {
            metadata["format_attempts"] = serde_json::Value::Number((accepted.attempts as i64).into());
            metadata["result"] = serde_json::from_slice(&accepted.payload_bytes).unwrap_or(serde_json::Value::Null);
            let report_path = artifacts.write_bytes("submission.json", &accepted.payload_bytes).await;
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
                            prices,
                        )
                        .await);
                    }
                }
            } else {
                None
            };

            let state_bytes = if !task.state_rest.is_empty() {
                match capture_state(&client, task, &runtime, &run.tool_invocations, artifacts, metadata).await {
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
                            prices,
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
                metadata["verifier_summary"] = serde_json::Value::String(verifier_summary(&outcome));
            }
            return Ok(finish(
                env_id,
                lane,
                task,
                if passed { Outcome::Passed } else { Outcome::Failed },
                Some(&run),
                artifacts,
                metadata,
                accepted.attempts,
                None,
                prices,
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
    submission_open: bool,
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
        submission_open,
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
        submission_open,
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

/// Assemble a stage's user message: the (runtime-expanded) stage text plus the trailing instruction.
/// On the final stage submission is open, so SUBMIT_INSTRUCTION is appended; on earlier stages it is
/// gated, so CONTINUE_INSTRUCTION is appended instead (which reveals nothing about submission).
fn stage_message(stage_text: &str, submission_open: bool) -> String {
    let trailer = if submission_open {
        SUBMIT_INSTRUCTION
    } else {
        CONTINUE_INSTRUCTION
    };
    format!("{stage_text}\n\n{trailer}")
}

/// Whether to send another submit-nudge. We re-prompt only when the lane voluntarily ended its turn
/// (`stop`) without submitting and nudges remain; any error/limit or non-`stop` finish ends the run,
/// and a recorded submission means we're done. Keeps the runaway bound and the clean-exit guards in
/// one testable place.
fn should_nudge(finish_reason: Option<&str>, submitted: bool, had_error: bool, nudges_sent: usize, cap: usize) -> bool {
    !had_error && !submitted && finish_reason == Some("stop") && nudges_sent < cap
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
    submission_open: bool,
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
    let text = stage_message(&expand_runtime(&stage.text, runtime), submission_open);
    let mut stream_parse_error: Option<String> = None;
    let mut coalescer = StreamCoalescer::new(artifacts);
    // `apply_chat_event` only ever sets `finish_reason` (on a finish event) and never clears it, so
    // reset it per turn here -- otherwise a turn that closes without a finish event would retain the
    // prior turn's value. Keeps the returned `finish_reason` scoped to this turn for the submit-nudge
    // loop's `stop` guard.
    run.finish_reason = None;

    let mut stream = client
        .stream_chat_records(conversation_id, prior_messages, &text, &files, turn_id)
        .await?;
    loop {
        let record = match timeout(STREAM_IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(record)) => record,
            Ok(None) => break,
            Err(_) => {
                if stream_parse_error.is_none() {
                    stream_parse_error = Some(format!("chat stream idle for {}s", STREAM_IDLE_TIMEOUT.as_secs()));
                }
                break;
            }
        };
        coalescer.feed(&record).await;
        match record.kind {
            ChatRecordKind::Event if record.event.is_some() => {
                let event = record.event.unwrap();
                // Auto-answer any elicitation this event carries before folding it. Backend
                // heartbeats keep the stream from going idle, so a failed answer would otherwise
                // hang until the backend's 10-minute elicitation timeout; fail the stage instead.
                if let Err(e) = client.answer_if_elicitation(&event).await {
                    if stream_parse_error.is_none() {
                        stream_parse_error = Some(format!("failed to answer MCP elicitation: {e}"));
                    }
                    break;
                }
                apply_chat_event(run, &event);
            }
            ChatRecordKind::ParseError if stream_parse_error.is_none() => {
                stream_parse_error = Some(
                    record
                        .reason
                        .unwrap_or_else(|| record.raw.unwrap_or_else(|| "malformed chat stream data".to_string())),
                );
            }
            _ => {}
        }
    }
    coalescer.flush().await;
    // Token usage is no longer read from the stream: the run's billable totals are summed post-run from
    // the persisted interaction rows (see grade_rollout), which capture every agentic step.
    Ok(combine_errors(run.stream_error.clone(), stream_parse_error))
}

fn combine_errors(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (None, None) => None,
        (Some(a), None) | (None, Some(a)) => Some(a),
        (Some(a), Some(b)) => Some(format!("{a}; {b}")),
    }
}

/// Files named `filename` that the agent exported to persistent storage, as visible from the final
/// conversation's `/files` payload: its own `generated` files plus the rollout project's
/// `projectFiles`. A file exported in an earlier stage's conversation and updated in place stays
/// attributed to that conversation (`generated` there), but reaches the final conversation through
/// the shared project -- the backend dedupes the two buckets by id, so each file appears in exactly
/// one. `attachments` are harness-staged inputs, never a deliverable.
fn named_exported_files(files: &HashMap<String, serde_json::Value>, filename: &str) -> Vec<serde_json::Value> {
    ["generated", "projectFiles"]
        .iter()
        .filter_map(|bucket| files.get(*bucket)?.as_array())
        .flatten()
        .filter(|f| f.get("name").and_then(|v| v.as_str()) == Some(filename))
        .cloned()
        .collect()
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
    let result: serde_json::Value = serde_json::from_slice(payload_bytes).unwrap_or(serde_json::Value::Null);
    let filename = result.get(artifact_key).and_then(|v| v.as_str()).map(|s| s.to_string());
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
    let matches = named_exported_files(&files, &filename);
    if matches.len() != 1 {
        artifacts
            .append_error(
                "artifact_missing",
                &format!(
                    "expected exactly one exported file named {filename:?} among the final \
                     conversation's generated + project files, found {}",
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
                    &format!("exported file {filename:?} has no contentUrl"),
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

async fn save_verifier_artifacts(artifacts: &RunArtifacts, metadata: &mut serde_json::Value, outcome: &VerifyOutcome) {
    let stdout_path = artifacts.write_text("verifier.stdout.txt", &outcome.stdout).await;
    let stderr_path = artifacts.write_text("verifier.stderr.txt", &outcome.stderr).await;
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
    prices: &PriceBook,
) -> RunResult {
    // Reported token totals come from reliable usage only, so an incomplete sum never skews the token
    // aggregates; cost classification (run_cost) looks at the full usage independently.
    let (total_tokens, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens) =
        match run.and_then(ChatRunResult::reliable_usage) {
            Some(u) => (
                Some(u.total_tokens()),
                Some(u.prompt_tokens),
                Some(u.completion_tokens),
                Some(u.cache_read_tokens),
                Some(u.cache_write_tokens),
            ),
            None => (None, None, None, None, None),
        };
    let price_model = lane.price_model();
    let cost = run_cost(run, prices, price_model.as_deref());
    let (cost_value, cost_status) = match cost {
        RunCost::Priced(c) => (serde_json::Value::from(c), "priced"),
        RunCost::Unpriced => (serde_json::Value::Null, "unpriced"),
        RunCost::NoSpend => (serde_json::Value::Null, "no_spend"),
    };
    if let serde_json::Value::Object(map) = metadata {
        map["finished_at"] = serde_json::Value::String(timestamp());
        map["outcome"] = serde_json::Value::String(outcome.value().to_string());
        map["agent_error"] = serde_json::to_value(&agent_error).unwrap_or(serde_json::Value::Null);
        map["format_attempts"] = serde_json::Value::Number((format_attempts as i64).into());
        // insert (not index-assign): unlike the keys above, run_one does not pre-seed these, and
        // indexing a missing key on a serde_json Map panics.
        map.insert(
            "price_model".to_string(),
            serde_json::to_value(&price_model).unwrap_or(serde_json::Value::Null),
        );
        map.insert("cost_usd".to_string(), cost_value);
        map.insert(
            "cost_status".to_string(),
            serde_json::Value::String(cost_status.to_string()),
        );
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
        total_tokens,
        prompt_tokens,
        completion_tokens,
        cache_read_tokens,
        cache_write_tokens,
        price_model,
        cost,
        agent_error,
        stage_count: task.stages.len(),
        format_attempts,
        artifact_dir: Some(artifacts.path.to_string_lossy().to_string()),
    }
}

/// Classify a rollout's USD cost from its interaction-sourced usage. Billable spend that we cannot
/// fully and faithfully price is `Unpriced` (loud), never silently dropped: an incomplete fetch, no
/// recorded rows despite turns, a per-row telemetry gap, or a session that mixed models (which one
/// lane slug cannot price) all unprice it, as does a slug absent from the price book. A rollout with
/// no recorded LLM call is `NoSpend` (a real zero).
fn run_cost(run: Option<&ChatRunResult>, prices: &PriceBook, price_model: Option<&str>) -> RunCost {
    let Some(run) = run else {
        return RunCost::NoSpend;
    };
    let usage = &run.usage;
    // A failed fetch leaves usage incomplete whenever there is any sign the rollout did LLM work
    // (recorded turns or rows); recorded turns with no rows at all is the same incompleteness. Either
    // way it is real spend we cannot fully account — kept consistent with `reliable_usage`, which
    // withholds the token totals for exactly these cases.
    if run.usage_fetch_failed && (run.turn_count > 0 || usage.chat_rows > 0) {
        return RunCost::Unpriced;
    }
    if run.turn_count > 0 && usage.chat_rows == 0 {
        return RunCost::Unpriced;
    }
    if !usage.had_spend() {
        return RunCost::NoSpend;
    }
    if usage.rows_with_null_tokens > 0 || usage.models.len() > 1 {
        return RunCost::Unpriced;
    }
    match prices.cost(
        Some(usage.prompt_tokens),
        Some(usage.completion_tokens),
        Some(usage.cache_read_tokens),
        Some(usage.cache_write_tokens),
        price_model,
    ) {
        Some(c) => RunCost::Priced(c),
        None => RunCost::Unpriced,
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
    prices: &PriceBook,
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
        prices,
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
        record.insert("sequence".to_string(), serde_json::Value::Number((*seq as i64).into()));
        record.insert("timestamp".to_string(), serde_json::Value::String(timestamp()));
        record.insert("kind".to_string(), serde_json::Value::String(kind.to_string()));
        if let serde_json::Value::Object(map) = data {
            for (k, v) in map {
                record.insert(k, v);
            }
        } else {
            record.insert("data".to_string(), data);
        }
        let mut line = match serde_json::to_string(&serde_json::Value::Object(record)) {
            Ok(l) => l,
            Err(e) => {
                error!("failed to serialize trajectory record: {e}");
                return;
            }
        };
        // Emit the record and its terminator as one buffer: a `tokio::fs::File`'s writes are
        // backgrounded and its `write_all` does not guarantee the bytes reached the kernel before
        // the next append runs, so a record and a separate newline write could interleave with the
        // following record under `O_APPEND`. One atomic write plus an explicit flush (both still
        // under the `sequence` lock) keeps every record on its own line.
        line.push('\n');
        if let Err(e) = async {
            let mut f: tokio::fs::File = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.path.join("trajectory.jsonl"))
                .await?;
            f.write_all(line.as_bytes()).await?;
            f.flush().await?;
            Ok::<(), std::io::Error>(())
        }
        .await
        {
            error!("failed to append trajectory record: {e}");
        }
    }

    async fn append_error(&self, kind: &str, message: &str) {
        self.append(kind, serde_json::json!({"error": message})).await;
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
                        .append("assistant_text", serde_json::json!({"id": id, "text": text}))
                        .await;
                }
            }
            Some("tool-input-start") => {
                if let Some(call_id) = event.get("toolCallId").and_then(|v| v.as_str()) {
                    let name = event.get("toolName").and_then(|v| v.as_str()).map(|s| s.to_string());
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
                    let field = |key: &str| data.get(key).and_then(|v| v.as_i64());
                    self.artifacts
                        .append(
                            "token_usage",
                            serde_json::json!({
                                "total_tokens": total,
                                "prompt_tokens": field("inputTokens"),
                                "completion_tokens": field("outputTokens"),
                                "cache_read_tokens": field("cacheReadTokens"),
                            }),
                        )
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
                self.artifacts.append("error", serde_json::json!({"error": text})).await;
            }
            Some("start") | Some("start-step") | Some("data-heartbeat") | Some("data-context-window-estimate") => {}
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
                    .append("assistant_text", serde_json::json!({"id": id, "text": text}))
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
    event.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

static RUNTIME_PLACEHOLDER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"\{\{(cell|agent_id)\}\}").expect("valid regex"));

fn expand_runtime(text: &str, mapping: &HashMap<String, String>) -> String {
    RUNTIME_PLACEHOLDER
        .replace_all(text, |caps: &regex::Captures| {
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
    let slug = if slug.is_empty() { "model".to_string() } else { slug };
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

/// Filesystem-safe slug for the `--branch` worktree directory: map every char that isn't
/// alnum/`-`/`_`/`.` (e.g. the `/` in `feature/foo`) to `-`, and suffix the run id so repeat runs of
/// the same ref don't collide on the path.
fn sanitize_slug(git_ref: &str, run_id: &str) -> String {
    format!("{git_ref}-{run_id}")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

async fn write_run_config(
    run_dir: &Path,
    run_id: &str,
    plan: &[EnvPlan],
    max_workers: usize,
    prices: &PriceBook,
    price_status: &str,
    backend_branch: Option<&str>,
    backend_commit: Option<&str>,
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
            let price_model = l.price_model();
            let price = price_model.as_deref().and_then(|slug| prices.get(slug));
            serde_json::json!({
                "name": l.name,
                "provider": l.provider,
                "model": l.model,
                "base_url": l.base_url,
                "price_model": price_model,
                "price": price,
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
                String::from_utf8(out.stdout).ok().map(|s| s.trim().to_string())
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
        // When `--branch` is used the backend runs from a worktree of this ref/commit, not the harness
        // checkout `git_commit` above; null on a normal run. Lets A/B results name the backend they ran.
        "backend_branch": backend_branch,
        "backend_commit": backend_commit,
        "temperature": crate::client::BENCH_TEMPERATURE,
        "pricing": {
            "source": "openrouter",
            "fetched_at": timestamp(),
            "status": price_status,
        },
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

    fn files_payload(json: serde_json::Value) -> HashMap<String, serde_json::Value> {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn test_sanitize_slug_is_filesystem_safe() {
        // Slashes and other non-`[A-Za-z0-9._-]` chars collapse to `-`; the run id is appended.
        assert_eq!(sanitize_slug("feature/foo", "rid1"), "feature-foo-rid1");
        assert_eq!(sanitize_slug("release/v1.2", "r2"), "release-v1.2-r2");
        assert_eq!(sanitize_slug("a b:c@d", "r"), "a-b-c-d-r");
        assert!(
            sanitize_slug("origin/x", "id")
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        );
    }

    #[test]
    fn test_named_exported_files_matches_generated() {
        let files = files_payload(serde_json::json!({
            "generated": [{"name": "report.xlsx", "contentUrl": "/api/skill-sandbox/artifacts/g1"}],
            "projectFiles": [{"name": "other.xlsx", "contentUrl": "/api/skill-sandbox/artifacts/p1"}],
            "attachments": [],
        }));
        let matches = named_exported_files(&files, "report.xlsx");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["contentUrl"], "/api/skill-sandbox/artifacts/g1");
    }

    #[test]
    fn test_named_exported_files_matches_project_files() {
        // The overwrite case: a file exported in an earlier stage's conversation is attributed
        // there, so the final conversation sees it only through the project bucket.
        let files = files_payload(serde_json::json!({
            "generated": [],
            "projectFiles": [{"name": "report.xlsx", "contentUrl": "/api/skill-sandbox/artifacts/p1"}],
        }));
        let matches = named_exported_files(&files, "report.xlsx");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["contentUrl"], "/api/skill-sandbox/artifacts/p1");
    }

    #[test]
    fn test_named_exported_files_no_match() {
        let files = files_payload(serde_json::json!({
            "generated": [{"name": "other.xlsx"}],
            "projectFiles": [],
        }));
        assert!(named_exported_files(&files, "report.xlsx").is_empty());
    }

    #[test]
    fn test_named_exported_files_duplicate_across_buckets() {
        // Cannot happen with project-scoped exports (name-unique per project, buckets deduped by
        // id), but the selection stays strict rather than salvaging if it ever does.
        let files = files_payload(serde_json::json!({
            "generated": [{"name": "report.xlsx"}],
            "projectFiles": [{"name": "report.xlsx"}],
        }));
        assert_eq!(named_exported_files(&files, "report.xlsx").len(), 2);
    }

    #[test]
    fn test_named_exported_files_ignores_attachments() {
        // Harness-staged inputs share the payload but are never a deliverable.
        let files = files_payload(serde_json::json!({
            "generated": [],
            "projectFiles": [],
            "attachments": [{"name": "report.xlsx", "contentUrl": "/api/chat/attachments/a1/content"}],
        }));
        assert!(named_exported_files(&files, "report.xlsx").is_empty());
    }

    #[test]
    fn test_named_exported_files_missing_buckets() {
        // A payload without the optional buckets (or with non-array values) yields no matches
        // rather than panicking.
        assert!(named_exported_files(&HashMap::new(), "report.xlsx").is_empty());
        let files = files_payload(serde_json::json!({"generated": "not-an-array"}));
        assert!(named_exported_files(&files, "report.xlsx").is_empty());
    }

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
    fn test_stage_message_final_appends_submit() {
        // Final stage: submission is open, so the hand-in instruction is appended (unchanged behavior).
        let msg = stage_message("do the thing", true);
        assert_eq!(msg, format!("do the thing\n\n{SUBMIT_INSTRUCTION}"));
        assert!(msg.ends_with(SUBMIT_INSTRUCTION));
    }

    #[test]
    fn test_stage_message_nonfinal_appends_continue() {
        // Non-final stage: submission is gated, so the continuation line is appended and the message
        // reveals nothing about submitting.
        let msg = stage_message("do the thing", false);
        assert_eq!(msg, format!("do the thing\n\n{CONTINUE_INSTRUCTION}"));
        assert!(!msg.contains(SUBMIT_INSTRUCTION));
        assert!(!msg.to_lowercase().contains("submit"));
    }

    #[test]
    fn test_should_nudge_stops_without_submission_under_cap() {
        // The case the loop exists for: clean stop, nothing submitted, no error, room left.
        assert!(should_nudge(Some("stop"), false, false, 0, 3));
        assert!(should_nudge(Some("stop"), false, false, 2, 3));
    }

    #[test]
    fn test_should_nudge_false_once_submitted() {
        assert!(!should_nudge(Some("stop"), true, false, 0, 3));
    }

    #[test]
    fn test_should_nudge_false_on_error() {
        // An error/limit already ended the run; never re-prompt over it.
        assert!(!should_nudge(Some("stop"), false, true, 0, 3));
    }

    #[test]
    fn test_should_nudge_false_on_non_stop_finish() {
        // Anything other than a voluntary `stop` (length cap, tool-calls, no finish event) ends.
        assert!(!should_nudge(Some("length"), false, false, 0, 3));
        assert!(!should_nudge(None, false, false, 0, 3));
    }

    #[test]
    fn test_should_nudge_respects_cap() {
        assert!(!should_nudge(Some("stop"), false, false, 3, 3));
        assert!(!should_nudge(Some("stop"), false, false, 4, 3));
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
        let required: HashSet<String> = ["archestra__todo_write"].iter().map(|s| s.to_string()).collect();
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

    #[test]
    fn test_pick_key_prefers_platform_over_process() {
        let cases = [
            // platform/.env wins when both are set.
            (Some("env"), Some("proc"), Some("env")),
            // empty/whitespace platform value is unset and falls back to the process env.
            (Some(""), Some("proc"), Some("proc")),
            (Some("  "), Some("proc"), Some("proc")),
            // missing platform falls back; missing process is fine when platform has a value.
            (None, Some("proc"), Some("proc")),
            (Some("env"), None, Some("env")),
            // neither set (or both empty) yields nothing.
            (None, None, None),
            (Some(" "), Some(""), None),
        ];
        for (platform, process, expected) in cases {
            assert_eq!(
                pick_key(platform, process),
                expected.map(str::to_string),
                "platform={platform:?} process={process:?}"
            );
        }
    }

    #[test]
    fn test_lane_api_keys_prefers_platform_env() {
        // A unique var, absent from the test process env and present only in platform_env, proves
        // `lane_api_keys` consults and uses the parsed `.env`.
        let mut lane = dummy_lane("l1");
        lane.api_key_env = Some("ARCHESTRA_BENCH_TEST_LANE_KEY".to_string());
        let platform_env = HashMap::from([("ARCHESTRA_BENCH_TEST_LANE_KEY".to_string(), "from-dotenv".to_string())]);
        let keys = lane_api_keys(&[lane], &platform_env).unwrap();
        assert_eq!(keys.get("l1"), Some(&"from-dotenv".to_string()));
    }

    #[test]
    fn test_lane_api_keys_falls_back_to_process_env() {
        // `PATH` is reliably set in the test process and absent from platform_env, so it exercises
        // the process-env fallback (the prod-image CI path) without mutating global state.
        let mut lane = dummy_lane("l1");
        lane.api_key_env = Some("PATH".to_string());
        let keys = lane_api_keys(&[lane], &HashMap::new()).unwrap();
        assert_eq!(keys.get("l1"), std::env::var("PATH").ok().as_ref());
    }

    #[test]
    fn test_lane_api_keys_missing_everywhere_is_config_error() {
        let mut lane = dummy_lane("l1");
        lane.api_key_env = Some("ARCHESTRA_BENCH_TEST_UNSET_LANE_KEY".to_string());
        let err = lane_api_keys(&[lane], &HashMap::new()).unwrap_err();
        assert!(matches!(err, RunError::Config(_)), "got {err:?}");
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
            fixture_mcp: false,
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
            openrouter_model: None,
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
            (dummy_env("a", vec![dummy_task("t1")]), vec![dummy_task("t1")]),
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
            vec![(shared, vec![dummy_task("t1")]), (isolated, vec![dummy_task("t2")])],
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
        assert!(matches!(event, archestra_bench_core::Event::ToolCall { .. }));
    }

    fn priced_book() -> PriceBook {
        crate::pricing::parse_price_book(&serde_json::json!({
            "data": [{ "id": "vendor/cheap", "pricing": { "prompt": "0.000001", "completion": "0.000002" } }]
        }))
    }

    #[tokio::test]
    async fn finish_writes_cost_to_run_json_and_result() {
        let tmp = tempfile::tempdir().unwrap();
        let artifacts = RunArtifacts::new(tmp.path().join("e__t1__l1")).await.unwrap();
        let mut lane = dummy_lane("l1");
        lane.provider = archestra_bench_core::Provider::Openrouter;
        lane.model = "vendor/cheap".to_string();
        let task = dummy_task("t1");
        let run = ChatRunResult {
            turn_count: 2,
            usage: RunUsage {
                prompt_tokens: 1000,
                completion_tokens: 500,
                chat_rows: 2,
                models: ["vendor/cheap".to_string()].into_iter().collect(),
                ..Default::default()
            },
            ..Default::default()
        };
        let mut metadata = serde_json::json!({
            "finished_at": null, "outcome": null, "agent_error": null, "format_attempts": 0,
        });
        let result = finish(
            "e",
            &lane,
            &task,
            Outcome::Passed,
            Some(&run),
            &artifacts,
            &mut metadata,
            0,
            None,
            &priced_book(),
        )
        .await;
        // 1000 * 1e-6 + 500 * 2e-6 = 0.002
        let RunCost::Priced(c) = result.cost else {
            panic!("expected a priced cost, got {:?}", result.cost);
        };
        assert!((c - 0.002).abs() < 1e-12);
        assert_eq!(result.price_model.as_deref(), Some("vendor/cheap"));
        assert_eq!(result.prompt_tokens, Some(1000));
        assert_eq!(result.completion_tokens, Some(500));
        assert_eq!(result.total_tokens, Some(1500));
        // finish owns price_model/cost in run.json (the token split is written upstream by grade_rollout).
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(artifacts.path.join("run.json")).unwrap()).unwrap();
        assert_eq!(written["cost_usd"], 0.002);
        assert_eq!(written["cost_status"], "priced");
        assert_eq!(written["price_model"], "vendor/cheap");
    }

    #[tokio::test]
    async fn finish_marks_spend_unpriced_without_price_model() {
        let tmp = tempfile::tempdir().unwrap();
        let artifacts = RunArtifacts::new(tmp.path().join("e__t1__l1")).await.unwrap();
        let lane = dummy_lane("l1"); // openai provider, no openrouter_model → no price_model
        let task = dummy_task("t1");
        let run = ChatRunResult {
            turn_count: 2,
            usage: RunUsage {
                prompt_tokens: 1000,
                completion_tokens: 500,
                chat_rows: 2,
                models: ["openai/gpt".to_string()].into_iter().collect(),
                ..Default::default()
            },
            ..Default::default()
        };
        let mut metadata = serde_json::json!({
            "finished_at": null, "outcome": null, "agent_error": null, "format_attempts": 0,
        });
        let result = finish(
            "e",
            &lane,
            &task,
            Outcome::Passed,
            Some(&run),
            &artifacts,
            &mut metadata,
            0,
            None,
            &priced_book(),
        )
        .await;
        // Spend happened but there is no slug to price it: unpriceable, not a silent zero.
        assert_eq!(result.cost, RunCost::Unpriced);
        assert_eq!(result.price_model, None);
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(artifacts.path.join("run.json")).unwrap()).unwrap();
        assert_eq!(written["cost_status"], "unpriced");
        assert!(written["cost_usd"].is_null());
    }

    #[tokio::test]
    async fn finish_withholds_token_totals_when_usage_is_incomplete() {
        let tmp = tempfile::tempdir().unwrap();
        let artifacts = RunArtifacts::new(tmp.path().join("e__t1__l1")).await.unwrap();
        let mut lane = dummy_lane("l1");
        lane.provider = archestra_bench_core::Provider::Openrouter;
        lane.model = "vendor/cheap".to_string();
        let task = dummy_task("t1");
        // A conversation's interaction fetch failed: the summed usage is partial, so neither cost nor
        // token totals may be presented as complete.
        let run = ChatRunResult {
            turn_count: 2,
            usage_fetch_failed: true,
            usage: RunUsage {
                prompt_tokens: 1000,
                completion_tokens: 500,
                chat_rows: 1,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut metadata = serde_json::json!({
            "finished_at": null, "outcome": null, "agent_error": null, "format_attempts": 0,
        });
        let result = finish(
            "e",
            &lane,
            &task,
            Outcome::Passed,
            Some(&run),
            &artifacts,
            &mut metadata,
            0,
            None,
            &priced_book(),
        )
        .await;
        assert_eq!(result.cost, RunCost::Unpriced);
        assert_eq!(result.total_tokens, None);
        assert_eq!(result.prompt_tokens, None);
    }

    #[tokio::test]
    async fn finish_reports_no_spend_when_no_llm_call() {
        let tmp = tempfile::tempdir().unwrap();
        let artifacts = RunArtifacts::new(tmp.path().join("e__t1__l1")).await.unwrap();
        let mut lane = dummy_lane("l1");
        lane.provider = archestra_bench_core::Provider::Openrouter;
        lane.model = "vendor/cheap".to_string();
        let task = dummy_task("t1");
        let run = ChatRunResult::default(); // no turns, no interaction rows
        let mut metadata = serde_json::json!({
            "finished_at": null, "outcome": null, "agent_error": null, "format_attempts": 0,
        });
        let result = finish(
            "e",
            &lane,
            &task,
            Outcome::AgentError,
            Some(&run),
            &artifacts,
            &mut metadata,
            0,
            Some("boom".to_string()),
            &priced_book(),
        )
        .await;
        assert_eq!(result.cost, RunCost::NoSpend);
        assert_eq!(result.total_tokens, None);
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(artifacts.path.join("run.json")).unwrap()).unwrap();
        assert_eq!(written["cost_status"], "no_spend");
    }

    #[tokio::test]
    async fn test_config_json_lists_each_lane_once_across_envs() {
        let envs = vec![
            (dummy_env("a", vec![dummy_task("t1")]), vec![dummy_task("t1")]),
            (dummy_env("b", vec![dummy_task("t2")]), vec![dummy_task("t2")]),
        ];
        let lanes = vec![dummy_lane("l1"), dummy_lane("l2")];
        let plan = build_run_plan(envs, lanes);
        let tmp = tempfile::tempdir().unwrap();
        write_run_config(tmp.path(), "rid", &plan, 2, &PriceBook::default(), "ok", None, None)
            .await
            .unwrap();
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(tmp.path().join("config.json")).unwrap()).unwrap();
        let names: Vec<&str> = config["lanes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["name"].as_str().unwrap())
            .collect();
        // two envs, but each lane listed exactly once and in declaration order.
        assert_eq!(names, ["l1", "l2"]);
        // each env records its active tool exposure mode (default here) for reproducibility.
        assert_eq!(config["environments"][0]["tool_exposure_mode"], "search_and_run_only");
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
            platform_dir: None,
            prices: Arc::new(PriceBook::default()),
        };
        let mut env = dummy_env("e", vec![dummy_task("t1")]);
        env.platform.tool_exposure_mode = crate::config::types::ToolExposureMode::Full;
        let lane = dummy_lane("l1");
        let progress = ProgressBar::hidden();
        // Setup failed before any agent existed -- the env's configured flag must still land in
        // run.json, since that is where the analyzer reads it (RunMeta).
        infra_results_for_lane(&env, &env.tasks, &lane, &ctx, &progress, "boom");
        let run_json = tmp.path().join(run_subdir("e", "t1", &lane)).join("run.json");
        let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(run_json).unwrap()).unwrap();
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
