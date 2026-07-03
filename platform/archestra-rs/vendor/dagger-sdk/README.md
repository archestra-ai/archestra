# Vendored dagger-sdk 0.21.7

This is the published [dagger-sdk 0.21.7](https://crates.io/crates/dagger-sdk/0.21.7)
crate (Apache-2.0, see `LICENSE`), vendored to fix a security advisory that
upstream has patched on `main` but not yet released.

## Why

Every released dagger-sdk (`<= 0.21.7`) depends on `reqwest 0.11 -> rustls
0.21 -> rustls-webpki 0.101`, and the 0.101 line has no patched release for
[GHSA-82j2-j2ch-gfr8](https://github.com/advisories/GHSA-82j2-j2ch-gfr8)
(RUSTSEC-2026-0104, CRL BIT STRING panic). Upstream bumped the SDK to
`reqwest 0.12` / `rustls 0.23` right after cutting v0.21.7
([dagger/dagger#13495](https://github.com/dagger/dagger/pull/13495)), but that
commit sits on `main` alongside regenerated 1.0-beta engine bindings that drop
APIs we use (e.g. `load_container_from_id`) and no release carries it yet.

A cargo `git` patch against `dagger/dagger` would pull those dev-schema
bindings (and clone the ~230 MB monorepo on every cold build), so instead this
directory holds the released 0.21.7 source with only the manifest-level
dependency bumps from #13495 applied. `src/` is byte-for-byte the published
crate; the only edits are in `Cargo.toml` (documented in its header comment).
The crate is wired in via `[patch.crates-io]` in the workspace `Cargo.toml`.

## When to delete

Delete this directory, the `[patch.crates-io]` entry, and the
`workspace.exclude` entry in `../../Cargo.toml` once a dagger-sdk release
ships with `reqwest >= 0.12` (check the
[release notes](https://github.com/dagger/dagger/releases)), then point
`sandbox-core/Cargo.toml` at that release. Keep the SDK version aligned with
the pinned Dagger engine version
(`backend/src/k8s/dagger-environment-runtime/manager.ts` and
`helm/dagger-runtime/Chart.yaml`).
