# The p4 shim: a minimal in-cluster HTTP proxy that executes an allowlisted
# set of Perforce CLI commands for the knowledge-base permission-sync feature.
#
# The image deliberately does NOT contain the proprietary `p4` binary: the
# platform backend downloads it (pinned version, checksum-verified) and pushes
# it to the running pod over the in-cluster provisioning endpoint, so nothing
# Archestra publishes redistributes Perforce software and the pod's egress can
# stay pinned to the customer's Perforce server alone.
#
# Debian (glibc) base — not Alpine like the platform's other images — because
# the official `p4` binary is glibc-linked and does not run on musl.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

FROM ${NODE_IMAGE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

# The entrypoint is `node /app/server.mjs`, server.mjs imports nothing outside
# Node's standard library, and no package is ever installed here or at runtime —
# so npm and corepack are dead weight. Not harmless dead weight: npm's own
# bundled tree (tar, brace-expansion, ip-address, undici) is where every CVE
# this image has been flagged for lives, and the sibling MCP image has to patch
# those packages by hand release after release because it genuinely needs npm.
# Deleting them removes the vulnerable code instead of tracking its versions,
# and leaves less for anyone who reaches a pod holding a tenant's Perforce
# credentials to work with.
RUN rm -rf /usr/local/lib/node_modules/npm \
  /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm \
  /usr/local/bin/npx \
  /usr/local/bin/corepack

# Explicit world-readable mode: COPY preserves the build context's file mode,
# and the server runs as uid 65534.
COPY server.mjs /app/server.mjs
RUN chmod 0444 /app/server.mjs

# Matches the pod securityContext (runAsNonRoot 65534, readOnlyRootFilesystem;
# /work is an emptyDir mounted by the runtime manager).
USER 65534:65534
ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/server.mjs"]
