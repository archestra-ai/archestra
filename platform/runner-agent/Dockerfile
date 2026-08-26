# runner-agent-base: the default image an Archestra Runner starts from.
#
# A Runner's contract with its image is small and deliberately so: tmux and a
# POSIX shell must exist, because the runtime makes tmux PID 1 and that is what
# lets a human attach to a live session and steer it. Everything else here is
# convenience — git and a toolbelt an agent usually reaches for.
#
# This image also satisfies the second half of the contract: `archestra-runner-agent`
# on PATH, so a runner started with no explicit command has something to run.
# A bring-your-own image either provides that binary or sets its own command.
FROM node:24-bookworm-slim

# tmux is load-bearing, not a convenience: without it the runtime's bootstrap
# refuses to start rather than launching a session nobody could attach to.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends \
      tmux git ca-certificates curl jq ripgrep less procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/archestra

# Installed with pnpm, not npm: this package takes `ai` from the workspace
# catalog, and `catalog:` is a pnpm protocol. Resolving it here keeps the
# runner's SDK version governed by the same catalog the backend uses, instead
# of a copy that drifts.
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml ./
# The workspace pins patched dependencies; pnpm reads these during install.
COPY patches ./patches
COPY runner-agent/package.json ./runner-agent/package.json
# The minimum-release-age policy is a guard on *choosing* new versions; here the
# committed lockfile has already fixed them, and the check needs registry
# metadata this build has no reason to fetch.
RUN pnpm install --filter @archestra/runner-agent --frozen-lockfile \
      --ignore-scripts --config.minimumReleaseAge=0

COPY runner-agent/tsconfig.json ./runner-agent/tsconfig.json
COPY runner-agent/src ./runner-agent/src
# Kept as its own step with no fallback: a compile failure must fail the image
# rather than produce one whose entrypoint is missing.
RUN pnpm --filter @archestra/runner-agent build

RUN chmod +x /opt/archestra/runner-agent/dist/index.js \
 && ln -s /opt/archestra/runner-agent/dist/index.js /usr/local/bin/archestra-runner-agent

# The agent runs as a normal user: nothing it does needs root, and an image that
# only works as root pushes every deployment towards a privileged runner.
# The base image already ships a uid-1000 user; reuse it rather than adding a
# second one, and give it the two directories a session actually writes to.
RUN mkdir -p /home/node/workspace /var/run/archestra \
 && chown -R 1000:1000 /home/node /var/run/archestra
USER 1000:1000
WORKDIR /home/node/workspace

# No CMD: the runtime always supplies the bootstrap that creates the steer FIFO
# and starts tmux. An image-level CMD here would be dead weight that masks a
# misconfigured runner by appearing to work.
