# Testing Guide

## 0. Prerequisites & database setup

- **Postgres running** and reachable from the backend.
- **Node + pnpm** installed (see main README for versions).
- A **`.env`** in `platform/` with at least `ARCHESTRA_DATABASE_URL` set.

### 0.1 One‑shot DB setup (recommended for local dev)

From **platform** root (Windows PowerShell):

```powershell
.\scripts\SETUP-DATABASE-NOW.ps1
```

This script:

- Creates the dev database and user (if needed).
- Applies all migrations, including `0099_tools_meta_mcp_apps.sql` (adds `tools.meta` used by MCP apps/E2E).

After this, you can run backend/frontend/dev scripts and E2E without manual SQL.

### 0.2 Manual / scripted DB setup

If you prefer more control:

- **PowerShell helpers** (from `platform` root):
  - `.\scripts\setup-db.ps1` – base DB bootstrap.
  - `.\scripts\setup-db-auto.ps1` / `setup-db-simple.ps1` / `setup-db-final.ps1` – variants for different environments.
- **Raw SQL**: `scripts/setup-db.sql` contains the schema/user bootstrap you can apply directly in Postgres.
- **Standalone TypeScript helper**:
  - `backend/src/standalone-scripts/setup-dev-db.ts` – programmatic dev DB setup (run via `pnpm ts-node` or similar).

Once DB exists, always make sure migrations are up to date:

```bash
cd platform
pnpm db:migrate
```

---

## 1. Unit and integration tests (Vitest)

From **platform** root:

```bash
pnpm test -- --run
```

- **Backend:** `platform/backend` — Vitest, many test files (models, routes, auth, etc.).
- **Frontend:** `platform/frontend` — Vitest, component and lib tests.
- **Shared:** runs if configured in turbo.

No app or DB required for most tests; backend tests use an in-process/test DB where applicable.

---

## 2. E2E tests (Playwright)

E2E tests require the app running: **frontend on port 3000**, **backend on port 9000**.

**Before running E2E:** Postgres must be running, and migrations applied from platform root: `pnpm db:migrate`. The backend needs `ARCHESTRA_DATABASE_URL` (from `platform/.env` or `backend/.env`). The script copies `platform/.env` into `backend/.env` so the backend sees DB and other env.

### Option A: One-shot script (recommended)

From **platform** root:

**PowerShell (Windows):**
```powershell
.\scripts\run-e2e-with-app.ps1
```

**Bash (Linux / macOS / WSL):**
```bash
./scripts/run-e2e-with-app.sh
```
(Ensure the script is executable: `chmod +x scripts/run-e2e-with-app.sh`.)

The script uses **backend-first startup** so the frontend never hits ECONNREFUSED:

1. Frees ports 3000 and 9000.
2. Copies `platform/.env` to `backend/.env` and writes `frontend/.env.development.local` so the frontend proxies to `http://127.0.0.1:9000`.
3. **Phase 1:** Starts **backend only** (`pnpm --filter @backend dev`), waits 90s for build+seed, then polls `http://127.0.0.1:9000/health` for up to ~10 minutes.
4. **Phase 2:** Starts **frontend only** (`pnpm --filter @frontend dev`), waits for http://localhost:3000.
5. **Optionally starts Vault** via Docker (`dev/docker-compose.vault.ee.yml`). If Docker is unavailable or Vault fails to start, the script continues and credentials-with-vault tests are skipped automatically.
6. Runs **full Playwright suite**: setup, credentials-with-vault (skipped when Vault not at localhost:8200), chromium, firefox, webkit, SSO, API.
7. Stops backend, frontend, and Vault (if started); restores env.

### Test Vault E2E (credentials-with-vault)

Runs the credentials-with-vault E2E tests against **real HashiCorp Vault** in Docker. **Docker Desktop (or the Docker daemon) must be running** before you run the script.

From **platform** root:

**PowerShell:**
```powershell
.\scripts\run-e2e-vault.ps1
```

**Bash:**
```bash
chmod +x scripts/run-e2e-vault.sh
./scripts/run-e2e-vault.sh
```

This script: checks that the Docker daemon is running, frees ports 3000/9000/8200, starts Vault via `dev/docker-compose.vault.ee.yml`, enables KV v2 at `secret`, starts backend and frontend, runs only the **credentials-with-vault** Playwright project, then stops everything. If Docker isn’t running or compose fails, the script exits with a clear error—fix the environment and re-run.

If the backend never becomes ready, check Postgres, `pnpm db:migrate`, and that `tools.meta` exists (migration `0099_tools_meta_mcp_apps.sql`).

### Option B: Manual (two terminals)

**Terminal 1 — start app:**

```bash
cd platform
pnpm dev
```

Wait until frontend (3000) and backend (9000) are up. For local backend, ensure `frontend/.env.development.local` has:

- `ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000`
- `NEXT_PUBLIC_ARCHESTRA_API_BASE_URL=http://127.0.0.1:9000`

**Terminal 2 — run E2E:**

```bash
cd platform
pnpm test:e2e
```

E2E config and base URL are in `platform/e2e-tests/` (e.g. `playwright.config.ts`, `consts.ts`). Default UI base URL is `http://localhost:3000`; admin credentials come from env or defaults (e.g. `admin@example.com` / `password`).

---

## 3. Manual testing

- Start the app (`pnpm dev` from platform).
- Open http://localhost:3000 and go through critical flows: login, agents, chat, MCP catalog, settings, etc.
- Use browser dev tools and network tab to confirm API calls hit the backend (9000) and no ECONNREFUSED.

---

## 4. Exploratory testing with Playwright CLI (codegen)

With the app already running (frontend on 3000, backend on 9000):

```bash
cd platform/e2e-tests
pnpm exec playwright codegen http://localhost:3000
```

This opens the Playwright Inspector and a browser; actions are recorded and can be copied as test code. Optional: `--target=javascript` for a Node script.

---

## 5. Helper scripts & shortcuts

These live in `platform/scripts/` and are useful when iterating locally:

- **`dev-for-e2e.ps1` / `dev-for-e2e.sh`**  
  Starts backend + frontend in an E2E‑friendly way (backend‑first, env wired correctly) and leaves them running so you can:
  - Run `pnpm exec playwright test` manually,
  - Or use Playwright UI / codegen against a stable dev stack.

- **`run-e2e-with-app.ps1` / `run-e2e-with-app.sh`**  
  Described above in **2. E2E tests** – one‑shot backend‑first + full Playwright run.

- **`run-e2e-vault.ps1` / `run-e2e-vault.sh`**  
  Described above – real Vault + `credentials-with-vault` only.

- **`test-all.ps1`**  
  Convenience wrapper to:
  - Run unit/integration tests (`pnpm test -- --run`),
  - Then run the main E2E flows (via the scripts above).  
  Exact sequence is kept in the script; use this when you want a “one button” local CI.

- **`backend/scripts/dev-with-server.mjs`**  
  Backend‑only dev script that:
  - Clears `backend/dist/`,
  - Runs a one‑time build with `tsdown`,
  - Starts `tsdown --watch` and `node dist/server.mjs` in parallel.  
  Useful if you want a pure Node backend dev loop instead of `pnpm --filter @backend dev`.

- **Frontend health route**  
  - `frontend/src/app/health/route.ts` exposes a simple health endpoint from the Next.js app, primarily for liveness checks in environments where you need a frontend‑side `/health`.

---

## Troubleshooting

- **Backend never becomes ready** — The script writes backend output to `platform/backend-e2e.log` (and `backend-e2e.log.err`). Check those after a failure. Ensure Postgres is running, run `pnpm db:migrate` from platform root, and that `ARCHESTRA_DATABASE_URL` is set in `platform/.env` or `backend/.env`. To debug interactively: `pnpm --filter @backend dev` in a separate terminal.
- **ECONNREFUSED 127.0.0.1:9000** — Backend is not listening. Check: Postgres running, `pnpm db:migrate`, backend logs for errors (e.g. missing `tools.meta`). Apply migration 0099 or run `ALTER TABLE tools ADD COLUMN IF NOT EXISTS meta jsonb;` if needed.
- **Port 3000 or 9000 in use** — Stop the other process or use the script’s port-freeing step; the script will exit if ports remain in use.
- **E2E sign-in 500** — When backend is up, check backend logs for auth errors (e.g. better-auth, DB, or env). Ensure default admin is seeded and matches E2E credentials.
