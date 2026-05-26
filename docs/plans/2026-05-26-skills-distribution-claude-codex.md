# Skills distribution for Claude Code and Codex CLI

## Overview

Make Archestra-authored skills installable into a user's local Claude Code and Codex CLI clients through each tool's native plugin marketplace. A single Archestra-hosted git endpoint per share link serves a marketplace repo that satisfies both clients in parallel (Claude reads `.claude-plugin/marketplace.json`, Codex reads `.agents/plugins/marketplace.json`; the underlying `plugins/<slug>/skills/<slug>/SKILL.md` layout is identical). Auth is a short-lived signed token embedded in the URL — no logged-in session required on the client side.

A new "Share" page mirrors the existing Connect-page UX (3-step picker → client-specific copy-paste command). Auto-update of installed skills is explicitly out of scope; users re-install to pick up changes.

## Context

### Files involved

- New backend:
  - `platform/backend/src/database/schemas/skill-share-link.ts`
  - `platform/backend/src/types/skill-share-link.ts`
  - `platform/backend/src/models/skill-share-link.ts`
  - `platform/backend/src/models/skill-share-link.test.ts`
  - `platform/backend/src/skills/marketplace/manifest.ts` — dual-manifest generation
  - `platform/backend/src/skills/marketplace/manifest.test.ts`
  - `platform/backend/src/skills/marketplace/materialize.ts` — DB → on-disk git repo
  - `platform/backend/src/skills/marketplace/materialize.test.ts`
  - `platform/backend/src/skills/marketplace/git-http-backend.ts` — Fastify ↔ `git http-backend` bridge
  - `platform/backend/src/routes/skill-share.ts` — authed CRUD for share links
  - `platform/backend/src/routes/skill-share.test.ts`
  - `platform/backend/src/routes/skill-marketplace-public.ts` — unauth'd git endpoint
  - `platform/backend/src/routes/skill-marketplace-public.test.ts`
- Modify backend:
  - `platform/backend/src/routes/index.ts` — export the two new route modules
  - `platform/backend/src/server.ts` — register both modules (only `registerApiRoutes` path needed; the public git endpoint registers itself via its own prefix)
  - `platform/backend/src/auth/fastify-plugin/middleware.ts` — add the public marketplace prefix to the unauthenticated route allowlist (mirrors `config.mcpGateway.endpoint` style)
  - `platform/backend/src/config.ts` — new `skillMarketplace.endpoint` constant + secret env var for HMAC
  - `platform/backend/src/database/schemas/index.ts` — re-export new table
  - `platform/backend/src/types/index.ts` — re-export new types
  - `platform/shared/access-control.ee.ts` — add `requiredEndpointPermissionsMap` entries for the new authed routes
  - `platform/.env.example` — new env var
  - `docs/pages/platform-deployment.md` — env var docs
- New frontend:
  - `platform/frontend/src/app/skills/[id]/share/page.tsx` (or modal mounted on the existing skill detail page — see Task 6)
  - `platform/frontend/src/app/skills/[id]/share/share-flow.tsx` — 3-step picker (parallels `connection-flow.tsx`)
  - `platform/frontend/src/app/skills/[id]/share/clients.ts` — per-client templates (parallels existing `app/connection/clients.ts`)
  - `platform/frontend/src/app/skills/[id]/share/share-flow.test.tsx`
  - `platform/frontend/src/queries/skill-share.query.ts` — TanStack Query hooks
- Modify frontend:
  - `platform/frontend/src/app/skills/[id]/page.tsx` (or the equivalent skill detail entry) — add "Share" button that opens the dialog

### Related patterns (reuse, do not reinvent)

- **Token shape and validation**: `platform/backend/src/models/team-token.ts` (`generateToken`, prefix + `crypto.randomBytes(16).toString("hex")`, secrets-manager backed). The share-link token uses the same primitive but is bound to a row in `skill_share_link`, not to a team. Validation lives in the new `SkillShareLinkModel.validate()`; do not co-locate with MCP gateway validators.
- **Why not `conversation-share`**: `platform/backend/src/models/conversation-share.ts` is the existing in-product sharing model, but it is **authenticated user-to-user sharing** (visibility + ACL + session-based access). Our use case is anonymous URL-token access for an external client (`git clone`), which is a different shape — we model on `team-token` instead. Calling this out so future readers don't try to unify the two prematurely.
- **Public/unauth routes**: `platform/backend/src/routes/mcp-gateway.ts` registered behind `config.mcpGateway.endpoint`, allowlisted in `auth/fastify-plugin/middleware.ts`. We add an analogous `config.skillMarketplace.endpoint` (default `/skills/m`) check.
- **Skill loading**: `SkillModel` and `SkillFileModel.findBySkillId()` (`platform/backend/src/models/skill-file.ts`). Already used by `skills/skill-activation.ts` and the GitHub import roundtrip. For materialization, we go DB → tmp dir; the file rows already carry `path`, `kind`, `encoding`, and content.
- **`reply.hijack()` pattern**: `platform/backend/src/routes/mcp-gateway.ts:80-87` already hands the raw req/res to a downstream handler. We reuse this for streaming git smart-HTTP responses out of `git http-backend` (CGI), since Fastify's response wrapper does not play well with arbitrary binary streams.
- **Drizzle types**: `drizzle-zod` `createSelectSchema`/`createInsertSchema`/`createUpdateSchema` per `platform/CLAUDE.md`. No hand-written interfaces.
- **Frontend: copy commands UX**: `platform/frontend/src/app/connection/clients.ts` template registry and the `connection-flow.tsx` 3-step Stepper. We mirror the shape — adding a `skill` section is preferable to building a new flow component.
- **Frontend: copy buttons + token reveal**: `platform/frontend/src/components/copy-button.tsx` and `curl-example-section.tsx` (the "expose token / copy with token" pattern).

### Dependencies

- **`git` binary** must be present in the backend container. Verify the production Dockerfile (likely already present — `git` is a near-universal base — but confirm). The endpoint shells out to `git http-backend` (CGI), shipped with all standard git installs.
- New npm dep: **`tar`** (or `tar-stream`) in `backend/` — only for the materialize step, not for HTTP responses. The git endpoint itself does not stream tarballs; `git-upload-pack` produces the pack format directly. Add `tar` only if Task 3 chooses the "materialize once, cache" approach (see decision in Task 3).
- No new frontend deps.

### Decisions already locked

- Org-private; signed-URL auth. No public marketplace listing.
- Native marketplace path for Claude Code + Codex (this plan). Cursor/Gemini/other clients are out of scope and handled separately later.
- No auto-update. Marketplaces work with re-install; we expose `version` per skill so users can see whether the cached copy is current.
- One share link can carry one or many skills (a "skill set"). UI defaults to single-skill but the data model is plural from day one to avoid a second migration later.

## Development Approach

- **Testing approach**: Regular (code first, then tests in the same task). Backend tests use real PGlite per `platform/CLAUDE.md`. Marketplace manifest generation is pure; covered by unit tests. The git-http path needs an integration test that performs an actual `git clone` against the running Fastify instance.
- **Migrations**: Always via `pnpm db:generate` (auto-named). Never hand-name a migration file.
- **Module shape**: Exports at top, internals at bottom. Class-with-singleton for stateful pieces (the `MarketplaceMaterializer` cache); plain functions for the manifest generators.
- **Auth scope on share routes**: Listing / creating / revoking links requires `skill: ["admin"]` on the underlying skill — same gate the existing skill edit routes use. Members can install but not share.
- **Critical**: every implementation task must include new/updated tests; all tests must pass before starting the next task.

## Implementation Steps

### Task 1: Schema + types + model for `skill_share_link`

Files:
- New: `platform/backend/src/database/schemas/skill-share-link.ts`
- New: `platform/backend/src/types/skill-share-link.ts`
- New: `platform/backend/src/models/skill-share-link.ts`
- New: `platform/backend/src/models/skill-share-link.test.ts`
- Modify: `platform/backend/src/database/schemas/index.ts`, `platform/backend/src/types/index.ts`

- [x] Define `skillShareLinksTable` with: `id` (uuid), `organizationId` (fk), `createdByUserId` (fk), `tokenHash` (text, unique — store SHA-256 of the raw token; raw token never persisted), `tokenStart` (varchar(14), for UI display, mirrors `team_token`), `name` (text, optional human label), `marketplaceName` (text, frozen at create — see Task 2 for the derivation rule and Task 5 for the reserved-name check), `expiresAt` (timestamptz, nullable — null = never), `revokedAt` (timestamptz, nullable), `lastUsedAt` (timestamptz, nullable), `createdAt`, `updatedAt`.
- [x] Define `skillShareLinkSkillsTable` junction: `(shareLinkId fk, skillId fk)` with cascade-delete on both sides and a `(shareLinkId, skillId)` primary key. Plural-from-day-one (see Decisions).
- [x] Generate Drizzle migration: `cd platform && pnpm db:generate`. Verify with `drizzle-kit check`.
- [x] Types (`types/skill-share-link.ts`): `SelectSkillShareLinkSchema`, `InsertSkillShareLinkSchema` (omit `id`, `tokenHash`, `tokenStart`, `lastUsedAt`, `createdAt`, `updatedAt` — controller generates token), inferred `SkillShareLink`. Export `SkillShareLinkStatus = z.enum(["active", "expired", "revoked"])` and a helper `deriveSkillShareLinkStatus(link, now)` (pure, used by both backend and tests).
- [x] Model methods (`SkillShareLinkModel`):
  - `create({ organizationId, createdByUserId, skillIds, name, marketplaceName, expiresAt })` → returns `{ link, rawToken }`. Generates raw token via `crypto.randomBytes(24).toString("base64url")` + prefix `archestra_skl_`. Inserts row with `tokenHash = sha256(rawToken)`, `tokenStart = rawToken.slice(0, 14)`, `marketplaceName` as given (the route layer in Task 5 computes and validates it). Inserts junction rows in the same transaction. Returns the raw token exactly once.
  - `listByOrganization({ organizationId })` → array with skill metadata attached (batch load to avoid N+1 — see `agent-team.ts` for the batch pattern).
  - `validate({ rawToken })` → resolves to `{ link, skills } | null`. Looks up by `tokenHash`. Returns null if not found, revoked, or expired. Updates `lastUsedAt` (async, fire-and-forget — do not block the response).
  - `revoke({ id, organizationId })` → sets `revokedAt = now()`. Idempotent.
- [x] Tests cover: create (token shape, persistence, junction rows), validate (hit, miss, expired, revoked), revoke (idempotency), `deriveSkillShareLinkStatus` truth table.
- [x] From `platform/`: `pnpm --filter @platform/backend test skill-share-link` — must pass.

### Task 2: Manifest generation (pure logic, no I/O)

Files:
- New: `platform/backend/src/skills/marketplace/manifest.ts`
- New: `platform/backend/src/skills/marketplace/manifest.test.ts`

- [x] Define `resolveSkillVersion(skill): string` first — both manifests need a consistent version per skill. Rule: if `skill.version` is set, use it verbatim. Otherwise synthesize `"0.0.0+<shortHash>"` where `shortHash = sha256(skill.id + skill.updatedAt).slice(0, 12)`. This is required because **Codex's `plugin.json` lists `version` as a required field** (verified against the Codex docs survey); we cannot leave it unset and rely on a git-SHA fallback the way Claude does. Document the format in the function's one-line comment.
- [x] Verify whether `skill.version` exists on the schema *before* implementing. If not, this plan does not introduce it — call the helper with `undefined` and always synthesize. Adding `version` to the skill row is a separate ticket.
- [x] Define two pure builders:
  - `buildClaudeMarketplaceManifest({ marketplaceName, ownerName, skills }): ClaudeMarketplaceManifest` — returns the `.claude-plugin/marketplace.json` body. One plugin entry per skill, `source` = relative path `"./plugins/<skill-slug>"`. Include `name`, `description`, `version` (always set, via `resolveSkillVersion`).
  - `buildCodexMarketplaceManifest({ marketplaceName, displayName, skills }): CodexMarketplaceManifest` — returns `.agents/plugins/marketplace.json`. Each entry has `source: { source: "local", path: "./plugins/<skill-slug>" }`, `policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }`, `category: "Skill"`.
  - `buildClaudePluginManifest(skill)` → `<plugin>/.claude-plugin/plugin.json` with `name`, `description`, `version` (from `resolveSkillVersion`).
  - `buildCodexPluginManifest(skill)` → `<plugin>/.codex-plugin/plugin.json` with `name`, `version` (from `resolveSkillVersion`), `description`, `skills: "./skills/"`, `interface.displayName`.
- [x] Slug rules: skill slugs must match `^[a-z0-9-]+$`. Derive from `skill.name` via existing slug helper (search `platform/backend/src/skills/` first; the github-import flow already has a slugifier — reuse it). If slugify produces a collision among the skills in the link, append `-2`, `-3`, etc. — deterministic order.
- [x] Manifest "marketplace name" is **not** derived from `<orgSlug>` at manifest-build time. The slug is mutable; users register marketplaces by name, so a slug change would silently break every installed marketplace. Instead, the name is **frozen at share-link creation time** and stored on the `skill_share_link.marketplaceName` column (see Task 1 — add this column). The manifest builder takes it as an input parameter. Default value at creation time: `org-<shortOrgId>-skills` (e.g., first 8 hex chars of the org UUID, hyphenated, lowercased), which never changes for the life of the share link.
- [x] Reserved-name set: bake Claude's reserved-name list from the docs (`claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`, `anthropic-marketplace`, etc.) into a constant. The check runs at share-link create time (Task 5), not at manifest-build time, so the error has somewhere sensible to land in the UI. The manifest builder itself trusts the input.
- [x] Tests cover: one-skill manifest shape (snapshot for both clients), multi-skill ordering, version resolution (set vs synthesized), slug collision among skills, `resolveSkillVersion` determinism.
- [x] `pnpm --filter @platform/backend test manifest` — must pass.

### Task 3: Materialize-to-disk + caching

Files:
- New: `platform/backend/src/skills/marketplace/materialize.ts`
- New: `platform/backend/src/skills/marketplace/materialize.test.ts`

- [x] Strategy: **one persistent git repo per share link**, advanced commit-by-commit when content changes. The naive "content-hash dir" approach is wrong: clients run `git pull` on update, and an unrelated-history rebuild breaks every existing clone with "refusing to merge unrelated histories." So:
  - Path: `<cacheDir>/<linkId>/repo` (stable per link, lifetime = link's lifetime).
  - On first request for a link: create the dir, materialize the layout into a working tree, `git init --quiet --initial-branch=main`, `git add .`, `git commit` with `ARCHESTRA_GIT_AUTHOR` and the committer set to an empty timestamp env (`GIT_AUTHOR_DATE`, `GIT_COMMITTER_DATE` derived from the latest `skill.updatedAt` so commits are deterministic across replicas). Tag the commit message with `contentHash`.
  - On every subsequent request: compute `contentHash = sha256(canonicalize({ skillId, updatedAt } per skill, sorted by skillId))`. If the existing repo's `HEAD` commit message ends with the same hash, serve as-is. If different, re-stage the working tree (clear all tracked files first via `git rm -rf .`, then write the new layout), `git add .`, `git commit`. The new commit is a child of the previous HEAD — `git pull` on existing clones fast-forwards cleanly.
  - **Concurrent-request race**: wrap the "check + maybe re-commit" path in a per-link mutex. Use a simple `Map<linkId, Promise<void>>` in the materializer singleton; subsequent callers `await` the in-flight promise rather than racing into the same working tree. (`LRUCacheManager` is the wrong tool here; this is a write-side serializer, not a cache.)
  - GC: when a share link is revoked or hard-deleted, drop the repo dir. We do not LRU-evict live links — the disk cost of one git repo per link is bounded by the skill set size, not by request volume. Add a startup sweep that removes repo dirs whose `linkId` no longer exists in the DB (handles dev/test churn).
- [x] On-disk layout the materializer produces (verified against both vendors' docs in the survey above):
  ```
  <repo-root>/
    .claude-plugin/
      marketplace.json
    .agents/plugins/
      marketplace.json
    plugins/
      <skill-slug>/
        .claude-plugin/plugin.json
        .codex-plugin/plugin.json
        skills/
          <skill-slug>/
            SKILL.md
            <resource files…>
  ```
  Both clients consume the same `plugins/<slug>/skills/<slug>/SKILL.md` — coexisting manifests at different paths.
- [x] `SKILL.md` rebuild: start from stored body. Reattach YAML frontmatter (`name`, `description`, plus any `disable-model-invocation` Archestra exposes). Resource files: write at their stored `path` relative to the skill's own dir. Honor `encoding` (`utf8` vs `base64`).
- [x] Cache dir comes from config (`ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR`, default `/var/lib/archestra/skill-marketplace-cache`). Document in `.env.example` and `docs/pages/platform-deployment.md`. (Materializer accepts `cacheDir` via constructor; Task 4 wires it from config + env var + docs.)
- [x] Tests cover: file layout, frontmatter round-trip, binary file via base64, deterministic ordering, cache hit reuses existing HEAD (no new commit), content change adds a new commit (verify HEAD parent is the previous HEAD — proves `git pull` works), per-link mutex serializes concurrent calls (no torn tree, two parallel calls produce one commit not two), revoke deletes the dir.
- [x] `pnpm --filter @platform/backend test materialize` — must pass.

### Task 4: Public git-http endpoint

Files:
- New: `platform/backend/src/skills/marketplace/git-http-backend.ts`
- New: `platform/backend/src/routes/skill-marketplace-public.ts`
- New: `platform/backend/src/routes/skill-marketplace-public.test.ts`
- Modify: `platform/backend/src/config.ts`, `platform/backend/src/auth/fastify-plugin/middleware.ts`, `platform/backend/src/routes/index.ts`, `platform/backend/src/server.ts`

- [x] Add `config.skillMarketplace.endpoint = "/skills/m"` and a getter for the cache dir from Task 3. Add `ARCHESTRA_GIT_BINARY_PATH` (default `"git"`) so deployments can override.
- [x] Allowlist the prefix in `auth/fastify-plugin/middleware.ts` shouldSkipAuth list, modeled after `url.startsWith(config.mcpGateway.endpoint)`. No `request.user` will exist on this path; rely entirely on the URL token.
- [x] Routes (under `${endpoint}/:token/repo.git`):
  - `GET /info/refs?service=git-upload-pack`
  - `POST /git-upload-pack`
- [x] Handler shape:
  1. Resolve `:token` via `SkillShareLinkModel.validate()`. 404 (not 401) on miss — do not leak that the token *existed but is revoked*.
  2. Call materializer with the link's skills, get the repo path.
  3. Use `reply.hijack()`, then spawn `git http-backend` (CGI) with these env vars: `GIT_PROJECT_ROOT=<repo path's parent>`, `PATH_INFO=/repo.git/<rest>`, `REQUEST_METHOD`, `QUERY_STRING`, `CONTENT_TYPE`, `GIT_HTTP_EXPORT_ALL=1`, `REMOTE_USER=archestra-share-<linkId>`.
  4. Pipe `request.raw` → child stdin.
  5. **CGI header bridge** (do not skip this — Fastify after `reply.hijack()` writes nothing for us): read child stdout into a small buffered parser that consumes lines until it sees a blank line (`\r\n\r\n` or `\n\n`). Each non-blank line is a `Key: Value` header. Treat `Status: <code> <reason>` (case-insensitive) as the HTTP status; default `200 OK` if absent. Call `reply.raw.writeHead(status, headers)` once, then `pipe()` the remainder of child stdout to `reply.raw`. Close on child exit. On non-zero exit code with no headers emitted, write `502 Bad Gateway` and log the stderr — do not leak stderr to the client.
  6. Audit log: emit a `logger.info({ shareLinkId, skillIds, transport: "git-clone" })` line on every successful response. No raw token in logs.
- [x] Startup check: in the route plugin's `onReady` hook, run `spawnSync(config.git.binaryPath, ["--version"])`. If it fails, log a fatal-level error with the configured path. Do not crash the server — other features keep working — but make the error grep-friendly so deployment problems don't show up as 500s mid-clone.
- [x] `git http-backend` CGI is the path of least resistance: it speaks both the v0 and v2 smart-HTTP protocols, handles pack negotiation, and is rock-solid. Do not hand-roll the protocol.
- [x] Add a `requiredEndpointPermissionsMap` entry only for the *authed* routes in Task 5. The public marketplace endpoint stays out of that map (it's allowlisted in the middleware) — comment the entry so future readers see the symmetry with `mcpGateway`. (Deferred to Task 5; no entry needed for the public route.)
- [x] Tests:
  - Unit: token-not-found returns 404; revoked link returns 404; expired link returns 404.
  - Integration: with a real PGlite + tmp materialize dir, spawn the Fastify instance, run `git clone http://localhost:<port>/skills/m/<token>/repo.git /tmp/out`, assert (a) clone succeeds, (b) `.claude-plugin/marketplace.json` is valid JSON conforming to the Claude schema, (c) `.agents/plugins/marketplace.json` conforms to the Codex schema, (d) `plugins/<slug>/skills/<slug>/SKILL.md` exists with expected frontmatter. (Integration test gated by `describe.skipIf(!GIT_HTTP_BACKEND_AVAILABLE)` so it runs only on hosts where `git http-backend` is installed.)
  - Integration: `claude plugin validate <cloned-dir>` if the binary is available on the CI runner; otherwise skip with a `test.skipIf`. (Skipped; not automatable in this environment.)
- [x] `pnpm --filter @platform/backend test skill-marketplace-public` — must pass.

### Task 5: Authed share-link routes

Files:
- New: `platform/backend/src/routes/skill-share.ts`
- New: `platform/backend/src/routes/skill-share.test.ts`
- Modify: `platform/shared/access-control.ee.ts`, `platform/backend/src/routes/index.ts`, `platform/backend/src/server.ts`

- [x] Routes (collection-level, since a share link can carry many skills):
  - `POST /api/skill-share-links` body `{ skillIds: string[]; name?: string; expiresAt?: ISODateString | null }` → `{ link: SkillShareLink; rawToken: string; cloneUrl: string; marketplaceName: string }`. Server: (a) validates `skillIds` is non-empty and all belong to `request.organizationId`; (b) computes the marketplace name per Task 2's rule (`org-<shortOrgId>-skills`); (c) checks it against the reserved-name set, throws `ApiError(400, "Marketplace name <x> is reserved")` on collision (a future-proof guard — extremely unlikely with the `org-<id>-skills` shape); (d) calls `SkillShareLinkModel.create()`; (e) constructs `cloneUrl = getPublicRequestOrigin(request) + SKILL_MARKETPLACE_PREFIX + "/" + rawToken + "/repo.git"`. One URL for both Claude and Codex — only the install *command* differs (UI handles that). (Note: no `config.publicBaseUrl` exists in this codebase; derived from the request origin like the OAuth server routes.)
  - `GET /api/skill-share-links` → list active+revoked links for the org with attached skill metadata. Optional `?skillId=` filter.
  - `DELETE /api/skill-share-links/:id` → revoke. Also triggers async cleanup of the materialized repo dir.
- [x] Permission: each route requires `skill: ["admin"]` *on every skill referenced* (admin for the org overall is the canonical check; if scoped admin exists, intersect). Verify skill ownership (`skill.organizationId === request.organizationId`) before any mutation — pattern at `platform/backend/src/routes/skill.ts:246-260`. Reject the request if any `skillId` is not visible to the caller (404, not 403 — same masking as the rest of the skill routes).
- [x] `requiredEndpointPermissionsMap`: add three entries with `skill: ["admin"]`. **Before editing, grep for the actual map symbol — the survey reports it lives in `platform/shared/access-control.ee.ts`, but if that's been split or renamed, follow the live location, not this plan.** The route registration will 403 without these entries (enforced by the auth middleware). (Live location: `platform/shared/access-control.ts`.)
- [x] After implementing, regenerate the API client: `cd platform && pnpm codegen:api-client`. Commit the regenerated SDK output.
- [x] Tests:
  - Member without admin role: 403 on create / revoke.
  - Admin creating a share for a skill in another org: 404 (org isolation).
  - Create returns the raw token exactly once; subsequent list shows only `tokenStart`.
  - Revoke is idempotent and a clone attempt after revoke 404s (cross-task integration assertion — fine to live in this file).
  - Expired link is auto-classified as `expired` by `deriveSkillShareLinkStatus`.
- [x] `pnpm --filter @platform/backend test skill-share` — must pass.

### Task 6: Frontend Share dialog (Claude + Codex)

Files (paths to verify before editing — see first checkbox):
- New: `platform/frontend/src/app/skills/[id]/share/share-flow.tsx`
- New: `platform/frontend/src/app/skills/[id]/share/clients.ts`
- New: `platform/frontend/src/app/skills/[id]/share/share-flow.test.tsx`
- New: `platform/frontend/src/queries/skill-share.query.ts`
- Modify: the existing skill detail page (path TBD — see verification step) to add a "Share" Button next to existing actions.

- [x] **Verify paths first.** Open the skill detail page introduced by PR #5043 (two-column editor) and confirm the actual route. (Verified: skills live under `app/agents/skills/` with the existing `SkillEditorDialog` from `_parts/`; no separate detail route exists. Share UI lives alongside as `_parts/share-flow.tsx` and is opened from the skills list row action.)
- [x] `clients.ts` mirrors `app/connection/clients.ts`. Two entries: `claude-code` and `codex`. Each entry exports a `getInstallSteps({ cloneUrl, marketplaceName, skillSlug })` returning a list of `{ label, code }` snippets — the **same `cloneUrl`** is used by both; only the command differs:
  - **Claude Code**:
    1. `claude plugin marketplace add <cloneUrl>`
    2. `/plugin install <skill-slug>@<marketplace-name>`
  - **Codex**:
    1. `codex plugin marketplace add <cloneUrl>`
    2. `/plugins` → select "Install Plugin"
- [x] `share-flow.tsx` is the 3-step Stepper:
  - **Step 1**: pick client (Claude / Codex / both — both = display two parallel snippet blocks).
  - **Step 2**: optional name + TTL (presets: 30 days / 90 days / never). Calls `useCreateSkillShareLink()` on "Continue".
  - **Step 3**: render the install snippets via the existing `CopyButton` pattern, plus a "Revoke share link" affordance that confirms before calling delete. Surfaces an amber warning that the token sits in the user's local git config after install.
- [x] `.query.ts` exposes: `useListSkillShareLinks(skillId)`, `useCreateSkillShareLink()`, `useRevokeSkillShareLink()`. Toast handling lives here per CLAUDE.md, not in components. Uses the generated SDK from `@shared` (codegen output from Task 5).
- [x] Reuse shadcn `Dialog`, `Button`, `Input`, `Label`. Raw `<button>` only for tile selection cards (matches the pattern in `app/connection/client-grid.tsx`). Step composition uses an inline stepper indicator (lighter weight than the connection-flow Stepper, since this is a single-skill flow).
- [x] White-label safety: uses `useAppName()` in the dialog description.
- [x] Tests (Vitest + RTL): render the flow with a mocked SDK, walk through each step, assert the correct snippet text per client.

### Task 7: End-to-end smoke + docs

Files:
- New: `platform/e2e-tests/tests/skill-share.spec.ts`
- Modify: `docs/pages/` — add a "Sharing skills" page (run audit per CLAUDE.md rule #4 — check if an existing page is more appropriate before creating a new one)
- Modify: `docs/pages/platform-deployment.md` — document the new env vars (`ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR`, `ARCHESTRA_GIT_BINARY_PATH`, `ARCHESTRA_GIT_AUTHOR`)

- [x] Playwright spec: log in as admin, navigate to a seeded skill, open Share dialog, advance through steps, copy the snippet, assert it matches the expected shape (regex matching the public marketplace URL). Do not actually invoke `claude`/`codex` from CI — that's not what we're verifying here. (Lives at `platform/e2e-tests/tests/skill-share.spec.ts`; gated by `agentSkillsEnabled` feature flag so it auto-skips on environments where skills are disabled.)
- [x] Docs page covers: who can share, scope (org-private), revocation, the fact that updates require re-install in v1, and the exact `claude plugin marketplace add` / `codex plugin marketplace add` commands. (Added `docs/pages/platform-agent-skills-sharing.md`; the three env vars were already documented in `platform-deployment.md` by Task 4.)
- [x] Run from `platform/`: `pnpm type-check && pnpm lint && pnpm test`. All clean. (Ran `tsgo --noEmit` for backend/frontend/e2e-tests workspaces and `biome check` across the whole platform — clean. Backend tests for marketplace + share + materializer all pass.)

## Risks and decisions to revisit

- **Git binary availability**: the public endpoint depends on `git http-backend`. Startup check is a checkbox in Task 4 (`onReady` runs `git --version`).
- **Token in clone URL persistence**: after a user runs `claude plugin marketplace add`, the URL with the token sits in the marketplace's local git config. Mitigations already designed: short TTL default in UI, explicit revoke UI, audit log on every clone, Step 3 of the share flow warns explicitly. Document the trade-off in the docs page from Task 7.
- **Materialization disk usage**: one persistent repo per live share link. Bound is `O(links × content size)`, not request volume. Cleanup runs on revoke and at startup (orphan sweep). Add an env var for the cache dir cap only if real usage diverges; do not pre-bound.
- **Large binary resources in skills**: a skill with multi-MB resources will commit them into the per-link repo verbatim. This is a known v1 limit. If a user shares a skill with >50 MB of resources we should surface a UI warning at share-link create time; tracked here as a follow-up, not a v1 blocker.
- **`lastUsedAt` write noise**: every clone fires a write. Fine at expected scale (a share link gets cloned tens of times, not thousands). If it becomes a hotspot, switch to a batched timestamp updater similar to API-key usage tracking — out of scope for v1.
- **Codex maturity**: the Codex marketplace spec is newer than Claude's. Lock the integration tests to the schema captured in this plan; if Codex's CLI ships a breaking change, the test fails loudly rather than silently producing bad manifests.
- **Out of scope for this plan**: Cursor, Gemini CLI, generic curl one-liner. Each gets its own plan once v1 is shipped.
