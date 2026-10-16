# sandbox-base: the baked execution base for the Dagger code sandbox.
#
# Mirrors what `sandbox-core/src/backends/dagger.rs` `build_warm_base()` builds at
# run time, so a restricted engine never has to apt/uv over the network. The apt
# set, python deps, venv path, and provenance marker are kept in sync with the
# DEFAULT_* constants there by `check:sandbox-base` in CI. The base image is
# digest-pinned and the python deps come from a committed, hashed
# `requirements.lock` (regenerate with `make update-lockfile` after editing
# pyproject.toml); the apt toolbelt is not version-pinned, so it floats with the
# Debian mirror.
FROM ghcr.io/astral-sh/uv:0.9.17-python3.12-bookworm-slim@sha256:d935373e69f9507199c29006b5eaec59893cbd606f6fb7a185da0c2c83f716e9

# root setup: toolbelt + sandbox dirs + ownership + the pip->uv shim (so the
# model is never tempted to `pip install` into a location the venv won't see).
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      bash coreutils curl git jq ca-certificates build-essential nodejs npm unzip zip \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/sandbox /skills \
 && chown -R 1000:1000 /home/sandbox /skills \
 && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.12 \
 && printf '%s\n' '#!/bin/sh' 'echo "error: pip is disabled in this sandbox. Use \"uv add --project /home/sandbox <pkg>\" instead." >&2' 'exit 1' > /usr/local/bin/pip \
 && chmod +x /usr/local/bin/pip \
 && ln -s pip /usr/local/bin/pip3 \
 && ln -s pip /usr/local/bin/pip3.12

# Provenance marker: a running sandbox can `cat` this to confirm it is on the
# baked base (the runtime-built fallback base does not write this file).
RUN printf 'archestra sandbox base: prebuilt/baked image\n' > /etc/archestra-sandbox-base \
 && chmod 0444 /etc/archestra-sandbox-base

USER 1000:1000
ENV HOME=/home/sandbox \
    VIRTUAL_ENV=/home/sandbox/.venv \
    PATH=/home/sandbox/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /home/sandbox

# user setup: the uv project + venv, with the default deps installed from the
# committed, hashed lockfile — reproducible, no floating resolution at build time.
# The pyproject stays in the image so a runtime `uv add` can extend the project.
COPY --chown=1000:1000 pyproject.toml requirements.lock /home/sandbox/
RUN uv venv --python python3 /home/sandbox/.venv \
 && uv pip sync --require-hashes requirements.lock
