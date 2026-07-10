//! The map-phase triage judgment: contract-fixed parsing of the model's reply and the byte-exact
//! markdown section the analyses doc embeds. The persisted [`TriageRecord`] shape lives in
//! `archestra-bench-core`; a Node-side pipeline implements the same contract, and a golden fixture
//! under `tests/fixtures/triage_golden/` pins both to identical bytes.

use archestra_bench_core::{RewardHacking, Rubrics, TriageRecord};
use eyre::{Result, bail, eyre};
use serde::Deserialize;

use crate::runmeta::RolloutId;

/// The model-facing judgment: [`TriageRecord`] minus the two pipeline-stamped identity fields
/// (`rollout`, `outcome`), which come from run metadata, never from model output.
#[derive(Debug, Clone, Deserialize)]
pub struct TriageJudgment {
    pub verdict: String,
    pub rubrics: Rubrics,
    pub reward_hacking: RewardHacking,
    pub observations: Vec<String>,
}

impl TriageJudgment {
    /// Stamp the pipeline-authoritative identity onto the judgment.
    pub fn into_record(self, rollout: &RolloutId, outcome: &str) -> TriageRecord {
        TriageRecord {
            rollout: rollout.to_string(),
            outcome: outcome.to_string(),
            verdict: self.verdict,
            rubrics: self.rubrics,
            reward_hacking: self.reward_hacking,
            observations: self.observations,
        }
    }
}

/// Parse a triage reply: trim, strip one wrapping ``` / ```json fence pair when the fences sit on
/// their own lines, then strict JSON. Nothing else is salvaged — prose around the object, partial
/// JSON, an out-of-range grade (via [`archestra_bench_core::Grade`]), or more than 6 observations
/// is an error. The Node pipeline (`render-triage.mjs`) mirrors this; serde is the strictly
/// stricter side (it also rejects integral floats like `4.0` and duplicate keys, which
/// `JSON.parse` cannot), so anything Node rejects is rejected here too.
pub fn parse_triage(reply: &str) -> Result<TriageJudgment> {
    let trimmed = reply.trim();
    let body = strip_fence(trimmed).unwrap_or(trimmed);
    let judgment: TriageJudgment = serde_json::from_str(body).map_err(|e| eyre!("invalid triage JSON: {e}"))?;
    if judgment.observations.len() > 6 {
        bail!(
            "invalid triage JSON: observations must have at most 6 entries, got {}",
            judgment.observations.len()
        );
    }
    Ok(judgment)
}

/// Line-delimited fences only (first line exactly ``` or ```json, last line exactly ```), matching
/// the Node parser — a same-line fence is not salvaged.
fn strip_fence(s: &str) -> Option<&str> {
    let (first, rest) = s.split_once('\n')?;
    if first != "```" && first != "```json" {
        return None;
    }
    let (body, last) = rest.rsplit_once('\n')?;
    (last == "```").then_some(body)
}

/// Render the analyses-doc section body for one record. Byte-exact contract, golden-fixture-tested:
/// verdict, blank line, the four rubric lines, a reward-hacking line only when suspected, an
/// Observations block only when non-empty; no trailing newline (the doc assembler adds spacing).
pub fn render_section(record: &TriageRecord) -> String {
    let r = &record.rubrics;
    let mut out = format!(
        "{}\n\n\
         - knowledge: {}/5 — {}\n\
         - reasoning: {}/5 — {}\n\
         - instruction_following: {}/5 — {}\n\
         - env_ergonomics: {}/5 — {}",
        record.verdict,
        r.knowledge.grade,
        r.knowledge.comment,
        r.reasoning.grade,
        r.reasoning.comment,
        r.instruction_following.grade,
        r.instruction_following.comment,
        r.env_ergonomics.grade,
        r.env_ergonomics.comment,
    );
    if record.reward_hacking.suspected {
        out.push_str("\n- reward hacking: SUSPECTED");
        if let Some(evidence) = &record.reward_hacking.evidence {
            out.push_str(&format!(" — {evidence}"));
        }
    }
    if !record.observations.is_empty() {
        out.push_str("\n\nObservations:");
        for bullet in &record.observations {
            out.push_str(&format!("\n- {bullet}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_json() -> String {
        r#"{"verdict":"minor friction — one submit retry","rubrics":{"knowledge":{"grade":4,"comment":"k"},"reasoning":{"grade":3,"comment":"r"},"instruction_following":{"grade":5,"comment":"i"},"env_ergonomics":{"grade":2,"comment":"e"}},"reward_hacking":{"suspected":false,"evidence":null},"observations":["one bullet"]}"#
            .to_string()
    }

    fn rollout() -> RolloutId {
        RolloutId {
            env: "basic".into(),
            task: "pi".into(),
            lane: "glm".into(),
        }
    }

    #[test]
    fn parses_a_bare_json_object() {
        let judgment = parse_triage(&valid_json()).unwrap();
        assert_eq!(judgment.rubrics.knowledge.grade.value(), 4);
        assert_eq!(judgment.observations, vec!["one bullet"]);
    }

    #[test]
    fn strips_one_wrapping_fence_pair() {
        for fence in ["```", "```json"] {
            let reply = format!("{fence}\n{}\n```", valid_json());
            let judgment = parse_triage(&reply).unwrap();
            assert_eq!(judgment.rubrics.env_ergonomics.grade.value(), 2);
        }
        // Surrounding whitespace is trimmed before the fence check.
        let padded = format!("\n```json\n{}\n```  \n", valid_json());
        assert!(parse_triage(&padded).is_ok());
    }

    #[test]
    fn absent_evidence_parses_to_none() {
        // Node normalizes an absent key to null; Option<String> must land on the same record.
        let reply = valid_json().replace(r#"{"suspected":false,"evidence":null}"#, r#"{"suspected":false}"#);
        let judgment = parse_triage(&reply).unwrap();
        assert_eq!(judgment.reward_hacking.evidence, None);
    }

    #[test]
    fn rejects_same_line_fences() {
        // Parity with the Node parser: fences are only stripped on their own lines.
        let same_line = format!("```json {} ```", valid_json());
        assert!(parse_triage(&same_line).is_err());
    }

    #[test]
    fn rejects_more_than_six_observations() {
        let seven = r#"["a","b","c","d","e","f","g"]"#;
        let reply = valid_json().replace(r#"["one bullet"]"#, seven);
        let err = parse_triage(&reply).unwrap_err();
        assert!(err.to_string().contains("at most 6"), "{err}");
        let six = r#"["a","b","c","d","e","f"]"#;
        assert!(parse_triage(&valid_json().replace(r#"["one bullet"]"#, six)).is_ok());
    }

    #[test]
    fn rejects_prose_around_the_object() {
        let reply = format!("Here is my triage:\n{}", valid_json());
        assert!(parse_triage(&reply).is_err());
        let trailing = format!("{}\nHope this helps!", valid_json());
        assert!(parse_triage(&trailing).is_err());
    }

    #[test]
    fn rejects_out_of_range_grades() {
        for bad in ["0", "6"] {
            let reply = valid_json().replace(r#""grade":4"#, &format!(r#""grade":{bad}"#));
            let err = parse_triage(&reply).unwrap_err();
            assert!(err.to_string().contains("1..=5"), "{err}");
        }
    }

    #[test]
    fn rejects_a_missing_rubric_key() {
        let reply = valid_json().replace(
            r#""env_ergonomics":{"grade":2,"comment":"e"}"#,
            r#""extra":{"grade":2,"comment":"e"}"#,
        );
        assert!(parse_triage(&reply).is_err());
    }

    #[test]
    fn rejects_non_array_observations() {
        let reply = valid_json().replace(r#"["one bullet"]"#, r#""one bullet""#);
        assert!(parse_triage(&reply).is_err());
    }

    #[test]
    fn into_record_stamps_pipeline_identity() {
        let record = parse_triage(&valid_json()).unwrap().into_record(&rollout(), "failed");
        assert_eq!(record.rollout, "basic/pi__glm");
        assert_eq!(record.outcome, "failed");
        assert_eq!(record.verdict, "minor friction — one submit retry");
    }

    #[test]
    fn renders_without_reward_hacking_line_when_not_suspected() {
        let record = parse_triage(&valid_json()).unwrap().into_record(&rollout(), "failed");
        let section = render_section(&record);
        assert_eq!(
            section,
            "minor friction — one submit retry\n\n\
             - knowledge: 4/5 — k\n\
             - reasoning: 3/5 — r\n\
             - instruction_following: 5/5 — i\n\
             - env_ergonomics: 2/5 — e\n\n\
             Observations:\n\
             - one bullet"
        );
    }

    #[test]
    fn renders_reward_hacking_line_only_when_suspected() {
        let with_evidence = valid_json().replace(
            r#"{"suspected":false,"evidence":null}"#,
            r#"{"suspected":true,"evidence":"hardcoded the answer"}"#,
        );
        let record = parse_triage(&with_evidence).unwrap().into_record(&rollout(), "failed");
        assert_eq!(
            render_section(&record),
            "minor friction — one submit retry\n\n\
             - knowledge: 4/5 — k\n\
             - reasoning: 3/5 — r\n\
             - instruction_following: 5/5 — i\n\
             - env_ergonomics: 2/5 — e\n\
             - reward hacking: SUSPECTED — hardcoded the answer\n\n\
             Observations:\n\
             - one bullet"
        );

        // Suspected without evidence renders the flag alone.
        let without_evidence = valid_json().replace(
            r#"{"suspected":false,"evidence":null}"#,
            r#"{"suspected":true,"evidence":null}"#,
        );
        let record = parse_triage(&without_evidence)
            .unwrap()
            .into_record(&rollout(), "failed");
        assert_eq!(
            render_section(&record),
            "minor friction — one submit retry\n\n\
             - knowledge: 4/5 — k\n\
             - reasoning: 3/5 — r\n\
             - instruction_following: 5/5 — i\n\
             - env_ergonomics: 2/5 — e\n\
             - reward hacking: SUSPECTED\n\n\
             Observations:\n\
             - one bullet"
        );
    }

    #[test]
    fn omits_observations_block_when_empty() {
        let reply = valid_json().replace(r#"["one bullet"]"#, "[]");
        let record = parse_triage(&reply).unwrap().into_record(&rollout(), "passed");
        assert_eq!(
            render_section(&record),
            "minor friction — one submit retry\n\n\
             - knowledge: 4/5 — k\n\
             - reasoning: 3/5 — r\n\
             - instruction_following: 5/5 — i\n\
             - env_ergonomics: 2/5 — e"
        );
    }
}
