//! `afc suggest`: read the decision log and emit two canned improvement patterns.

use std::collections::BTreeMap;
use std::path::Path;

use afc_core::engine::{DecisionKind, DecisionRecord};

#[derive(Debug, PartialEq, Eq)]
pub struct Suggestion {
    pub pattern: String,
    pub message: String,
}

/// Parse a JSONL decision log into records.
pub fn read_log(path: &Path) -> Result<Vec<DecisionRecord>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let record: DecisionRecord = serde_json::from_str(line).map_err(|e| e.to_string())?;
        out.push(record);
    }
    Ok(out)
}

/// Emit suggestions from the log:
/// 1. a rule that repeatedly denies the same tool → propose a declassifier / narrower sink;
/// 2. an unlabeled tool that is repeatedly blocked on Unknown → propose annotating it.
pub fn suggest(records: &[DecisionRecord]) -> Vec<Suggestion> {
    let mut denies_by_rule: BTreeMap<(String, String), usize> = BTreeMap::new();
    let mut unknown_blocks: BTreeMap<String, usize> = BTreeMap::new();

    for r in records {
        if r.decision != DecisionKind::Deny {
            continue;
        }
        if let Some(rule) = &r.rule_id {
            *denies_by_rule
                .entry((rule.clone(), r.tool.clone()))
                .or_default() += 1;
            if rule == "on_unknown.egress" {
                *unknown_blocks.entry(r.tool.clone()).or_default() += 1;
            }
        }
    }

    let mut suggestions = Vec::new();
    for ((rule, tool), count) in &denies_by_rule {
        if rule == "std.no_leak" && *count >= 1 {
            suggestions.push(Suggestion {
                pattern: "repeated-deny-declassify".to_string(),
                message: format!(
                    "`{tool}` was blocked by {rule} {count}x — consider a declassifier or a narrower sink audience for this flow"
                ),
            });
        }
    }
    for (tool, count) in &unknown_blocks {
        suggestions.push(Suggestion {
            pattern: "unknown-tool-repeated-block".to_string(),
            message: format!(
                "`{tool}` blocked an Unknown value {count}x — annotate the source tool so its results are labeled"
            ),
        });
    }
    suggestions
}
