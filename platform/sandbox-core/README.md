# sandbox-core

Pure Rust execution core for sandbox and code-runtime calls. The N-API package
and a future daemon should both treat this crate as the source of truth for
serde DTOs, validation, execution, and typed error codes.

## Tracing

Public async functions create `tracing` spans with `skip_all` and attach a W3C
`traceparent` as the remote parent in the shared `with_dagger` entrypoint. The
host process must install a `tracing-opentelemetry` subscriber before invoking
the core for those spans to export. In the current N-API host this should happen
once during backend observability startup; in a daemon it belongs in the server
bootstrap before routes are registered.
