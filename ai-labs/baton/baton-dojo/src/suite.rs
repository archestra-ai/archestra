//! A tiny benchmark suite: run named [`Case`]s with the baton gate off and on,
//! and report the utility/security trade-off as one table.
//!
//! This is the "cases as data" shape — each case is a library value (see
//! [`crate::scenarios`]), and the runner loops them uniformly, rather than one
//! hand-written binary per scenario.

use crate::error::DojoError;
use crate::model::Model;
use crate::policy::BatonGate;
use crate::scoring::{SecurityCheck, UtilityCheck, run_episode};
use crate::tool::Toolset;

/// A named, self-scoring benchmark case over a workspace `W`.
///
/// The task is scored twice — undefended and baton-defended — so the report can
/// show what the gate changed. There is no injection here: the "security" check
/// asks whether the *disallowed data flow* completed, which is the model's own
/// behaviour, gated or not.
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

/// The scalar signals of one run.
#[derive(Clone, Copy)]
pub struct Scores {
    pub utility: bool,
    pub security: bool,
    pub blocked: usize,
}

/// One case scored with the gate off and on.
pub struct CaseReport {
    pub name: &'static str,
    pub off: Scores,
    pub on: Scores,
}

impl<W: Clone> Case<W> {
    /// Run the task undefended and then baton-defended, scoring both.
    pub async fn run(&self, model: &Model) -> Result<CaseReport, DojoError> {
        let off = run_episode(
            model,
            (self.seed)(),
            &self.tools,
            None,
            None,
            self.prompt,
            &self.utility,
            &self.security,
        )
        .await?;
        let on = run_episode(
            model,
            (self.seed)(),
            &self.tools,
            Some((self.gate)()?),
            None,
            self.prompt,
            &self.utility,
            &self.security,
        )
        .await?;
        Ok(CaseReport {
            name: self.name,
            off: Scores {
                utility: off.utility,
                security: off.security,
                blocked: off.blocked_calls,
            },
            on: Scores {
                utility: on.utility,
                security: on.security,
                blocked: on.blocked_calls,
            },
        })
    }
}

/// Render the reports as a table showing the gate's effect on each case.
/// `utility` and `leak` are shown as `off → on`; a good gate drives `leak` to 0
/// while keeping `utility` up.
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
        "overall  utility off/on {:.2}/{:.2}   leak off/on {:.2}/{:.2}   mean blocked {:.2}\n",
        rate(&|r| r.off.utility),
        rate(&|r| r.on.utility),
        rate(&|r| r.off.security),
        rate(&|r| r.on.security),
        mean_blocked,
    ));
    out
}
