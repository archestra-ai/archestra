use crate::{
    Sql,
    errors::{invalid_input, sql_failure},
    input::Input,
    sealed, state_mutex,
};
use appa_eventlog::{encryption::StorageCipher, postgres::PostgresError};
use appa_runtime_api::{HookEvent, SpawnBinding, SpawnRef, TrajectoryId};
use napi_derive::napi;
use serde::Serialize;
use serde_json::Value;
use std::time::SystemTime;

#[napi(object)]
#[derive(Default)]
pub struct ChildReturnLookup {
    /// Narrow the authority lookup to one registered child when known.
    pub child_session_id: Option<String>,
    /// Load only the latest admitted operation with this task prefix.
    pub operation_prefix: Option<String>,
}

#[napi(object)]
#[derive(Serialize)]
pub struct ChildReturnRecord {
    /// Fully scoped session id of the child whose return crossed.
    pub child_session_id: String,
    /// The spawn call the return answers, when the child named it at ChildEnd.
    pub spawn_call_id: Option<String>,
    /// The client-native child identity, when the child named one.
    pub child_native_id: Option<String>,
    /// The operation that durably recorded this crossing. An echo keeps its
    /// `:echo` suffix so a task prefix still matches.
    pub operation_id: Option<String>,
    /// The exact bytes the runtime admitted across the child boundary.
    pub value: String,
}

/// Loads the child returns a parent's family durably crossed, from the
/// retained ChildEnd and admitted ChildReturn operations in PostgreSQL. This
/// is the authority the parent side verifies an arriving completion against;
/// nothing the client carries proves a return.
#[napi(js_name = "loadChildReturns")]
pub async fn load_child_returns(
    organization_id: String,
    parent_session_id: String,
    lookup: Option<ChildReturnLookup>,
) -> napi::Result<Vec<ChildReturnRecord>> {
    // Mirror load_offer_review: clone state, drop the mutex, then lease a
    // connection before host SQL so lookups never contend with dispatches.
    let state = {
        let slot = state_mutex().lock().await;
        slot.as_ref()
            .ok_or_else(|| invalid_input("OpenAPPA is not initialized"))?
            .clone()
    };
    let leased = state.lease().await?;
    let pg = &Sql(&leased.state.store);
    pg.with_client(move |client| {
        // session_id is the leading PK column of openappa_operations, and
        // organization_id is an additional tenancy guard. ChildEnd keeps its
        // existing reading: a staged end carries decision.value, a released
        // one carries input.output, and the echo is not another crossing.
        // ChildReturn is a mid-turn crossing. Only an ack is admitted — a
        // child_return decision is still staged, or is a substitution the
        // host has not echoed — and the ack's output is the exact bytes that
        // crossed. The echo ack is that crossing, so its operation id is kept,
        // suffix included. A row this filter drops must not fail the lookup.
        use postgres::{fallible_iterator::FallibleIterator, types::ToSql};
        let lookup = lookup.unwrap_or_default();
        let limit: i64 = if lookup.operation_prefix.is_some() { 1 } else { 10_001 };
        // PostgreSQL's heterogeneous bind-parameter API, not domain type erasure.
        let params: &[&(dyn ToSql + Sync)] = &[
            &organization_id, &parent_session_id, &lookup.child_session_id,
            &lookup.operation_prefix, &limit,
        ];
        let mut rows = client.query_raw(
            &format!("SELECT o.session_id AS child_session_id, \
              o.operation_id, o.created_at, \
              COALESCE(o.input->'semantic'->>'event', o.input->>'event') AS event, \
              o.decision->>'decision' AS decision, \
              o.decision->>'value' AS decision_value, \
              COALESCE(o.input->'semantic'->>'spawn_call_id', o.input->>'spawn_call_id') AS spawn_call_id, \
              COALESCE(o.input->'semantic'->>'child_native_id', o.input->>'child_native_id') AS child_native_id, \
              COALESCE(o.input->'semantic'->>'output', o.input->>'output') AS output \
              FROM openappa_operations o \
              WHERE o.organization_id=$1 AND o.status='complete' AND NOT {ESCAPED} \
              AND EXISTS (SELECT 1 FROM openappa_sessions s \
                WHERE s.session_id=o.session_id AND s.organization_id=$1 AND s.parent_id=$2) \
              AND COALESCE(o.input->'semantic'->>'event', o.input->>'event') IN ('child_end', 'child_return') \
              AND (o.decision->>'decision' = 'ack' OR \
                (COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_end' \
                 AND o.decision->>'decision' = 'child_return')) \
              AND ((COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_return' \
                    AND COALESCE(o.input->'semantic'->>'output', o.input->>'output') IS NOT NULL) \
                OR (COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_end' \
                    AND o.operation_id NOT LIKE '%:echo' \
                    AND ((o.decision->>'decision' = 'ack' \
                          AND COALESCE(o.input->'semantic'->>'output', o.input->>'output') IS NOT NULL) \
                      OR (o.decision->>'decision' = 'child_return' AND o.decision->>'value' IS NOT NULL)))) \
              AND ($3::text IS NULL OR o.session_id=$3) \
              AND ($4::text IS NULL OR left(o.operation_id,length($4))=$4) \
              ORDER BY o.created_at DESC, o.session_id, o.operation_id DESC LIMIT $5",
                ESCAPED = sealed::ESCAPED),
            params.iter().copied(),
        )?;
        let mut records: Vec<(SystemTime, ChildReturnRecord)> = Vec::new();
        let mut budget = ReceiptLookupBudget::default();
        while let Some(row) = rows.next()? {
            let event: Option<String> = row.get("event");
            let operation_id: String = row.get("operation_id");
            let decision: Option<String> = row.get("decision");
            let decision_value: Option<String> = row.get("decision_value");
            let output: Option<String> = row.get("output");
            budget.take(decision_value.as_deref().unwrap_or("").len()
                .saturating_add(output.as_deref().unwrap_or("").len()))?;
            let Some(crossed) = crossed_return(ReturnReceipt {
                event: event.as_deref().unwrap_or(""),
                operation_id: &operation_id,
                decision: decision.as_deref().unwrap_or(""),
                decision_value: decision_value.as_deref(),
                output: output.as_deref(),
            }) else {
                continue;
            };
            records.push((row.get("created_at"), ChildReturnRecord {
                child_session_id: row.get("child_session_id"),
                spawn_call_id: row.get("spawn_call_id"),
                child_native_id: row.get("child_native_id"),
                operation_id: Some(crossed.operation_id),
                value: crossed.value,
            }));
        }
        drop(rows);
        // The same lookup over the receipts SQL cannot read inside; crossed_return
        // decides for them as for the rows above.
        let opened = sealed::read(
            client,
            &StorageCipher::Plain,
            sealed::Receipts::Escaped,
            "o.organization_id=$1 \
             AND EXISTS (SELECT 1 FROM openappa_sessions s \
               WHERE s.session_id=o.session_id AND s.organization_id=$1 AND s.parent_id=$2) \
             AND ($3::text IS NULL OR o.session_id=$3) \
             AND ($4::text IS NULL OR left(o.operation_id,length($4))=$4)",
            &params[..4],
        )?;
        let unsealed = records.len();
        for receipt in opened {
            let event = receipt.input_text("event");
            let decision = receipt.decision_text("decision");
            let decision_value = receipt.decision_text("value");
            let output = receipt.input_text("output");
            let Some(crossed) = crossed_return(ReturnReceipt {
                event: event.as_deref().unwrap_or(""),
                operation_id: &receipt.operation_id,
                decision: decision.as_deref().unwrap_or(""),
                decision_value: decision_value.as_deref(),
                output: output.as_deref(),
            }) else {
                continue;
            };
            budget.take(crossed.value.len())?;
            records.push((receipt.created_at, ChildReturnRecord {
                spawn_call_id: receipt.input_text("spawn_call_id"),
                child_native_id: receipt.input_text("child_native_id"),
                child_session_id: receipt.session_id,
                operation_id: Some(crossed.operation_id),
                value: crossed.value,
            }));
        }
        if records.len() > unsealed {
            records.sort_by(|(a_at, a), (b_at, b)| {
                b_at.cmp(a_at)
                    .then_with(|| a.child_session_id.cmp(&b.child_session_id))
                    .then_with(|| b.operation_id.cmp(&a.operation_id))
            });
            records.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
        }
        Ok(records.into_iter().map(|(_, record)| record).collect())
    })
    .map_err(sql_failure)
}

#[napi(object)]
#[derive(Serialize)]
pub struct ChildAddressRecord {
    /// Fully scoped session id of the parent that addressed the child.
    pub parent_session_id: String,
    /// The exact message the parent addressed to the child.
    pub value: String,
}

/// Loads the messages a child's parent addressed to it, from the retained
/// ChildAddress operations in PostgreSQL. This is the authority the child side
/// verifies an arriving message against; nothing the client carries proves one.
#[napi(js_name = "loadChildAddresses")]
pub async fn load_child_addresses(
    organization_id: String,
    child_session_id: String,
) -> napi::Result<Vec<ChildAddressRecord>> {
    // Mirror load_child_returns: clone state, drop the mutex, then lease a
    // connection before host SQL so lookups never contend with dispatches.
    let state = {
        let slot = state_mutex().lock().await;
        slot.as_ref()
            .ok_or_else(|| invalid_input("OpenAPPA is not initialized"))?
            .clone()
    };
    let leased = state.lease().await?;
    let pg = &Sql(&leased.state.store);
    pg.with_client(move |client| {
        // Only the child's own parent addresses it, and only an address the
        // runtime acknowledged carried the parent's label into the child.
        use postgres::{fallible_iterator::FallibleIterator, types::ToSql};
        let params: &[&(dyn ToSql + Sync)] = &[&organization_id, &child_session_id];
        let mut rows = client.query_raw(
            &format!(
                "SELECT o.session_id AS parent_session_id, o.created_at, \
              COALESCE(o.input->'semantic'->>'output', o.input->>'output') AS value \
              FROM openappa_operations o \
              WHERE o.organization_id=$1 AND o.status='complete' AND NOT {ESCAPED} \
              AND EXISTS (SELECT 1 FROM openappa_sessions s \
                WHERE s.organization_id=$1 AND s.session_id=$2 AND s.parent_id=o.session_id) \
              AND COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_address' \
              AND COALESCE(o.input->'semantic'->>'spawned_id', o.input->>'spawned_id') = $2 \
              AND o.decision->>'decision' = 'ack' \
              AND COALESCE(o.input->'semantic'->>'output', o.input->>'output') IS NOT NULL \
              ORDER BY o.created_at LIMIT 10001",
                ESCAPED = sealed::ESCAPED
            ),
            params.iter().copied(),
        )?;
        let mut records: Vec<(SystemTime, ChildAddressRecord)> = Vec::new();
        let mut budget = ReceiptLookupBudget::default();
        while let Some(row) = rows.next()? {
            let value: Option<String> = row.get("value");
            budget.take(value.as_deref().unwrap_or("").len())?;
            records.push((
                row.get("created_at"),
                ChildAddressRecord {
                    parent_session_id: row.get("parent_session_id"),
                    value: value.ok_or_else(|| {
                        PostgresError("OpenAPPA retained a child address without a value".into())
                    })?,
                },
            ));
        }
        drop(rows);
        let opened = sealed::read(
            client,
            &StorageCipher::Plain,
            sealed::Receipts::Escaped,
            "o.organization_id=$1 AND EXISTS (SELECT 1 FROM openappa_sessions s \
               WHERE s.organization_id=$1 AND s.session_id=$2 AND s.parent_id=o.session_id)",
            params,
        )?;
        let unsealed = records.len();
        for receipt in opened {
            if !addresses(&receipt, &child_session_id)
                || receipt.decision_text("decision").as_deref() != Some("ack")
            {
                continue;
            }
            let Some(value) = receipt.input_text("output") else {
                continue;
            };
            budget.take(value.len())?;
            records.push((
                receipt.created_at,
                ChildAddressRecord {
                    parent_session_id: receipt.session_id,
                    value,
                },
            ));
        }
        if records.len() > unsealed {
            records.sort_by_key(|(created_at, _)| *created_at);
            // The same bound the SQL applies, over the merged list.
            records.truncate(10_001);
        }
        Ok(records.into_iter().map(|(_, record)| record).collect())
    })
    .map_err(sql_failure)
}

/// Whether `receipt` is a ChildAddress to `child_session_id`.
pub(crate) fn addresses(receipt: &sealed::OpenedReceipt, child_session_id: &str) -> bool {
    receipt.input_text("event").as_deref() == Some("child_address")
        && receipt.input_text("spawned_id").as_deref() == Some(child_session_id)
}

/// Whether this child's parent addressed it before the child's first event.
pub(crate) fn addressed_before_start(pg: &Sql<'_>, input: &Input) -> napi::Result<bool> {
    let Some(parent) = input.parent_id.clone() else {
        return Ok(false);
    };
    let (organization_id, child) = (input.organization_id.clone(), input.session_id.clone());
    pg.with_client(move |client| {
        let addressed = client
            .query_one(
                "SELECT EXISTS (SELECT 1 FROM openappa_operations o \
                  WHERE o.organization_id=$1 AND o.session_id=$2 AND o.status='complete' \
                  AND COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'child_address' \
                  AND COALESCE(o.input->'semantic'->>'spawned_id', o.input->>'spawned_id') = $3)",
                &[&organization_id, &parent, &child],
            )?
            .get::<_, bool>(0);
        if addressed {
            return Ok(true);
        }
        let opened = sealed::read(
            client,
            &StorageCipher::Plain,
            sealed::Receipts::Escaped,
            "o.organization_id=$1 AND o.session_id=$2",
            &[&organization_id, &parent],
        )?;
        Ok(opened.iter().any(|receipt| addresses(receipt, &child)))
    })
    .map_err(sql_failure)
}

/// Receipt key for a spawn call. The host's id is raw; the operation the tool-call
/// dispatch stored is `call:<id>`. The engine does not accept either string as a
/// [`SpawnRef`].
fn spawn_operation_id(spawn_call_id: &str) -> String {
    format!("call:{spawn_call_id}")
}

/// Refuse the whole authority lookup on overflow: partial history cannot prove
/// that an omitted child never crossed, including enforcement-off recovery.
#[derive(Default)]
pub(crate) struct ReceiptLookupBudget {
    records: usize,
    bytes: usize,
}

impl ReceiptLookupBudget {
    pub(crate) fn take(&mut self, bytes: usize) -> Result<(), PostgresError> {
        self.records = self.records.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes);
        if self.records > 10_000 || self.bytes > 8 * 1024 * 1024 {
            return Err(PostgresError(
                "OpenAPPA receipt history exceeds its bounded lookup; narrow the child/task lookup"
                    .into(),
            ));
        }
        Ok(())
    }
}

struct ReturnReceipt<'a> {
    event: &'a str,
    operation_id: &'a str,
    decision: &'a str,
    decision_value: Option<&'a str>,
    output: Option<&'a str>,
}

struct CrossedReturn {
    operation_id: String,
    value: String,
}

/// Which retained receipt is a crossing the parent may read back.
///
/// ChildEnd is unchanged: the base operation carries the admitted bytes, and
/// its echo is not a second crossing. ChildReturn admits only an ack. A
/// `child_return` decision is still staged, or is a substitution the host has
/// not echoed, so it is not a value. The echo ack is the crossing, and its
/// operation id keeps the `:echo` suffix.
fn crossed_return(receipt: ReturnReceipt<'_>) -> Option<CrossedReturn> {
    let value = match receipt.event {
        "child_end"
            if !receipt.operation_id.ends_with(":echo")
                && matches!(receipt.decision, "ack" | "child_return") =>
        {
            receipt.decision_value.or(receipt.output)
        }
        "child_return" if receipt.decision == "ack" => receipt.output,
        _ => None,
    }?;
    Some(CrossedReturn {
        operation_id: receipt.operation_id.to_owned(),
        value: value.to_owned(),
    })
}

/// A named spawn call binds only through the receipt's sealed binding. Omitting the
/// call id keeps the native in-flight path. A named call with no binding does not
/// guess.
pub(crate) fn spawn_ref_from_receipt(
    spawn_call_id: Option<&str>,
    binding: Option<String>,
) -> Result<SpawnRef, &'static str> {
    match spawn_call_id {
        None => Ok(SpawnRef::InFlight),
        Some(_) => {
            let Some(binding) = binding.filter(|binding| !binding.is_empty()) else {
                return Err("spawn call has no released binding");
            };
            Ok(SpawnRef::Binding(SpawnBinding(binding)))
        }
    }
}

/// The sealed binding a released spawn handed back, from the parent's completed
/// allow-call receipt. `None` when that receipt is absent, incomplete, or not a
/// spawn release.
pub(crate) fn released_spawn_binding(
    pg: &Sql<'_>,
    organization_id: &str,
    parent_session_id: &str,
    spawn_call_id: &str,
) -> napi::Result<Option<String>> {
    let organization_id = organization_id.to_owned();
    let parent_session_id = parent_session_id.to_owned();
    let operation_id = spawn_operation_id(spawn_call_id);
    pg.with_client(move |client| {
        let Some(row) = client.query_opt(
            "SELECT input, status, decision FROM openappa_operations \
             WHERE organization_id = $1 AND session_id = $2 AND operation_id = $3",
            &[&organization_id, &parent_session_id, &operation_id],
        )?
        else {
            return Ok(None);
        };
        let status: String = row.get("status");
        if status != "complete" {
            return Ok(None);
        }
        let input = sealed::unescape(row.get("input"))?;
        let decision: Option<Value> = row.get("decision");
        let Some(decision) = decision.map(sealed::unescape).transpose()? else {
            return Ok(None);
        };
        let semantic = input.get("semantic").unwrap_or(&input);
        if semantic.get("spawn").and_then(Value::as_bool) != Some(true) {
            return Ok(None);
        }
        if decision.get("decision").and_then(Value::as_str) != Some("allow_call") {
            return Ok(None);
        }
        Ok(decision
            .get("spawn_binding")
            .and_then(Value::as_str)
            .filter(|binding| !binding.is_empty())
            .map(str::to_owned))
    })
    .map_err(sql_failure)
}

pub(crate) enum AddressedChild {
    /// Exact persisted child. The string is the stored actor, not a synthesized id.
    Rebind(String),
    /// Native `{parent}:` name with no row yet. The first event joins the label.
    UnstartedNative,
    /// No exact row, and not an unstarted native child.
    Foreign,
}

pub(crate) fn classify_addressed_child(
    parent: &str,
    child_session: &str,
    stored_actor: Option<String>,
) -> AddressedChild {
    if let Some(actor) = stored_actor {
        return AddressedChild::Rebind(actor);
    }
    if child_session.starts_with(&format!("{parent}:")) {
        AddressedChild::UnstartedNative
    } else {
        AddressedChild::Foreign
    }
}

/// Re-bind a started child to the dispatcher's family root and the actor the row stored.
pub(crate) fn rebind_child(root: &TrajectoryId, stored_actor: String) -> HookEvent {
    HookEvent::ChildStart {
        root: root.clone(),
        child: TrajectoryId(stored_actor),
        spawn: SpawnRef::InFlight,
    }
}

#[cfg(test)]
mod runtime_child_tests {
    use super::{
        AddressedChild, ReturnReceipt, classify_addressed_child, crossed_return, rebind_child,
        spawn_operation_id, spawn_ref_from_receipt,
    };
    use crate::input::{HookEventKind, Input, validate};
    use crate::session::wire;
    use appa_eventlog::{Backend, LogStore};
    use appa_runtime::{
        api::{AuditEvent, LabelSpelling, OfferId, RemedyArguments, RemedyOutcome},
        hooks,
    };
    use appa_runtime_api::{
        Actor, HookDecision, HookEvent, OfferedReturn, OutcomeBody, ProposedCall, SpawnBinding,
        SpawnKind, SpawnRef, ToolOutcome, TrajectoryId,
    };
    use serde_json::{Value, json};
    use std::sync::Arc;

    fn event_input(event: &str, extra: Value) -> Input {
        let mut input = json!({
            "organization_id": "organization",
            "session_id": "child-session",
            "parent_id": "parent-session",
            "event": event,
            "operation_id": "return-1",
            "output": "exact bytes",
        });
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(input).unwrap()
    }

    #[test]
    fn child_return_requires_a_child_operation_and_output_before_a_receipt() {
        assert!(validate(&event_input("child_return", json!({}))).is_ok());
        let mut missing_output = event_input("child_return", json!({}));
        missing_output.output = None;
        assert_eq!(
            crate::errors::rejected_input(validate(&missing_output).unwrap_err()),
            "missing output"
        );
        let mut missing_parent = event_input("child_return", json!({}));
        missing_parent.parent_id = None;
        assert_eq!(
            crate::errors::rejected_input(validate(&missing_parent).unwrap_err()),
            "missing parent_id"
        );
        let mut missing_operation = event_input("child_return", json!({}));
        missing_operation.operation_id = None;
        assert_eq!(
            crate::errors::rejected_input(validate(&missing_operation).unwrap_err()),
            "missing operation_id"
        );
        assert!(matches!(
            event_input("child_return", json!({})).event,
            HookEventKind::ChildReturn
        ));
    }

    #[test]
    fn a_spawn_call_id_stays_raw_and_does_not_fall_back_to_in_flight() {
        assert_eq!(spawn_operation_id("toolu_1"), "call:toolu_1");
        assert_eq!(spawn_operation_id("call:toolu_1"), "call:call:toolu_1");
        assert!(matches!(
            spawn_ref_from_receipt(None, None).unwrap(),
            SpawnRef::InFlight
        ));
        match spawn_ref_from_receipt(Some("toolu_1"), Some("sealed".into())).unwrap() {
            SpawnRef::Binding(binding) => assert_eq!(binding.0, "sealed"),
            other => panic!("a released receipt must bind explicitly, got {other:?}"),
        }
        assert_eq!(
            spawn_ref_from_receipt(Some("toolu_1"), None).unwrap_err(),
            "spawn call has no released binding"
        );
        assert_eq!(
            spawn_ref_from_receipt(Some("toolu_1"), Some(String::new())).unwrap_err(),
            "spawn call has no released binding"
        );
    }

    #[test]
    fn an_exact_row_authorizes_an_arbitrary_id_and_a_prefix_does_not_rebind() {
        let parent = "user:1|workload";
        let stored = "archestra:stored-actor".to_owned();
        match classify_addressed_child(parent, "workspace-9f3c", Some(stored.clone())) {
            AddressedChild::Rebind(actor) => assert_eq!(actor, stored),
            _ => panic!("an exact row must rebind the stored actor"),
        }
        assert!(matches!(
            classify_addressed_child(parent, &format!("{parent}:native"), None),
            AddressedChild::UnstartedNative
        ));
        assert!(matches!(
            classify_addressed_child(parent, &format!("{parent}:child:grand"), None),
            AddressedChild::UnstartedNative
        ));
        assert!(matches!(
            classify_addressed_child(parent, "workspace-9f3c", None),
            AddressedChild::Foreign
        ));
        assert!(matches!(
            classify_addressed_child(parent, &format!("{parent}:other"), None),
            AddressedChild::UnstartedNative
        ));
    }

    #[test]
    fn a_rebind_uses_the_family_root_and_the_stored_actor() {
        let root = TrajectoryId("archestra:family".into());
        let event = rebind_child(&root, "archestra:stored".into());
        match event {
            HookEvent::ChildStart {
                root: bound_root,
                child,
                spawn,
            } => {
                assert_eq!(bound_root, root);
                assert_eq!(child.0, "archestra:stored");
                assert_eq!(spawn, SpawnRef::InFlight);
            }
            other => panic!("rebind must be a child start, got {other:?}"),
        }
    }

    #[test]
    fn child_return_wire_keeps_the_exact_value_and_a_block_names_its_reason() {
        let staged = wire(&HookDecision::ChildReturn {
            value: "scrubbed".into(),
        })
        .unwrap();
        assert_eq!(staged["decision"], "child_return");
        assert_eq!(staged["value"], "scrubbed");
        let blocked = wire(&HookDecision::Block {
            reason: "the child has a call still open; report its outcome before the child ends"
                .into(),
        })
        .unwrap();
        assert_eq!(blocked["decision"], "block");
        assert_eq!(
            blocked["reason"],
            "the child has a call still open; report its outcome before the child ends"
        );
        assert!(blocked.get("feedback").is_none());
    }

    #[test]
    fn a_loader_keeps_admitted_child_returns_and_drops_an_unechoed_stage() {
        let admitted = crossed_return(ReturnReceipt {
            event: "child_return",
            operation_id: "runtime-return:task-1:req-1",
            decision: "ack",
            decision_value: None,
            output: Some("exact file bytes"),
        })
        .expect("an ack is a crossing");
        assert_eq!(admitted.operation_id, "runtime-return:task-1:req-1");
        assert_eq!(admitted.value, "exact file bytes");

        assert!(
            crossed_return(ReturnReceipt {
                event: "child_return",
                operation_id: "runtime-return:task-1:req-2",
                decision: "child_return",
                decision_value: Some("staged"),
                output: Some("raw"),
            })
            .is_none(),
            "an unechoed stage is not a crossing"
        );

        let echo = crossed_return(ReturnReceipt {
            event: "child_return",
            operation_id: "runtime-return:task-1:req-2:echo",
            decision: "ack",
            decision_value: None,
            output: Some("canonical"),
        })
        .expect("the echo ack is the crossing");
        assert_eq!(echo.operation_id, "runtime-return:task-1:req-2:echo");
        assert!(echo.operation_id.starts_with("runtime-return:task-1:"));
        assert_eq!(echo.value, "canonical");

        assert!(
            crossed_return(ReturnReceipt {
                event: "child_return",
                operation_id: "runtime-return:task-1:req-3",
                decision: "block",
                decision_value: None,
                output: Some("held"),
            })
            .is_none()
        );

        let ended = crossed_return(ReturnReceipt {
            event: "child_end",
            operation_id: "end-1",
            decision: "child_return",
            decision_value: Some("canonical end"),
            output: Some("raw end"),
        })
        .expect("a child end still carries its staged value");
        assert_eq!(ended.value, "canonical end");
        assert!(
            crossed_return(ReturnReceipt {
                event: "child_end",
                operation_id: "end-1:echo",
                decision: "ack",
                decision_value: None,
                output: Some("canonical end"),
            })
            .is_none(),
            "a child-end echo is not a second crossing"
        );
    }

    fn arguments() -> Box<serde_json::value::RawValue> {
        serde_json::value::RawValue::from_string("{}".into()).unwrap()
    }

    fn policy(delegate: &str, read: &str) -> String {
        format!(
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"{delegate}\"\ndelta = {{}}\n[[policy.tool]]\nname = \"{read}\"\ndelta = {{}}\n[policy.deployment]\ncontext_control = true\n"
        )
    }

    fn open_runtime(delegate: &str, read: &str) -> appa_runtime::api::Runtime {
        let store = Arc::new(LogStore::open(Backend::Memory).unwrap());
        crate::policy::open(
            crate::policy::compile(&policy(delegate, read), |_| None).unwrap(),
            store,
        )
        .unwrap()
    }

    fn tool_call(
        root: &TrajectoryId,
        child: Option<&TrajectoryId>,
        tool: &str,
        call_id: Option<&str>,
        spawn: bool,
    ) -> HookEvent {
        HookEvent::ToolCall {
            actor: Actor {
                root: root.clone(),
                child: child.cloned(),
            },
            call: ProposedCall {
                tool: tool.to_owned(),
                arguments: arguments(),
                cwd: None,
            },
            call_id: call_id.map(str::to_owned),
            spawn: spawn.then_some(SpawnKind::Single),
            prompt: None,
            ruling: None,
        }
    }

    async fn released_binding(
        runtime: &appa_runtime::api::Runtime,
        root: &TrajectoryId,
        tool: &str,
    ) -> SpawnBinding {
        let spawn = || tool_call(root, None, tool, None, true);
        let HookDecision::DenyCall { offers, .. } = hooks::handle(runtime, spawn()).await else {
            panic!("a marked spawn blocks until its return is declared");
        };
        let offer = offers
            .iter()
            .find(|offer| offer.returns == Some(OfferedReturn::AsSpoken))
            .expect("the menu offers an as-spoken return");
        let outcome = runtime
            .execute_remedy_with(
                &Actor {
                    root: root.clone(),
                    child: None,
                },
                OfferId(offer.id.clone()),
                RemedyArguments {
                    label: Some(LabelSpelling::default()),
                    return_schema: None,
                },
            )
            .await;
        assert!(
            matches!(outcome, RemedyOutcome::Authorized { .. }),
            "{outcome:?}"
        );
        let released = hooks::handle(runtime, spawn()).await;
        let HookDecision::AllowCall {
            spawn: Some(binding),
            ..
        } = released
        else {
            panic!("the declared spawn must release a binding, got {released:?}");
        };
        binding
    }

    fn start(root: &TrajectoryId) -> HookEvent {
        HookEvent::SessionStart {
            root: root.clone(),
            principal: None,
            address: None,
            title: None,
            start: None,
            launch: None,
        }
    }

    fn child_of(root: &TrajectoryId) -> TrajectoryId {
        let child = TrajectoryId("archestra:workspace-9f3c".into());
        assert!(
            !child.0.starts_with(&format!("{}:", root.0)),
            "the workspace id must not pass the native prefix check"
        );
        child
    }

    async fn opened_child(
        runtime: &appa_runtime::api::Runtime,
        root: &TrajectoryId,
        child: &TrajectoryId,
        delegate: &str,
    ) {
        assert_eq!(hooks::handle(runtime, start(root)).await, HookDecision::Ack);
        let binding = released_binding(runtime, root, delegate).await;
        let forged = hooks::handle(
            runtime,
            HookEvent::ChildStart {
                root: root.clone(),
                child: child.clone(),
                spawn: SpawnRef::Binding(SpawnBinding("not-a-seal".into())),
            },
        )
        .await;
        assert!(
            matches!(forged, HookDecision::Refuse { .. }),
            "a forged binding must not fall back to in-flight, got {forged:?}"
        );
        assert!(
            runtime
                .audit(root)
                .unwrap()
                .iter()
                .all(|entry| entry.trajectory != child.0)
        );
        let started = hooks::handle(
            runtime,
            HookEvent::ChildStart {
                root: root.clone(),
                child: child.clone(),
                spawn: SpawnRef::Binding(binding),
            },
        )
        .await;
        assert!(
            matches!(started, HookDecision::Ack | HookDecision::Context { .. }),
            "{started:?}"
        );
    }

    #[tokio::test]
    async fn a_sealed_binding_opens_an_arbitrary_child_and_a_return_leaves_it_live() {
        let delegate = crate::operations::canonical_tool("delegate").unwrap();
        let read = crate::operations::canonical_tool("read").unwrap();
        let runtime = open_runtime(&delegate, &read);
        let root = TrajectoryId("archestra:parent-root".into());
        let child = child_of(&root);
        opened_child(&runtime, &root, &child, &delegate).await;

        let returned = hooks::handle(
            &runtime,
            HookEvent::ChildReturn {
                root: root.clone(),
                child: child.clone(),
                value: "exact file bytes".into(),
            },
        )
        .await;
        assert_eq!(returned, HookDecision::Ack);
        assert!(runtime.audit(&root).unwrap().iter().any(|entry| {
            entry.trajectory == child.0 && matches!(entry.event, AuditEvent::ChildReturn { .. })
        }));

        let later = hooks::handle(
            &runtime,
            tool_call(&root, Some(&child), &read, Some("call:later"), false),
        )
        .await;
        assert!(
            matches!(later, HookDecision::AllowCall { .. }),
            "the child stays live after a return, got {later:?}"
        );
    }

    #[test]
    fn only_the_exact_open_call_hold_is_marked_busy() {
        let hold = |reason: &str| json!({ "decision": "block", "reason": reason });
        assert_eq!(
            crate::session::mark_busy_hold(hold(crate::session::CHILD_CALL_OPEN_REASON))["busy"],
            json!(true)
        );
        let quoted = format!("denied: {}", crate::session::CHILD_CALL_OPEN_REASON);
        assert!(
            crate::session::mark_busy_hold(hold(&quoted))
                .get("busy")
                .is_none()
        );
        let ack = json!({ "decision": "ack", "reason": crate::session::CHILD_CALL_OPEN_REASON });
        assert!(crate::session::mark_busy_hold(ack).get("busy").is_none());
    }

    #[tokio::test]
    async fn a_child_return_does_not_settle_an_open_call() {
        let delegate = crate::operations::canonical_tool("delegate").unwrap();
        let read = crate::operations::canonical_tool("read").unwrap();
        let runtime = open_runtime(&delegate, &read);
        let root = TrajectoryId("archestra:parent-root".into());
        let child = child_of(&root);
        opened_child(&runtime, &root, &child, &delegate).await;

        let opened = hooks::handle(
            &runtime,
            tool_call(&root, Some(&child), &read, Some("call:read-1"), false),
        )
        .await;
        assert!(
            matches!(opened, HookDecision::AllowCall { .. }),
            "{opened:?}"
        );
        let blocked = hooks::handle(
            &runtime,
            HookEvent::ChildReturn {
                root: root.clone(),
                child: child.clone(),
                value: "pending".into(),
            },
        )
        .await;
        let HookDecision::Block { reason } = blocked else {
            panic!("an open call must hold the return, got {blocked:?}");
        };
        // The binding marks exactly this hold as busy (`mark_busy_hold`), so
        // the host keeps a busy runtime's file pending instead of refusing it.
        assert_eq!(reason, crate::session::CHILD_CALL_OPEN_REASON);
        assert!(runtime.audit(&root).unwrap().iter().all(|entry| {
            entry.trajectory != child.0 || !matches!(entry.event, AuditEvent::ChildReturn { .. })
        }));
        assert!(
            runtime.audit(&root).unwrap().iter().all(|entry| {
                entry.trajectory != child.0 || !matches!(entry.event, AuditEvent::Closed { .. })
            }),
            "the open call must stay open"
        );

        let reported = hooks::handle(
            &runtime,
            HookEvent::ToolResult {
                actor: Actor {
                    root: root.clone(),
                    child: Some(child.clone()),
                },
                call: ProposedCall {
                    tool: read.clone(),
                    arguments: arguments(),
                    cwd: None,
                },
                call_id: Some("call:read-1".into()),
                outcome: ToolOutcome::Success {
                    body: OutcomeBody::Available("note".into()),
                },
            },
        )
        .await;
        assert!(
            matches!(reported, HookDecision::Ack),
            "the withheld return must not have settled the call, got {reported:?}"
        );

        let returned = hooks::handle(
            &runtime,
            HookEvent::ChildReturn {
                root: root.clone(),
                child: child.clone(),
                value: "exact file bytes".into(),
            },
        )
        .await;
        assert_eq!(returned, HookDecision::Ack);
        let later = hooks::handle(
            &runtime,
            tool_call(&root, Some(&child), &read, Some("call:after"), false),
        )
        .await;
        assert!(
            matches!(later, HookDecision::AllowCall { .. }),
            "a later call still runs after the crossing, got {later:?}"
        );
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn receipt_lookup_refuses_record_or_byte_overflow_instead_of_partial_authority() {
        let mut by_records = crate::child_returns::ReceiptLookupBudget::default();
        for _ in 0..10_000 {
            by_records.take(0).unwrap();
        }
        assert!(by_records.take(0).is_err());
        let mut by_bytes = crate::child_returns::ReceiptLookupBudget::default();
        by_bytes.take(8 * 1024 * 1024).unwrap();
        assert!(by_bytes.take(1).is_err());
        assert!(
            crate::child_returns::ReceiptLookupBudget::default()
                .take(usize::MAX)
                .is_err()
        );
    }
}
