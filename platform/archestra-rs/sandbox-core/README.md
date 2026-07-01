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

## Tracing & telemetry

Public async functions open `tracing` spans with `skip_all` and attach the
caller's W3C `traceparent` as a remote parent, so these spans nest under the
originating trace instead of starting new roots.

The crate owns its telemetry pipeline rather than borrowing the host's.
`telemetry::init()` — gated by the `telemetry` feature and idempotent — installs
a process-global OTLP exporter for traces and logs under
`service.name=archestra-sandbox-rs`, aimed at the same collector the Node SDK
uses. The N-API binding calls `init()` on every entry point, so the host
forwards a `traceparent` but registers no subscriber for this crate. Call
`flushTelemetry` (`telemetry::flush()`) on graceful shutdown to drain the final
export batch.
