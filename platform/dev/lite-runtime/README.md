# Lite Agent Runtime image

A runtime image for Archestra work that runs the dev stack as plain processes:
PostgreSQL, the backend dev server and the Next.js dev server. No Docker, kind,
Helm or Tilt inside the pod, so the pod needs no privilege and no Docker volume,
starts in half the time of the full stack and idles at a tenth of its CPU (see
"Lite and full stacks side by side" below).

It is not a replacement for the full image. It covers the common cases: a
preview of a branch, manual QA, code review with a running app, unit tests, and
the Playwright lite projects (with `--keycloak`, the identity-provider and JWKS
specs too). Work that needs Kubernetes stays on the full image: MCP server
installs (the orchestrator), nested Agent Runtime, the Dagger code runtime and
Vault.

Lite is the default: a Lobster Agent runs this kind of image, unprivileged, at
every tier, by default M (4 CPU, 8 GiB, 16 GiB limit). A run whose work needs a
different size starts a run of its own Agent at that tier (up to the Agent's
largest tier) with `start_agent_run` and hands over its branch. Work that needs
Kubernetes goes to one of a few separate Tilt Agents that run the full image,
privileged, at tier L; any lite Agent can hand work to any of them. Nothing
switches a running workspace in place. Inside a run,
`$ARCHESTRA_AGENT_RUNTIME_TIER` and `$ARCHESTRA_AGENT_RUNTIME_MAX_TIER` name the
Pod's size and the largest it may move to, and
`$ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST` and
`$ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT` what that size gives.

## What the image adds to the public agent image

The public `agent-claude-code` image already has Node 24, pnpm, Rust,
PostgreSQL 18 with pgvector, Playwright with Chromium, tmux and the GitHub CLI.
This image adds:

- `rustfmt`, `rust-analyzer` and the musl targets that `platform/rust-toolchain.toml`
  asks for. The toolchain home is read-only for the workspace user, so without
  them the first `cargo metadata` fails.
- A warm pnpm store for the `WORKSPACE_REF` commit under `/home/node/.pnpm-store`
  (pnpm 11 keeps the store next to the HOME that holds the project, whatever
  `store-dir` says). A task's `pnpm install` hard-links from it: 178 MB of
  `node_modules` on disk instead of a 2.4 GB download.
- The frontend's pinned Playwright Chromium next to the shared browser.
- A Java 21 runtime (the Temurin JRE) and the WireMock standalone jar, the LLM
  provider stub the Playwright suite uses. Keycloak is not in the image:
  `up --keycloak` downloads the pinned release into the state dir on first use.
- `archestra-dev-lite`, a wrapper that runs `platform/scripts/dev-lite.sh` in
  the task checkout. The repository owns the stack commands; the image only
  warms caches.

Native addons (`app-runtime-rs`, `image-rs`, `openappa-rs`, `router-rs`,
`sandbox-rs`) are not in the image. `dev-lite.sh` installs the ones CI
publishes for main's `platform/archestra-rs` tree (`scripts/napi-prebuilt.mjs`,
about a second) and builds them with cargo only for a changed tree (about 6
minutes at 16 CPUs, longer at 2 or 4).

## Use

In a checkout inside the runtime:

```bash
archestra-dev-lite up            # PostgreSQL, migrations, backend :9000, frontend :3000
archestra-dev-lite status        # processes with RSS, cgroup memory, disk, URLs
archestra-dev-lite logs backend  # or db, migrate, frontend, wiremock, a2a, keycloak
archestra-dev-lite up --e2e      # also WireMock :9092 and the A2A fixture :9191; frontend as a production build
archestra-dev-lite up --e2e --keycloak   # also Keycloak :30081 with the e2e realm
archestra-dev-lite e2e           # Playwright chromium + api projects against this stack; identity-providers too with Keycloak
archestra-dev-lite restart       # down, then up
archestra-dev-lite down          # stop; data and caches stay
```

`platform/scripts/dev-lite.sh --help` lists every option. Each component runs
in its own tmux session (`tmux -L archestra-dev-lite ls`), so a shell tool's
process-group cleanup cannot stop the stack. The backend and frontend run
their dev commands directly (`tsdown`, `next dev`), not through
`pnpm dev --filter`: the pnpm and turbo wrappers cost eight extra Node
processes and about 1 GB of RSS.

The image sets `ARCHESTRA_DEV_BACKEND_WATCH=false`: the backend builds once and runs
without the tsdown watcher, which keeps about 1.2 GB resident. After backend
edits run `archestra-dev-lite reload backend` (about 15 s). If the server
exits, it restarts after a second; five exits within 60 s of starting stop the
loop until the next reload. `ARCHESTRA_DEV_BACKEND_WATCH=true` brings the watcher
back.

## Build

```bash
cd platform/dev/lite-runtime
docker build -t archestra-lite-runtime:dev .
```

`BASE_IMAGE` must be a public agent image tag that carries PostgreSQL 18 and
Rust (commit tags from `971714fea` on; `:latest` did not on 2026-10-29).
`WORKSPACE_REF` is the commit whose dependencies are warmed. The build needs
BuildKit.

## Measurements

Measured on 2026-10-29 on an `n2-standard-16` GCE VM (16 vCPU, 62 GiB), the
stack running in a container from this image with host networking and no CPU
or memory limit. Base image `agent-claude-code:f80e33a17`, checkout at
`6c84e3bf3`.

| What | Result |
| --- | --- |
| Image size (`docker image inspect`) | base 1.22 GB, lite 2.42 GB |
| Cold start, fresh container and clone to ready stack | 2 min 11 s (clone 18 s, `pnpm install` 90 s, addons installed, `initdb` 2 s, 610 migrations 5 s, servers 16 s) |
| Same with an archestra-rs change (no published addons) | add about 6 min of `cargo` for the five addons |
| Warm restart (`restart`) | 54 s |
| CPU for the whole cold start | 99 CPU-seconds; idle stack 0 % of a core |
| Memory right after start | 2.7 GB anonymous, 3.4 GB total RSS: backend 2.4 GB (tsdown watcher 1.2 GB, server 0.9 GB), frontend 0.6 GB, PostgreSQL 0.3 GB |
| Memory after compiling six pages | 5.4 GB anonymous: frontend 3.6 GB (Next dev server and turbopack workers), backend 2.3 GB, PostgreSQL 0.3 GB; cgroup 10.2 GB with file cache |
| Disk per workspace | `node_modules` 178 MB (hard links), `frontend/.next` 0.6 to 1.4 GB, PostgreSQL data 75 MB |
| `up --e2e` warm restart with WireMock and the A2A fixture, before e2e mode served a production build | 21 s; WireMock 218 MB RSS, fixture 61 MB |
| Playwright `chromium` project, `agents`, `auth-redirect` and `chat` specs, against the dev server at 16 vCPU | 25 passed, 1 flaky (the Anthropic chat spec passed on retry), 3.2 min |

### Compared with the full Tilt stack on the same VM

The full stack (`tilt up` on the VM host, kind cluster, default namespace, the
same checkout) was measured after the same page warm-up. Host processes are
RSS, which double-counts shared pages, so compare orders of magnitude.

| What | Full Tilt stack | Lite stack |
| --- | --- | --- |
| App dev servers (Next dev, tsdown watcher, backend) | 2.8 GB + 1.2 GB + 0.9 GB | 3.6 GB + 1.2 GB + 0.9 GB after six pages |
| Fixed overhead | second Next dev server for the integration tests 0.5 GB, Tilt 0.2 GB, six pnpm/turbo wrappers 0.7 GB, drizzle studio 0.3 GB, kind node 0.8 GB working set (3.1 GB with its file cache, 1.8 GB of images inside), dockerd and containerd 0.25 GB | PostgreSQL 0.3 GB |
| Host or container processes, total RSS | 7.5 GB plus the kind node and Docker | 3.4 GB after start, about 6 GB after six pages |
| Idle CPU | 16 % of a core (kind, Tilt, watchers) | 0 % |
| Privilege | privileged pod, Docker volume, nested Kubernetes | none |
| Disk per workspace | `node_modules` 2.4 GB, kind node image about 1 GB, images inside the node 1.8 GB, build caches | `node_modules` 178 MB, `.next` up to 1.4 GB |

The application's own dev servers cost about the same in both. What the lite
image removes is the fixed overhead around them, the privilege, and the file
cache that Kubernetes counts against the pod's limit; that is where the 24 GiB
went.

Part of that overhead is cheap to remove from the full stack as well, and the
Tilt stack now does so (`dev/Tiltfile.dev`, `dev/Tiltfile.database`,
`dev/run-backend-dev.sh`): the integration-test Next server and Drizzle Studio
start on demand instead of by default, and the two dev servers launch without
the pnpm/turbo wrapper chain. Measured with the same method, ten minutes idle
after six pages, the full stack's host processes went from 5.2 GB to 3.7 GB of
RSS and from 26 to 7 Node processes; idle CPU stayed at 15 % of a core, 11 %
of it the kind node. Turning the backend watcher off as well
(`ARCHESTRA_DEV_BACKEND_WATCH=false`, the default inside an Agent Runtime)
brought host RSS to 2.2 GB; `tilt trigger pnpm-dev-backend` then rebuilds and
restarts the backend in about 18 s. What remains after those changes is kind
(0.6 GB anonymous, 3.2 GB with its file cache), dockerd and containerd (0.25
GB), Tilt (0.16 GB), the Playwright MCP pod the backend seeds into the cluster
(0.13 GB plus a 414 MB image), and the privilege; only running without
Kubernetes removes those.

Staging Agent Runtime pods running the full image over seven days (86 pods,
Cloud Monitoring, 2026-10-22 to 2026-10-29) peaked at 7.4 GiB of non-evictable
memory at the median, 16.8 GiB at p90 and 23.2 GiB at most. CPU averaged 0.39
cores at the median, and each pod's busiest 5 minutes reached 5.3 cores at the
median and 6.5 at p90. The Lobster agents' requests were cut on that evidence
from 7 CPU / 24 GiB to 3.5 CPU / 12 GiB with an 18 GiB limit, which fits two
runs on an `n2d-standard-8` node instead of one.

The tiers' default sizes, with no CPU limit (administrators change any of them
under Settings > Agents > Runtime tiers):

| Tier | Request | Memory limit | Used for |
| --- | --- | --- | --- |
| S | 2 CPU, 4 GiB | 8 GiB | reviews, scripts, light edits; the lite stack fits, as measured below |
| M | 4 CPU, 8 GiB | 16 GiB | the default: a dev stack, tests and builds |
| L | 8 CPU, 16 GiB | 32 GiB | large builds and test suites, work that ran out of memory at M, and the Tilt Agents' full image (its p90 of 16.8 GiB above fits) |

L keeps no warm spares by default: its runs are rare and an idle spare holds 8
CPU and 16 GiB.
The frontend dev server is the largest and most variable consumer. The e2e
mode (`up --e2e`) already serves a production build instead (see below); doing
the same for preview-only runs would cost a build per start and is a candidate
follow-up.

## Lite and full stacks side by side

Measured on 2026-10-30 on an `n2-standard-16` VM, both stacks on the same
commit, each in a container set up like a runtime Pod. `--cpus` held each stack
to the CPU request of its size, so these are the slow case; a Pod with spare
node CPU runs faster. One run per configuration.

| | Lite, 2 CPU / 8 GiB (S) | Full Tilt, 4 CPU / 16 GiB (M) | Full Tilt, 2 CPU / 8 GiB |
| --- | --- | --- | --- |
| Cold start, clone to ready | 63 s (90 CPU-seconds) | 121 s (191) | 148 s (191) |
| Warm restart | 26 s | 43 s | not measured |
| Six pages, first visit / warm | 82 s / 7.9 s | 58 s / 5.9 s | 91 s / 14.8 s |
| Backend reload, median of 3 | 16 s, see below | 17 s | 19 s |
| vitest file, pure / with the database | 13 s / 19 s | 13 s / 18 s | not measured |
| Idle CPU | 0.02 cores | 0.19 cores | 0.18 cores |
| Peak memory, anonymous | 5.3 GiB | 8.4 GiB | 5.9 GiB |
| Disk: home volume + Docker volume | 6.3 GB | 12.7 GB | 9.7 GB |

The full stack's extra cost is kind, Tilt, dockerd and the Playwright MCP Pod:
about 0.17 cores at idle, 1 GiB of memory and 3.5 to 7 GB of Docker disk. At
equal CPU the lite stack starts in less than half the time and serves pages at
least as fast. The full stack at 4 CPU wins first page compiles because of its
CPU, not its stack.

A first run measured the lite reload at 31 s: the container's PID 1 never
reaped exited processes, and `dev-lite.sh` counted those zombies as a server
still running until its 15 s cap. It now counts only live processes, and caps a
backend stop at 5 s like Tilt's backend runner. With a PID 1 that reaps, the
reload took 16 s.

At 2 CPU and 8 GiB the Playwright suite against the Next dev server first
timed out on pages compiling for the first time, and once the specs had
opened their pages the dev server held about 5 GB, so Chromium and the dev
server were killed for memory. With `--e2e` the frontend is therefore a
production build served by its standalone server, as CI and the released image
serve it: it compiles nothing while the specs run and holds a few hundred MB.
After frontend edits in e2e mode, `reload frontend` rebuilds it; `restart`
without `--e2e` returns to the dev server. On 2 to 4 CPUs `e2e` also runs fewer
workers with scaled timeouts (`E2E_WORKERS`, `E2E_TIMEOUT_SCALE`), and the
build runs one Next worker per CPU.

Measured on 2026-10-30 on the same VM, held to 2 CPU and 8 GiB, on a clean
clone:

| e2e mode at 2 CPU / 8 GiB (S) | Result |
| --- | --- |
| Frontend build | 112 s with 2 workers; whole stack at most 5.5 GiB anonymous memory |
| `up --e2e` on a running dev stack | 123 s, most of it the build |
| `reload frontend` | 44 s |
| Standalone frontend server | 160 MB idle, 480 MB after the full suite |
| Full default `e2e`, 115 tests | 97 passed, 3 skipped, 15 failed, none flaky; 15.4 min; at most 3.5 GiB anonymous memory, no process killed for memory |

All 15 failures needed what the lite stack does not run: 9 need Kubernetes
(the MCP server runtime and the orchestrator) and 6 need Keycloak (JWKS auth
for the LLM proxy and the MCP gateway). Those tests now carry the tags
`@needs-kubernetes` and `@needs-keycloak`, and `e2e` names what the stack lacks
in `E2E_UNAVAILABLE`, so they report as skipped with that reason instead of
failing (`e2e-tests/dependencies.ts`). A value set by hand wins; an empty one
skips nothing.

### Keycloak

`up --e2e --keycloak` runs Keycloak as a plain process on `127.0.0.1:30081`
with the e2e realm (`helm/e2e-tests/files/archestra-realm.json`: the
`archestra-oidc` client and the test users), configured as the Docker lite
harness configures its container: the browser-facing issuer is
`http://localhost:30081`, backchannel URLs follow the request, the realm's
features are on. The backend gets `http://localhost:30081` among its trusted
origins, so `up --keycloak` restarts a running backend once. `e2e` then runs
the `identity-providers` project as well, stops naming `keycloak` in
`E2E_UNAVAILABLE`, and points the backend-side Keycloak URL
(`E2E_KEYCLOAK_BACKEND_URL`) at the loopback. The request is recorded in the
state dir until `down`: a Keycloak that exits afterwards fails `up`, `wait` and
`e2e` with a pointer to its log instead of quietly dropping the coverage
(`scripts/dev-lite.test.sh` covers this).

The distribution is the stock release pinned in `dev-lite.sh` (version and
SHA-256), about 170 MB, downloaded into `~/.archestra-dev-lite/keycloak` the
first time; `ARCHESTRA_DEV_LITE_KEYCLOAK_DIST` points at an unpacked
distribution instead. CI runs a custom build for the ID-JAG receiver
(`helm/e2e-tests/keycloak-pr46048`); no lite spec needs it. Keycloak needs
Java 21, which the lite image ships. The realm is imported on the first start
and then lives in Keycloak's dev-mode database under the distribution's
`data/` directory; `reset` removes it with the state dir. The heap is capped at
1 GiB (`JAVA_OPTS_KC_HEAP`), as Keycloak would otherwise size it from 70% of
the Pod's memory.

## Not covered

- MCP server installs and anything else the Kubernetes orchestrator does. The
  stack points `ARCHESTRA_ORCHESTRATOR_KUBECONFIG` at a file that does not
  exist, so the backend logs "MCP Server Runtime is disabled" once at startup
  and `/ready` reports `sandbox: disabled`. Remote (HTTP) MCP servers still
  work. The `p4_shim_reconcile` periodic task logs one warning every 5 minutes.
- Nested Agent Runtime, the Dagger code runtime, Vault, and the `api-k8s`,
  `hibernation` and `vault-k8s` Playwright projects. Specs in the default `e2e`
  run that need Kubernetes are tagged and skip (see above); so are the
  Keycloak-backed ones unless the stack was started with `--keycloak`.

## PGlite was tried and does not fit

`pglite-server` (PGlite over the PostgreSQL wire protocol, with pgvector and
`pg_trgm`) applied all 610 migrations in 7 seconds once `CONCURRENTLY` was
stripped, and answered multiplexed clients and advisory locks. The backend
then failed at seed time with `prepared statement
"archestra_read_recipients_by_scopes" already exists`: PGlite is a single
session, and the socket server multiplexes every pooled connection through
it, so named prepared statements, `SET` state and concurrent transactions from
different connections collide. NOTIFY also never reaches another connection.
The backend's pool and transaction model need one server session per
connection, which only a real PostgreSQL gives. PostgreSQL 18 from the base
image costs 0.3 GB of RSS and 2 seconds of `initdb`, so there is nothing to
gain there anyway.
