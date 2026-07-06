//! `afc bootstrap` / `afc review`: propose annotations for unlabeled tools and review them. No LLM is
//! called — proposals come from a fixture — but the [`ProposalSource`] seam lets a real one slot in.

use std::path::Path;

use serde::Deserialize;

/// A proposed annotation for a tool. The provenance fields are `None` in the fixture, mirroring an
/// un-reviewed machine proposal.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Proposal {
    pub tool: String,
    pub effects: Vec<String>,
    pub proposed_by: Option<String>,
    pub confidence: Option<String>,
    pub reviewed_by: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProposalsFile {
    proposals: Vec<Proposal>,
}

/// A source of annotation proposals. A real implementation would query an LLM over the tool inventory.
pub trait ProposalSource {
    fn propose(&self) -> Result<Vec<Proposal>, String>;
}

/// Loads canned proposals from a YAML fixture.
pub struct FixtureProposalSource {
    path: std::path::PathBuf,
}

impl FixtureProposalSource {
    pub fn new(path: impl AsRef<Path>) -> Self {
        FixtureProposalSource {
            path: path.as_ref().to_path_buf(),
        }
    }
}

impl ProposalSource for FixtureProposalSource {
    fn propose(&self) -> Result<Vec<Proposal>, String> {
        let text = std::fs::read_to_string(&self.path).map_err(|e| e.to_string())?;
        let file: ProposalsFile = serde_yaml::from_str(&text).map_err(|e| e.to_string())?;
        Ok(file.proposals)
    }
}

/// Review proposals non-interactively: approve all except the named exceptions (which stay
/// unreviewed). Mirrors `afc review --approve-all --except <tool>`.
pub fn review(proposals: &[Proposal], except: &[String]) -> Vec<Proposal> {
    proposals
        .iter()
        .map(|p| {
            let mut reviewed = p.clone();
            if except.contains(&p.tool) {
                reviewed.reviewed_by = None;
            } else {
                reviewed.reviewed_by = Some("auto-approve".to_string());
            }
            reviewed
        })
        .collect()
}
