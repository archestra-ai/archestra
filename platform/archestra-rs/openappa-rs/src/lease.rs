//! The lease one dispatch holds on its trajectory family while it claims and
//! completes receipts.
//!
//! A receipt stays `pending` from its claim to its completion, and a process
//! that stops in between leaves it pending. A later dispatch of the family
//! finds it while holding the family's advisory lock, so it knows the
//! receipt's owner is gone: PostgreSQL drops that lock when the owner's
//! connection ends, and no sooner. No clock is compared.
//!
//! What the stopped dispatch kept is then answered per operation, never
//! guessed from the family's log position:
//!
//! - A resubmitted operation whose receipt is pending is driven again through
//!   the runtime. Work the event log never kept runs as a first run; work it
//!   kept is answered from the committed facts, without re-execution. Either
//!   way the pending receipt completes with exactly the decision the host was
//!   owed, and no family is closed for an ordinary interruption.
//! - A dispatch whose own work failed while it committed nothing to the log
//!   releases the receipts it claimed at once, so the host's retry runs them
//!   again without waiting for the recovery above.
//!
//! Every function here runs on the dispatch's own connection, which holds the
//! family's advisory lock for the whole dispatch.
use appa_eventlog::postgres::{LeasedPostgres, PostgresError};
use postgres::GenericClient;
use std::{future::Future, time::Duration};
use tokio::time::MissedTickBehavior;

/// How often a working dispatch checks that it still owns its lease.
const PROBE_INTERVAL: Duration = Duration::from_secs(5);

/// The receipts one dispatch may have claimed, all in one session of its
/// family: operation ids and the tool-call ids of processed results.
pub(crate) struct OwnReceipts {
    pub session_id: String,
    pub operations: Vec<String>,
    pub results: Vec<String>,
}

/// What became of the work a lease guarded.
pub(crate) enum Guarded<T> {
    Finished(T),
    /// This dispatch no longer owns its family: its connection ended, or
    /// another dispatch took the lease.
    Lost,
}

/// One dispatch's lease on its family.
pub(crate) struct DispatchLease {
    root: String,
    owner: String,
}

impl DispatchLease {
    /// Takes the lease of a family. The event log's end is read here, so take
    /// it after the dispatch's last write that precedes its first claim.
    /// `attempt` counts the family's lease generations: a family whose
    /// dispatches keep stopping shows a growing number, which is telemetry for
    /// diagnostics, never a reason to refuse the family.
    pub(crate) fn take(pg: &LeasedPostgres, root: &str) -> Result<Self, PostgresError> {
        let key = root.to_owned();
        let owner = pg.with_client(move |client| {
            let seq = head(client, &key)?;
            Ok(client
                .query_one(
                    "INSERT INTO openappa_dispatch_leases (root, owner, event_seq, attempt) \
                     VALUES ($1, gen_random_uuid()::text, $2, 1) \
                     ON CONFLICT (root) DO UPDATE SET owner = EXCLUDED.owner, \
                         event_seq = EXCLUDED.event_seq, \
                     attempt = LEAST(openappa_dispatch_leases.attempt, 2147483646) + 1 \
                     RETURNING owner",
                    &[&key, &seq],
                )?
                .get(0))
        })?;
        Ok(Self {
            root: root.to_owned(),
            owner,
        })
    }

    /// Runs `work`, checking the lease while it runs. A dispatch that lost its
    /// lease stops where it is: nothing it would still write could be kept, and
    /// the dispatch that took the family over answers the host's retry.
    pub(crate) async fn hold<F: Future>(&self, pg: &LeasedPostgres, work: F) -> Guarded<F::Output> {
        tokio::pin!(work);
        let mut probes = tokio::time::interval(PROBE_INTERVAL);
        probes.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // An interval's first tick is immediate, and the lease is new.
        probes.tick().await;
        loop {
            tokio::select! {
                biased;
                output = &mut work => return Guarded::Finished(output),
                _ = probes.tick() => {
                    if !matches!(self.owned(pg), Ok(true)) {
                        return Guarded::Lost;
                    }
                }
            }
        }
    }

    /// Ends a lease this dispatch still holds. `finished` is whether its work
    /// returned a decision. Work that failed and left the event log where the
    /// lease found it kept nothing, so the receipts it claimed are released at
    /// once and the host's retry runs them again. Any other pending receipt is
    /// recovered when its own operation is resubmitted, and keeps the lease
    /// row as the sign that recovery is owed.
    pub(crate) fn settle(
        &self,
        pg: &LeasedPostgres,
        finished: bool,
        own: &OwnReceipts,
    ) -> Result<(), PostgresError> {
        let (root, owner) = (self.root.clone(), self.owner.clone());
        let (session_id, operations, results) = (
            own.session_id.clone(),
            own.operations.clone(),
            own.results.clone(),
        );
        pg.with_client(move |client| {
            let mut transaction = client.transaction()?;
            let held = transaction
                .query_opt(
                    "SELECT event_seq FROM openappa_dispatch_leases \
                     WHERE root = $1 AND owner = $2 FOR UPDATE",
                    &[&root, &owner],
                )?
                .map(|row| row.get::<_, i64>(0));
            let Some(event_seq) = held else {
                return Ok(());
            };
            if !finished && head(&mut transaction, &root)? == event_seq {
                release_own(&mut transaction, &root, &session_id, &operations, &results)?;
            }
            if !has_pending(&mut transaction, &root)? {
                transaction.execute(
                    "DELETE FROM openappa_dispatch_leases WHERE root = $1 AND owner = $2",
                    &[&root, &owner],
                )?;
            }
            transaction.commit()?;
            Ok(())
        })
    }

    fn owned(&self, pg: &LeasedPostgres) -> Result<bool, PostgresError> {
        let (root, owner) = (self.root.clone(), self.owner.clone());
        pg.with_client(move |client| {
            Ok(client
                .query_opt(
                    "SELECT 1 FROM openappa_dispatch_leases WHERE root = $1 AND owner = $2",
                    &[&root, &owner],
                )?
                .is_some())
        })
    }
}

fn has_pending(client: &mut impl GenericClient, root: &str) -> Result<bool, PostgresError> {
    Ok(client
        .query_opt(
            "SELECT 1 FROM openappa_operations WHERE root = $1 AND status = 'pending' \
             UNION ALL \
             SELECT 1 FROM openappa_processed_results WHERE root = $1 AND status = 'pending' \
             LIMIT 1",
            &[&root],
        )?
        .is_some())
}

/// The last event sequence of `root`, or -1 for an empty log.
fn head(client: &mut impl GenericClient, root: &str) -> Result<i64, PostgresError> {
    Ok(client
        .query_one(
            "SELECT COALESCE(max(seq), -1) FROM openappa_events WHERE root = $1",
            &[&root],
        )?
        .get(0))
}

/// Releases the pending rows one dispatch claimed itself: its session's rows
/// for exactly the operation and tool-call ids it worked on. Another
/// dispatch's receipts, including recovered ones still awaiting their own
/// resubmission, are never touched.
fn release_own(
    client: &mut impl GenericClient,
    root: &str,
    session_id: &str,
    operations: &[String],
    results: &[String],
) -> Result<(), PostgresError> {
    if !operations.is_empty() {
        client.execute(
            "DELETE FROM openappa_operations \
             WHERE root = $1 AND session_id = $2 AND operation_id = ANY($3) AND status = 'pending'",
            &[&root, &session_id, &operations],
        )?;
    }
    if !results.is_empty() {
        client.execute(
            "DELETE FROM openappa_processed_results \
             WHERE root = $1 AND session_id = $2 AND tool_call_id = ANY($3) AND status = 'pending'",
            &[&root, &session_id, &results],
        )?;
    }
    Ok(())
}
