#!/bin/sh
# Dagger's Go module with Archestra's CVE dependency floors, run from the root of
# a Dagger checkout that already holds ./dockercompat. platform/Dockerfile
# builds the Dagger CLI and the patched engine image from the same result, so
# a dependency floor added here reaches both.
set -eu

# dagger v0.21.11's vendored Go SDK requires go >= 1.26.1; align the module directive.
go mod edit -go=1.26.1
# cve-2026-34040: replace Dagger's BuildKit Docker monolith imports with split Moby modules.
go mod edit -require=github.com/docker/docker@v29.3.1+incompatible
go mod edit -replace=github.com/docker/docker=./dockercompat
# CVE-2026-34986 and CVE-2026-116587: patched go-jose JWE/JWK parsing.
go get github.com/go-jose/go-jose/v4@v4.1.6
# cve-2026-45022: go-git validation issue fixed in >= 5.19.0
# cve-2026-71556: go-git link following fixed in >= 5.19.2
go get github.com/go-git/go-git/v5@v5.19.2
# cve-2026-44973: go-billy path traversal fixed in >= 5.9.0
go get github.com/go-git/go-billy/v5@v5.9.0
# cve-2026-39821: x/net CRITICAL fixed in >= 0.55.0.
# cve-2026-46600: x/net HIGH fixed in >= 0.56.0.
# x/net <0.60.0: HTTP/2 security fixes (CVE-2026-78663/78669/78660/78659).
# CVE-2026-78661: x/net HTTP/2 fix requires >= 0.62.0.
go get golang.org/x/net@v0.62.0
# cve-2026-46597: x/crypto issue fixed in >= 0.52.0; keep this after x/net.
# cve-2026-78662 / cve-2026-56855: x/crypto HIGH fixed in >= 0.56.0.
# Keep >= 0.58.0 to satisfy x/net@v0.62.0 without downgrading it.
go get golang.org/x/crypto@v0.58.0
# cve-2026-56865: x/mod/sumdb/tlog tile verification bypass (HIGH) fixed in >= 0.40.0.
# cve-2026-56864: x/mod/sumdb accepts unauthenticated hashes; same fix version.
# Arrives transitively (dagger and containerd both floor it at 0.36.0), so it needs
# an explicit requirement rather than a bump of any single dependency.
# Keep the patched x/mod floor when updating transitive dependencies.
go get golang.org/x/mod@v0.41.0
# cve-2026-17106: go-archive path traversal fixed in >= 0.3.0 (matches dockercompat's floor).
# sys/user must be >= 0.4.1 here — go-archive 0.3.0 requires it, and asking for 0.4.0 in the
# same `go get` would make go resolve the conflict by downgrading go-archive below 0.3.0.
go get github.com/moby/go-archive@v0.3.0 github.com/moby/profiles/seccomp@v0.2.3 github.com/moby/sys/reexec@v0.1.0 github.com/moby/sys/user@v0.4.1
# cve-2026-46680: containerd type confusion fixed in >= 2.2.4
# cve-2026-53488/53492/53489: containerd injection/input-validation/symlink-following fixed in >= 2.2.5
# cve-2026-95837: containerd improper privilege management (HIGH) fixed in >= 2.2.7
go get github.com/containerd/containerd/v2@v2.2.7
# GHSA-hrxh-6v49-42gf: grpc xDS RBAC and HTTP/2 vulnerabilities fixed in >= 1.82.1.
# CVE-2026-84304: grpc resource exhaustion fixed in >= 1.83.1.
# CVE-2026-84445: grpc array index validation fixed in >= 1.83.2.
# CVE-2026-116591: Dagger's transitive zstd decoder must use compress >= 1.20.2.
# Keep these security floors in the LAST `go get` before `go mod tidy` — earlier
# dependency updates can otherwise downgrade the explicit requirements.
go get golang.org/x/net@v0.62.0 google.golang.org/grpc@v1.83.2 github.com/klauspost/compress@v1.20.2
go mod tidy
