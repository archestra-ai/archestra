//! baton-approver-demo: the human-in-the-loop approval demo for baton-proxy.
//!
//! PARKED — does not build against the current value-granular baton-core. The
//! shared [`approval`] type is written against `baton_core::Grant`, which the
//! #6525 rewrite removed, and the end-to-end flow needs the *approval-rewriting*
//! proxy behavior (a blocked call becoming a `baton__request_approval` call)
//! that `baton-proxy` no longer has — it now blocks fail-closed. This crate is
//! the preserved home for that flow; it returns once the approval path is
//! ported to External authorities (`PendingApproval` + `apply_approval`). Until
//! then the binaries here will not compile. See `README.md`.

pub mod approval;

pub use approval::{ApprovalRecord, Verdict};
