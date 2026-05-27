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

## Prototype Proofs

Measured locally on May 27, 2026 with warm Docker cache:

- Dagger Rust SDK inside Node on musl: partially answered. The Alpine
  `sandbox-rs-musl-smoke` Docker target builds the N-API addon, loads it from
  Node, runs the typed-error smoke, and runs the panic smoke. Full Dagger engine
  execution still needs a runner-backed CI environment.
- tokio + libuv under sustained load: not answered. The current smoke is
  correctness-oriented, not a sustained parallel load test.
- Rust panic as JS error: answered for direct Rust panics and panics inside the
  shared Dagger callback path. The panic helper is gated behind the
  `test-helpers` feature and is not exported by the production `.d.ts`.
- `.d.ts` no-leak surface: answered. Production exports are five async verbs
  with typed DTOs: `checkDaggerSession`, `checkCodeRuntimeSession`,
  `runSandboxCommand`, `readSandboxArtifact`, and `runCodeRuntime`.
- Docker impact: current final image `720,910,959` bytes versus main baseline
  `727,177,726` bytes. Local warm-cache build elapsed `10m04s` versus baseline
  `5m45s`; the Rust package compile inside the Alpine builder was `1m13s`.
  The builder stage is not shipped; Alpine reported `624.9 MiB in 52 packages`
  after installing `build-base cargo rust`.
