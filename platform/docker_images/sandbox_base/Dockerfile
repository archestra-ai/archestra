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
# TODO: move to python 3.15 (lazy imports) once ML wheels such as torch and
# onnxruntime ship cp315 on PyPI.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node-runtime

FROM ghcr.io/astral-sh/uv:0.13.8-python3.14-trixie-slim@sha256:81a1340fea1e72ad4a8e9a016128b0c61041cf182ea49fd788023e52842bc147

# root setup: toolbelt + sandbox dirs + ownership + the pip->uv shim (so the
# model is never tempted to `pip install` into a location the venv won't see).
# libbrotli1 is listed so apt upgrades the copy the base image ships: Debian's
# nodejs and curl decode Brotli through it. The floor fails the build if the
# CVE-2026-111497 fix is missing. zlib1g is listed for the same reason: the base
# ships it, and the floor fails the build without the CVE-2026-85091 and
# CVE-2026-76844 fix.
# Upgrade inherited apt packages too; CVE-2026-109518 is fixed in 3.0.4.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      apt libapt-pkg7.0 bash coreutils curl git jq ca-certificates build-essential nodejs npm libbrotli1 zlib1g unzip zip \
 && for package in apt libapt-pkg7.0; do \
      dpkg --compare-versions "$(dpkg-query -W -f='${Version}' "$package")" ge 3.0.4 || exit 1; \
    done \
 && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libbrotli1)" ge 1.1.0-2+deb13u1 \
 && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' zlib1g)" ge 1:1.3.dfsg+really1.3.1-1+deb13u1 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /home/sandbox /skills \
 && chown -R 1000:1000 /home/sandbox /skills \
 && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.14 \
 && printf '%s\n' '#!/bin/sh' 'echo "error: pip is disabled in this sandbox. Use \"uv add --project /home/sandbox <pkg>\" instead." >&2' 'exit 1' > /usr/local/bin/pip \
 && chmod +x /usr/local/bin/pip \
 && ln -s pip /usr/local/bin/pip3 \
 && ln -s pip /usr/local/bin/pip3.14 \
 && python3 -c "import compileall, sysconfig; compileall.compile_dir(sysconfig.get_path('stdlib'), quiet=2, workers=4)"

# Debian's Node/npm packages retain a separate, vulnerable JavaScript dependency
# tree even after npm itself is upgraded. Replace that distribution completely,
# preserving Node/npm with the upstream runtime and a mature, bundled npm.
# pip is deliberately disabled above: remove its unused vendored libraries and
# ensurepip wheel too, while keeping uv as the project's package installer.
RUN apt-get purge -y --auto-remove nodejs npm \
 && rm -rf /usr/local/lib/python3.14/site-packages/pip \
      /usr/local/lib/python3.14/site-packages/pip-*.dist-info \
      /usr/local/lib/python3.14/ensurepip

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node

# These archives are unpacked without executing package lifecycle scripts.
# npm 11.21.1 includes the fixed tar/brace-expansion/pacote dependencies, but
# its separately vendored Undici still needs the CVE-2026-109869 repair.
RUN curl -fsSL https://registry.npmjs.org/npm/-/npm-11.21.1.tgz -o /tmp/npm.tgz \
 && echo 'dd77c48eb845f4856c2cdba347cfb52bd877a2655a1ea48ff0c4796e3df9dd7b  /tmp/npm.tgz' | sha256sum -c - \
 && mkdir -p /usr/local/lib/node_modules/npm \
 && tar -xzf /tmp/npm.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm \
 && curl -fsSL https://registry.npmjs.org/undici/-/undici-6.29.1.tgz -o /tmp/undici.tgz \
 && echo '29c4b8e0b2d86cb8795571c1959012ce057a14ecfd34858335f47c31e770a04f  /tmp/undici.tgz' | sha256sum -c - \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
 && mkdir -p /usr/local/lib/node_modules/npm/node_modules/undici \
 && tar -xzf /tmp/undici.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/undici \
 && ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && rm /tmp/npm.tgz /tmp/undici.tgz \
 && node --version && npm --version

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
 && uv pip sync --require-hashes --compile-bytecode requirements.lock

# Exercise the actual image toolchain without external network access.
RUN --network=none \
    --mount=type=bind,source=tests,target=/tmp/sandbox-base-tests \
    python3 /tmp/sandbox-base-tests/runtime.py
