# The p4 shim: a minimal in-cluster HTTP proxy that executes an allowlisted
# set of Perforce CLI commands for the knowledge-base permission-sync feature.
#
# The image deliberately does NOT contain the proprietary `p4` binary: the
# platform backend downloads it (pinned version, checksum-verified) and pushes
# it to the running pod over the in-cluster provisioning endpoint, so nothing
# Archestra publishes redistributes Perforce software and the pod's egress can
# stay pinned to the customer's Perforce server alone.
#
# The official `p4` binary needs glibc. The dev variant supplies apt for the
# small runtime package set; untrusted PRs use the matching public Node release.
ARG RUNTIME_BASE=hardened
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime-base-public
RUN apt-get update \
  && apt-get install -y --no-install-recommends apt libapt-pkg6.0 tini libpcre2-8-0 perl-base \
  # CVE-2026-109518: upgrade the package manager inherited from the base image.
  && for package in apt libapt-pkg6.0; do \
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' "$package")" ge 2.6.2 || exit 1; \
  done \
  # CVE-2026-86145 and CVE-2026-103111: reject a repository snapshot that
  # predates the pcre2 fixes.
  && dpkg --compare-versions \
    "$(dpkg-query --show --showformat='${Version}' libpcre2-8-0)" \
    ge 10.42-1+deb12u2 \
  # CVE-2026-8376, CVE-2026-42496, CVE-2026-13221, CVE-2026-12087,
  # CVE-2026-57432, CVE-2026-48959, CVE-2026-42497, CVE-2026-48962: perl fixes.
  && dpkg --compare-versions \
    "$(dpkg-query --show --showformat='${Version}' perl-base)" \
    ge 5.36.0-7+deb12u4 \
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

# The published image needs only Node, glibc and tini. Keep apt and the shell
# in a throwaway stage, then copy the process reaper into the runtime image.
FROM dhi.io/node:24.22.3-debian12-dev@sha256:cab4b2c693a761af346c0de57a9c53acfc0dfd75acd502b31dd7182fef2104e1 AS tini-build
RUN apt-get update && apt-get install -y --no-install-recommends tini
FROM dhi.io/node:24.22.3-debian12@sha256:f86966eca7244d136d7383debd6572d0917c8836200e3ff87282ebcbd7970875 AS runtime-base-hardened
COPY --from=tini-build /usr/bin/tini /usr/bin/tini

FROM runtime-base-${RUNTIME_BASE}

# Explicit world-readable mode: COPY preserves the build context's file mode,
# and the server runs as uid 65534.
COPY --chmod=0444 server.mjs /app/server.mjs

# Matches the pod securityContext (runAsNonRoot 65534, readOnlyRootFilesystem;
# /work is an emptyDir mounted by the runtime manager).
USER 65534:65534
ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/server.mjs"]
