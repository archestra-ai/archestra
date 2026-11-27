# Curated Agent catalog images. The build context is platform/ so every native
# CLI shares one hardened execution base.
FROM dhi.io/uv:0.13.9@sha256:923818bf3ed45deb3030c1fa0b2a46b354c812560185c51a94c57ff3f7bf10c1 AS uv
# The uv release Hermes locks its environment with.
FROM dhi.io/uv:0.12.3@sha256:6eb8ea7c3ff90b389a4d1e3c41ee66d8daa204fc6609df65b0ef21e3ba29dd57 AS uv-hermes

# One Rust toolchain both builds the review engine and ships in the runtime, so
# projects with native code (Archestra's addons included) compile in place.
FROM rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97 AS rust

# Build the review engine once for each native architecture. Skills supply the
# review procedure and configuration; the runtime needs only this executable.
FROM rust AS nitpicker-build
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/* \
 && cargo install --git https://github.com/arsenyinfo/nitpicker.git \
      --rev 3530f2e0a2c2678f892f43b938a4f2516d94e8b9 \
      nitpicker --locked --features otel

# Upstream gh 2.103.2 and 2.103.3 embed x/net 0.60.0 (CVE-2026-78661).
# Rebuild the existing CLI release with the fixed module until upstream ships it.
# Docker's hardened Go image has no curl or gzip: BuildKit fetches and checks the
# source, and apt adds gzip to unpack it.
FROM dhi.io/golang:1.27.4-debian13-dev@sha256:121afb8b390b1d6babba8cd0a93eaf2ffa3735f835d388b9d79c2be38b41ee4f AS gh-build
WORKDIR /src
ADD --checksum=sha256:0eda9a553f1e191d7d63214dd1373f184a8f922b221387af510e63252c1d5419 \
    https://codeload.github.com/cli/cli/tar.gz/4f2cfe92e3499f8581bf39db77e0a1431fa7b55c \
    /tmp/gh-source.tar.gz
RUN apt-get update \
 && apt-get install -y --no-install-recommends gzip \
 && rm -rf /var/lib/apt/lists/* \
 && tar -xzf /tmp/gh-source.tar.gz --strip-components=1 \
 && rm /tmp/gh-source.tar.gz \
 && go get golang.org/x/net@v0.63.0 \
 && go mod verify \
 && CGO_ENABLED=0 go build -trimpath \
      -ldflags='-s -w -X github.com/cli/cli/v2/internal/build.Version=2.103.2 -X github.com/cli/cli/v2/internal/build.Date=2026-10-23' \
      -o /out/gh ./cmd/gh \
 && go version -m /out/gh \
 && /out/gh --version \
 && /out/gh api --help >/dev/null \
 && /out/gh auth git-credential --help >/dev/null

FROM dhi.io/node:24.22.3-debian13-dev@sha256:50fc8dd8255049096c6e23aada41ef8e7ffc0e1a7ba067a8c2300389e8e5c527 AS agent-base
ARG TARGETARCH
# DHI's apt mirror can serve a stale archive after its signed index changes.
# Request fresh packages while retaining apt's index and archive verification.
RUN printf '%s\n' 'Acquire::http::No-Cache "true";' > /etc/apt/apt.conf.d/99dhi-no-cache \
 && mkdir -p /usr/local/bin && ln -s /usr/bin/node /usr/local/bin/node

# Require fixed apt, OpenSSL and Cyrus SASL packages and refresh cached apt layers.
# CVE-2026-109518 (apt), CVE-2026-84782 (OpenSSL), CVE-2026-107161 (Cyrus SASL).
# Keep already-installed hardened packages; libssl-dev still pulls in its
# matching fixed OpenSSL libraries, and the version checks below enforce them.
RUN apt-get update -qq \
 && apt-get install -y --no-upgrade --no-install-recommends \
      apt libapt-pkg7.0 build-essential ca-certificates curl ffmpeg fonts-dejavu-core git jq less \
      libsasl2-2 libsasl2-modules-db libssl-dev libssl3t64 \
      openssh-client openssl pkg-config procps python3 python3-venv ripgrep tmux ncurses-term gzip hostname bsdutils \
 && for package in apt libapt-pkg7.0; do \
      dpkg --compare-versions "$(dpkg-query -W -f='${Version}' "$package")" ge '3.0.4' || exit 1; \
    done \
 && for package in openssl libssl3t64 libssl-dev; do \
      dpkg --compare-versions "$(dpkg-query -W -f='${Version}' "$package")" ge '3.5.9-1~deb13u1' || exit 1; \
    done \
 && for package in libsasl2-2 libsasl2-modules-db; do \
      dpkg --compare-versions "$(dpkg-query -W -f='${Version}' "$package")" ge '2.1.28+dfsg1-9' || exit 1; \
    done \
 && rm -rf /var/lib/apt/lists/*

# A local PostgreSQL with pgvector for projects that need a database. Debian's
# own postgresql-common enables the PGDG repository: Debian's pgvector
# predates HNSW indexes. No cluster ships; the agent runs initdb under HOME,
# and the shared socket directory lets local clients connect without flags.
# The DHI mirror has served postgresql-common archives that do not match its
# signed index, and its PostgreSQL builds collide with Debian's helpers. Resolve
# every PostgreSQL package from the signed Debian and PGDG repositories.
RUN printf '%s\n' \
      'Package: postgresql* libpq*' \
      'Pin: origin "dhi.io"' \
      'Pin-Priority: -1' > /etc/apt/preferences.d/postgresql-common \
 && apt-get update -qq \
 && apt-get install -y --no-install-recommends postgresql-common \
 && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
 && sed -i 's/^#*\s*create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf \
 && apt-get install -y --no-install-recommends postgresql-18 postgresql-18-pgvector \
 && chmod 1777 /var/run/postgresql \
 && rm -rf /var/lib/apt/lists/*

# The toolchain stays read-only; downloaded crates and `cargo install` go to
# the persistent HOME, as do `uv tool` and `pip --user` commands.
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/home/node/.cargo
ENV PATH=/home/node/.local/bin:/home/node/.cargo/bin:/usr/local/cargo/bin:/usr/lib/postgresql/18/bin:$PATH

# Keep the real CLI at /usr/bin/gh: /usr/local/bin/gh is the managed credential
# reader, including when Git invokes its credential helper. Debian's old CLI
# queries retired Projects fields during PR edits.
COPY --from=gh-build /out/gh /usr/bin/gh

COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=nitpicker-build /usr/local/cargo/bin/nitpicker /usr/local/bin/nitpicker

# Keep the venv bootstrap wheel and system pip on fixed, checksum-verified
# versions. Debian 13 no longer seeds setuptools into newly created venvs.
RUN find /usr/share/python-wheels -maxdepth 1 -name 'setuptools-*.whl' -delete \
 && curl -fsSL --retry 3 --retry-all-errors \
      "https://files.pythonhosted.org/packages/95/9c/c510029fc6ef33a6275cd2c5d3cecd6613dfd6aa401d57c54f1c18852ccf/setuptools-84.0.0-py3-none-any.whl" \
      -o /usr/share/python-wheels/setuptools-84.0.0-py3-none-any.whl \
 && echo "51a52592b3b99e102b609654876bd65f19f999935166d1352678931132b0c670  /usr/share/python-wheels/setuptools-84.0.0-py3-none-any.whl" | sha256sum -c - \
 && curl -fsSL --retry 3 --retry-all-errors \
      "https://files.pythonhosted.org/packages/44/3c/d717024885424591d5376220b5e836c2d5293ce2011523c9de23ff7bf068/pip-25.3-py3-none-any.whl" \
      -o /tmp/pip-25.3-py3-none-any.whl \
 && echo "9655943313a94722b7774661c21049070f6bbb0a1516bf02f7c8d5d9201514cd  /tmp/pip-25.3-py3-none-any.whl" | sha256sum -c - \
 && mkdir -p /usr/local/lib/python3.13/dist-packages \
 && python3 -m zipfile -e /tmp/pip-25.3-py3-none-any.whl /usr/local/lib/python3.13/dist-packages \
 && rm /tmp/pip-25.3-py3-none-any.whl \
 && printf '%s\n' '#!/bin/sh' 'exec python3 -m pip "$@"' > /usr/local/bin/pip \
 && chmod 0755 /usr/local/bin/pip \
 && ln -s pip /usr/local/bin/pip3 \
 && python3 -m venv /tmp/agent-python-check \
 && /tmp/agent-python-check/bin/python -m pip install --no-index --find-links=/usr/share/python-wheels setuptools==84.0.0 \
 && /tmp/agent-python-check/bin/python -c "import setuptools; assert setuptools.__version__ == '84.0.0'" \
 && rm -rf /tmp/agent-python-check

# Tool environments and browsers stay outside HOME so a workspace mount cannot
# hide them. Skills are loaded at run time; no workflow or credentials ship here.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY docker_images/agent/requirements.lock /opt/agent-tools-requirements.lock
# The Playwright wheel bundles its own Node build for its driver, and that
# build falls behind Node's security releases (1.64.0 ships 24.21.0). The
# driver runs on the image's Node instead, which follows the base image.
RUN uv venv --python /usr/bin/python3 /opt/agent-tools \
 && uv pip sync --python /opt/agent-tools/bin/python --require-hashes /opt/agent-tools-requirements.lock \
 && playwright_node="$(/opt/agent-tools/bin/python -c 'import pathlib, playwright; print(pathlib.Path(playwright.__file__).parent / "driver" / "node")')" \
 && test -f "$playwright_node" \
 && rm "$playwright_node" \
 && ln -s /usr/local/bin/node "$playwright_node" \
 && ln -s /opt/agent-tools/bin/shot-scraper /usr/local/bin/shot-scraper \
 && ln -s /opt/agent-tools/bin/playwright /usr/local/bin/playwright \
 && playwright install --with-deps chromium \
 && chmod -R a+rX /opt/agent-tools /opt/playwright \
 && rm -rf /var/lib/apt/lists/* /root/.cache

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME/bin:$PNPM_HOME:$PATH
# pnpm runs through corepack, so a repository that pins pnpm
# (`packageManager`) gets that version in one Node process. A global pnpm of
# another version starts the pinned one as a second process: about 0.11 GiB
# of anonymous memory more per pnpm call, measured in an Agent Runtime, and a
# check chain nests several. Repositories without a pin get 11.28.7.
# COREPACK_HOME is shared and writable by the agent's user: a pinned version
# is downloaded, signature-checked, on first use. Corepack never writes a pin
# into a repository's package.json, and a newer version some repository pins
# never becomes the default for the others.
ENV COREPACK_HOME=/usr/local/share/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_ENABLE_AUTO_PIN=0 \
    COREPACK_DEFAULT_TO_LATEST=0
RUN corepack disable \
 && rm -rf /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/npm \
 && curl -fsSL https://registry.npmjs.org/npm/-/npm-11.21.1.tgz -o /tmp/npm.tgz \
 && echo 'dd77c48eb845f4856c2cdba347cfb52bd877a2655a1ea48ff0c4796e3df9dd7b  /tmp/npm.tgz' | sha256sum -c - \
 && mkdir -p /usr/local/lib/node_modules/npm \
 && tar -xzf /tmp/npm.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm \
 && curl -fsSL https://registry.npmjs.org/undici/-/undici-6.29.1.tgz -o /tmp/undici.tgz \
 && echo '29c4b8e0b2d86cb8795571c1959012ce057a14ecfd34858335f47c31e770a04f  /tmp/undici.tgz' | sha256sum -c - \
 && rm -rf /usr/local/lib/node_modules/npm/node_modules/undici \
 && mkdir -p /usr/local/lib/node_modules/npm/node_modules/undici \
 && tar -xzf /tmp/undici.tgz --strip-components=1 -C /usr/local/lib/node_modules/npm/node_modules/undici \
 && ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && curl -fsSL https://registry.npmjs.org/corepack/-/corepack-0.36.0.tgz -o /tmp/corepack.tgz \
 && echo '9128cfe26aee0c99f4fc68c15c6b8b12309a68be0de2c012cdfea2a463cb722f  /tmp/corepack.tgz' | sha256sum -c - \
 && mkdir -p /usr/local/lib/node_modules/corepack \
 && tar -xzf /tmp/corepack.tgz --strip-components=1 -C /usr/local/lib/node_modules/corepack \
 && ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && rm /tmp/npm.tgz /tmp/undici.tgz /tmp/corepack.tgz \
 && corepack enable --install-directory /usr/local/bin pnpm \
 && corepack install --global pnpm@11.28.7 \
 && chown -R 1000:1000 "$COREPACK_HOME" \
 && node --version && npm --version && corepack --version && pnpm --version

COPY docker_images/agent/bin /usr/local/bin
# The maintained launchers append this description of the machine to the
# Agent's instructions, so a run knows where to work and what is installed.
COPY docker_images/agent/environment.md /etc/archestra/agent-environment.md
# The backend sends this program to the workspace inline, so the image needs no
# copy to serve file transfers. One is installed anyway: it keeps the image's
# own test honest and gives anyone debugging inside a pod the same tool.
COPY backend/src/static/workspace-files.py /usr/local/bin/archestra-workspace-files
RUN chmod 0755 /usr/local/bin/archestra-*
# The agent client's shell commands take the highest OOM score through the
# BASH_ENV its launcher sets (archestra-command-oom-score.sh). Bash skips
# BASH_ENV in two cases and reads this file instead: an interactive shell, and
# a command line whose input is a socket while SHLVL is below 1, which is how
# Claude Code and Kimi Code start their shell commands. Only a shell whose
# BASH_ENV is that file runs it, so other shells in the pod are unaffected.
RUN { printf '%s\n' \
        '# Agent Runtime: a shell the agent client started takes the highest OOM score.' \
        'case "${BASH_ENV:-}" in */archestra-command-oom-score.sh) . "${BASH_ENV}" ;; esac' \
        ''; \
      cat /etc/bash.bashrc; \
    } > /tmp/bash.bashrc \
 && mv /tmp/bash.bashrc /etc/bash.bashrc

ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
ENV HOME=/home/node
RUN usermod -s /bin/bash node \
 && mkdir -p /home/node/workspace /var/run/archestra \
 && chown -R 1000:1000 /home/node /var/run/archestra
USER 1000:1000
WORKDIR /home/node/workspace

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/workspace-files.py \
 && python3 /tmp/agent-image-tests/interactive-resume.py \
 && python3 /tmp/agent-image-tests/tui-exec.py \
 && python3 /tmp/agent-image-tests/development-tools.py \
 && python3 /tmp/agent-image-tests/memory-warden.py \
 && node /tmp/agent-image-tests/npm-http.cjs

FROM agent-base AS agent-claude-code
USER root
RUN pnpm --config.ignore-scripts=false add --global @anthropic-ai/claude-code@2.1.326 \
 && CLAUDE_PACKAGE_DIR=$(pnpm list --global --json @anthropic-ai/claude-code | jq -r '.[0].dependencies["@anthropic-ai/claude-code"].path') \
 && node "$CLAUDE_PACKAGE_DIR/install.cjs" \
 && claude --version \
 && mkdir -p /home/node/.claude \
 && printf '%s\n' '{"hasCompletedOnboarding":true,"lastOnboardingVersion":"2.1.326","theme":"dark","shiftEnterKeyBindingInstalled":true,"projects":{"/home/node/workspace":{"allowedTools":[],"hasTrustDialogAccepted":true}}}' > /home/node/.claude.json \
 && printf '%s\n' '{"skipDangerousModePermissionPrompt":true}' > /home/node/.claude/settings.json \
 && chmod 0600 /home/node/.claude.json /home/node/.claude/settings.json \
 && chown -R 1000:1000 /home/node
ENV DISABLE_AUTOUPDATER=1
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/claude-tui-start.py \
 && python3 /tmp/agent-image-tests/claude-auth.py

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py claude-code \
 && python3 /tmp/agent-image-tests/command-oom-score.py claude-code

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/claude-background-agents.py \
 && python3 /tmp/agent-image-tests/claude-background-work.py

FROM agent-base AS agent-codex
USER root
RUN pnpm add --global @openai/codex@0.170.0 \
 && codex --version \
 && chown -R 1000:1000 /home/node
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/codex-failure.py

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py codex \
 && python3 /tmp/agent-image-tests/command-oom-score.py codex

FROM agent-base AS agent-opencode
USER root
RUN pnpm add --global opencode-ai@1.19.6 \
 && OPENCODE_PACKAGE_DIR="$(pnpm list --global --json opencode-ai | jq -r '.[0].dependencies["opencode-ai"].path')" \
 && node "${OPENCODE_PACKAGE_DIR}/postinstall.mjs" \
 && opencode --version \
 && chown -R 1000:1000 /home/node
ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV OPENCODE_DISABLE_PROJECT_CONFIG=1
USER 1000:1000

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py opencode \
 && python3 /tmp/agent-image-tests/command-oom-score.py opencode

FROM agent-base AS agent-hermes
ARG TARGETARCH
USER root
# Hermes ships only from source (PyPI stopped at 0.19.0): build the release
# commit the way upstream's own image does. Python, uv, and every Python
# package come from the hash-locked versions in the checkout. Pillow, PyJWT,
# certifi, and urllib3 are raised past the lock's vulnerable versions; the startup
# tests below exercise the resulting runtime, including gateway discovery.
# Keep 0.22.2 until the persistent gateway used by 0.22.4/0.22.5 supports the
# required MCP startup guard and refreshes runtime bindings on session resume.
COPY --from=uv-hermes /uv /usr/local/bin/uv-hermes
RUN --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    hermes_version=0.23.2 \
 && hermes_commit=ae2a81ccc00e9b7c06301523e5bb09608397149c \
 && git clone --quiet --depth 1 --branch "v${hermes_version}" https://github.com/NousResearch/hermes-agent /opt/hermes \
 && test "$(git -C /opt/hermes rev-parse HEAD)" = "${hermes_commit}" \
 && case "${TARGETARCH}" in amd64) python_target=linux-x64 ;; arm64) python_target=linux-arm64 ;; *) exit 1 ;; esac \
 # Python itself is pinned here, not taken from Hermes' lock: the lock's
 # CPython 3.14.9 lacks the 3.14.10 fix to the ssl module's denylist of
 # compromised intermediate certificates. Same python-build-standalone
 # install_only build, a newer release. Digests from its SHA256SUMS.
 && case "${TARGETARCH}" in \
      amd64) set -- x86_64 3fe0d7c0538eb5d190c34582992d26230532551355cbd789fabc6591621cfc07 ;; \
      arm64) set -- aarch64 e59f83159984a55e719bb3805a0b2b5b281f645769222218084b78b92eedc07f ;; \
    esac \
 && set -- "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.14.10+20261110-$1-unknown-linux-gnu-install_only.tar.gz" "$2" \
 && curl -fsSL "$1" -o /tmp/hermes-python.tgz \
 && echo "$2  /tmp/hermes-python.tgz" | sha256sum -c - \
 && mkdir -p /opt/hermes-python \
 && tar -xzf /tmp/hermes-python.tgz -C /opt/hermes-python --strip-components=1 \
 && rm /tmp/hermes-python.tgz \
 # Hermes builds and runs its TUI on the Node and pnpm its lock pins, which
 # are newer than the image's own; both stay private to Hermes.
 && set -- $(python3 -c 'import json, sys; a = json.load(open("/opt/hermes/pm/lock.json"))["packages"]["node"]["artifacts"][sys.argv[1]]; print(a["url"], a["sha256"])' "${python_target}") \
 && curl -fsSL "$1" -o /tmp/hermes-node.tar.xz \
 && echo "$2  /tmp/hermes-node.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/hermes-node \
 && tar -xJf /tmp/hermes-node.tar.xz -C /opt/hermes-node --strip-components=1 \
 && rm -rf /tmp/hermes-node.tar.xz /opt/hermes-node/include /opt/hermes-node/share \
 && set -- $(python3 -c 'import json, sys; a = json.load(open("/opt/hermes/pm/lock.json"))["packages"]["pnpm"]["artifacts"][sys.argv[1]][0]; print(a["url"], a["sha256"])' "${python_target}") \
 && curl -fsSL "$1" -o /tmp/hermes-pnpm.tgz \
 && echo "$2  /tmp/hermes-pnpm.tgz" | sha256sum -c - \
 && mkdir -p /tmp/hermes-pnpm \
 && tar -xzf /tmp/hermes-pnpm.tgz -C /tmp/hermes-pnpm --strip-components=1 \
 && rm /tmp/hermes-pnpm.tgz \
 && /opt/hermes-python/bin/python3 -c 'import sqlite3, sys; assert sys.version_info[:3] >= (3, 14, 10); assert sqlite3.sqlite_version_info >= (3, 51, 3), sqlite3.sqlite_version' \
 && cd /opt/hermes \
 # Upstream's source package uses 0.0.0; stamp the verified release into its metadata.
 && python3 /tmp/agent-image-patches/hermes-release-version.py /opt/hermes "${hermes_version}" \
 && UV_NO_CONFIG=1 UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy uv-hermes sync --quiet --frozen --no-default-groups --extra mcp \
      --python /opt/hermes-python/bin/python3 --compile-bytecode \
 && UV_NO_CONFIG=1 uv-hermes pip install --quiet --python /opt/hermes/.venv/bin/python \
      Pillow==13.0.0 PyJWT==2.14.0 certifi==2026.10.19 urllib3==2.8.0 \
 && PATH="/tmp/hermes-pnpm:/opt/hermes-node/bin:$PATH" LEFTHOOK=0 npm_config_install_links=false \
      node scripts/build/node-deps.mjs --source /opt/hermes --workspace ui-tui \
 && PATH="/opt/hermes-node/bin:$PATH" node scripts/build/tui.mjs --source /opt/hermes --out /opt/hermes-tui \
 && rm -rf node_modules ui-tui/node_modules /root/.npm /root/.cache /tmp/hermes-pnpm \
      website apps tests tests-js evals \
 && .venv/bin/python scripts/write_install_stamp.py --output install-stamp.json \
      --commit "${hermes_commit}" --base-version "${hermes_version}" --distance 0 \
      --source docker --distribution docker --update-mechanism external \
 && printf '%s\n' docker > .install_method \
 # Discard superseded wheels and build-only installers, including pip's vendored packages.
 # Hermes runs only HERMES_NODE at runtime; the npm and corepack its Node
 # tarball bundles are build tools (npm 11.20.0 carries brace-expansion 5.0.9
 # and undici 6.28.0). The pnpm store holds only the TUI build's packages,
 # including lefthook's Go binary (go1.27.0, x/net 0.59.0).
 && rm -rf .git /home/node/.cache/uv /usr/local/bin/uv-hermes /usr/local/share/pnpm/store \
      /opt/hermes-node/lib/node_modules/npm /opt/hermes-node/lib/node_modules/corepack \
      /opt/hermes-node/bin/npm /opt/hermes-node/bin/npx /opt/hermes-node/bin/corepack \
      /opt/hermes-python/lib/python3.14/site-packages/pip \
      /opt/hermes-python/lib/python3.14/site-packages/pip-*.dist-info \
      /opt/hermes-python/lib/python3.14/ensurepip \
      /opt/hermes-python/bin/pip* \
 && ln -s /opt/hermes/.venv/bin/hermes /usr/local/bin/hermes \
 && hermes --version \
 && chown -R 1000:1000 /home/node
ENV HERMES_TUI_DIR=/opt/hermes-tui
ENV HERMES_NODE=/opt/hermes-node/bin/node
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    /opt/hermes/.venv/bin/python /tmp/agent-image-patches/hermes-tui-mcp-discovery.py \
 && /opt/hermes/.venv/bin/python /tmp/agent-image-patches/hermes-mcp-sdk-import.py \
 && /opt/hermes/.venv/bin/python /tmp/agent-image-patches/hermes-no-first-contact-note.py
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/hermes-startup.py

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py hermes \
 && python3 /tmp/agent-image-tests/command-oom-score.py hermes

FROM agent-base AS agent-openclaw
USER root
COPY docker_images/agent/openclaw /opt/agent-openclaw
# The image pins OpenClaw; skip its startup update checks and notices.
ENV OPENCLAW_NO_AUTO_UPDATE=1
RUN pnpm --dir /opt/agent-openclaw install --frozen-lockfile \
 && ln -s /opt/agent-openclaw/node_modules/.bin/openclaw /usr/local/bin/openclaw \
 && openclaw --version \
 && chown -R 1000:1000 /home/node
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    # npm 12.2.1 fixes its bundled brace-expansion, but still bundles undici 6.29.0.
    # Reuse the checksummed 6.29.1 copy already installed for the global npm CLI.
    npm_dir=/opt/agent-openclaw/node_modules/.pnpm/npm@12.2.1/node_modules/npm && \
    test "$(node -p "require('${npm_dir}/package.json').version")" = 12.2.1 && \
    test "$(node -p "require('/usr/local/lib/node_modules/npm/node_modules/undici/package.json').version")" = 6.29.1 && \
    rm -rf "${npm_dir}/node_modules/undici" && \
    cp -a /usr/local/lib/node_modules/npm/node_modules/undici "${npm_dir}/node_modules/undici" && \
    node /tmp/agent-image-tests/npm-http.cjs "${npm_dir}/node_modules/undici" && \
    python3 /tmp/agent-image-patches/openclaw-mcp-required.py
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py openclaw \
 && python3 /tmp/agent-image-tests/command-oom-score.py openclaw

# The npm package's postinstall only unpacks the platform binary into
# ~/.grok/bin, under the persisted HOME, and writes ~/.grok/config.toml. Unpack
# the pinned, checksummed binary into the image instead; the launcher writes
# Grok's configuration at run time.
FROM agent-base AS agent-grok
ARG TARGETARCH
# Set before the version check below so no Grok process looks for updates.
ENV GROK_DISABLE_AUTOUPDATER=1
USER root
RUN case "$TARGETARCH" in \
      amd64) grok_arch=x64; checksum=4cef43ce2b62cccdb39acb216d8042f91d78d7fb022375b31dd7a3e8d747fc5c ;; \
      arm64) grok_arch=arm64; checksum=c5139d8fb6fe050e5519cd1abc41e957366cf31a24983537627849c34f2bf5cd ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && mkdir -p /tmp/grok /opt/grok/bin \
 && cd /tmp/grok \
 && npm pack --silent "@xai-official/grok-linux-${grok_arch}@1.0.90" \
 && tar -xzf "xai-official-grok-linux-${grok_arch}-1.0.90.tgz" \
 && echo "$checksum  package/bin/grok.br" | sha256sum -c - \
 && node -e 'const fs = require("fs"), zlib = require("zlib"); fs.writeFileSync("/opt/grok/bin/grok", zlib.brotliDecompressSync(fs.readFileSync("package/bin/grok.br")));' \
 && chmod 0755 /opt/grok/bin/grok \
 && ln -s /opt/grok/bin/grok /usr/local/bin/grok \
 && cd / && rm -rf /tmp/grok /root/.npm \
 && HOME=/tmp/grok-version grok --version \
 && rm -rf /tmp/grok-version \
 && chown -R 1000:1000 /home/node
USER 1000:1000

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py grok \
 && python3 /tmp/agent-image-tests/command-oom-score.py grok

# The npm package's postinstall only renames a previous Python kimi shim on
# global installs. Install the checksummed tarball without lifecycle scripts.
# Kimi finds ripgrep and fd on PATH instead of downloading its own copies.
FROM agent-base AS agent-kimi
USER root
# Set before the version check below so no Kimi process looks for updates.
ENV KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CLI_NO_AUTO_UPDATE=1 KIMI_DISABLE_TELEMETRY=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends fd-find \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/kimi \
 && cd /tmp/kimi \
 && mv "$(npm pack --silent @moonshot-ai/kimi-code@2.6.3)" kimi-code.tgz \
 && echo "403ad8e450362d05d09b785c045edeb9efc02cc7adeca1aadb9bb0cab800214969e6ebe7e21e75e35c58d9449efa6f767ffaabe64ed3e37c07c5f19274b07693  kimi-code.tgz" | sha512sum -c - \
 && npm install --global --prefix /opt/kimi --ignore-scripts --no-audit --no-fund ./kimi-code.tgz \
 && ln -s /opt/kimi/bin/kimi /usr/local/bin/kimi \
 && cd / && rm -rf /tmp/kimi /root/.npm \
 && HOME=/tmp/kimi-version KIMI_CODE_HOME=/tmp/kimi-version kimi --version \
 && rm -rf /tmp/kimi-version \
 && chown -R 1000:1000 /home/node
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/patches,target=/tmp/agent-image-patches \
    python3 /tmp/agent-image-patches/kimi-user-mcp-only.py \
 && python3 /tmp/agent-image-patches/kimi-long-tool-call-ids.py \
 && python3 /tmp/agent-image-patches/kimi-late-mcp-tools.py
USER 1000:1000

RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/mcp-startup.py kimi \
 && python3 /tmp/agent-image-tests/command-oom-score.py kimi

# Redistribute the unmodified native binary and its license/notices together.
# No package lifecycle scripts or automatic updates run in this image.
FROM agent-base AS agent-copilot
USER root
ENV COPILOT_AUTO_UPDATE=false
RUN case "$TARGETARCH" in \
      amd64) copilot_arch=x64; copilot_checksum=8079c8366f5f7c5ab3f86d7d71052a45ede5b130103b74db763eebec1c7592d66f0b95fa89777f9dfa350d14e3f666a06f9d9a1918aec01df2bc3d65916ebcc5 ;; \
      arm64) copilot_arch=arm64; copilot_checksum=e30ab66a503e3d7fe101c64c41ea6e2e496b9f6c26388bcd80fbd7db1d10b4e5a89d7adf8b1c4aff1e4088d8a1c81104abe62a523a36f60d1f1f04dd369b47c1 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && mkdir -p /opt/copilot \
 && cd /tmp \
 && mv "$(npm pack --silent @github/copilot-linux-${copilot_arch}@1.0.114)" copilot.tgz \
 && echo "$copilot_checksum  copilot.tgz" | sha512sum -c - \
 && tar -xzf copilot.tgz --strip-components=1 -C /opt/copilot \
 && test -s /opt/copilot/LICENSE.md \
 && ln -s /opt/copilot/copilot /usr/local/bin/copilot \
 && COPILOT_HOME=/tmp/copilot-version COPILOT_OFFLINE=true copilot --no-auto-update --version \
 && rm -rf /tmp/copilot.tgz /tmp/copilot-version /root/.npm \
 && chown -R 1000:1000 /home/node
USER 1000:1000
RUN --network=none \
    --mount=type=bind,source=docker_images/agent/tests,target=/tmp/agent-image-tests \
    python3 /tmp/agent-image-tests/copilot.py \
 && python3 /tmp/agent-image-tests/command-oom-score.py copilot
