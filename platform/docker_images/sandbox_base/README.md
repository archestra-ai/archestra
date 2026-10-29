# sandbox-base

The baked execution base for the Dagger code sandbox. It pre-builds exactly what
`build_warm_base()` (in `archestra-rs/sandbox-core/src/backends/dagger.rs`)
otherwise constructs at run time — the apt toolbelt, the `pip`→`uv` shim, the uv
project, and the venv with the default deps.

Point `ARCHESTRA_DAGGER_RUNTIME_IMAGE` at a published build of this image and set
`ARCHESTRA_CODE_RUNTIME_BASE_PREBUILT=true`; the runtime then skips the apt/uv
build steps, so a restricted Dagger engine needs no ghcr.io / debian / pypi
egress — only the registry hosting this image.

## Keeping it in sync

The apt set, python deps, venv path, and provenance marker MUST match the
`DEFAULT_*` constants in `dagger.rs`. CI enforces this via `check:sandbox-base`;
if it fails, reconcile this directory with those constants.

## Updating python deps

Edit `pyproject.toml`, then regenerate the hashed lockfile (requires `uv`):

```
make update-lockfile
```

The base image is digest-pinned in the `Dockerfile`; bump the digest deliberately
when moving the uv/python base.
