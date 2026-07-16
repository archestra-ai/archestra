# Fix: quickstart OAuth metadata rejects its own frontend proxy's origin (MCP auth fails on remapped ports)

## Context

**Repro (verified live):** quickstart container `archestra` maps host `4400→3000` (frontend) and `4401→9000` (backend). The Connect page hands out `http://localhost:4400/v1/mcp/<slug>`, but Claude Code's MCP SDK fails RFC 9728 validation: the protected-resource metadata advertises `http://localhost:9000/...` instead.

```
SDK auth failed: Protected resource http://localhost:9000/v1/mcp/my-gateway-admin-760416
does not match expected http://localhost:4400/v1/mcp/my-gateway-admin-760416 (or origin)
```

**Root-cause chain:**

1. Connect UI derives displayed URLs from `window.location.origin` when `NEXT_PUBLIC_ARCHESTRA_API_BASE_URL` is unset — `platform/frontend/src/lib/config/config.ts:72-84` → shows `localhost:4400`.
2. `/v1/*` and `/.well-known/*` are proxied by Next.js rewrites to the internal backend `http://localhost:9000` — `platform/frontend/next.config.ts:140-146`. Next forwards the real origin as `x-forwarded-host: localhost:4400`.
3. `getPublicRequestOrigin` rejects that forwarded host because the allowlist only contains configured origins — `platform/backend/src/routes/request-origin.ts:60-70`. Container log confirms: `forwardedHost: "localhost:4400", allowed: ["localhost:3000"]`. It falls back to the direct (internal) Host → `resource: http://localhost:9000/...` → client-side mismatch → auth always fails.

**Why it's a product bug (not just user misconfig):** the container runs with `ARCHESTRA_QUICKSTART=true`, and quickstart's documented networking model deliberately accepts *any* origin (strategy comment at `platform/backend/src/config.ts:154-177` — "It's ok if someone will decide to access Archestra from the mobile phone"). Yet the OAuth origin derivation contradicts both that design and the URLs the product itself displays. Every quickstart user with remapped ports or LAN/hostname access hits a cryptic dead end in a flow the product generated for them. (In production, requiring `ARCHESTRA_API_BASE_URL` / `ARCHESTRA_TRUST_PROXY` is correct hardening — unchanged.)

**Outcome:** in quickstart mode, OAuth metadata follows the origin the client actually used; the Connect flow works out of the box regardless of port mapping.

## Change (minimal)

1. **`platform/backend/src/routes/request-origin.ts`** (~line 56): extend the existing trust branch to `config.api.trustProxy || config.isQuickstart`, with a short comment referencing the quickstart networking strategy (forwarded header comes from the bundled same-container Next.js proxy; quickstart accepts arbitrary origins by design). `config.isQuickstart` already exists (`platform/backend/src/config.ts:1835`) — no new env var, no config change.

2. **Test — new `platform/backend/src/routes/request-origin.test.ts`** (helper currently has zero direct tests):
   - quickstart on + un-allowlisted `x-forwarded-host` → returns the forwarded origin (the bug case).
   - quickstart off → falls back to direct host (pins current behavior; the existing `oauth-server.test.ts` case "ignores forwarded public origin when proxy trust is disabled" must stay green).
   - Mock config per `archestra-dev-backend-tests` conventions (`configModuleMock` overrides) in the new file only, keeping `oauth-server.test.ts` un-mocked in the fast path. Either unit-call `getPublicRequestOrigin` with a faked request or `app.inject` through `oauthServerRoutes` like the existing test file — whichever reads cleaner with the config mock.

3. **Docs — `docs/pages/platform-deployment.md`**: one sentence under `ARCHESTRA_TRUST_PROXY` (or `ARCHESTRA_API_BASE_URL`): quickstart mode trusts the bundled proxy's forwarded origin automatically, so custom port mappings need no extra env. Follow `archestra-docs-writer` skill for the edit.

Deliberately **not** doing: Connect-page mismatch warning UI (backend fix makes the displayed URLs correct in quickstart; production misconfig remains a docs matter), any change to dev/production allowlist logic.

**Security note:** trusting `X-Forwarded-Host` in quickstart only echoes per-request metadata (resource / authorization_servers / WWW-Authenticate) back to the requester — no shared cache to poison; consistent with quickstart's accept-all-origins CORS stance and loopback-by-default port binding.

## Immediate local unblock (independent of the fix)

An existing container can work today by recreating it with `-e ARCHESTRA_API_BASE_URL=http://localhost:4400`, or by pointing the MCP client at the direct backend port `http://localhost:4401/v1/mcp/<slug>`.

## Verification

1. `cd platform/backend && pnpm vitest run src/routes/request-origin.test.ts` (new tests) and `src/routes/oauth-server.test.ts` (regression).
2. Runtime check of the changed logic: run the local backend with `ARCHESTRA_QUICKSTART=true`, then
   `curl -H "x-forwarded-host: localhost:4400" http://localhost:9000/.well-known/oauth-protected-resource/v1/mcp/x`
   → `resource` must be `http://localhost:4400/v1/mcp/x`. Repeat without the flag → stays `http://localhost:9000/...`.
3. `pnpm lint && pnpm type-check` from `platform/`.
4. Final smoke (post-image-build, optional): the 4400/4401 container + `claude /mcp` → Authenticate completes.

Work on a branch; commit locally; no push/PR without approval (repo rule).
