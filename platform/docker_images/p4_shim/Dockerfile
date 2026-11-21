# The p4 shim: a minimal in-cluster HTTP proxy that executes an allowlisted
# set of Perforce CLI commands for the knowledge-base permission-sync feature.
#
# The image deliberately does NOT contain the proprietary `p4` binary: the
# platform backend downloads it (pinned version, checksum-verified) and pushes
# it to the running pod over the in-cluster provisioning endpoint, so nothing
# Archestra publishes redistributes Perforce software and the pod's egress can
# stay pinned to the customer's Perforce server alone.
#
# The official `p4` binary needs glibc, so this image uses Debian 12.
# The published image needs only Node, glibc and tini. Keep apt and the shell
# in a throwaway stage, then copy the process reaper into the runtime image.
FROM dhi.io/node:24.22.3-debian12-dev@sha256:cab4b2c693a761af346c0de57a9c53acfc0dfd75acd502b31dd7182fef2104e1 AS tini-build
RUN apt-get update && apt-get install -y --no-install-recommends tini
FROM dhi.io/node:24.22.3-debian12@sha256:f86966eca7244d136d7383debd6572d0917c8836200e3ff87282ebcbd7970875
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
