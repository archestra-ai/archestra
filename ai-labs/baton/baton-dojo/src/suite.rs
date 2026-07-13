//! A tiny benchmark suite: run named [`Case`]s with the baton gate off or on and
//! report the utility/leak results as a table.
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
    /// A leak check — `true` when the disallowed data reached a sink. `None` for a
    /// utility-only case (a legitimate flow with no attacker to detect).
    pub security: Option<SecurityCheck<W>>,
}

/// The scalar signals of one run.
#[derive(Clone, Copy)]
pub struct Scores {
    pub utility: bool,
    /// `None` for a utility-only case (no leak check).
    pub security: Option<bool>,
    pub blocked: usize,
}

impl<W: Clone> Case<W> {
    /// Run and score the case, `defended` toggling the baton gate.
    pub async fn score(&self, model: &Model, defended: bool) -> Result<Scores, DojoError> {
        let gate = if defended { Some((self.gate)()?) } else { None };
        let ep = run_episode(
            model,
            (self.seed)(),
            &self.tools,
            gate,
            None,
            self.prompt,
            &self.utility,
            self.security.as_ref(),
        )
        .await?;
        Ok(Scores {
            utility: ep.utility,
            security: ep.security,
            blocked: ep.blocked_calls,
        })
    }
}

/// Render `(case, defended, scores)` rows as a table. The `gate` column is `off` /
/// `on`; `leak` is `—` for a utility-only case (no leak check).
pub fn table(rows: &[(&'static str, bool, Scores)]) -> String {
    let bit = |x: bool| if x { "1" } else { "0" };
    let mut out = String::new();
    out.push_str(&format!(
        "{:<22} {:<5} {:>7} {:>5} {:>8}\n",
        "case", "gate", "utility", "leak", "blocked"
    ));
    out.push_str(&format!("{}\n", "-".repeat(51)));
    for (name, defended, s) in rows {
        out.push_str(&format!(
            "{:<22} {:<5} {:>7} {:>5} {:>8}\n",
            name,
            if *defended { "on" } else { "off" },
            bit(s.utility),
            s.security.map_or("—", bit),
            s.blocked,
        ));
    }
    out
}
