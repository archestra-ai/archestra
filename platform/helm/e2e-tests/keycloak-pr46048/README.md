# Keycloak PR 46048 Image

This directory documents the custom Keycloak image used by the e2e test chart for both local development and CI.

## Provenance

- Upstream PR: `keycloak/keycloak#46048`
- PR URL: `https://github.com/keycloak/keycloak/pull/46048`
- Fork branch: `Hitachi:ISSUE-43971-IDJAGReceiver`
- Source commit: `5afbf425b19a3f4b4a1b5a37cba890fcfee977a4`
- Published image: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/keycloak:pr46048-5afbf42`
- Platforms: `linux/amd64`, `linux/arm64`

## Why this image exists

The standard Keycloak `26.5.x` release is sufficient for normal token exchange, but the ID-JAG receiver work discussed in `keycloak/keycloak#43971` is still in progress upstream. This image tracks the PR build we want to evaluate in Archestra's local and CI e2e environments.

## Build steps

These are the commands used to build the image from the PR source.
The `Makefile` in this directory wraps the same workflow and is the preferred entrypoint.

```bash
cd platform/helm/e2e-tests/keycloak-pr46048
make all
```

## Important build note

The PR branch did not build cleanly with the stock upstream Maven path on this machine.
The working recipe used for the published image was:

1. Run a real JS workspace install in `js/` with `pnpm install --frozen-lockfile`
2. Run a real JS workspace build in `js/` with `pnpm build`
3. Patch `js/pom.xml` to:
   - remove `--ignore-scripts` from the `pnpm-install` execution
   - remove the `pnpm-build` execution entirely
4. Run the normal Maven distribution build:
   - `./mvnw -B -pl quarkus/dist -am install -DskipTests -DskipExamples -DskipProtoLock=true`

That patch is build-only. The published image still uses Keycloak runtime bits built from:
- commit `5afbf425b19a3f4b4a1b5a37cba890fcfee977a4`

Equivalent manual steps:

```bash
TMP_DIR="$(mktemp -d /tmp/keycloak-idjag-pr46048.XXXXXX)"
git clone --depth 1 --branch ISSUE-43971-IDJAGReceiver https://github.com/Hitachi/keycloak.git "$TMP_DIR"
cd "$TMP_DIR"
git fetch --depth 1 origin 5afbf425b19a3f4b4a1b5a37cba890fcfee977a4
git checkout 5afbf425b19a3f4b4a1b5a37cba890fcfee977a4

docker run --rm --platform linux/amd64 \
  -v "$TMP_DIR":/workspace \
  -w /workspace/js \
  node:24-bookworm \
  bash -lc 'corepack enable >/dev/null 2>&1 && pnpm install --frozen-lockfile'

docker run --rm --platform linux/amd64 \
  -v "$TMP_DIR":/workspace \
  -w /workspace/js \
  node:24-bookworm \
  bash -lc 'corepack enable >/dev/null 2>&1 && pnpm build'

python3 - <<'PY' "$TMP_DIR/js/pom.xml"
from pathlib import Path
import re
import sys
pom_path = Path(sys.argv[1])
text = pom_path.read_text()
text = text.replace(
  "install --prefer-offline --frozen-lockfile --ignore-scripts",
  "install --prefer-offline --frozen-lockfile",
  1,
)
pattern = re.compile(r"\s*<execution>\s*<id>pnpm-build</id>.*?</execution>", re.S)
new_text, count = pattern.subn("\n", text, count=1)
if count != 1:
  raise SystemExit(f"expected 1 pnpm-build execution, got {count}")
pom_path.write_text(new_text)
PY

docker run --rm --platform linux/amd64 \
  -e PATH=/workspace/js/node:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v "$TMP_DIR":/workspace \
  -v "$HOME/.m2":/root/.m2 \
  -w /workspace \
  maven:3.9-eclipse-temurin-21 \
  ./mvnw -B -pl quarkus/dist -am install -DskipTests -DskipExamples -DskipProtoLock=true

cp quarkus/dist/target/keycloak-*.tar.gz quarkus/container/

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f quarkus/container/Dockerfile \
  --build-arg KEYCLOAK_DIST="$(basename quarkus/container/keycloak-*.tar.gz)" \
  -t europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/keycloak:pr46048-5afbf42 \
  --push \
  quarkus/container
```

## Push steps

The build command above already pushes the multi-arch manifest. Before running it:

```bash
gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet
docker buildx inspect --bootstrap archestra-multiarch
```

If `gcloud auth configure-docker` is using expired credentials, refresh them first:

```bash
gcloud auth login
```

## Helm wiring

The e2e Keycloak chart uses this image through:

- `platform/helm/e2e-tests/values.yaml`

That means:

- local `tilt trigger e2e-test-dependencies`
- CI jobs that install `platform/helm/e2e-tests`

both use the same image tag by default.
