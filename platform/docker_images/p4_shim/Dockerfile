# The p4 shim: a minimal in-cluster HTTP proxy that executes an allowlisted
# set of Perforce CLI commands for the knowledge-base permission-sync feature.
#
# The image deliberately does NOT contain the proprietary `p4` binary: the
# platform backend downloads it (pinned version, checksum-verified) and pushes
# it to the running pod over the in-cluster provisioning endpoint, so nothing
# Archestra publishes redistributes Perforce software and the pod's egress can
# stay pinned to the customer's Perforce server alone.
#
# The official `p4` binary needs glibc, so this image uses Debian 13.
# The published image needs only Node, glibc and tini. Keep apt and the shell
# in a throwaway stage, then copy the process reaper into the runtime image.
FROM dhi.io/debian-base:trixie-debian13-dev@sha256:3fa66c79193ec70e04ce95ab7a695a65e8eab39b313500e0454d9ea607b1da10 AS tini-build
RUN apt-get update && apt-get install -y --no-install-recommends tini
FROM dhi.io/node:24.22.3-debian13@sha256:b1f27e02fbc8c2178892d39affd54dc2bd4e2215100b47a79c6f6038858eba72
COPY --from=tini-build /usr/bin/tini /usr/bin/tini

# Explicit world-readable mode: COPY preserves the build context's file mode,
# and the server runs as uid 65534.
COPY --chmod=0444 server.mjs /app/server.mjs

# Matches the pod securityContext (runAsNonRoot 65534, readOnlyRootFilesystem;
# /work is an emptyDir mounted by the runtime manager).
USER 65534:65534
ENV NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/server.mjs"]
