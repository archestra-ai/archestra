//! A tiny benchmark suite: run named [`Case`]s in one or both [`Mode`]s and
//! report the utility/security trade-off as a table.
//!
//! This is the "cases as data" shape — each case is a library value (see
//! [`crate::scenarios`]), and the runner selects and loops them, rather than one
//! hand-written binary per scenario.

use crate::error::DojoError;
use crate::model::Model;
use crate::policy::BatonGate;
use crate::scoring::{SecurityCheck, UtilityCheck, run_episode};
use crate::tool::Toolset;

/// A named, self-scoring benchmark case over a workspace `W`.
///
/// There is no injection here: the "security" check asks whether the *disallowed
/// data flow* completed, which is the model's own behaviour, gated or not.
pub struct Case<W> {
    pub name: &'static str,
    /// A fresh workspace for each run.
    pub seed: fn() -> W,
    pub tools: Toolset<W>,
    /// A fresh gate for each defended run (the gate is consumed per run).
    pub gate: fn() -> Result<BatonGate, DojoError>,
    pub prompt: &'static str,
    /// `true` when the legitimate user task was accomplished.
    pub utility: UtilityCheck<W>,
    /// `true` when the disallowed flow completed (a leak / unauthorized egress).
    pub security: SecurityCheck<W>,
}

/// Which run of a case to score.
#[derive(Clone, Copy, Debug)]
pub enum Mode {
    /// Baseline — no baton gate (what happens undefended).
    Base,
    /// Defended — the baton gate is on.
    Security,
}

impl Mode {
    /// Parse a mode name (`base` / `security`).
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "base" => Some(Mode::Base),
            "security" => Some(Mode::Security),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Mode::Base => "base",
            Mode::Security => "security",
        }
    }
}

/// The scalar signals of one run.
#[derive(Clone, Copy)]
pub struct Scores {
    pub utility: bool,
    pub security: bool,
    pub blocked: usize,
}

/// One case scored in both modes.
pub struct CaseReport {
    pub name: &'static str,
    pub off: Scores,
    pub on: Scores,
}

impl<W: Clone> Case<W> {
    /// Run and score the case in one mode.
    pub async fn score(&self, model: &Model, mode: Mode) -> Result<Scores, DojoError> {
        let gate = match mode {
            Mode::Base => None,
            Mode::Security => Some((self.gate)()?),
        };
        let ep = run_episode(
            model,
            (self.seed)(),
            &self.tools,
            gate,
            None,
            self.prompt,
            &self.utility,
            &self.security,
        )
        .await?;
        Ok(Scores {
            utility: ep.utility,
            security: ep.security,
            blocked: ep.blocked_calls,
        })
    }

    /// Run and score the case in both modes (base, then security).
    pub async fn run(&self, model: &Model) -> Result<CaseReport, DojoError> {
        Ok(CaseReport {
            name: self.name,
            off: self.score(model, Mode::Base).await?,
            on: self.score(model, Mode::Security).await?,
        })
    }
}

/// Render both-mode reports as a table showing the gate's effect on each case.
/// `utility` and `leak` are shown as `base → security`; a good gate drives `leak`
/// to 0 while keeping `utility` up.
pub fn report_table(reports: &[CaseReport]) -> String {
    let bit = |x: bool| if x { 1 } else { 0 };
    let mut out = String::new();
    out.push_str(&format!(
        "{:<22} {:^14} {:^14} {:>8}\n",
        "case", "utility →", "leak →", "blocked"
    ));
    out.push_str(&format!("{}\n", "-".repeat(62)));
    for r in reports {
        out.push_str(&format!(
            "{:<22} {:>5} → {:<6} {:>5} → {:<6} {:>8}\n",
            r.name,
            bit(r.off.utility),
            bit(r.on.utility),
            bit(r.off.security),
            bit(r.on.security),
            r.on.blocked,
        ));
    }

    let n = reports.len().max(1) as f64;
    let rate = |f: &dyn Fn(&CaseReport) -> bool| reports.iter().filter(|r| f(r)).count() as f64 / n;
    let mean_blocked = reports.iter().map(|r| r.on.blocked).sum::<usize>() as f64 / n;
    out.push_str(&format!("{}\n", "-".repeat(62)));
    out.push_str(&format!(
        "overall  utility base/security {:.2}/{:.2}   leak base/security {:.2}/{:.2}   mean blocked {:.2}\n",
        rate(&|r| r.off.utility),
        rate(&|r| r.on.utility),
        rate(&|r| r.off.security),
        rate(&|r| r.on.security),
        mean_blocked,
    ));
    out
}

/// Render single-mode results (case, mode, utility, leak, blocked).
pub fn mode_table(rows: &[(&'static str, Mode, Scores)]) -> String {
    let bit = |x: bool| if x { 1 } else { 0 };
    let mut out = String::new();
    out.push_str(&format!(
        "{:<22} {:<9} {:>7} {:>5} {:>8}\n",
        "case", "mode", "utility", "leak", "blocked"
    ));
    out.push_str(&format!("{}\n", "-".repeat(55)));
    for (name, mode, s) in rows {
        out.push_str(&format!(
            "{:<22} {:<9} {:>7} {:>5} {:>8}\n",
            name,
            mode.label(),
            bit(s.utility),
            bit(s.security),
            s.blocked,
        ));
    }
    out
}
