//! Serialize native receipt claims with rewrite-group cleanup.
//!
//! A claim's pending insert commits inside `appa_eventlog`'s `serialized()`,
//! which always issues its own `BEGIN` and then `COMMIT` or `ROLLBACK`. That
//! function is private and takes no already-open transaction and no host hook.
//! The group lock therefore shares the claim transaction only by being open
//! when `serialized` starts, which makes PostgreSQL warn on the inner `BEGIN`.
//! Notices are not suppressed. `Hold` rolls an abandoned transaction back
//! before the lease returns the connection to the pool.
//!
//! Request paths and cleanup take `FOR UPDATE` on `openappa_rewrite_groups`.
//! A transaction that may write `expires_at` starts with that lock. `FOR SHARE`
//! followed by an update deadlocks a `FOR UPDATE` waiter.

use std::collections::HashSet;

use appa_eventlog::postgres::{LeasedPostgres, PostgresError};
use postgres::Client;

use crate::session_actor;

pub const EXPIRED: &str = "OpenAPPA replay retention expired";
const PROTOCOL_VERSION: i32 = 1;
const TOUCH_SLACK: &str = "60 seconds";
pub(crate) const MAX_FORK_DEPTH: usize = 32;

#[derive(Clone, Debug)]
pub struct Subject<'a> {
    pub organization_id: &'a str,
    pub root: &'a str,
    pub session_id: &'a str,
    pub fork_of: Option<&'a str>,
    pub parent_id: Option<&'a str>,
    pub caller_id: Option<&'a str>,
}

#[derive(Debug)]
pub enum Error {
    Expired,
    Storage(PostgresError),
}

pub struct Hold<'a> {
    pg: &'a LeasedPostgres,
    open: bool,
}

impl Hold<'_> {
    pub fn disarm(&mut self) {
        self.open = false;
    }
}

impl Drop for Hold<'_> {
    fn drop(&mut self) {
        if !self.open {
            return;
        }
        self.open = false;
        let _ = self.pg.with_client(|client| {
            rollback_if_open(client);
            Ok(())
        });
    }
}

pub fn touch(pg: &LeasedPostgres, subject: Subject<'_>) -> Result<(), Error> {
    let mut held = hold(pg, subject)?;
    if !held.open {
        return Ok(());
    }
    pg.with_client(|client| {
        client.batch_execute("COMMIT")?;
        Ok(())
    })
    .map_err(Error::Storage)?;
    held.disarm();
    Ok(())
}

pub fn hold<'a>(pg: &'a LeasedPostgres, subject: Subject<'_>) -> Result<Hold<'a>, Error> {
    let owned = Owned::from(subject);
    let step = pg
        .with_client(move |client| begin_and_lock(client, &owned))
        .map_err(Error::Storage)?;
    match step {
        Lock::Clear => Ok(Hold { pg, open: false }),
        Lock::Armed => Ok(Hold { pg, open: true }),
        Lock::Refuse => Err(Error::Expired),
    }
}

#[derive(Clone)]
struct Owned {
    organization_id: String,
    root: String,
    session_id: String,
    fork_of: Option<String>,
    parent_id: Option<String>,
    caller_id: Option<String>,
}

impl From<Subject<'_>> for Owned {
    fn from(subject: Subject<'_>) -> Self {
        Self {
            organization_id: subject.organization_id.to_owned(),
            root: subject.root.to_owned(),
            session_id: subject.session_id.to_owned(),
            fork_of: subject.fork_of.map(str::to_owned),
            parent_id: subject.parent_id.map(str::to_owned),
            caller_id: subject.caller_id.map(str::to_owned),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Lock {
    Clear,
    Armed,
    Refuse,
}

fn begin_and_lock(client: &mut Client, subject: &Owned) -> Result<Lock, PostgresError> {
    client.batch_execute("BEGIN")?;
    match lock_open(client, subject) {
        Ok(Lock::Armed) => Ok(Lock::Armed),
        Ok(done) => {
            client.batch_execute("ROLLBACK")?;
            Ok(done)
        }
        Err(error) => {
            let _ = client.batch_execute("ROLLBACK");
            Err(error)
        }
    }
}

fn rollback_if_open(client: &mut Client) {
    let open = match client.query_one("SELECT pg_current_xact_id_if_assigned() IS NOT NULL", &[]) {
        Ok(row) => row.get::<_, bool>(0),
        Err(_) => true,
    };
    if !open {
        return;
    }
    if client.batch_execute("ROLLBACK").is_err() {
        let _ = client.batch_execute("SELECT pg_terminate_backend(pg_backend_pid())");
    }
}

fn lock_open(client: &mut Client, subject: &Owned) -> Result<Lock, PostgresError> {
    if !journal_present(client)? {
        return Ok(Lock::Clear);
    }
    let group_id = match resolve_group(client, subject)? {
        Resolve::None => return Ok(Lock::Clear),
        Resolve::TooDeep => return Ok(Lock::Refuse),
        Resolve::Group(group_id) => group_id,
    };
    let Some(row) = client.query_opt(
        "SELECT status, protocol_version, \
             expires_at < clock_timestamp() + (idle_ttl_ms * INTERVAL '1 millisecond') AS due \
             FROM openappa_rewrite_groups \
             WHERE organization_id = $1 AND group_id = $2 \
             FOR UPDATE",
        &[&subject.organization_id, &group_id],
    )?
    else {
        return Ok(Lock::Refuse);
    };
    let status: String = row.get(0);
    let protocol_version: i32 = row.get(1);
    let due: bool = row.get(2);
    if decide_row(&status, protocol_version) == RowDecision::Refuse {
        return Ok(Lock::Refuse);
    }
    if due {
        let updated = client.execute(
            &format!(
                "UPDATE openappa_rewrite_groups \
                 SET expires_at = clock_timestamp() \
                       + (idle_ttl_ms * INTERVAL '1 millisecond') \
                       + INTERVAL '{TOUCH_SLACK}', \
                     touched_at = clock_timestamp() \
                 WHERE organization_id = $1 AND group_id = $2 \
                   AND status = 'live' AND protocol_version = {PROTOCOL_VERSION}"
            ),
            &[&subject.organization_id, &group_id],
        )?;
        if updated != 1 {
            return Ok(Lock::Refuse);
        }
    }
    Ok(Lock::Armed)
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RowDecision {
    Refuse,
    Hold,
}

pub(crate) fn decide_row(status: &str, protocol_version: i32) -> RowDecision {
    if status == "live" && protocol_version == PROTOCOL_VERSION {
        RowDecision::Hold
    } else {
        RowDecision::Refuse
    }
}

pub(crate) fn lineage_truncated(visited: usize, unresolved_link: bool) -> bool {
    visited >= MAX_FORK_DEPTH && unresolved_link
}

fn journal_present(client: &mut Client) -> Result<bool, PostgresError> {
    let present: Option<String> = client
        .query_one(
            "SELECT to_regclass('public.openappa_rewrite_groups')::text",
            &[],
        )?
        .get(0);
    Ok(present.is_some())
}

enum Resolve {
    None,
    Group(String),
    TooDeep,
}

fn resolve_group(client: &mut Client, subject: &Owned) -> Result<Resolve, PostgresError> {
    if let Some(group) = lookup_root(client, &subject.organization_id, &subject.root)? {
        return Ok(Resolve::Group(group));
    }
    let mut seen = HashSet::new();
    seen.insert(subject.session_id.clone());
    let mut pending =
        if let Some(row) = load_session(client, &subject.organization_id, &subject.session_id)? {
            if let Some(group) = lookup_root(client, &subject.organization_id, &row.root)? {
                return Ok(Resolve::Group(group));
            }
            next_link(&row)
        } else if let Some(hint) = subject
            .fork_of
            .clone()
            .or_else(|| subject.parent_id.clone())
        {
            if !seen.insert(hint.clone()) {
                return Ok(Resolve::None);
            }
            let Some(row) = load_verified(
                client,
                &subject.organization_id,
                &hint,
                subject.caller_id.as_deref(),
            )?
            else {
                return Ok(Resolve::None);
            };
            if let Some(group) = lookup_root(client, &subject.organization_id, &row.root)? {
                return Ok(Resolve::Group(group));
            }
            next_link(&row)
        } else {
            None
        };
    loop {
        if lineage_truncated(seen.len(), pending.is_some()) {
            return Ok(Resolve::TooDeep);
        }
        let Some(session_id) = pending.take() else {
            return Ok(Resolve::None);
        };
        if !seen.insert(session_id.clone()) {
            return Ok(Resolve::None);
        }
        let Some(row) = load_session(client, &subject.organization_id, &session_id)? else {
            return Ok(Resolve::None);
        };
        if let Some(group) = lookup_root(client, &subject.organization_id, &row.root)? {
            return Ok(Resolve::Group(group));
        }
        pending = next_link(&row);
    }
}

fn next_link(row: &Lineage) -> Option<String> {
    row.forked_from.clone().or_else(|| row.parent_id.clone())
}

struct Lineage {
    root: String,
    forked_from: Option<String>,
    parent_id: Option<String>,
}

fn lookup_root(
    client: &mut Client,
    organization_id: &str,
    root: &str,
) -> Result<Option<String>, PostgresError> {
    Ok(client
        .query_opt(
            "SELECT group_id FROM openappa_rewrite_roots \
             WHERE organization_id = $1 AND native_root = $2",
            &[&organization_id, &root],
        )?
        .map(|row| row.get(0)))
}

fn load_session(
    client: &mut Client,
    organization_id: &str,
    session_id: &str,
) -> Result<Option<Lineage>, PostgresError> {
    let actor = session_actor(session_id);
    Ok(client
        .query_opt(
            "SELECT root, forked_from, parent_id FROM openappa_sessions \
             WHERE organization_id = $1 AND actor = $2",
            &[&organization_id, &actor],
        )?
        .map(lineage_row))
}

fn load_verified(
    client: &mut Client,
    organization_id: &str,
    session_id: &str,
    caller_id: Option<&str>,
) -> Result<Option<Lineage>, PostgresError> {
    let actor = session_actor(session_id);
    Ok(client
        .query_opt(
            "SELECT root, forked_from, parent_id FROM openappa_sessions \
             WHERE organization_id = $1 AND actor = $2 \
               AND caller_id IS NOT DISTINCT FROM $3",
            &[&organization_id, &actor, &caller_id],
        )?
        .map(lineage_row))
}

fn lineage_row(row: postgres::Row) -> Lineage {
    Lineage {
        root: row.get(0),
        forked_from: row.get(1),
        parent_id: row.get(2),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Lock, MAX_FORK_DEPTH, Owned, RowDecision, begin_and_lock, decide_row, lineage_truncated,
        rollback_if_open,
    };
    use crate::session_actor;
    use postgres::{Client, NoTls};
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn a_non_live_or_foreign_protocol_row_is_refused() {
        assert_eq!(decide_row("live", 1), RowDecision::Hold);
        assert_eq!(decide_row("expired", 1), RowDecision::Refuse);
        assert_eq!(decide_row("live", 2), RowDecision::Refuse);
    }

    #[test]
    fn a_lineage_that_still_has_a_link_at_the_depth_cap_is_truncated() {
        assert!(!lineage_truncated(MAX_FORK_DEPTH - 1, true));
        assert!(!lineage_truncated(MAX_FORK_DEPTH, false));
        assert!(lineage_truncated(MAX_FORK_DEPTH, true));
    }

    #[test]
    fn admission_serializes_with_cleanup_and_releases_on_every_claim_exit() {
        let Some(url) = std::env::var("OPENAPPA_ADMISSION_PG_URL")
            .ok()
            .filter(|url| !url.is_empty())
        else {
            eprintln!(
                "OPENAPPA_ADMISSION_PG_URL unset; skipped disposable postgres admission test"
            );
            return;
        };
        let mut admin = connect(&url);
        admin
            .batch_execute(
                "CREATE TABLE IF NOT EXISTS openappa_rewrite_groups (
                   organization_id text NOT NULL,
                   group_id text NOT NULL,
                   status text NOT NULL,
                   protocol_version integer NOT NULL,
                   idle_ttl_ms integer NOT NULL,
                   expires_at timestamptz NOT NULL,
                   touched_at timestamptz NOT NULL,
                   expired_at timestamptz,
                   payload_swept_at timestamptz,
                   PRIMARY KEY (organization_id, group_id)
                 );
                 CREATE TABLE IF NOT EXISTS openappa_rewrite_roots (
                   organization_id text NOT NULL,
                   native_root text NOT NULL,
                   group_id text NOT NULL,
                   PRIMARY KEY (organization_id, native_root)
                 );
                 CREATE TABLE IF NOT EXISTS openappa_sessions (
                   organization_id text NOT NULL,
                   actor text NOT NULL,
                   root text NOT NULL,
                   session_id text NOT NULL,
                   forked_from text,
                   parent_id text,
                   caller_id text,
                   PRIMARY KEY (organization_id, actor)
                 );
                 CREATE TABLE IF NOT EXISTS openappa_operations (
                   organization_id text NOT NULL,
                   session_id text NOT NULL,
                   operation_id text NOT NULL,
                   root text NOT NULL,
                   status text NOT NULL,
                   created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
                   PRIMARY KEY (organization_id, session_id, operation_id)
                 );",
            )
            .expect("admission fixture tables");
        admin
            .batch_execute(
                "TRUNCATE openappa_operations, openappa_sessions, openappa_rewrite_roots, openappa_rewrite_groups",
            )
            .expect("admission fixture reset");
        cleanup_wins(&url);
        admission_wins(&url);
        complete_claim_releases_the_lock(&url);
        error_rollback_releases_the_lock(&url);
        expired_unswept_is_terminal(&url);
        wrong_caller_does_not_lock_a_foreign_group(&url);
        verified_fork_locks_the_source_group(&url);
        deep_lineage_fails_closed(&url);
        missing_journal_does_not_error(&url);
        cancellation_releases_the_lock_before_reuse(&url);
    }

    fn cleanup_wins(url: &str) {
        let org = "org-cleanup-wins";
        seed_due_group(url, org, "live");
        let mut holder = connect(url);
        holder
            .batch_execute("BEGIN")
            .and_then(|_| {
                holder.execute(
                    "SELECT 1 FROM openappa_rewrite_groups WHERE organization_id = $1 FOR UPDATE",
                    &[&org],
                )?;
                Ok(())
            })
            .expect("cleanup lock");
        let (ready_tx, ready_rx) = mpsc::channel();
        let worker_url = url.to_owned();
        let worker = thread::spawn(move || {
            let mut client = connect(&worker_url);
            ready_tx
                .send(
                    client
                        .query_one("SELECT pg_backend_pid()", &[])
                        .unwrap()
                        .get::<_, i32>(0),
                )
                .unwrap();
            begin_and_lock(&mut client, &enrolled(org))
        });
        let pid = ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        wait_until_blocked(&mut holder, pid);
        holder
            .execute(
                "UPDATE openappa_rewrite_groups \
                 SET status = 'expired', expired_at = clock_timestamp(), payload_swept_at = NULL \
                 WHERE organization_id = $1",
                &[&org],
            )
            .unwrap();
        holder.batch_execute("COMMIT").unwrap();
        assert_eq!(worker.join().unwrap().unwrap(), Lock::Refuse);
        let mut check = connect(url);
        let status: String = check
            .query_one(
                "SELECT status FROM openappa_rewrite_groups WHERE organization_id = $1",
                &[&org],
            )
            .unwrap()
            .get(0);
        assert_eq!(status, "expired");
        assert!(nowait(&mut check, org));
    }

    fn admission_wins(url: &str) {
        let org = "org-admission-wins";
        seed_due_group(url, org, "live");
        let (ready_tx, ready_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let url_b = url.to_owned();
        let worker = thread::spawn(move || {
            let mut client = connect(&url_b);
            let locked = begin_and_lock(&mut client, &enrolled(org)).unwrap();
            assert_eq!(locked, Lock::Armed);
            ready_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            client
                .execute(
                    "INSERT INTO openappa_operations \
                     (organization_id, session_id, operation_id, root, status) \
                     VALUES ($1, 'session', 'op', $2, 'pending')",
                    &[&org, &"root-admission-wins"],
                )
                .unwrap();
            client.batch_execute("BEGIN").unwrap();
            client.query_one("SELECT 1", &[]).unwrap();
            client.batch_execute("COMMIT").unwrap();
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (pid_tx, pid_rx) = mpsc::channel();
        let url_gc = url.to_owned();
        let gc = thread::spawn(move || {
            let mut client = connect(&url_gc);
            let pid: i32 = client
                .query_one("SELECT pg_backend_pid()", &[])
                .unwrap()
                .get(0);
            pid_tx.send(pid).unwrap();
            client.batch_execute("BEGIN").unwrap();
            client
                .execute(
                    "SELECT 1 FROM openappa_rewrite_groups WHERE organization_id = $1 FOR UPDATE",
                    &[&org],
                )
                .unwrap();
            let pending: bool = client
                .query_one(
                    "SELECT EXISTS (\
                       SELECT 1 FROM openappa_operations \
                       WHERE organization_id = $1 AND status = 'pending')",
                    &[&org],
                )
                .unwrap()
                .get(0);
            client.batch_execute("ROLLBACK").unwrap();
            pending
        });
        let pid = pid_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut watcher = connect(url);
        wait_until_blocked(&mut watcher, pid);
        release_tx.send(()).unwrap();
        assert!(gc.join().unwrap(), "cleanup must see the pending insert");
        worker.join().unwrap();
        let due: bool = connect(url)
            .query_one(
                "SELECT expires_at > clock_timestamp() \
                 FROM openappa_rewrite_groups WHERE organization_id = $1",
                &[&org],
            )
            .unwrap()
            .get(0);
        assert!(due, "a due live group is renewed before the insert commits");
    }

    fn complete_claim_releases_the_lock(url: &str) {
        let org = "org-complete";
        seed_due_group(url, org, "live");
        let mut client = connect(url);
        assert_eq!(
            begin_and_lock(&mut client, &enrolled(org)).unwrap(),
            Lock::Armed
        );
        client.batch_execute("BEGIN").unwrap();
        client.query_one("SELECT 1", &[]).unwrap();
        client.batch_execute("COMMIT").unwrap();
        let mut other = connect(url);
        assert!(nowait(&mut other, org));
    }

    fn error_rollback_releases_the_lock(url: &str) {
        let org = "org-rollback";
        seed_due_group(url, org, "live");
        let mut client = connect(url);
        assert_eq!(
            begin_and_lock(&mut client, &enrolled(org)).unwrap(),
            Lock::Armed
        );
        client.batch_execute("ROLLBACK").unwrap();
        let mut other = connect(url);
        assert!(nowait(&mut other, org));
    }

    fn expired_unswept_is_terminal(url: &str) {
        let org = "org-unswept";
        seed_due_group(url, org, "expired");
        connect(url)
            .execute(
                "UPDATE openappa_rewrite_groups SET payload_swept_at = NULL WHERE organization_id = $1",
                &[&org],
            )
            .unwrap();
        let mut client = connect(url);
        assert_eq!(
            begin_and_lock(&mut client, &enrolled(org)).unwrap(),
            Lock::Refuse
        );
        let row = connect(url)
            .query_one(
                "SELECT status, payload_swept_at IS NULL FROM openappa_rewrite_groups WHERE organization_id = $1",
                &[&org],
            )
            .unwrap();
        let status: String = row.get(0);
        let unswept: bool = row.get(1);
        assert_eq!(status, "expired");
        assert!(unswept);
    }

    fn wrong_caller_does_not_lock_a_foreign_group(url: &str) {
        let org = "org-foreign";
        seed_due_group(url, org, "live");
        insert_session(
            url,
            org,
            "source",
            &group_root(org),
            None,
            Some("user:owner"),
        );
        let mut client = connect(url);
        let mut subject = enrolled(org);
        subject.root = "unregistered-fork-root".into();
        subject.session_id = "new-fork".into();
        subject.fork_of = Some("source".into());
        subject.caller_id = Some("user:other".into());
        assert_eq!(begin_and_lock(&mut client, &subject).unwrap(), Lock::Clear);
        let mut other = connect(url);
        assert!(nowait(&mut other, org));
    }

    fn verified_fork_locks_the_source_group(url: &str) {
        let org = "org-fork";
        seed_due_group(url, org, "live");
        insert_session(
            url,
            org,
            "source",
            &group_root(org),
            None,
            Some("user:owner"),
        );
        let mut client = connect(url);
        let mut subject = enrolled(org);
        subject.root = "unregistered-fork-root".into();
        subject.session_id = "new-fork".into();
        subject.fork_of = Some("source".into());
        subject.caller_id = Some("user:owner".into());
        assert_eq!(begin_and_lock(&mut client, &subject).unwrap(), Lock::Armed);
        let mut other = connect(url);
        assert!(!nowait(&mut other, org));
        client.batch_execute("ROLLBACK").unwrap();
    }

    fn deep_lineage_fails_closed(url: &str) {
        let org = "org-deep";
        let mut previous: Option<String> = None;
        for index in (0..=MAX_FORK_DEPTH).rev() {
            let session_id = format!("deep-{index}");
            insert_session(
                url,
                org,
                &session_id,
                &format!("root-{session_id}"),
                previous.as_deref(),
                None,
            );
            previous = Some(session_id);
        }
        let mut client = connect(url);
        assert_eq!(
            begin_and_lock(&mut client, &{
                let mut subject = enrolled(org);
                subject.session_id = "deep-0".into();
                subject.root = "root-deep-0".into();
                subject
            })
            .unwrap(),
            Lock::Refuse
        );
    }

    fn cancellation_releases_the_lock_before_reuse(url: &str) {
        let org = "org-cancel";
        seed_due_group(url, org, "live");
        let mut client = connect(url);
        assert_eq!(
            begin_and_lock(&mut client, &enrolled(org)).unwrap(),
            Lock::Armed
        );
        rollback_if_open(&mut client);
        assert!(transaction_idle(&mut client));
        let mut other = connect(url);
        assert!(nowait(&mut other, org));

        assert_eq!(
            begin_and_lock(&mut client, &enrolled(org)).unwrap(),
            Lock::Armed
        );
        let cancelled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = CancelGuard {
                client: &mut client,
            };
            panic!("dispatch cancelled before the claim");
        }));
        assert!(cancelled.is_err());
        assert!(transaction_idle(&mut client));
        assert!(nowait(&mut other, org));

        install_host_schema(url);
        let store = appa_eventlog::LogStore::open(appa_eventlog::Backend::Postgres {
            url: format!("{url}?sslmode=disable"),
            max_connections: std::num::NonZeroUsize::new(1).unwrap(),
        })
        .expect("leased postgres");
        {
            let leased = store.lease().expect("lease");
            let pg = leased.postgres().expect("postgres lease");
            let organization_id = org.to_owned();
            let root = group_root(org);
            let session_id = "session".to_owned();
            let held = super::hold(
                pg,
                super::Subject {
                    organization_id: &organization_id,
                    root: &root,
                    session_id: &session_id,
                    fork_of: None,
                    parent_id: None,
                    caller_id: None,
                },
            )
            .expect("armed hold");
            drop(held);
            let idle = pg
                .with_client(|client| Ok(transaction_idle(client)))
                .expect("idle after cancel");
            assert!(idle);
        }
        let leased = store.lease().expect("recheckout");
        let pg = leased.postgres().expect("rechecked postgres");
        let idle = pg
            .with_client(|client| Ok(transaction_idle(client)))
            .expect("idle after pool return");
        assert!(idle, "a cancelled hold must not return an open transaction");
        assert!(nowait(&mut other, org));
    }

    struct CancelGuard<'a> {
        client: &'a mut Client,
    }

    impl Drop for CancelGuard<'_> {
        fn drop(&mut self) {
            rollback_if_open(self.client);
        }
    }

    fn transaction_idle(client: &mut Client) -> bool {
        client
            .query_one("SELECT pg_current_xact_id_if_assigned() IS NULL", &[])
            .map(|row| row.get::<_, bool>(0))
            .unwrap_or(false)
    }

    fn install_host_schema(url: &str) {
        connect(url)
            .batch_execute(
                "CREATE TABLE IF NOT EXISTS openappa_events (
                   root text NOT NULL,
                   seq bigint NOT NULL,
                   payload bytea NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS openappa_policy_files (
                   hash text NOT NULL,
                   bytes bytea NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS openappa_host_keys (
                   key text NOT NULL,
                   root text NOT NULL
                 );
                  CREATE TABLE IF NOT EXISTS openappa_processed_results (
                    organization_id text NOT NULL,
                    session_id text NOT NULL,
                    tool_call_id text NOT NULL,
                    PRIMARY KEY (organization_id, session_id, tool_call_id)
                  );
                  CREATE TABLE IF NOT EXISTS openappa_held_peer_messages (
                    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    id text NOT NULL UNIQUE,
                    receiver text NOT NULL,
                    digest text NOT NULL,
                    label jsonb NOT NULL,
                    body text NOT NULL,
                    expires_at bigint NOT NULL,
                    notified boolean NOT NULL DEFAULT false
                  );
                  CREATE TABLE IF NOT EXISTS openappa_embedded_peer_messages (
                    seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                    id text NOT NULL UNIQUE,
                    root text NOT NULL,
                    sender text NOT NULL,
                    recipient text NOT NULL,
                    pending_spawn text,
                    dispatch text NOT NULL,
                    digest text NOT NULL,
                    label jsonb NOT NULL,
                    body text,
                    status text NOT NULL,
                    read_call_id text,
                    read_arguments text,
                    decision jsonb,
                    expires_at bigint NOT NULL,
                    created_at bigint NOT NULL,
                    UNIQUE (root, sender, dispatch)
                  );",
            )
            .expect("host schema for a leased store");
    }

    fn missing_journal_does_not_error(url: &str) {
        let name = format!("admission_empty_{}", std::process::id());
        let mut admin = connect(url);
        let _ = admin.batch_execute(&format!("DROP DATABASE IF EXISTS {name}"));
        admin
            .batch_execute(&format!("CREATE DATABASE {name}"))
            .expect("empty admission database");
        let mut config: postgres::Config = url.parse().expect("admission url");
        config.dbname(&name);
        let mut empty = config.connect(NoTls).expect("empty database");
        assert_eq!(
            begin_and_lock(&mut empty, &enrolled("org")).unwrap(),
            Lock::Clear
        );
        drop(empty);
        admin
            .batch_execute(&format!("DROP DATABASE {name}"))
            .expect("drop empty admission database");
    }

    fn seed_due_group(url: &str, org: &str, status: &str) {
        let root = group_root(org);
        let group = format!("group-{org}");
        connect(url)
            .execute(
                "INSERT INTO openappa_rewrite_groups \
                 (organization_id, group_id, status, protocol_version, idle_ttl_ms, expires_at, touched_at) \
                 VALUES ($1, $2, $3, 1, 86400000, clock_timestamp() - INTERVAL '1 hour', clock_timestamp())",
                &[&org, &group, &status],
            )
            .unwrap();
        connect(url)
            .execute(
                "INSERT INTO openappa_rewrite_roots (organization_id, native_root, group_id) \
                 VALUES ($1, $2, $3)",
                &[&org, &root, &group],
            )
            .unwrap();
        insert_session(url, org, "session", &root, None, None);
    }

    fn insert_session(
        url: &str,
        org: &str,
        session_id: &str,
        root: &str,
        forked_from: Option<&str>,
        caller_id: Option<&str>,
    ) {
        let actor = session_actor(session_id);
        connect(url)
            .execute(
                "INSERT INTO openappa_sessions \
                 (organization_id, actor, root, session_id, forked_from, caller_id) \
                 VALUES ($1, $2, $3, $4, $5, $6)",
                &[&org, &actor, &root, &session_id, &forked_from, &caller_id],
            )
            .unwrap();
    }

    fn group_root(org: &str) -> String {
        format!("root-{org}")
    }

    fn enrolled(org: &str) -> Owned {
        Owned {
            organization_id: org.to_owned(),
            root: group_root(org),
            session_id: "session".to_owned(),
            fork_of: None,
            parent_id: None,
            caller_id: None,
        }
    }

    fn connect(url: &str) -> Client {
        let mut client = Client::connect(url, NoTls).expect("disposable postgres");
        client
            .batch_execute("SET lock_timeout = '15s'")
            .expect("lock timeout");
        client
    }

    fn nowait(client: &mut Client, org: &str) -> bool {
        client
            .execute(
                "SELECT 1 FROM openappa_rewrite_groups WHERE organization_id = $1 FOR UPDATE NOWAIT",
                &[&org],
            )
            .is_ok()
    }

    fn wait_until_blocked(client: &mut Client, pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let blocked: bool = client
                .query_one(
                    "SELECT EXISTS (\
                       SELECT 1 FROM pg_stat_activity \
                       WHERE pid = $1 AND wait_event_type = 'Lock')",
                    &[&pid],
                )
                .unwrap()
                .get(0);
            if blocked {
                return;
            }
            if Instant::now() >= deadline {
                panic!("admission did not wait on the group lock");
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}
