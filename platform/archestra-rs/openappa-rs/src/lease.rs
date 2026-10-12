//! The lease one dispatch holds on its trajectory family while it claims and
//! completes receipts.
//!
//! A receipt stays `pending` from its claim to its completion, and a pending
//! receipt stops every later dispatch of the family. A process that stops in
//! between leaves the receipt pending for good. The lease records which
//! dispatch was doing that work and where the family's event log ended when
//! the work began, so a later dispatch can tell what the stopped one left:
//!
//! - The event log has not advanced: the runtime kept nothing of the stopped
//!   work, so its receipts are released and the operation runs again when it
//!   is next submitted.
//! - The event log advanced: the runtime kept part of a decision the host
//!   never saw. Nothing here can replay that safely, so the family stays
//!   closed for an operator.
//!
//! A lease lasts as long as its owner's connection does. Every function here
//! runs on the dispatch's own connection, which holds the family's advisory
//! lock. PostgreSQL drops that lock when the owner's connection ends, and no
//! sooner, so a dispatch that holds the lock and still finds pending receipts
//! knows their owner is no longer working on them. No clock is compared.
use appa_eventlog::postgres::{LeasedPostgres, PostgresError};
use postgres::GenericClient;
use std::{future::Future, time::Duration};
use tokio::time::MissedTickBehavior;

/// How often a working dispatch checks that it still owns its lease.
const PROBE_INTERVAL: Duration = Duration::from_secs(5);

/// A family stops recovering by itself after this many dispatches in a row
/// stopped with pending receipts: an operation that ends its process every
/// time must not be run again on every retry.
const MAX_ATTEMPTS: i32 = 3;

/// What a dispatch found when it looked at its family's pending receipts.
#[derive(Debug, PartialEq)]
pub(crate) enum Admission {
    /// Nothing is pending. `attempt` numbers the lease this dispatch takes.
    Clear { attempt: i32 },
    /// Receipts are pending and cannot be released without an operator.
    Interrupted,
}

/// The lease a stopped dispatch left behind.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Left {
    event_seq: i64,
    attempt: i32,
}

/// Whether pending receipts left under `lease` can be released, with the event
/// log now ending at `head`.
fn admission(lease: Option<Left>, head: i64) -> Admission {
    match lease {
        Some(lease) if lease.event_seq == head && lease.attempt < MAX_ATTEMPTS => {
            Admission::Clear {
                attempt: lease.attempt + 1,
            }
        }
        // The runtime kept part of the work, the family keeps stopping, or the
        // receipts were claimed without a lease: by a version that took none,
        // by a remedy, or by a peer operation.
        _ => Admission::Interrupted,
    }
}

/// Decides whether this dispatch may work on `root`, releasing the receipts of
/// an owner that stopped before the runtime kept anything.
pub(crate) fn admit(pg: &LeasedPostgres, root: &str) -> Result<Admission, PostgresError> {
    let root = root.to_owned();
    pg.with_client(move |client| {
        if !has_pending(client, &root)? {
            return Ok(Admission::Clear { attempt: 1 });
        }
        let lease = client
            .query_opt(
                "SELECT event_seq, attempt FROM openappa_dispatch_leases WHERE root = $1",
                &[&root],
            )?
            .map(|row| Left {
                event_seq: row.get(0),
                attempt: row.get(1),
            });
        let admission = admission(lease, head(client, &root)?);
        if admission != Admission::Interrupted {
            let mut transaction = client.transaction()?;
            release(&mut transaction, &root)?;
            transaction.commit()?;
        }
        Ok(admission)
    })
}

/// Works on `root` without a lease. Receipts claimed this way are never
/// released for a second run, so no earlier lease may remain to vouch for them.
pub(crate) fn forgo(pg: &LeasedPostgres, root: &str) -> Result<(), PostgresError> {
    let root = root.to_owned();
    pg.with_client(move |client| {
        client.execute(
            "DELETE FROM openappa_dispatch_leases WHERE root = $1",
            &[&root],
        )?;
        Ok(())
    })
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
    /// Takes the lease of a family [`admit`] found clear. The event log's end is
    /// read here, so take it after the dispatch's last write that precedes its
    /// first claim.
    pub(crate) fn take(
        pg: &LeasedPostgres,
        root: &str,
        attempt: i32,
    ) -> Result<Self, PostgresError> {
        let key = root.to_owned();
        let owner = pg.with_client(move |client| {
            let seq = head(client, &key)?;
            Ok(client
                .query_one(
                    "INSERT INTO openappa_dispatch_leases (root, owner, event_seq, attempt) \
                     VALUES ($1, gen_random_uuid()::text, $2, $3) \
                     ON CONFLICT (root) DO UPDATE SET owner = EXCLUDED.owner, \
                         event_seq = EXCLUDED.event_seq, attempt = EXCLUDED.attempt \
                     RETURNING owner",
                    &[&key, &seq, &attempt],
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
    /// lease found it is released at once, so the host's retry runs it again.
    /// Any other pending receipt keeps its lease for the next dispatch to judge.
    pub(crate) fn settle(&self, pg: &LeasedPostgres, finished: bool) -> Result<(), PostgresError> {
        let (root, owner) = (self.root.clone(), self.owner.clone());
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
            if has_pending(&mut transaction, &root)? {
                if finished || head(&mut transaction, &root)? != event_seq {
                    return Ok(());
                }
                release(&mut transaction, &root)?;
            }
            transaction.execute(
                "DELETE FROM openappa_dispatch_leases WHERE root = $1 AND owner = $2",
                &[&root, &owner],
            )?;
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

fn release(client: &mut impl GenericClient, root: &str) -> Result<(), PostgresError> {
    client.execute(
        "DELETE FROM openappa_operations WHERE root = $1 AND status = 'pending'",
        &[&root],
    )?;
    client.execute(
        "DELETE FROM openappa_processed_results WHERE root = $1 AND status = 'pending'",
        &[&root],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Admission, Left, MAX_ATTEMPTS, admission};

    fn left(event_seq: i64, attempt: i32) -> Option<Left> {
        Some(Left { event_seq, attempt })
    }

    #[test]
    fn pending_receipts_without_a_lease_need_an_operator() {
        assert_eq!(admission(None, 4), Admission::Interrupted);
    }

    #[test]
    fn stopped_work_is_released_only_when_the_log_did_not_advance() {
        assert_eq!(admission(left(4, 1), 4), Admission::Clear { attempt: 2 });
        assert_eq!(admission(left(4, 1), 5), Admission::Interrupted);
        assert_eq!(admission(left(-1, 1), -1), Admission::Clear { attempt: 2 });
    }

    #[test]
    fn a_family_that_keeps_stopping_is_not_released_again() {
        assert_eq!(
            admission(left(4, MAX_ATTEMPTS - 1), 4),
            Admission::Clear {
                attempt: MAX_ATTEMPTS
            }
        );
        assert_eq!(admission(left(4, MAX_ATTEMPTS), 4), Admission::Interrupted);
    }
}
