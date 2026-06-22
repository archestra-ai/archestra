---
name: archestra-dev-rust-napi
description: Use when editing Rust core code, NAPI bindings, generated TypeScript bindings, Rust telemetry, Rust validation/errors, or Rust build/test checks.
---

# Archestra Rust / NAPI Coding Style

Write Rust as a reusable library first. NAPI should be a thin adapter around the Rust core, not the place where product logic lives. The Rust part should be easy to move later into a companion app, CLI, daemon, desktop process, or IPC service.

## Architecture

- Keep core Rust logic independent from Node, JavaScript, and NAPI.
- No `#[napi]`, `napi::Result`, JS types, or Node-specific assumptions in core Rust modules.
- NAPI functions should only receive JS input, validate and convert it into Rust domain types, call the Rust core, and convert the result or error back to JS.
- Minimize the JS-to-Rust API surface. Prefer a few coarse operations over many tiny exported helpers.
- Do not expose internal implementation details through the NAPI API.
- Generated TypeScript definitions are part of the public API and should stay clean, stable, and intentional.
- Keep observability in the core as `tracing` spans and events only.
- OTLP/exporter wiring belongs in a single feature-gated module, never scattered through the logic.
- Propagate trace context, such as W3C `traceparent`, explicitly across detached tasks and actor boundaries. It does not flow implicitly.

## Types and data modeling

- Prefer structs, enums, and newtypes over primitive-heavy signatures, tuples, raw strings, and boolean flags.
- Use enums for closed sets of states or modes.
- Use named structs for meaningful data instead of passing many positional arguments.
- Make invalid states unrepresentable where practical.
- Treat all JS input as untrusted.
- Validate JS input at the boundary and convert it immediately into Rust-native types.
- Validate untrusted input at the public core entry points, not deep in the call graph.
- Data validated when first accepted, such as persisted or replayed history, is trusted on reuse. Document that trust boundary wherever it is not obvious.
- Keep NAPI-facing DTOs separate from richer internal domain types when that improves clarity.

## Control flow and style

- Prefer `match` for enums, variants, and meaningful branching.
- Use `if` for simple boolean checks.
- Prefer early returns for validation and error paths.
- Avoid deeply nested control flow.
- Prefer functional style where it improves readability.
- Do not force iterator chains when a simple loop is clearer.
- Prefer clear, boring, explicit code over clever abstractions.

## Errors and safety

- Use `Result<T, E>` consistently in core Rust.
- Prefer domain-specific error enums over generic strings.
- Convert Rust errors into JS/NAPI errors only at the boundary.
- Preserve useful error context.
- No `unwrap`, `expect`, or `panic!` in code reachable from the NAPI boundary.
- Assume dependencies can still panic despite that rule.
- Wrap every future that enters the core from the NAPI boundary in `catch_unwind` and convert the payload into a domain error.
- The host process must never abort on a Rust panic.
- No `unsafe` unless isolated, documented, and clearly justified.

## Abstractions

- Avoid speculative abstractions.
- Avoid `dyn Trait` unless runtime polymorphism is clearly needed.
- Prefer concrete types, enums, generics, or plain functions before trait objects.
- Keep modules small and named around domain concepts, not patterns.
- Do not add indirection unless it makes testing, ownership, or API boundaries meaningfully better.

## Cleanliness

- Zero dead code policy.
- No commented-out code.
- No unused exports.
- No unused dependencies.
- No placeholder modules for later.
- Keep dependencies minimal and justified.
- Avoid adding crates for trivial functionality.

## Tests and checks

- Test Rust core logic directly, not only through Node.
- Add tests for validation, parsing, edge cases, and error handling.
- Use JS/NAPI integration tests only for actual boundary behavior.
- Keep every `cfg` or feature gate as narrow as its actual use.
- Code compiled only because a gate is wider than its callers is dead code and will trip `-D warnings`.
- Run checks under the default feature set and the binding's feature set, such as `napi` and `telemetry`, not only `--all-features`.
- Always run `cargo check` after finishing Rust work.
- Required before merge: `cargo fmt`, `cargo check`, `cargo clippy -- -D warnings`, and `cargo test`.

## Design target

The desired shape is:

```text
JS/Node -> thin NAPI adapter -> reusable Rust core
```

Not:

```text
JS-flavored business logic written in Rust
```

Deleting or replacing the NAPI layer should not delete or rewrite the product logic.
