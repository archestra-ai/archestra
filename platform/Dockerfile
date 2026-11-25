# NOTE: CI builds this image with the shell-based build-docker-image action (buildx + registry cache).
# build KinD, Docker CLI, Dagger CLI, and kubectl from source with a patched Go toolchain.
# the Alpine packages/binaries have historically lagged on Go patch releases, so
# we compile these tools ourselves to pick up upstream fixes without local vendoring hacks.
ARG KIND_VERSION=v0.31.0
ARG KIND_COMMIT=a323333ff9efd8099f95a8a6b5c86c75a210d00f
ARG DOCKER_CLI_VERSION=v29.3.0
ARG DOCKER_CLI_COMMIT=5927d80c76b3ce5cf782be818922966e8a0d87a3
ARG DAGGER_VERSION=v0.21.11
ARG DAGGER_COMMIT=631cdb609aaddc0037c2ba713e7642cadf645ff4
ARG KUBECTL_VERSION=v1.35.0
ARG KUBECTL_COMMIT=66452049f3d692768c39c797b21b793dce80314e
FROM golang:1.26.11-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab AS go-builder-base
ARG TARGETARCH
RUN if [ "$TARGETARCH" != "amd64" ] && [ "$TARGETARCH" != "arm64" ]; then \
        echo "ERROR: Unsupported architecture: $TARGETARCH. KinD is only available for amd64 and arm64."; \
        exit 1; \
    fi && \
    apk add --no-cache git

# Build the four pinned Go tools in independent stages so BuildKit schedules
# them concurrently. Go caches stay outside exported layers, and each clone is
# removed in the same RUN so mode=max never publishes source trees.
FROM go-builder-base AS kind-builder
ARG TARGETARCH
ARG KIND_VERSION
ARG KIND_COMMIT
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    git clone --depth 1 --branch "${KIND_VERSION}" https://github.com/kubernetes-sigs/kind.git /kind && \
    test "$(git -C /kind rev-parse HEAD)" = "${KIND_COMMIT}" && \
    cd /kind && \
    go mod edit -go=1.25.11 && \
    # golang.org/x/net <0.55.0: CVE-2026-39821 (CRITICAL); fixed in >= 0.55.0
    # golang.org/x/net <0.56.0: CVE-2026-46600 (HIGH); fixed in >= 0.56.0
    # CVE-2026-78661: x/net HTTP/2 fix requires >= 0.62.0.
    go get golang.org/x/net@v0.62.0 && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -o /kind-binary . && \
    cd / && rm -rf /kind

FROM go-builder-base AS docker-cli-builder
ARG TARGETARCH
ARG DOCKER_CLI_VERSION
ARG DOCKER_CLI_COMMIT
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    git clone --depth 1 --branch "${DOCKER_CLI_VERSION}" https://github.com/docker/cli.git /docker-cli && \
    test "$(git -C /docker-cli rev-parse HEAD)" = "${DOCKER_CLI_COMMIT}" && \
    cd /docker-cli && \
    cp vendor.mod go.mod && cp vendor.sum go.sum && \
    go mod edit -go=1.25.11 && \
    # CVE-2026-39883: OTel SDK untrusted search path fixed in >= 1.43.0
    go get go.opentelemetry.io/otel/sdk@v1.43.0 && \
    # CVE-2026-34986, CVE-2026-116587 and the advisories 4.1.7 fixes: patched go-jose parsing.
    go get github.com/go-jose/go-jose/v4@v4.1.7 && \
    # CVE-2026-17106: go-archive path traversal fixed in >= 0.3.0 (vendor.mod floors it at 0.2.0)
    go get github.com/moby/go-archive@v0.3.0 && \
    # x/sys/x/term must be pinned for `go mod vendor` to find windows/registry and plan9 sub-pkgs.
    # x/net@v0.62.0 requires x/sys >= v0.49.0 and x/term >= v0.47.0.
    go get golang.org/x/sys@v0.49.0 && \
    go get golang.org/x/term@v0.47.0 && \
    # golang.org/x/net <0.55.0: CVE-2026-39821 (CRITICAL); fixed in >= 0.55.0.
    # golang.org/x/net <0.56.0: CVE-2026-46600 (HIGH); fixed in >= 0.56.0.
    # CVE-2026-33186: grpc Improper Authorization fixed in >= 1.79.3.
    # GHSA-hrxh-6v49-42gf: grpc xDS RBAC and HTTP/2 vulnerabilities fixed in >= 1.82.1.
    # CVE-2026-84304: grpc resource exhaustion fixed in >= 1.83.1.
    # CVE-2026-84445: grpc array index validation fixed in >= 1.83.2.
    # x/net <0.60.0: HTTP/2 security fixes (CVE-2026-78663/78669/78660/78659).
    # CVE-2026-78661: x/net HTTP/2 fix requires >= 0.62.0.
    # go-archive 0.3.0 pulls klauspost/compress 1.18.7; CVE-2026-116591 is fixed in 1.20.2.
    # Keep all three security floors in the LAST `go get` before `go mod vendor`:
    # earlier OTel/x/sys and go-archive updates can pull older x/net, grpc, and compress versions.
    go get golang.org/x/net@v0.62.0 google.golang.org/grpc@v1.83.2 github.com/klauspost/compress@v1.20.2 && \
    go mod vendor && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -mod=vendor \
    -ldflags "-X github.com/docker/cli/cli/version.Version=${DOCKER_CLI_VERSION#v}" \
    -o /docker-binary ./cmd/docker && \
    cd / && rm -rf /docker-cli

FROM go-builder-base AS dagger-builder
ARG TARGETARCH
ARG DAGGER_VERSION
ARG DAGGER_COMMIT
COPY docker/dagger-dockercompat /dagger-dockercompat
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    git clone --depth 1 --branch "${DAGGER_VERSION}" https://github.com/dagger/dagger.git /dagger && \
    test "$(git -C /dagger rev-parse HEAD)" = "${DAGGER_COMMIT}" && \
    cd /dagger && \
    cp -R /dagger-dockercompat ./dockercompat && \
    # dagger v0.21.11's vendored Go SDK requires go >= 1.26.1; align the module directive.
    go mod edit -go=1.26.1 && \
    # cve-2026-34040: replace Dagger's BuildKit Docker monolith imports with split Moby modules.
    go mod edit -require=github.com/docker/docker@v29.3.1+incompatible && \
    go mod edit -replace=github.com/docker/docker=./dockercompat && \
    # CVE-2026-34986, CVE-2026-116587 and the advisories 4.1.7 fixes: patched go-jose parsing.
    go get github.com/go-jose/go-jose/v4@v4.1.7 && \
    # cve-2026-45022: go-git validation issue fixed in >= 5.19.0
    # cve-2026-71556: go-git link following fixed in >= 5.19.2
    go get github.com/go-git/go-git/v5@v5.19.2 && \
    # cve-2026-44973: go-billy path traversal fixed in >= 5.9.0
    go get github.com/go-git/go-billy/v5@v5.9.0 && \
    # cve-2026-39821: x/net CRITICAL fixed in >= 0.55.0.
    # cve-2026-46600: x/net HIGH fixed in >= 0.56.0.
    # x/net <0.60.0: HTTP/2 security fixes (CVE-2026-78663/78669/78660/78659).
    # CVE-2026-78661: x/net HTTP/2 fix requires >= 0.62.0.
    go get golang.org/x/net@v0.62.0 && \
    # cve-2026-46597: x/crypto issue fixed in >= 0.52.0; keep this after x/net.
    # cve-2026-78662 / cve-2026-56855: x/crypto HIGH fixed in >= 0.56.0.
    # Keep >= 0.58.0 to satisfy x/net@v0.62.0 without downgrading it.
    go get golang.org/x/crypto@v0.58.0 && \
    # cve-2026-56865: x/mod/sumdb/tlog tile verification bypass (HIGH) fixed in >= 0.40.0.
    # cve-2026-56864: x/mod/sumdb accepts unauthenticated hashes; same fix version.
    # Arrives transitively (dagger and containerd both floor it at 0.36.0), so it needs
    # an explicit requirement rather than a bump of any single dependency.
    # Keep the patched x/mod floor when updating transitive dependencies.
    go get golang.org/x/mod@v0.41.0 && \
    # cve-2026-17106: go-archive path traversal fixed in >= 0.3.0 (matches dockercompat's floor).
    # sys/user must be >= 0.4.1 here — go-archive 0.3.0 requires it, and asking for 0.4.0 in the
    # same `go get` would make go resolve the conflict by downgrading go-archive below 0.3.0.
    go get github.com/moby/go-archive@v0.3.0 github.com/moby/profiles/seccomp@v0.2.3 github.com/moby/sys/reexec@v0.1.0 github.com/moby/sys/user@v0.4.1 && \
    # cve-2026-46680: containerd type confusion fixed in >= 2.2.4
    # cve-2026-53488/53492/53489: containerd injection/input-validation/symlink-following fixed in >= 2.2.5
    # cve-2026-95837: containerd improper privilege management (HIGH) fixed in >= 2.2.7
    # CVE-2026-95839: containerd uncaught exception (HIGH) fixed in >= 2.2.10
    go get github.com/containerd/containerd/v2@v2.2.10 && \
    # GHSA-hrxh-6v49-42gf: grpc xDS RBAC and HTTP/2 vulnerabilities fixed in >= 1.82.1.
    # CVE-2026-84304: grpc resource exhaustion fixed in >= 1.83.1.
    # CVE-2026-84445: grpc array index validation fixed in >= 1.83.2.
    # CVE-2026-116591: Dagger's transitive zstd decoder must use compress >= 1.20.2.
    # Keep these security floors in the LAST `go get` before `go mod tidy` — earlier
    # dependency updates can otherwise downgrade the explicit requirements.
    go get golang.org/x/net@v0.62.0 google.golang.org/grpc@v1.83.2 github.com/klauspost/compress@v1.20.2 && \
    go mod tidy && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build \
    -ldflags "-X github.com/dagger/dagger/engine.Version=${DAGGER_VERSION} -X github.com/dagger/dagger/engine.Tag=${DAGGER_VERSION}" \
    -o /dagger-binary ./cmd/dagger && \
    cd / && rm -rf /dagger /dagger-dockercompat

FROM go-builder-base AS kubectl-builder
ARG TARGETARCH
ARG KUBECTL_VERSION
ARG KUBECTL_COMMIT
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    git clone --depth 1 --branch "${KUBECTL_VERSION}" https://github.com/kubernetes/kubernetes.git /kubernetes && \
    test "$(git -C /kubernetes rev-parse HEAD)" = "${KUBECTL_COMMIT}" && \
    cd /kubernetes && \
    go mod edit -go=1.25.11 && \
    go work edit -go=1.25.11 && \
    # cve-2026-35469: spdystream resource exhaustion fixed in >= 0.5.1.
    go get github.com/moby/spdystream@v0.5.1 && \
    # cve-2026-29181: OTel resource exhaustion fixed in >= 1.41.0.
    go get go.opentelemetry.io/otel@v1.41.0 go.opentelemetry.io/otel/metric@v1.41.0 go.opentelemetry.io/otel/trace@v1.41.0 go.opentelemetry.io/otel/sdk@v1.41.0 && \
    # cve-2026-39821: x/net CRITICAL fixed in >= 0.55.0.
    # cve-2026-46600: x/net HIGH fixed in >= 0.56.0.
    # CVE-2026-78661: x/net HTTP/2 fix requires >= 0.62.0.
    go get golang.org/x/net@v0.62.0 && \
    # cve-2026-56865: x/mod/sumdb/tlog tile verification bypass (HIGH) fixed in >= 0.40.0.
    # cve-2026-56864: x/mod/sumdb accepts unauthenticated hashes; same fix version.
    # Keep the patched x/mod floor when updating transitive dependencies.
    go get golang.org/x/mod@v0.41.0 && \
    # Keep the patched x/net after all transitive dependency updates.
    go get golang.org/x/net@v0.62.0 && \
    CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -mod=readonly \
    -ldflags "-X k8s.io/component-base/version.gitVersion=${KUBECTL_VERSION} -X k8s.io/component-base/version.gitCommit=${KUBECTL_COMMIT} -X k8s.io/component-base/version.gitTreeState=clean" \
    -o /kubectl-binary ./cmd/kubectl && \
    cd / && rm -rf /kubernetes

# pre-bake the Dagger Engine image as a docker-archive so the quickstart can
# kind-load it into the embedded node instead of pulling ~352MB from the registry
# on every boot (KinD recreates its node each run and its containerd cannot see
# the host Docker image cache). tagged to match the engine ref the rendered
# manifest uses, so imagePullPolicy: IfNotPresent finds it locally.
FROM node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc AS dagger-engine-image
ARG TARGETARCH
ARG DAGGER_VERSION
RUN apk add --no-cache skopeo
RUN skopeo copy --override-os linux --override-arch "${TARGETARCH}" \
        "docker://registry.dagger.io/engine:${DAGGER_VERSION}" \
        "docker-archive:/dagger-engine.tar:registry.dagger.io/engine:${DAGGER_VERSION}"

# <----- M-Files VAF Add On ----->
# Compile the add-on from this checkout's source so every platform image
# carries the exact package matching its code, served by the backend's
# mfiles-vaf-add-on routes with no runtime GitHub dependency. The output is
# framework-neutral IL (net472 assemblies zipped into a .mfappx), so the
# stage always runs on the build platform — never under target-arch
# emulation — and the same bytes land in every target arch.
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:8.0-alpine@sha256:4f4992f8f302150e4adb5e78c324731e968493a30c0638985ba29cb42a858cd6 AS vaf-add-on-builder
WORKDIR /src
COPY backend/src/knowledge-base/connectors/mfiles/vaf-add-on/ ./
# The csproj's packaging target writes exactly one versioned
# archestra-m-files-vaf-add-on-<version>.mfappx (it deletes older ones
# first); ship it alongside a stable-named copy — the name the installer and
# the docs reference.
RUN --mount=type=cache,id=nuget,target=/root/.nuget/packages \
    set -eux; \
    dotnet build Archestra.MFiles.VAFAddOn.csproj -c Release; \
    mkdir /out; \
    versioned="$(find bin/Release -name 'archestra-m-files-vaf-add-on-*.mfappx')"; \
    [ "$(printf '%s\n' "${versioned}" | wc -l)" -eq 1 ]; \
    cp "${versioned}" /out/; \
    cp "${versioned}" /out/archestra-m-files-vaf-add-on.mfappx

# <----- Archestra CLI release binaries ----->
# `archestra` is the program users run on their own computers. The backend
# serves its binaries from /app/archestra-cli: one file per system and CPU,
# plus manifest.json with their version.
# This stage downloads the binaries instead of compiling them, because the
# macOS and Windows binaries cannot be built in a Linux image.
# .github/workflows/build-archestra-cli.yml builds all six on their own
# systems and publishes them as the release archestra-cli-v<version>.
# archestra-cli/release.lock.json pins that release: its URL and the SHA-256
# of each file. A failed download or a checksum mismatch fails the build.
# With an empty lock (no release pinned) /out stays empty: the image holds no
# program and the backend answers "not found" for its downloads.
# Only the lock file is copied, so this stage re-runs only when the lock
# changes. The bytes are the same for every target architecture, so the stage
# runs on the build platform, never under emulation.
# The script uses paths relative to / so that
# .github/scripts/test_archestra_cli_image_stage.py can run it in a directory
# of its own.
FROM --platform=$BUILDPLATFORM node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc AS archestra-cli-release
WORKDIR /
COPY archestra-cli/release.lock.json ./release.lock.json
RUN <<'ARCHESTRA_CLI_RELEASE'
set -eu
mkdir out
# node checks the lock and prints the version, the release URL, and then one
# "<sha256>  <name>" line per file, the format that `sha256sum -c` reads.
# Names and checksums are matched in full before any of them reaches a path.
plan="$(node -e '
const lock = JSON.parse(require("node:fs").readFileSync("release.lock.json", "utf8"));
const fail = (message) => {
  console.error("release.lock.json: " + message);
  process.exit(1);
};
const files = lock.files;
if (files === null || typeof files !== "object" || Array.isArray(files)) fail("files must be an object");
const names = Object.keys(files).sort();
if (lock.version === null && lock.url === null && names.length === 0) process.exit(0);
if (typeof lock.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(lock.version)) {
  fail("version must look like 1.2.3");
}
if (typeof lock.url !== "string" || !/^https:\/\/[^\s\/][^\s]*[^\s\/]$/.test(lock.url)) {
  fail("url must be an https URL with no slash at the end");
}
if (names.length === 0) fail("a pinned version needs files");
for (const name of names) {
  if (!/^archestra-(darwin|linux)-(arm64|x86_64)$|^archestra-windows-(arm64|x86_64)\.exe$/.test(name)) {
    fail("unexpected file name: " + name);
  }
  if (typeof files[name] !== "string" || !/^[0-9a-f]{64}$/.test(files[name])) {
    fail("the checksum of " + name + " must be 64 lowercase hex characters");
  }
}
console.log(lock.version);
console.log(lock.url);
for (const name of names) console.log(files[name] + "  " + name);
')"
if [ -z "$plan" ]; then
  echo "release.lock.json pins no release: this image holds no archestra program"
  exit 0
fi
version="$(printf '%s\n' "$plan" | sed -n 1p)"
url="$(printf '%s\n' "$plan" | sed -n 2p)"
sums="$(mktemp)"
printf '%s\n' "$plan" | sed 1,2d > "$sums"
cd out
# BusyBox wget has a read timeout (-T) and no retry option, so retry here.
while read -r _ name; do
  attempt=1
  until wget -q -T 60 -O "$name" "$url/$name"; do
    if [ "$attempt" -ge 3 ]; then
      echo "ERROR: could not download $url/$name" >&2
      exit 1
    fi
    attempt=$((attempt + 1))
    sleep 5
  done
done < "$sums"
sha256sum -c "$sums"
chmod 0755 archestra-*
rm "$sums"
printf '{ "version": "%s" }\n' "$version" > manifest.json
ARCHESTRA_CLI_RELEASE

FROM node:24.22.3-alpine3.23@sha256:3946fb783fdce8a2812136ea694bc95c698c4f4096f3fd18568dc27a8ac389dc AS base

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

RUN corepack prepare pnpm@11.9.0 --activate

# Dependencies stage
FROM base AS deps
WORKDIR /app

# Copy package files for all workspaces
# pnpm-workspace.yaml contains pnpm v11 project settings.
# turbo.json deliberately NOT copied here: `pnpm install` never reads it, and
# including it made every turbo.json edit bust this stage's ~30s install layer.
# The builder stage below copies it alongside the source files.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
COPY backend/package.json backend/
COPY frontend/package.json frontend/
COPY shared/package.json shared/
COPY archestra-rs/napi-loader/package.json archestra-rs/napi-loader/
COPY archestra-rs/sandbox-rs/package.json archestra-rs/sandbox-rs/
COPY archestra-rs/app-runtime-rs/package.json archestra-rs/app-runtime-rs/
COPY archestra-rs/image-rs/package.json archestra-rs/image-rs/
COPY archestra-rs/openappa-rs/package.json archestra-rs/openappa-rs/
COPY archestra-rs/router-rs/package.json archestra-rs/router-rs/

# Install all dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# CVE-2026-33671: Next.js bundles picomatch 4.0.3 at dist/compiled/picomatch/.
# pnpm overrides cannot reach this vendored copy; upstream has not re-vendored
# yet (tracked at vercel/next.js#92950). Replace it with the 4.0.4 package tree.
# The path resolves through the symlink frontend/node_modules/next → .pnpm/next@.../node_modules/next,
# so overwriting once updates every reference.
RUN set -eux; \
    cd /tmp; \
    wget -q -O picomatch-4.0.4.tgz https://registry.npmjs.org/picomatch/-/picomatch-4.0.4.tgz; \
    echo "515b5ab666558ed9a117483a310892aede54a68dd78f2d8db6604513e578571c  picomatch-4.0.4.tgz" | sha256sum -c -; \
    target=/app/frontend/node_modules/next/dist/compiled/picomatch; \
    rm -rf "$target"/*; \
    tar -xzf picomatch-4.0.4.tgz --strip-components=1 -C "$target"; \
    rm -f picomatch-4.0.4.tgz; \
    grep -q '"version": "4.0.4"' "$target/package.json"

# <----- Rust dependency cache ----->
# Alpine's packaged rustc lags platform/rust-toolchain.toml; take that release from the official musl image.
FROM rust:1.97.1-alpine3.23@sha256:c4a364ddbf684fe038e6fa6a4f25b30c8dc85247423e0e660676ece0d17be4a2 AS rust-toolchain

FROM base AS rust-builder-base
WORKDIR /app
RUN apk add --no-cache build-base openssl-dev pkgconf
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
COPY --from=rust-toolchain /usr/local/cargo/bin /usr/local/cargo/bin
# Cargo's own home stays /root/.cargo, where the registry cache mounts. The
# unknown-linux-musl targets link statically by default, which drops cdylibs.
ENV RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH \
    RUSTFLAGS="-C target-feature=-crt-static"
# Use the builder's installed OpenSSL for PostgreSQL TLS. Cross-builds outside
# this image use the vendored musl dependency from openappa-rs instead.
ENV OPENSSL_NO_VENDOR=1
# Cargo fetches OpenAPPA at the revision pinned in openappa-rs/Cargo.toml and
# Cargo.lock, including the runtime's plugin fingerprint inputs. No sibling
# checkout or additional Docker build context is required.

FROM rust-builder-base AS rust-deps
ARG TARGETARCH
COPY archestra-rs/Cargo.toml archestra-rs/Cargo.lock ./archestra-rs/
COPY archestra-rs/vendor/dagger-sdk-0.21.11 ./archestra-rs/vendor/dagger-sdk-0.21.11
COPY archestra-rs/sandbox-core/Cargo.toml ./archestra-rs/sandbox-core/
COPY archestra-rs/sandbox-rs/Cargo.toml archestra-rs/sandbox-rs/build.rs ./archestra-rs/sandbox-rs/
COPY archestra-rs/app-runtime-core/Cargo.toml ./archestra-rs/app-runtime-core/
COPY archestra-rs/app-runtime-rs/Cargo.toml archestra-rs/app-runtime-rs/build.rs ./archestra-rs/app-runtime-rs/
COPY archestra-rs/image-core/Cargo.toml ./archestra-rs/image-core/
COPY archestra-rs/image-rs/Cargo.toml archestra-rs/image-rs/build.rs ./archestra-rs/image-rs/
COPY archestra-rs/openappa-rs/Cargo.toml archestra-rs/openappa-rs/build.rs ./archestra-rs/openappa-rs/
COPY archestra-rs/router-core/Cargo.toml ./archestra-rs/router-core/
COPY archestra-rs/router-rs/Cargo.toml archestra-rs/router-rs/build.rs ./archestra-rs/router-rs/
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    for crate in sandbox-core sandbox-rs app-runtime-core app-runtime-rs image-core image-rs openappa-rs router-core router-rs; do \
      mkdir -p "archestra-rs/${crate}/src"; \
      printf 'pub fn dependency_cache_placeholder() {}\n' > "archestra-rs/${crate}/src/lib.rs"; \
    done && \
    cd archestra-rs && \
    case "${TARGETARCH}" in \
      amd64) RUST_TARGET=x86_64-unknown-linux-musl ;; \
      arm64) RUST_TARGET=aarch64-unknown-linux-musl ;; \
      *) echo "Unsupported Rust architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    for package in app_runtime_rs image_rs sandbox_rs openappa_rs router_rs; do \
      cargo build --release --locked \
        --target "${RUST_TARGET}" -p "${package}"; \
    done

# <----- Builder base stage ----->
FROM rust-builder-base AS builder-base

# Copy the dependency graph and native workspace before application source so
# backend/frontend/shared changes can reuse the exported N-API build layer.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/archestra-rs/sandbox-rs/node_modules ./archestra-rs/sandbox-rs/node_modules
COPY --from=deps /app/archestra-rs/app-runtime-rs/node_modules ./archestra-rs/app-runtime-rs/node_modules
COPY --from=deps /app/archestra-rs/image-rs/node_modules ./archestra-rs/image-rs/node_modules
COPY --from=deps /app/archestra-rs/openappa-rs/node_modules ./archestra-rs/openappa-rs/node_modules
COPY --from=deps /app/archestra-rs/router-rs/node_modules ./archestra-rs/router-rs/node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY archestra-rs/Cargo.toml archestra-rs/Cargo.lock ./archestra-rs/
COPY archestra-rs/vendor/dagger-sdk-0.21.11 ./archestra-rs/vendor/dagger-sdk-0.21.11
COPY archestra-rs/napi-loader ./archestra-rs/napi-loader
COPY archestra-rs/sandbox-core ./archestra-rs/sandbox-core
COPY archestra-rs/sandbox-rs ./archestra-rs/sandbox-rs
COPY archestra-rs/app-runtime-core ./archestra-rs/app-runtime-core
COPY archestra-rs/app-runtime-rs ./archestra-rs/app-runtime-rs
COPY archestra-rs/image-core ./archestra-rs/image-core
COPY archestra-rs/image-rs ./archestra-rs/image-rs
COPY archestra-rs/openappa-rs ./archestra-rs/openappa-rs
COPY archestra-rs/router-core ./archestra-rs/router-core
COPY archestra-rs/router-rs ./archestra-rs/router-rs

# These tasks stay outside Turbo's shared cache because their artifacts are
# platform-specific. This Docker layer is architecture-scoped and exportable,
# so ordinary application source changes no longer recompile Rust. Touch real
# sources after importing dummy-crate fingerprints so Cargo always recompiles
# local crates while retaining the manifest-keyed dependency artifacts.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=bind,from=rust-deps,source=/app/archestra-rs/target,target=/app/archestra-rs/target,rw \
    find archestra-rs -type f -path '*/src/*.rs' -exec touch {} + && \
    pnpm --filter @archestra/sandbox-rs \
         --filter @archestra/app-runtime-rs \
         --filter @archestra/image-rs \
         --filter @archestra/openappa-rs \
         --filter @archestra/router-rs build

# The constrained frontend build uses the dev-lite Bash entrypoint.
RUN apk add --no-cache bash

# VERSION is intentionally declared after the native RUN. Build args implicitly
# participate in following RUN cache keys, and every staging commit has a new
# VERSION even when the Rust workspace is unchanged.
ARG VERSION=dev

COPY --from=deps /app/backend/node_modules ./backend/node_modules
COPY --from=deps /app/frontend/node_modules ./frontend/node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY turbo.json ./
COPY vitest.resources.ts ./
COPY Tiltfile .env.example ./
COPY scripts ./scripts
COPY patches ./patches
COPY backend ./backend
COPY frontend ./frontend
COPY shared ./shared

ENV NEXT_TELEMETRY_DISABLED=1

# VERSION is exported as env var for child processes (used by Sentry source map upload)
ENV VERSION=${VERSION}

FROM builder-base AS rust-napi-musl-smoke
# Reuse manifest-keyed release dependencies, plus local cargo caches for the
# debug tests and test-helper feature variant unique to this stage.
# Smokes every N-API addon under musl: build the .node, then load and call it so
# a musl-specific loader/linkage regression fails here rather than at runtime.
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=bind,from=rust-deps,source=/app/archestra-rs/target,target=/app/archestra-rs/target,rw \
    --mount=type=cache,id=rust-napi-debug,target=/app/archestra-rs/target/debug \
    pnpm --filter @archestra/sandbox-rs --filter @archestra/app-runtime-rs --filter @archestra/image-rs --filter @archestra/openappa-rs --filter @archestra/router-rs check:musl

# <----- Builder stage ----->
FROM builder-base AS builder

# Use Docker secrets to securely pass various sensitive environment variables during build
# These environment variables are NOT persisted in the final image
#
# SENTRY_AUTH_TOKEN is used by backend/frontend builds to upload source maps
# SENTRY_URL points to the EU region where the archestra org is hosted
#
# https://docs.docker.com/build/building/secrets/#using-build-secrets
# https://docs.docker.com/build/building/secrets/#target
# Native artifacts were built in builder-base before application source was
# copied. Include shared's synthetic build task so its source remains in the
# backend/frontend Turbo cache keys while excluding the four N-API tasks.
RUN --mount=type=cache,target=/app/.turbo \
    --mount=type=cache,target=/app/frontend/.next/cache \
    --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    SENTRY_URL=https://de.sentry.io/ \
    pnpm exec turbo build --filter=@backend --filter=@frontend \
      --filter=@archestra/shared --only

# Assemble the production backend with `pnpm deploy` — pnpm's recommended
# monorepo packaging step (https://pnpm.io/cli/deploy). It produces a
# self-contained /prod/backend whose node_modules includes every workspace
# dependency (the four NAPI crates, @archestra/napi-loader, @archestra/shared)
# alongside their transitive production deps, with each crate able to resolve
# @archestra/napi-loader from a nested store. This replaces the old hand-rolled
# COPY of each crate's *.node / index.cjs into a workspace-shaped, root-hoisted
# node_modules (the layout that dropped @archestra/napi-loader and crashed the
# image with MODULE_NOT_FOUND).
#
# Ordering matters: this runs after both build steps, so the compiled *.node
# addons already exist in each crate dir. deploy copies them via the crates' `files`
# globs — it never rebuilds (install scripts are disabled repo-wide).
#
# --legacy keeps pnpm's original deploy implementation, which does not require
# inject-workspace-packages=true. We deliberately avoid enabling that setting:
# injecting would copy workspace packages into node_modules instead of
# symlinking them, changing the dev/Tilt layout and breaking the NAPI crates'
# watch-mode rebuilds. --legacy scopes the deploy semantics to this build step
# only, leaving local development untouched. The frontend is intentionally not
# deployed here: `next build` already emits a self-contained standalone server
# (frontend/.next/standalone), which we copy directly below.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --filter=@backend --prod --legacy /prod/backend

# Trim the deployed tree to what the server loads: drop the optional peers
# pnpm resolved for better-auth and drizzle-orm (Next.js with its SWC binary,
# Vitest with msw/vite/TypeScript, PGlite), plus every third-party source map
# and type declaration. The server keeps its own dist/*.map for
# --enable-source-maps. About 700 MB of the 1.4 GB tree; the script fails the
# build if the bundle ever imports a package it removes.
COPY docker/scripts/prune-backend-deploy.mjs /tmp/prune-backend-deploy.mjs
RUN node /tmp/prune-backend-deploy.mjs /prod/backend

# <----- Runtime stage (shared by both published images) ----->
# Everything both images run: the backend, the frontend, the Node supervisor
# (docker/scripts/supervisor.mjs), git, kubectl and the Dagger CLI. Two images
# are built on it:
#   unified-slim  the Kubernetes image (archestra/platform:<version>-slim, the
#                 Helm chart's default): no bundled PostgreSQL, no quickstart.
#   unified       the docker run image (archestra/platform:<version>): adds
#                 PostgreSQL and the quickstart's docker CLI, KinD, manifests and
#                 Dagger Engine archive.
# Both share these layers, so the second costs one build of its own layers and
# a registry stores and serves the shared ones once.
#
# The base is Docker's hardened Node image (https://docs.docker.com/dhi/),
# built by Docker from Docker's package builds with its own provenance, SBOM
# and VEX. Its -dev variant here, for apk and the packages below; the docker
# run image also needs its shell. The Kubernetes image is the distroless
# variant with this stage's files copied on (unified-slim).
# Same Node release and Alpine branch as the builder stages above, so their
# native addons load here. Pulling it needs a Docker login (`docker login
# dhi.io`, any Docker account); CI logs in where it builds this file
# (.github/actions/dhi-login). The organization's base-image check verifies
# its signature with Docker's signing key (supply-chain-policy/base-images.toml
# in archestra-ai/.github).
# The same hardened Node release without the -dev tools: no shell, no apk, only
# node and its libraries. The Kubernetes image is built on it (unified-slim).
# Keep its digest on the same Node release as the -dev pin below.
FROM dhi.io/node:24.22.3-alpine3.23@sha256:056085462c7ee6d47db4e10ab26a9ff63c6cb4c1b88473096ec9c3660345cb54 AS runtime-base-distroless
FROM dhi.io/node:24.22.3-alpine3.23-dev@sha256:15790f002ac9021e621e5cbd5321fc341051d7288ad250823e11268542bf49dc AS runtime
WORKDIR /app
# The hardened image runs as UID 1000 by default. This stage installs packages,
# and the full image starts as root (see the archestra user below).
USER root

ARG VERSION=dev
ARG TARGETARCH

ENV NODE_ENV=production
# disable telemetry for next.js
ENV NEXT_TELEMETRY_DISABLED=1

ENV ARCHESTRA_VERSION=${VERSION}
# 127.0.0.1, not `localhost`: the API and the Next.js server both bind IPv4
# only (backend config.ts pins the API to 0.0.0.0; supervisor.mjs starts Next with
# HOSTNAME=0.0.0.0), while `localhost` resolves to ::1 first — getaddrinfo
# applies RFC 6724 precedence regardless of /etc/hosts order, and musl has no
# /etc/gai.conf to retune it. Naming it would start every hop to the backend on
# an address with no listener. See issues #4917 and #6933, and LOOPBACK_HOST in
# shared/consts.ts.
#
# This is read at runtime by the SSR/API-route consumers (frontend proxy.ts,
# the generated API client, lib/config/config.ts). The Next.js `rewrites()`
# destination is NOT one of them: with output "standalone" it is resolved
# during `pnpm build` in the builder stage — where this variable does not
# exist — and frozen into .next/routes-manifest.json, so that path is governed
# by DEFAULT_INTERNAL_API_BASE_URL in shared/consts.ts instead.
ENV ARCHESTRA_INTERNAL_API_BASE_URL="http://127.0.0.1:9000"
ENV ARCHESTRA_API_BASE_URL=""
# Empty, so analytics follows its default: on in this production image, off
# when ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED is "true". Operators override it.
ENV ARCHESTRA_ANALYTICS=""
ENV ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED="false"
ENV ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING="false"
ENV ARCHESTRA_SENTRY_FRONTEND_DSN=""
ENV ARCHESTRA_SENTRY_ENVIRONMENT=""

# Idle keep-alive window (ms) for both HTTP servers in this image: the Fastify
# API reads it directly, and supervisor.mjs maps it onto KEEP_ALIVE_TIMEOUT for the
# Next.js standalone server, which otherwise falls back to Node's 5s default.
# It has to stay above the keep-alive timeout of whatever proxies the container
# (a cloud load balancer holds pooled connections far longer than 5s), so
# declaring it here gives every deployment a safe value while leaving it
# overridable per-deployment. See platform-deployment.md.
ENV ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS="620000"

# Cloud database CA bundle for SSL certificate validation
# This allows sslmode=require to work with AWS RDS and Google Cloud SQL.
# Node reads it through NODE_EXTRA_CA_CERTS. The OpenAPPA runtime connects
# through OpenSSL, which reads only the system store, so the RUN below also
# appends the bundle to /etc/ssl/certs/ca-certificates.crt.
ENV NODE_EXTRA_CA_CERTS="/etc/ssl/certs/cloud-database-ca-bundle.pem"

# Vendor cloud database CA bundles into the repository so image builds do not
# depend on live network fetches for trust roots.
COPY docker/certs/aws-rds-global-bundle.pem /tmp/aws-rds-ca.pem
COPY docker/certs/gcloud-sql-global.pem /tmp/gcloud-sql-ca.pem

RUN apk --no-cache upgrade && \
    # CVE-2026-6276, CVE-2026-5773: libcurl vulnerabilities (HIGH) fixed in 8.20.0-r0.
    # The bare `apk upgrade` above would pick up fixes, but this RUN layer is
    # Docker-cached on its instruction text and never re-runs against a newer
    # index — so the floors below guarantee the fixed versions whatever the cache holds.
    apk add --no-cache --upgrade "libcurl>=8.20.0-r0" && \
    # CVE-2026-63076, CVE-2026-63075, CVE-2026-63072, CVE-2026-54874, CVE-2026-18798,
    # CVE-2026-14457, CVE-2026-14456: OpenSSL vulnerabilities (HIGH) fixed in 3.5.8-r0.
    # Only the libraries are installed here (the `openssl` CLI package is not), so the
    # floors go on libcrypto3/libssl3.
    apk add --no-cache --upgrade "libcrypto3>=3.5.8-r0" "libssl3>=3.5.8-r0" && \
    # CVE-2026-4738 (zlib, CRITICAL, fixed in 1.4-r0) and CVE-2026-107891 (musl, HIGH,
    # fixed in 1.2.5-r24).
    apk add --no-cache --upgrade "zlib>=1.4-r0" "musl>=1.2.5-r24" "musl-utils>=1.2.5-r24" && \
    # The skill-marketplace clone endpoint needs the git CLI (materialize.ts) and
    # git-http-backend, the smart-HTTP CGI — which Alpine ships in git-daemon, not git.
    apk add --no-cache git git-daemon && \
    # Nothing here uses npm, yarn or corepack (pnpm runs only in the builder
    # stages; DB migrations call drizzle-kit directly), and they bring extra
    # dependencies and vulnerabilities. The hardened base installs them as
    # packages.
    for package in npm yarn corepack; do \
        if apk info --installed "$package" >/dev/null; then apk del --no-cache "$package"; fi; \
    done && \
    rm -rf /root/.npm /root/.node-gyp && \
    # Combine all CA bundles
    cat /tmp/aws-rds-ca.pem /tmp/gcloud-sql-ca.pem > /etc/ssl/certs/cloud-database-ca-bundle.pem && \
    cat /etc/ssl/certs/cloud-database-ca-bundle.pem >> /etc/ssl/certs/ca-certificates.crt && \
    rm -f /tmp/aws-rds-ca.pem /tmp/gcloud-sql-ca.pem && \
    ! command -v npm && ! command -v yarn && ! command -v corepack && \
    # Clean up
    rm -rf /tmp/*

# kubectl: the Dagger CLI reaches the code sandbox's engine through its
# kube-pod:// connection, which runs kubectl exec.
COPY --from=kubectl-builder /kubectl-binary /usr/local/bin/kubectl
RUN chmod +x /usr/local/bin/kubectl
# TODO: Once KinD releases a version compiled with Go >= 1.25.11, remove the kind-builder stage
# at the top of this file and restore the pre-built binary download below for faster builds.
# Track releases at: https://github.com/kubernetes-sigs/kind/releases
# RUN ARCH=$(uname -m) && \
#     if [ "$ARCH" = "x86_64" ]; then \
#         KIND_URL="https://kind.sigs.k8s.io/dl/v0.31.0/kind-linux-amd64"; \
#         KIND_SHA256="eb244cbafcc157dff60cf68693c14c9a75c4e6e6fedaf9cd71c58117cb93e3fa"; \
#     elif [ "$ARCH" = "aarch64" ]; then \
#         KIND_URL="https://kind.sigs.k8s.io/dl/v0.31.0/kind-linux-arm64"; \
#         KIND_SHA256="8e1014e87c34901cc422a1445866835d1e666f2a61301c27e722bdeab5a1f7e4"; \
#     else \
#         echo "ERROR: Unsupported architecture: $ARCH. KinD is only available for x86_64 and aarch64."; \
#         exit 1; \
#     fi && \
#     wget -O /usr/local/bin/kind "${KIND_URL}" && \
#     echo "${KIND_SHA256}  /usr/local/bin/kind" | sha256sum -c - && \
#     chmod +x /usr/local/bin/kind

# install the Dagger CLI. The Rust dagger-sdk used by the N-API sandbox addon needs it to open a session
# to the Dagger Engine; its npm postinstall download is blocked by
# ignore-scripts, so the binary is pinned and built from source above.
# keep DAGGER_VERSION in sync with dagger-sdk in archestra-rs/sandbox-core/Cargo.toml.
COPY --from=dagger-builder /dagger-binary /usr/local/bin/dagger
RUN chmod +x /usr/local/bin/dagger
# point the SDK at the baked-in CLI so it never downloads one at runtime.
ENV _EXPERIMENTAL_DAGGER_CLI_BIN=/usr/local/bin/dagger


# The image starts as root, which the quickstart needs (the Docker socket, the
# embedded PostgreSQL). It can also run as the archestra user (UID 10001), as
# the Helm chart's `archestra.runAsNonRoot` does, or as an arbitrary UID in
# group 0 (OpenShift). The paths those processes write belong to UID 10001 and
# are group-0 writable; any other path in the image stays read-only to them.
RUN addgroup -g 10001 archestra && \
    adduser -D -u 10001 -G archestra -h /home/archestra -s /sbin/nologin archestra && \
    mkdir -p /app/data /run/archestra /home/archestra && \
    chown 10001:0 /app/data /run/archestra /home/archestra && \
    chmod 0775 /app/data /run/archestra /home/archestra

VOLUME /app/data

# Runtime files. The backend and its full node_modules arrive as a single
# self-contained tree from the builder's `pnpm deploy` output (copied below),
# and the frontend ships as Next's standalone server, so no package manifests
# or `pnpm install` are needed in this stage.
COPY docker/scripts/docker-entrypoint.sh /docker-entrypoint.sh
COPY docker/scripts/docker-banner.mjs docker/scripts/entrypoint.mjs \
     docker/scripts/shutdown-budget.mjs docker/scripts/start-backend.mjs \
     docker/scripts/supervisor.mjs docker/scripts/with-vault-env.mjs /app/


# Copy the fully-assembled backend from the builder's `pnpm deploy` output.
# /prod/backend contains backend/dist, scripts, drizzle.config.ts and the
# migrations (scoped by the backend package's `files` field) plus a
# self-contained node_modules — including the four NAPI crates with their
# compiled *.node addons and a resolvable @archestra/napi-loader. This single
# tree replaces the previous per-crate .node/index.cjs copy choreography and
# the runtime `pnpm install`.
COPY --from=builder /prod/backend ./backend
RUN chmod +x /app/backend/scripts/start-production.sh

# The M-Files VAF Add On package built from this checkout's source (versioned
# file + stable-named copy). The backend's mfiles-vaf-add-on routes serve it
# from here (ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_PACKAGE_DIR), keeping
# the connector-beta gating and rate limits — which is why it lives outside
# the ungated static frontend/public tree.
COPY --from=vaf-add-on-builder /out/ ./mfiles-vaf-add-on/

# The released binaries of the archestra program and manifest.json with their
# version, as pinned by archestra-cli/release.lock.json (the
# archestra-cli-release stage above). The backend serves them to the users'
# computers from this directory. It is empty while the lock pins no release.
COPY --from=archestra-cli-release /out/ ./archestra-cli/

# Copy built frontend
COPY --from=builder /app/frontend/public ./frontend/public
COPY --from=builder /app/frontend/.next/standalone ./
# Next.js writes optimized images here at runtime, also as a non-root user.
RUN mkdir -p /app/frontend/.next/cache && \
    chown 10001:0 /app/frontend/.next/cache && \
    chmod 0775 /app/frontend/.next/cache

# Copy previous version's static assets first (from CI build context)
# Content-hashed filenames ensure no conflicts between versions
COPY docker/prev-static-assets/ ./frontend/.next/static/

# Copy current build's assets on top
COPY --from=builder /app/frontend/.next/static ./frontend/.next/static

# Keep a clean copy of ONLY this build's assets (not accumulated)
# CI will extract from this path for the NEXT deployment
COPY --from=builder /app/frontend/.next/static /static-assets-source/

RUN chmod +x /docker-entrypoint.sh

# Expose ports
EXPOSE 9000 9050 3000

# Health check. Probes a static public file rather than `/`: `/` redirects to
# /chat, and rendering a page fetches appearance settings from the backend,
# which put two request log lines into `docker logs` every 30 seconds.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/default-favicon.ico || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]

# Nothing at runtime uses apk itself, and a package manager in a running
# container only helps an intruder. `apk del` removes apk last and keeps its
# database, so image scanners still list every OS package. The docker run
# image below runs it as its last step, after its own packages; the Kubernetes
# image has no apk to begin with.

# <----- Kubernetes image (archestra/platform:<version>-slim) ----->
# The Helm chart's default image. The database is external and the cluster is
# real, so it carries no PostgreSQL and none of the quickstart's tooling. It is
# Docker's distroless hardened Node image plus the files the platform runs
# (docker/scripts/build-slim-rootfs.sh): no shell and no package manager, so a
# compromised process has neither to work with, and there are far fewer
# packages to patch. Its entrypoint and scripts are Node (entrypoint.mjs); the
# entrypoint says which image to use when started without a database URL or
# with ARCHESTRA_QUICKSTART. CI's Kubernetes e2e jobs build this target.
#
# Operators run commands with node, which is on PATH:
#   kubectl exec deploy/archestra-platform -- node /app/backend/dist/standalone-scripts/reset-user-password.mjs --email you@example.com
FROM runtime AS slim-rootfs
COPY --from=runtime-base-distroless /lib/apk/db/installed /tmp/base/installed
COPY --from=runtime-base-distroless /etc/passwd /etc/group /tmp/base/
COPY docker/scripts/build-slim-rootfs.sh /tmp/build-slim-rootfs.sh
# scanelf (pax-utils) lists the shared libraries each binary loads.
RUN apk add --no-cache pax-utils && \
    ROOTFS=/rootfs BASE=/tmp/base sh /tmp/build-slim-rootfs.sh

FROM runtime-base-distroless AS unified-slim
ARG VERSION=dev
COPY --from=slim-rootfs /rootfs/ /
# The runtime stage's environment, which a new base does not inherit. Keep the
# two lists equal (.github/scripts/test_platform_dockerfile.py checks it).
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV ARCHESTRA_VERSION=${VERSION}
ENV ARCHESTRA_INTERNAL_API_BASE_URL="http://127.0.0.1:9000"
ENV ARCHESTRA_API_BASE_URL=""
ENV ARCHESTRA_ANALYTICS=""
ENV ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED="false"
ENV ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING="false"
ENV ARCHESTRA_SENTRY_FRONTEND_DSN=""
ENV ARCHESTRA_SENTRY_ENVIRONMENT=""
ENV ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS="620000"
ENV NODE_EXTRA_CA_CERTS="/etc/ssl/certs/cloud-database-ca-bundle.pem"
ENV _EXPERIMENTAL_DAGGER_CLI_BIN=/usr/local/bin/dagger
WORKDIR /app
VOLUME /app/data
EXPOSE 9000 9050 3000
# Same probe as the docker run image, without wget.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/default-favicon.ico', { signal: AbortSignal.timeout(8000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Nothing in this image needs root, so it runs as the archestra user wherever
# it starts, not only under the chart's securityContext. Numeric, so
# Kubernetes can verify runAsNonRoot.
USER 10001
ENTRYPOINT ["node", "/app/entrypoint.mjs"]

# <----- docker run image (archestra/platform:<version>, default target) ----->
# The runtime plus the bundled PostgreSQL and the quickstart. This MUST remain
# the last stage: builds without --target (releases, quickstart CI, fork PRs,
# local docker build) get the full image.
FROM runtime AS unified
# Install PostgreSQL 18, pg_trgm (contrib), and pgvector from the hardened
# Alpine repository used by the Node base. Keep the major version and data
# directory unchanged so existing quickstart volumes remain readable. Restrict
# this install to DHI: the public Alpine community pgvector package is older.
RUN printf '%s\n' 'https://dhi.io/apk/alpine/v3.23/main' > /tmp/dhi-postgres-repositories && \
    apk --repositories-file /tmp/dhi-postgres-repositories add --no-cache \
        postgresql18=18.7-r0 postgresql18-contrib=18.7-r0 \
        pgvector-0-pg18=0.8.7-r1 su-exec=0.3-r0 && \
    rm /tmp/dhi-postgres-repositories && \
    # The postgres user comes with the package.
    mkdir -p /var/lib/postgresql/data /run/postgresql && \
    chown -R postgres:postgres /var/lib/postgresql /run/postgresql
VOLUME /var/lib/postgresql/data
EXPOSE 5432

# The quickstart's embedded KinD cluster: the docker CLI drives the host's
# Docker through the mounted socket. Built with Go 1.26.9 for the October 2026
# stdlib security fixes.
COPY --from=docker-cli-builder /docker-binary /usr/local/bin/docker
COPY --from=kind-builder /kind-binary /usr/local/bin/kind
RUN chmod +x /usr/local/bin/kind /usr/local/bin/docker
# Dagger Engine manifest applied into the embedded KinD cluster; backs the
# skill sandbox / code runtime (archestra__run_command and friends). Real
# deployments provision engines in code instead — the quickstart runs this one
# and points the backend at it through ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST.
COPY docker/dagger-engine.quickstart.yaml /app/dagger-engine.quickstart.yaml
# Upstream Agent Sandbox controller, applied into the embedded KinD cluster in
# quickstart mode: every Agent Runtime run is one of its Sandbox resources. Real deployments install it themselves;
# keep this version in step with the Agent Runtime prerequisites in
# docs/pages/platform-deployment.md.
ARG AGENT_SANDBOX_VERSION=v1.0.1
RUN wget -O /app/agent-sandbox.quickstart.yaml \
        "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${AGENT_SANDBOX_VERSION}/sandbox-with-extensions.yaml" && \
    echo "460c1e0272c793c98de82482aed57db1bddb0afcb979c19325dc6cc52289c44c  /app/agent-sandbox.quickstart.yaml" | sha256sum -c -
# The pre-baked Dagger Engine docker-archive. Quickstart kind-loads it into the
# embedded node at boot so the engine starts offline instead of pulling ~352MB
# from the registry on every run (KinD recreates its node each boot and its
# containerd cannot see the host Docker image cache) — see docker-entrypoint.sh
# and the commit that introduced the tar (#5275).
COPY --from=dagger-engine-image /dagger-engine.tar /app/dagger-engine.tar
RUN apk del --no-cache apk-tools && \
    test -s /lib/apk/db/installed && \
    ! test -e /usr/bin/curl && ! test -e /sbin/apk
