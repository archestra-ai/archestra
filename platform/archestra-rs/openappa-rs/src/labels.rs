//! Each change a dispatch makes to its root trajectory's label, kept as a row of
//! `openappa_label_changes`: what a session trace shows as the label over time.
//! A dataset, never an input to a decision.
//!
//! After a dispatch the root's label is read once and compared with the last
//! label recorded for the root; a row is written only when they differ. The
//! first row of a root is its baseline (`session_start`, before = after).
//! Dispatches of one family may overlap, so a change is filed under the
//! dispatch that observed it first; the label sequence itself stays exact.

/// One label: the trust level and the audience, as the runtime names them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Label {
    pub trust: String,
    pub audience: String,
}

/// What the dispatch handled, as the table names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ChangeEvent {
    SessionStart,
    ToolCall,
    ToolResult,
    Remedy,
    ChildReturn,
    Other,
}

impl ChangeEvent {
    fn name(self) -> &'static str {
        match self {
            ChangeEvent::SessionStart => "session_start",
            ChangeEvent::ToolCall => "tool_call",
            ChangeEvent::ToolResult => "tool_result",
            ChangeEvent::Remedy => "remedy",
            ChangeEvent::ChildReturn => "child_return",
            ChangeEvent::Other => "other",
        }
    }
}

/// Who and what one observation is filed under.
pub(crate) struct Observation {
    pub organization_id: String,
    pub root: String,
    pub session_id: String,
    pub caller_id: Option<String>,
    pub event: ChangeEvent,
    /// The runtime's operation id, `call:<id>`, when the event was a call's.
    pub call_id: Option<String>,
    pub tool: Option<String>,
    pub policy_revision: Option<i64>,
}

/// Records `label` as the root's label after a dispatch, when it differs from
/// the last recorded one. A failure is reported and swallowed: the dataset
/// never changes what the dispatch returns.
pub(crate) fn record(pg: &crate::Sql<'_>, observation: Observation, label: Label) {
    if let Err(error) = insert_if_changed(pg, observation, label) {
        eprintln!("OpenAPPA: a label change was not recorded: {error}");
    }
}

fn insert_if_changed(
    pg: &crate::Sql<'_>,
    observation: Observation,
    label: Label,
) -> Result<(), crate::SqlError> {
    pg.with_client(move |client| {
        let last = client
            .query_opt(
                "SELECT trust_after, audience_after FROM openappa_label_changes \
                 WHERE root = $1 ORDER BY created_at DESC, id DESC LIMIT 1",
                &[&observation.root],
            )
            .map_err(crate::consults::described)?
            .map(|row| Label {
                trust: row.get(0),
                audience: row.get(1),
            });
        let Some(change) = change(last, observation.event, label) else {
            return Ok(());
        };
        client.execute(
            "INSERT INTO openappa_label_changes (organization_id, root, session_id, caller_id, event, call_id, tool, trust_before, audience_before, trust_after, audience_after, policy_revision) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
            &[
                &observation.organization_id,
                &observation.root,
                &observation.session_id,
                &observation.caller_id,
                &change.event.name(),
                &observation.call_id,
                &observation.tool,
                &change.before.trust,
                &change.before.audience,
                &change.after.trust,
                &change.after.audience,
                &observation.policy_revision,
            ],
        )
        .map_err(crate::consults::described)?;
        Ok(())
    })
}

/// The row to write, if any: a baseline for a root with no rows yet, a change
/// when the label moved, nothing otherwise.
#[derive(Debug, PartialEq, Eq)]
struct Change {
    event: ChangeEvent,
    before: Label,
    after: Label,
}

fn change(last: Option<Label>, event: ChangeEvent, label: Label) -> Option<Change> {
    match last {
        None => Some(Change {
            event: ChangeEvent::SessionStart,
            before: label.clone(),
            after: label,
        }),
        Some(last) if last == label => None,
        Some(last) => Some(Change {
            event,
            before: last,
            after: label,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(trust: &str, audience: &str) -> Label {
        Label {
            trust: trust.to_owned(),
            audience: audience.to_owned(),
        }
    }

    #[test]
    fn a_root_without_rows_gets_a_baseline() {
        assert_eq!(
            change(None, ChangeEvent::ToolResult, label("trusted", "public")),
            Some(Change {
                event: ChangeEvent::SessionStart,
                before: label("trusted", "public"),
                after: label("trusted", "public"),
            })
        );
    }

    #[test]
    fn an_unchanged_label_writes_nothing() {
        assert_eq!(
            change(
                Some(label("trusted", "public")),
                ChangeEvent::ToolResult,
                label("trusted", "public"),
            ),
            None
        );
    }

    #[test]
    fn a_moved_label_is_filed_under_the_event_that_observed_it() {
        assert_eq!(
            change(
                Some(label("trusted", "public")),
                ChangeEvent::ToolResult,
                label("suspicious", "internal"),
            ),
            Some(Change {
                event: ChangeEvent::ToolResult,
                before: label("trusted", "public"),
                after: label("suspicious", "internal"),
            })
        );
    }
}
