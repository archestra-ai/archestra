# syntax=docker/dockerfile:1
# Bench runner image: the bench binary + fixtures + uv layered on top of the prod platform image, so
# the benchmark runs against the exact deployed code (its built server.mjs, node, drizzle-kit, and the
# baked-in dagger CLI). Build context is the repo root.
ARG PLATFORM_IMAGE
# Pinned static-musl uv image; a named stage is required because COPY --from cannot expand a variable
# inside the image reference.
ARG UV_VERSION=0.5.18@sha256:e2101b9e627153b8fe4e8a1249cc4194f1b38ece7f28a5a9b8f958e3b560e69c

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# Compile the bench binary against musl so it runs unchanged in the alpine-based platform image.
FROM rust:1-alpine@sha256:f87aa870663e2b57ec8c69de82c7eedf7383bee987eef7612c0359635eaadb41 AS bench-builder
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY ai-labs ./ai-labs
RUN cargo build --release --locked \
    --manifest-path ai-labs/Cargo.toml --bin archestra-bench

FROM ${PLATFORM_IMAGE} AS runner
USER root

# uv runs the pytest verifiers in ephemeral environments; python3 is the venv base.
COPY --from=uv /uv /usr/local/bin/uv
# hadolint ignore=DL3018
RUN apk add --no-cache python3
# Bake the reporting deps into a venv so the pod exports TensorBoard + uploads to GCS offline — no
# runtime package resolution at the critical post-run reporting step (a cold/failed fetch there would
# silently lose a whole run's results). PATH-prepended so plain `python3` resolves them.
RUN uv venv /opt/bench-venv \
    && uv pip install --python /opt/bench-venv/bin/python \
       tensorboard==2.20.0 google-cloud-storage==3.12.0
ENV PATH="/opt/bench-venv/bin:${PATH}"

COPY --from=bench-builder /src/ai-labs/target/release/archestra-bench /usr/local/bin/archestra-bench
# Fixtures the harness reads locally via --bench-dir (skills are web-pinned and fetched at runtime, so
# they are not copied). tasks/ carries each task's verifier.py + inputs/ + expected/.
COPY ai-labs/envs /bench/envs
COPY ai-labs/tasks /bench/tasks
COPY ai-labs/lanes.toml /bench/lanes.toml
# Post-run reporting (TensorBoard export + GCS upload + Slack) runs in-pod with the baked venv python3.
COPY ai-labs/scripts /bench/scripts
COPY .github/bench/runner-entrypoint.sh /usr/local/bin/run-benchmark
RUN chmod +x /usr/local/bin/run-benchmark

# Image-layout facts the bench needs to drive the prod image: drizzle-kit replaces the dev pnpm
# migrate, and the dagger CLI is the one baked into the platform image. The dagger runner host and
# feature flags are run-specific and arrive as Job container env vars.
ENV ARCHESTRA_BENCH_MIGRATE_CMD="cd backend && ./node_modules/.bin/drizzle-kit migrate"
ENV ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN=/usr/local/bin/dagger
