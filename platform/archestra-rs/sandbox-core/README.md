# sandbox-core

Pure-Rust execution core for the skill sandbox and code runtime. It owns the
serde DTOs, input validation, Dagger-backed execution, and typed error codes.
The crate has no host bindings of its own — the N-API package
[`sandbox-rs`](../sandbox-rs) wraps it for Node, and any future daemon should
treat this crate as the single source of truth.

## Layout

- `sandbox-core` (this crate) — runtime logic, exposed as a normal Rust library.
- [`sandbox-rs`](../sandbox-rs) — `napi-rs` addon that re-exports the core to the
  TypeScript backend as `@archestra/sandbox-rs`. Enable the `napi` feature here
  to compile the `#[napi]`-annotated surface.

## Build & test

```bash
cargo check --workspace --locked        # type-check both crates
cargo test --workspace --locked         # unit tests
cargo fmt --all                         # format
```

The Dagger CLI must be on `PATH` (or pointed to via
`_EXPERIMENTAL_DAGGER_CLI_BIN`) for execution paths to open an engine session.
Keep `dagger-sdk` in `Cargo.toml` in sync with `DAGGER_VERSION` in the platform
`Dockerfile` and the managed Dagger Helm charts;
`scripts/check-dagger-version-sync.sh` enforces this in CI.

## Tracing

Public async functions open `tracing` spans with `skip_all` and attach the
incoming W3C `traceparent` as a remote parent in the shared `with_dagger`
entrypoint. The host process must install a `tracing-opentelemetry` subscriber
before calling the core — in the N-API host this happens once during backend
observability startup, and in a daemon it belongs in server bootstrap before
routes are registered.
