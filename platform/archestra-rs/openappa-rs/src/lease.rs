//! The receipts one dispatch works on, and the leases it holds on them.
//!
//! A receipt stays `pending` from its claim to its completion. The dispatch that
//! claimed it holds a lease on it: an owner id and an expiry the database clock
//! judges. The dispatch renews its leases while it works, so a lease outlives
//! any consult it waits on. A process that stops renews nothing, its leases
//! expire, and the next dispatch of the same operation takes the receipt over:
//!
//! - A resubmitted operation whose receipt is pending under an expired lease is
//!   driven again through the runtime. Work the event log never kept runs as a
//!   first run; work it kept is answered from the committed facts, without
//!   re-execution. Either way the receipt completes with exactly the decision
//!   the host was owed.
//! - A receipt pending under a live lease belongs to a dispatch still at work.
//!   A second request for the same operation waits for that dispatch's answer
//!   for a bounded time, holding no connection, and is then refused as
//!   retryable.
//! - A dispatch whose work failed while the family's log stood still committed
//!   nothing, so it removes the receipts it created and the host's retry runs
//!   them as first runs. Any other receipt it holds keeps its recorded input and
//!   only its lease ends, so the retry takes it over at once.
//!
//! Only the owner of a pending receipt completes it, so a dispatch that lost a
//! lease to a takeover can never overwrite what the new owner decides.
//!
//! No dispatch holds a database connection or a lock while it works: every
//! claim, renewal and completion is one short transaction.
use crate::Sql;
use appa_eventlog::{
    LeaseOwner, LogStore, OperationKey, ProcessedResultKey, ReceiptLease, Renewal,
};
use std::{
    future::Future,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};
use tokio::time::MissedTickBehavior;

/// How often a working dispatch renews its leases.
const RENEW_INTERVAL: Duration = Duration::from_secs(5);

/// How long a lease stands without renewal. Several renewals can fail before
/// it ends, so only a stopped process lets one expire.
const LEASE_TTL: Duration = Duration::from_secs(30);

/// How long a request waits for another request working on the same operation
/// before it is refused as retryable. Longer than a lease outlives its last
/// renewal, so the retry of a stopped dispatch's operation takes it over
/// rather than failing.
const HELD_WAIT: Duration = Duration::from_secs(45);

/// What became of the work a dispatch's leases guarded.
pub(crate) enum Guarded<T> {
    Finished(T),
    /// Another dispatch took over a receipt this one claimed: its lease
    /// expired before a renewal reached the database.
    Lost,
}

/// How this dispatch came to hold a receipt.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Holding {
    /// This dispatch wrote the receipt.
    Created,
    /// An earlier dispatch wrote it and stopped; this one took it over.
    Recovered,
}

/// The receipts one dispatch claimed, under the one owner id it claims them as.
pub(crate) struct Receipts {
    store: Arc<LogStore>,
    lease: ReceiptLease,
    claimed: Mutex<Claimed>,
}

#[derive(Default)]
struct Claimed {
    operations: Vec<(OperationKey, Holding)>,
    results: Vec<(ProcessedResultKey, Holding)>,
}

impl Receipts {
    pub(crate) fn new(store: Arc<LogStore>) -> Self {
        let owner = LeaseOwner::parse(&uuid::Uuid::now_v7().to_string())
            .expect("a UUID is a valid lease owner");
        Self {
            store,
            lease: ReceiptLease::new(owner, LEASE_TTL).expect("the lease TTL is positive"),
            claimed: Mutex::default(),
        }
    }

    pub(crate) fn lease(&self) -> &ReceiptLease {
        &self.lease
    }

    pub(crate) fn owner(&self) -> &LeaseOwner {
        self.lease.owner()
    }

    /// Records a receipt this dispatch now holds, so its lease is renewed.
    pub(crate) fn hold_operation(&self, key: OperationKey, holding: Holding) {
        self.claimed().operations.push((key, holding));
    }

    pub(crate) fn hold_result(&self, key: ProcessedResultKey, holding: Holding) {
        self.claimed().results.push((key, holding));
    }

    /// Runs `work`, renewing this dispatch's leases while it runs. A dispatch
    /// that lost a lease stops where it is: what it would still write could not
    /// complete a receipt it no longer owns.
    pub(crate) async fn hold<F: Future>(&self, work: F) -> Guarded<F::Output> {
        tokio::pin!(work);
        let mut renewals = tokio::time::interval(RENEW_INTERVAL);
        renewals.set_missed_tick_behavior(MissedTickBehavior::Delay);
        // An interval's first tick is immediate, and nothing is claimed yet.
        renewals.tick().await;
        loop {
            tokio::select! {
                biased;
                output = &mut work => return Guarded::Finished(output),
                _ = renewals.tick() => {
                    if self.renew_lost() {
                        return Guarded::Lost;
                    }
                }
            }
        }
    }

    /// Leaves the receipts of a dispatch that did not finish for the host's
    /// retry. `committed_nothing`: the family's log stood still for the whole
    /// dispatch, so the receipts this dispatch created guard no work and are
    /// removed. Every other pending receipt keeps its recorded input, and its
    /// lease ends so the retry takes it over at once.
    pub(crate) fn release(&self, committed_nothing: bool) {
        let (operations, results) = self.held();
        if operations.is_empty() && results.is_empty() {
            return;
        }
        if committed_nothing {
            let created = |holding: &Holding| *holding == Holding::Created;
            let (operations, results) = {
                let claimed = self.claimed();
                (
                    keys(&claimed.operations, created),
                    keys(&claimed.results, created),
                )
            };
            if let Err(error) = remove_pending(&Sql(&self.store), self.owner(), operations, results)
            {
                // Their leases still end below; the retry recovers them instead.
                eprintln!("OpenAPPA could not remove its unused receipts: {error}");
            }
        }
        if let Err(error) = self
            .store
            .release_receipts(self.owner(), &operations, &results)
        {
            // The leases then expire on their own.
            eprintln!("OpenAPPA could not end its receipt leases: {error}");
        }
    }

    /// Whether a renewal found a held receipt taken over. A renewal that cannot
    /// reach the database loses nothing yet: the lease stands until it expires,
    /// and the next renewal tries again.
    fn renew_lost(&self) -> bool {
        let (operations, results) = self.held();
        if operations.is_empty() && results.is_empty() {
            return false;
        }
        match self
            .store
            .renew_receipts(&self.lease, &operations, &results)
        {
            Ok(renewal) => renewal == Renewal::Lost,
            Err(error) => {
                eprintln!("OpenAPPA could not renew its receipt leases: {error}");
                false
            }
        }
    }

    fn held(&self) -> (Vec<OperationKey>, Vec<ProcessedResultKey>) {
        let claimed = self.claimed();
        (
            keys(&claimed.operations, |_| true),
            keys(&claimed.results, |_| true),
        )
    }

    fn claimed(&self) -> std::sync::MutexGuard<'_, Claimed> {
        self.claimed.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The wait of a request for another request that works on the same operation.
pub(crate) struct HeldWait {
    since: Instant,
    delay: Duration,
}

impl HeldWait {
    pub(crate) fn new() -> Self {
        Self {
            since: Instant::now(),
            delay: Duration::from_millis(50),
        }
    }

    /// Waits before the next claim attempt, holding no connection. `false`
    /// once the request has waited long enough and should be refused instead.
    pub(crate) async fn again(&mut self) -> bool {
        if self.since.elapsed() >= HELD_WAIT {
            return false;
        }
        tokio::time::sleep(self.delay).await;
        self.delay = (self.delay * 2).min(Duration::from_secs(1));
        true
    }
}

fn keys<K: Clone>(held: &[(K, Holding)], keep: impl Fn(&Holding) -> bool) -> Vec<K> {
    held.iter()
        .filter(|(_, holding)| keep(holding))
        .map(|(key, _)| key.clone())
        .collect()
}

/// Removes the listed receipts that are still pending under `owner`.
fn remove_pending(
    sql: &Sql<'_>,
    owner: &LeaseOwner,
    operations: Vec<OperationKey>,
    results: Vec<ProcessedResultKey>,
) -> Result<(), appa_eventlog::postgres::PostgresError> {
    if operations.is_empty() && results.is_empty() {
        return Ok(());
    }
    let owner = owner.as_str().to_owned();
    sql.with_client(move |client| {
        for key in &operations {
            client.execute(
                "DELETE FROM openappa_operations \
                 WHERE organization_id = $1 AND session_id = $2 AND operation_id = $3 \
                   AND status = 'pending' AND lease_owner = $4",
                &[
                    &key.session.organization_id,
                    &key.session.session_id,
                    &key.operation_id,
                    &owner,
                ],
            )?;
        }
        for key in &results {
            client.execute(
                "DELETE FROM openappa_processed_results \
                 WHERE organization_id = $1 AND session_id = $2 AND tool_call_id = $3 \
                   AND status = 'pending' AND lease_owner = $4",
                &[
                    &key.session.organization_id,
                    &key.session.session_id,
                    &key.tool_call_id,
                    &owner,
                ],
            )?;
        }
        Ok(())
    })
}

/// Where `root`'s event log ends now, or -1 for an empty log. A failed dispatch
/// compares it with where the log ended when it began.
pub(crate) fn log_end(
    sql: &Sql<'_>,
    root: &str,
) -> Result<i64, appa_eventlog::postgres::PostgresError> {
    let root = root.to_owned();
    sql.with_client(move |client| {
        Ok(client
            .query_one(
                "SELECT COALESCE(max(seq), -1) FROM openappa_events WHERE root = $1",
                &[&root],
            )?
            .get(0))
    })
}
