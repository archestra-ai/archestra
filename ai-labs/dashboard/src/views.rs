//! View-model construction: everything is flattened to plain strings/bools here so the Askama
//! templates stay dumb (no `Option` in `{% if %}`, no formatting in template expressions).

use std::collections::HashMap;
use std::path::Path;
use std::time::SystemTime;

use askama::Template;
use chrono::{DateTime, Local};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;

use archestra_bench_core::{Outcome, RolloutId, TriageRecord};

use crate::load::{
    ReduceSource, Rollout, RubricKey, RubricStatus, Run, RunListEntry, mean_grade,
};

/// Everything outside `[A-Za-z0-9._-]` is percent-encoded, including `/` — rollout ids travel as a
/// single opaque path segment.
const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.');

const ALL_OUTCOMES: [Outcome; 5] = [
    Outcome::Passed,
    Outcome::Failed,
    Outcome::FormatFailed,
    Outcome::NoSubmission,
    Outcome::AgentError,
];

fn encode_segment(raw: &str) -> String {
    utf8_percent_encode(raw, SEGMENT).to_string()
}

fn fmt_time(t: SystemTime) -> String {
    DateTime::<Local>::from(t).format("%Y-%m-%d %H:%M").to_string()
}

fn fmt_rate(rate: Option<f64>) -> String {
    match rate {
        Some(r) => format!("{:.1}%", r * 100.0),
        None => "—".to_string(),
    }
}

fn grade_class(mean: f64) -> String {
    let bucket = mean.round().clamp(1.0, 5.0) as u8;
    format!("grade-{bucket}")
}

fn outcome_class(raw: &str) -> String {
    match Outcome::from_value(raw) {
        Some(o) => format!("outcome-{}", o.value()),
        None => "outcome-unknown".to_string(),
    }
}

pub struct RubricBadge {
    pub label: String,
    pub class: String,
}

impl RubricBadge {
    fn from_status(status: RubricStatus) -> Self {
        match status {
            RubricStatus::None => RubricBadge {
                label: "no rubrics".to_string(),
                class: "badge-none".to_string(),
            },
            RubricStatus::Full { count } => RubricBadge {
                label: format!("rubrics ({count})"),
                class: "badge-full".to_string(),
            },
            RubricStatus::Partial { present, total } => RubricBadge {
                label: format!("partial rubrics ({present} of {total})"),
                class: "badge-partial".to_string(),
            },
        }
    }
}

// ---------------------------------------------------------------------------
// GET /
// ---------------------------------------------------------------------------

/// A short abbreviation chip for a reduce report present on a run (A = analyzer, C = Claude).
pub struct ReportChip {
    pub abbr: &'static str,
    pub title: String,
}

impl ReportChip {
    fn of(source: ReduceSource) -> Self {
        let abbr = match source {
            ReduceSource::Analyzer => "A",
            ReduceSource::Claude => "C",
        };
        ReportChip {
            abbr,
            title: source.label().to_string(),
        }
    }
}

pub struct RunRow {
    pub id: String,
    pub href: String,
    pub date: String,
    pub envs: String,
    pub lanes: String,
    pub outcomes: String,
    pub pass_rate: String,
    /// Integer percent (`"0".."100"`) for the pass-rate bar width; empty when the rate is unknown.
    pub pass_pct: String,
    pub rubric_badge: RubricBadge,
    pub reports: Vec<ReportChip>,
}

#[derive(Template)]
#[template(path = "index.html")]
pub struct IndexTemplate {
    pub experiments_dir: String,
    pub runs: Vec<RunRow>,
}

pub fn build_index(experiments_dir: &Path, entries: Vec<RunListEntry>) -> IndexTemplate {
    let runs = entries
        .into_iter()
        .map(|e| {
            let counts = e.counts;
            let outcomes = match counts.total() {
                0 => "—".to_string(),
                _ => format!(
                    "{} ✓ / {} ✗ / {} other",
                    counts.passed,
                    counts.failed,
                    counts.format_failed + counts.no_submission + counts.agent_error
                ),
            };
            RunRow {
                href: format!("/runs/{}", encode_segment(&e.id)),
                date: fmt_time(e.mtime),
                envs: e.envs.join(", "),
                lanes: e.lanes.join(", "),
                outcomes,
                pass_rate: fmt_rate(e.pass_rate),
                pass_pct: e
                    .pass_rate
                    .map(|r| format!("{:.0}", r * 100.0))
                    .unwrap_or_default(),
                rubric_badge: RubricBadge::from_status(e.rubric_status),
                reports: e.report_sources.iter().copied().map(ReportChip::of).collect(),
                id: e.id,
            }
        })
        .collect();
    IndexTemplate {
        experiments_dir: experiments_dir.display().to_string(),
        runs,
    }
}

// ---------------------------------------------------------------------------
// Grid (shared by GET /runs/{id} and GET /runs/{id}/grid)
// ---------------------------------------------------------------------------

/// Grid filter signals. Arrive either via DataStar's `datastar` JSON query param or as plain query
/// params; empty string means "no filter".
#[derive(Debug, Default, Deserialize)]
pub struct GridFilters {
    #[serde(default)]
    pub lane: String,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub mingrade: String,
    #[serde(default)]
    pub rhonly: bool,
}

impl GridFilters {
    pub fn from_query(query: &HashMap<String, String>) -> Self {
        match query.get("datastar") {
            Some(json) => serde_json::from_str(json).unwrap_or_default(),
            None => GridFilters {
                lane: query.get("lane").cloned().unwrap_or_default(),
                outcome: query.get("outcome").cloned().unwrap_or_default(),
                mingrade: query.get("mingrade").cloned().unwrap_or_default(),
                rhonly: matches!(
                    query.get("rhonly").map(String::as_str),
                    Some("true") | Some("1")
                ),
            },
        }
    }

    fn min_grade(&self) -> Option<f64> {
        self.mingrade.parse().ok()
    }
}

pub struct GridCell {
    pub href: String,
    pub outcome_label: String,
    pub outcome_class: String,
    pub grade_text: String,
    pub grade_class: String,
    pub hacking: bool,
}

pub struct GridRow {
    pub label: String,
    pub cells: Vec<Option<GridCell>>,
    /// Mean of this task's graded cells across the shown lanes; empty when none carry a grade.
    pub avg_text: String,
    pub avg_class: String,
}

pub struct GridView {
    pub lanes: Vec<String>,
    pub rows: Vec<GridRow>,
    pub shown: usize,
    pub total: usize,
}

#[derive(Template)]
#[template(path = "grid.html")]
pub struct GridTemplate {
    pub grid: GridView,
}

pub fn build_grid(run: &Run, filters: &GridFilters) -> GridView {
    let lanes: Vec<String> = run
        .lane_names()
        .into_iter()
        .filter(|lane| filters.lane.is_empty() || *lane == filters.lane)
        .collect();

    // Row key: (env, task), ordered. Multiple envs stay unambiguous via the env/task label.
    let mut row_keys: Vec<(String, String)> = run
        .rollouts
        .values()
        .map(|r| (r.id.env.clone(), r.id.task.clone()))
        .collect();
    row_keys.sort();
    row_keys.dedup();

    let mut shown = 0;
    let mut rows = Vec::new();
    for (env, task) in row_keys {
        let mut cells = Vec::with_capacity(lanes.len());
        let mut grades: Vec<f64> = Vec::new();
        for lane in &lanes {
            let key = RolloutId {
                env: env.clone(),
                task: task.clone(),
                lane: lane.clone(),
            }
            .to_string();
            let rollout = run
                .rollouts
                .get(&key)
                .filter(|r| cell_matches(r, run.rubrics.get(&key), filters));
            if rollout.is_some() {
                shown += 1;
                if let Some(rec) = run.rubrics.get(&key) {
                    grades.push(mean_grade(&rec.rubrics));
                }
            }
            cells.push(rollout.map(|r| make_cell(run, r)));
        }
        if cells.iter().any(Option::is_some) {
            let (avg_text, avg_class) = match grades.len() {
                0 => (String::new(), String::new()),
                n => {
                    let avg = grades.iter().sum::<f64>() / n as f64;
                    (format!("{avg:.1}"), grade_class(avg))
                }
            };
            rows.push(GridRow {
                label: format!("{env}/{task}"),
                cells,
                avg_text,
                avg_class,
            });
        }
    }

    GridView {
        lanes,
        rows,
        shown,
        total: run.rollouts.len(),
    }
}

fn cell_matches(rollout: &Rollout, record: Option<&TriageRecord>, filters: &GridFilters) -> bool {
    if !filters.outcome.is_empty() && rollout.meta.outcome != filters.outcome {
        return false;
    }
    if let Some(min) = filters.min_grade() {
        // A minimum-grade filter only ever matches rollouts that actually have a rubric record.
        match record {
            Some(rec) if mean_grade(&rec.rubrics) >= min => {}
            _ => return false,
        }
    }
    if filters.rhonly {
        match record {
            Some(rec) if rec.reward_hacking.suspected => {}
            _ => return false,
        }
    }
    true
}

fn make_cell(run: &Run, rollout: &Rollout) -> GridCell {
    let key = rollout.id.to_string();
    let record = run.rubrics.get(&key);
    let (grade_text, grade_class_str) = match record {
        Some(rec) => {
            let mean = mean_grade(&rec.rubrics);
            (format!("{mean:.1}"), grade_class(mean))
        }
        None => (String::new(), String::new()),
    };
    GridCell {
        href: rollout_href(&run.id, &rollout.id),
        outcome_label: rollout.meta.outcome.clone(),
        outcome_class: outcome_class(&rollout.meta.outcome),
        grade_text,
        grade_class: grade_class_str,
        hacking: record.is_some_and(|rec| rec.reward_hacking.suspected),
    }
}

fn rollout_href(run_id: &str, id: &RolloutId) -> String {
    format!(
        "/runs/{}/rollouts/{}",
        encode_segment(run_id),
        encode_segment(&id.to_string())
    )
}

// ---------------------------------------------------------------------------
// GET /runs/{run_id}
// ---------------------------------------------------------------------------

pub struct SummaryRow {
    pub label: String,
    pub value: String,
}

/// One outcome tally rendered as a colored pill on the run page.
pub struct OutcomePill {
    pub label: &'static str,
    pub count: u64,
    pub class: String,
}

pub struct RubricAvgRow {
    pub label: String,
    pub values: Vec<String>,
    /// Average of this rubric across all lanes (over every rollout with a record).
    pub avg: String,
}

pub struct HackRow {
    pub id: String,
    pub href: String,
    pub evidence: String,
}

pub struct ReportView {
    pub label: String,
    pub filename: String,
    pub html: String,
}

#[derive(Template)]
#[template(path = "run.html")]
pub struct RunTemplate {
    pub id: String,
    pub date: String,
    pub warnings: Vec<String>,
    pub summary: Vec<SummaryRow>,
    pub outcome_pills: Vec<OutcomePill>,
    pub rubric_badge: RubricBadge,
    pub lanes: Vec<String>,
    pub has_rubrics: bool,
    pub rubric_rows: Vec<RubricAvgRow>,
    pub reports: Vec<ReportView>,
    pub hacking: Vec<HackRow>,
    pub outcome_options: Vec<&'static str>,
    pub grid_url: String,
    pub grid_html: String,
}

pub fn build_run(run: &Run, grid_html: String) -> RunTemplate {
    let counts = run.counts();
    let mut summary = vec![
        SummaryRow {
            label: "rollouts".to_string(),
            value: run.rollouts.len().to_string(),
        },
        SummaryRow {
            label: "pass rate".to_string(),
            value: fmt_rate(run.pass_rate()),
        },
    ];
    let outcome_pills = [
        ("passed", counts.passed),
        ("failed", counts.failed),
        ("format_failed", counts.format_failed),
        ("no_submission", counts.no_submission),
        ("agent_error", counts.agent_error),
    ]
    .into_iter()
    .filter(|(_, count)| *count > 0)
    .map(|(label, count)| OutcomePill {
        label,
        count,
        class: format!("outcome-{label}"),
    })
    .collect();
    if let Some(agg) = &run.aggregate {
        if let Some(turns) = agg.avg_turns {
            summary.push(SummaryRow {
                label: "avg turns".to_string(),
                value: format!("{turns:.1}"),
            });
        }
        if let Some(tokens) = agg.avg_tokens {
            summary.push(SummaryRow {
                label: "avg tokens".to_string(),
                value: format!("{tokens:.0}"),
            });
        }
        if let Some(cost) = agg.cost_usd {
            summary.push(SummaryRow {
                label: "cost".to_string(),
                value: format!("${cost:.2}"),
            });
        }
    }

    let lanes = run.lane_names();
    let has_rubrics = !matches!(run.rubric_status, RubricStatus::None);
    let fmt_avg = |v: Option<f64>| match v {
        Some(avg) => format!("{avg:.1}"),
        None => "—".to_string(),
    };
    let rubric_rows = RubricKey::ALL
        .iter()
        .map(|key| RubricAvgRow {
            label: key.label().to_string(),
            values: lanes
                .iter()
                .map(|lane| fmt_avg(run.lane_rubric_avg(lane, *key)))
                .collect(),
            avg: fmt_avg(run.rubric_avg(*key)),
        })
        .collect();

    let reports = run
        .reports
        .iter()
        .map(|r| ReportView {
            label: r.source.label().to_string(),
            filename: r.filename.clone(),
            html: render_markdown(&r.markdown),
        })
        .collect();

    let hacking = hacking_rows(run);

    RunTemplate {
        id: run.id.clone(),
        date: fmt_time(run.mtime),
        warnings: run.warnings.clone(),
        summary,
        outcome_pills,
        rubric_badge: RubricBadge::from_status(run.rubric_status),
        lanes,
        has_rubrics,
        rubric_rows,
        reports,
        hacking,
        outcome_options: ALL_OUTCOMES.iter().map(|o| o.value()).collect(),
        grid_url: format!("/runs/{}/grid", encode_segment(&run.id)),
        grid_html,
    }
}

fn hacking_rows(run: &Run) -> Vec<HackRow> {
    let mut rows: Vec<HackRow> = run
        .rollouts
        .values()
        .filter_map(|rollout| {
            let key = rollout.id.to_string();
            let record = run.rubrics.get(&key)?;
            match record.reward_hacking.suspected {
                true => Some(HackRow {
                    href: rollout_href(&run.id, &rollout.id),
                    evidence: record.reward_hacking.evidence.clone().unwrap_or_default(),
                    id: key,
                }),
                false => None,
            }
        })
        .collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

// ---------------------------------------------------------------------------
// GET /runs/{run_id}/rollouts/{rollout}
// ---------------------------------------------------------------------------

pub struct ScoreRow {
    pub label: String,
    pub grade: String,
    pub class: String,
    pub comment: String,
}

pub struct RolloutRubric {
    pub verdict: String,
    pub mean: String,
    pub mean_class: String,
    pub scores: Vec<ScoreRow>,
    pub hacking_suspected: bool,
    pub hacking_evidence: String,
    pub observations: Vec<String>,
}

#[derive(Template)]
#[template(path = "rollout.html")]
pub struct RolloutTemplate {
    pub run_id: String,
    pub run_href: String,
    pub id: String,
    pub outcome_label: String,
    pub outcome_class: String,
    pub meta_rows: Vec<SummaryRow>,
    pub rubric: Option<RolloutRubric>,
    pub trajectory_html: String,
    pub trajectory_note: String,
}

const MAX_TRAJECTORY_BYTES: u64 = 1024 * 1024;
const TRAJECTORY_MD: &str = "trajectory.md";

pub fn build_rollout(run: &Run, rollout: &Rollout) -> RolloutTemplate {
    let key = rollout.id.to_string();
    let meta = &rollout.meta;
    let opt_u64 = |v: Option<u64>| v.map_or_else(|| "—".to_string(), |n| n.to_string());
    let opt_str = |v: &Option<String>| v.clone().unwrap_or_else(|| "—".to_string());
    let meta_rows = vec![
        SummaryRow {
            label: "provider / model".to_string(),
            value: format!("{} / {}", meta.provider, meta.model),
        },
        SummaryRow {
            label: "outcome".to_string(),
            value: meta.outcome.clone(),
        },
        SummaryRow {
            label: "turns".to_string(),
            value: meta.turn_count.to_string(),
        },
        SummaryRow {
            label: "tool calls".to_string(),
            value: meta.tool_call_count.to_string(),
        },
        SummaryRow {
            label: "total tokens".to_string(),
            value: opt_u64(meta.total_tokens),
        },
        SummaryRow {
            label: "stages".to_string(),
            value: meta.stage_count.to_string(),
        },
        SummaryRow {
            label: "format attempts".to_string(),
            value: meta.format_attempts.to_string(),
        },
        SummaryRow {
            label: "finish reason".to_string(),
            value: opt_str(&meta.finish_reason),
        },
        SummaryRow {
            label: "verifier exit".to_string(),
            value: meta
                .verifier_exit_code
                .map_or_else(|| "—".to_string(), |c| c.to_string()),
        },
        SummaryRow {
            label: "tool exposure".to_string(),
            value: opt_str(&meta.tool_exposure_mode),
        },
        SummaryRow {
            label: "agent error".to_string(),
            value: opt_str(&meta.agent_error),
        },
    ];

    let rubric = run.rubrics.get(&key).map(rubric_view);
    let (trajectory_html, trajectory_note) = render_trajectory(&rollout.dir);

    RolloutTemplate {
        run_id: run.id.clone(),
        run_href: format!("/runs/{}", encode_segment(&run.id)),
        id: key,
        outcome_label: meta.outcome.clone(),
        outcome_class: outcome_class(&meta.outcome),
        meta_rows,
        rubric,
        trajectory_html,
        trajectory_note,
    }
}

fn rubric_view(record: &TriageRecord) -> RolloutRubric {
    let mean = mean_grade(&record.rubrics);
    let scores = RubricKey::ALL
        .iter()
        .map(|key| {
            let score = key.score(&record.rubrics);
            ScoreRow {
                label: key.label().to_string(),
                grade: score.grade.to_string(),
                class: grade_class(f64::from(score.grade.value())),
                comment: score.comment.clone(),
            }
        })
        .collect();
    RolloutRubric {
        verdict: record.verdict.clone(),
        mean: format!("{mean:.1}"),
        mean_class: grade_class(mean),
        scores,
        hacking_suspected: record.reward_hacking.suspected,
        hacking_evidence: record.reward_hacking.evidence.clone().unwrap_or_default(),
        observations: record.observations.clone(),
    }
}

/// Render `trajectory.md` to HTML, or explain why not: `(html, note)` — exactly one is non-empty.
fn render_trajectory(rollout_dir: &Path) -> (String, String) {
    let path = rollout_dir.join(TRAJECTORY_MD);
    match std::fs::metadata(&path) {
        Err(_) => (
            String::new(),
            format!("no rendered trajectory found at {}", path.display()),
        ),
        Ok(m) if m.len() > MAX_TRAJECTORY_BYTES => (
            String::new(),
            format!(
                "trajectory.md is {} bytes (over 1 MB); open it directly: {}",
                m.len(),
                path.display()
            ),
        ),
        Ok(_) => match std::fs::read_to_string(&path) {
            Ok(md) => (render_markdown(&md), String::new()),
            Err(err) => (
                String::new(),
                format!("failed to read {}: {err}", path.display()),
            ),
        },
    }
}

/// Trajectories are untrusted agent/tool output rendered with `|safe`: raw HTML blocks must come
/// out as visible text, never live markup; link destinations must not smuggle an active scheme
/// (`javascript:`, `data:`, …) into a live href; and images load only from relative (run-local)
/// paths — a remote `<img>` would beacon to an attacker-chosen host the moment the page opens.
/// Stripped links/images render as their label/alt text.
fn render_markdown(md: &str) -> String {
    use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, TagEnd, html};
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH;
    // Link/image starts and ends nest properly among themselves; the stack pairs each end with
    // its own start so dropping an unsafe link never swallows a safe nested image's end tag.
    let mut dropped: Vec<bool> = Vec::new();
    let parser = Parser::new_ext(md, options).filter_map(|event| match event {
        Event::Html(raw) | Event::InlineHtml(raw) => {
            Some(Event::Text(CowStr::from(raw.into_string())))
        }
        Event::Start(Tag::Link { ref dest_url, .. }) => {
            let drop = !is_safe_link(dest_url);
            dropped.push(drop);
            (!drop).then_some(event)
        }
        Event::Start(Tag::Image { ref dest_url, .. }) => {
            let drop = !is_relative(dest_url);
            dropped.push(drop);
            (!drop).then_some(event)
        }
        Event::End(TagEnd::Link | TagEnd::Image) => {
            (!dropped.pop().unwrap_or(false)).then_some(event)
        }
        other => Some(other),
    });
    let mut out = String::with_capacity(md.len() * 2);
    html::push_html(&mut out, parser);
    out
}

/// Scheme allowlist for untrusted link destinations. Relative URLs (no scheme) are inert
/// navigation and pass through.
fn is_safe_link(url: &str) -> bool {
    match url.split_once(':') {
        Some((scheme, _)) if !scheme.contains('/') => {
            scheme.eq_ignore_ascii_case("http")
                || scheme.eq_ignore_ascii_case("https")
                || scheme.eq_ignore_ascii_case("mailto")
        }
        _ => true,
    }
}

/// No scheme and not protocol-relative: the fetch stays on this dashboard's origin.
fn is_relative(url: &str) -> bool {
    !url.starts_with("//")
        && match url.split_once(':') {
            Some((scheme, _)) => scheme.contains('/'),
            None => true,
        }
}

#[cfg(test)]
mod tests {
    use super::render_markdown;

    #[test]
    fn raw_html_renders_as_text_not_markup() {
        let html = render_markdown("before\n\n<script>alert(1)</script>\n\nafter");
        assert!(!html.contains("<script>"), "{html}");
        assert!(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"), "{html}");
    }

    #[test]
    fn active_scheme_links_are_stripped_to_their_label() {
        let html = render_markdown("[click](javascript:alert(1)) and [ok](https://example.com)");
        assert!(!html.contains("javascript:"), "{html}");
        assert!(html.contains("click"), "{html}");
        assert!(html.contains(r#"<a href="https://example.com">ok</a>"#), "{html}");
    }

    #[test]
    fn relative_image_inside_unsafe_link_keeps_balanced_markup() {
        let html = render_markdown("[![alt](local/a.png)](data:text/html,x)");
        assert!(!html.contains("data:"), "{html}");
        assert!(!html.contains("<a "), "{html}");
        assert!(html.contains(r#"<img src="local/a.png""#), "{html}");
    }

    #[test]
    fn remote_and_protocol_relative_images_are_stripped_to_alt_text() {
        for md in ["![beacon](https://evil.example/x.png)", "![beacon](//evil.example/x.png)"] {
            let html = render_markdown(md);
            assert!(!html.contains("<img"), "{html}");
            assert!(html.contains("beacon"), "{html}");
        }
    }
}
