---
name: archestra-dev-rust-napi
description: Use when editing Rust in this repo — the NAPI crates under platform/archestra-rs (Node bindings, generated TypeScript bindings, telemetry, validation/errors) or the standalone ai-labs Rust workspace (core/runner/cli/analyzer) — including Rust build/test checks.
---

# Archestra Rust Coding Style

This covers all Rust in the repo:

- `platform/archestra-rs/*` — embedded in Node via NAPI.
- `ai-labs/*` — a standalone pure-Rust workspace (core/runner/cli/analyzer), no NAPI.

The library-quality rules below apply everywhere. Rules tagged **(NAPI only)** apply only to Rust embedded via NAPI.

Write Rust as a reusable library first. For NAPI crates the binding is a thin adapter around a Node-free core — deleting or replacing the NAPI layer should not delete or rewrite the product logic. The bench crates are already standalone Rust, so the same core-quality bar applies to them directly.

## Default posture: boring Rust

Rust is a normal product language here, not a type-system puzzle. The first correct version should be boring and explicit.

Prefer plain functions, concrete structs, enums for closed states, newtypes for domain identifiers, `Option<T>`/`Result<T, E>`, owned data at public boundaries and borrowed data inside small internal functions, and small modules named after domain concepts.

Avoid by default: custom macros, actor frameworks, hidden global registries, smart-pointer graphs, runtime type erasure, and clever lifetime-heavy public APIs. (See Abstractions for trait-object and generics rules.)

Do not make Rust code look like Java, TypeScript DI, or Haskell cosplay.

## Architecture

Applies to all Rust:

- Minimize the public API surface. Prefer a few coarse operations over many tiny exported helpers.
- Keep observability in the core as `tracing` spans and events only.
- OTLP/exporter wiring belongs in a single feature-gated module, never scattered through the logic.
- Propagate trace context, such as W3C `traceparent`, explicitly across detached tasks and actor boundaries. It does not flow implicitly.

**(NAPI only)** boundary rules:

- Keep core Rust logic independent from Node, JavaScript, and NAPI. No `#[napi]`, `napi::Result`, JS types, or Node-specific assumptions in core modules.
- NAPI functions should only receive JS input, validate and convert it into Rust domain types, call the Rust core, and convert the result or error back to JS.
- Do not expose internal implementation details through the NAPI API.
- Generated TypeScript definitions are part of the public API and should stay clean, stable, and intentional.

## Types and data modeling

- Prefer structs, enums, and newtypes over primitive-heavy signatures, tuples, raw strings, boolean flags, and long positional argument lists.
- Use enums for closed sets of states or modes.
- Make invalid states unrepresentable where practical.
- Treat all external input as untrusted (JS input at the NAPI boundary; argv, files, and network/process output in the bench).
- Validate untrusted input at the public entry points and convert it immediately into Rust-native types, not deep in the call graph.
- Data validated when first accepted, such as persisted or replayed history, is trusted on reuse. Document that trust boundary wherever it is not obvious.
- Keep boundary-facing DTOs separate from richer internal domain types when that improves clarity.

## Ownership defaults

Start with values, references, and clear ownership.

- Public domain structs should usually own their data.
- Avoid public structs with lifetime parameters unless there is a clear performance or API reason.
- Cloning small strings, IDs, config values, and DTO fields is acceptable when it keeps ownership simple.
- Do not clone large buffers, request bodies, process output, or hot-path data without a reason.
- Do not use `Box<T>` unless the type is recursive, very large, or must be behind a stable pointer.
- Do not use `Rc<T>` or `RefCell<T>` in product logic unless modeling a local graph/tree where ownership is inherently shared.
- Do not use `Arc<T>` unless data must cross task or thread boundaries.
- Do not use `Arc<Mutex<T>>` as a default escape hatch. If used, document what is shared, who locks it, and why message passing or single ownership is worse.
- Never hold a lock across `.await`.
- Do not use `Pin`, self-referential structs, or unsafe lifetime tricks unless explicitly requested and reviewed.
- Do not add indirection to avoid understanding ownership. Fix the ownership model instead.

## Control flow and style

- Prefer `match` for enums, variants, and meaningful branching.
- Prefer early returns for validation and error paths.
- Avoid deeply nested control flow.
- Prefer functional style where it reads better, but do not force iterator chains when a simple loop is clearer.

## Abstractions

Abstractions must pay rent immediately.

- Do not introduce a trait unless there are at least two real implementations today, or it represents a real boundary such as storage, process execution, clock/time, network I/O, or NAPI adapter isolation.
- Do not create `FooService`, `FooManager`, `FooProvider`, or `FooFactory` traits just to make testing easier. Prefer passing concrete input data, small pure functions, or explicit test fixtures.
- Avoid `dyn Trait`. Use concrete types first, an enum when the set of implementations is closed, and generics only when the caller truly needs static polymorphism. `dyn Trait` requires a written justification in the PR summary: why runtime polymorphism is needed, what the concrete implementations are, and why an enum or concrete type is worse.
- Avoid `async_trait` unless integrating with an existing async trait API. Prefer concrete async functions.
- Do not add generic type parameters unless there are multiple real call sites with different concrete types, or the generic is a standard Rust convenience such as accepting a path-like input.
- Keep modules small and named around domain concepts, not patterns.

## Macros and code generation

Macros are not a product architecture tool.

- Do not introduce custom `macro_rules!` macros for normal product logic, and do not introduce proc macros.
- Existing framework derives already used by the crate, such as NAPI/serde-style derives, are fine.
- Do not hide validation, I/O, error mapping, authorization, tracing, or control flow behind macros.
- Generated TypeScript bindings are public API. Keep generated names boring and stable.

## Errors and safety

- Use `Result<T, E>` consistently in library code.
- Prefer domain-specific error enums over generic strings.
- Preserve useful error context.
- Avoid `unwrap`, `expect`, and `panic!` in library code. Pragmatic `unwrap`/`expect` is acceptable only in CLI entrypoints, build scripts, and tests.
- `expect` is acceptable on provably-infallible static initializers (e.g. `LazyLock<Regex>` over a literal pattern), where the message documents the invariant. This carve-out applies everywhere, including NAPI-reachable code.
- No `unsafe` unless isolated, documented, and clearly justified.
- **(NAPI only)** No `unwrap`, `expect`, or `panic!` in code reachable from the NAPI boundary, except the static-initializer carve-out above. Convert Rust errors into JS/NAPI errors only at the boundary. Assume dependencies can still panic despite that rule: wrap every future that enters the core from the NAPI boundary in `catch_unwind` and convert the payload into a domain error. The host process must never abort on a Rust panic.

## Rust footprint discipline

Do not expand the Rust footprint opportunistically. Reach for Rust when the task has at least one of:

- A crisp input/output boundary.
- Security, validation, sandboxing, parsing, or escaping logic.
- Performance-sensitive code.
- Logic that benefits from explicit domain states.
- Code that should be reusable outside Node later.

**(NAPI only):**

- Do not move TypeScript code to Rust just because Rust is available.
- Do not add a new NAPI export for every helper function.
- A Rust change should leave the TypeScript-facing API smaller or equally simple.

## Cleanliness

- Zero dead code: no commented-out code, unused exports, unused dependencies, or placeholder modules for later.
- Keep dependencies minimal and justified; avoid crates for trivial functionality.

## Tests and checks

- Test core logic directly in Rust. Add tests for validation, parsing, edge cases, and error handling.
- Use JS/NAPI integration tests only for actual boundary behavior.
- Keep every `cfg` or feature gate as narrow as its actual use. Code compiled only because a gate is wider than its callers is dead code and will trip `-D warnings`.
- **(NAPI only)** Run checks under the default feature set and the binding's feature set, such as `napi` and `telemetry`, not only `--all-features`.
- `platform/archestra-rs` and `ai-labs` are separate workspaces. Run the checks below in each workspace you touched.
- Always run `cargo check` after finishing Rust work.
- Required before merge: `cargo fmt`, `cargo check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test`.

## Design target

For NAPI crates the desired shape is:

```text
JS/Node -> thin NAPI adapter -> reusable Rust core
```

Not:

```text
JS-flavored business logic written in Rust
```

The bench is the same idea without the adapter: keep `core`/`analyzer` reusable, and let `cli`/`runner` stay thin.
