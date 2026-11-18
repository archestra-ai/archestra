# Sites

A **site** is one Archestra install (one Helm release, usually one cluster or
cloud). Several sites can share one PostgreSQL database. This module is the
shared layer they coordinate through: who each site is, which sites are alive,
and a signed channel to send work to another site. The LLM proxy uses the
identity and registry only: every site calls providers directly. Nothing
calls the channel yet;
it is here for features that must run work on a particular site (for example
MCP servers deployed to one cluster).

User docs: `docs/pages/admin/deployment/multi-site.md`.

## Identity

`config.site` (`ARCHESTRA_SITE_NAME`, `ARCHESTRA_SITE_ROLE`,
`ARCHESTRA_SITE_INTERNAL_URL`, Helm `archestra.site`). A single install is the
primary site named `default` and needs no configuration.

- `primary`: applies migrations, owns the encryption canary and JWKS keys.
- `secondary`: never migrates (Helm skips the migration Job and startup
  migrations), only verifies the encryption canary and the JWKS key
  (`secrets-manager/encryption-key-guard.ts`, `auth/jwks-signing-key-guard.ts`),
  and refuses to start on another version than the primary's
  (`startup-guard.ts`).

## Registry (`registry.ts`, table `sites`)

On startup the web process upserts its row (name, role, internal URL, version,
capabilities) and refreshes `last_seen_at` every 15 s. A site whose heartbeat
is older than 45 s, that is draining, or that has no internal URL can't take
work over the channel (`siteUnavailableReason`). `listSites()` caches the table for 5 s
per process, since a site may be far from the database.

Capabilities are detected from the site's own environment
(`detectCapabilities`). Today: the keyless LLM providers it enables. Add what
your feature needs to route on (for example whether the site can run
Kubernetes workloads) to `SiteCapabilities` in `types/site.ts`.

## LLM providers across sites

Every site calls providers itself, so a request is served where it lands.

- Keys with a stored secret work on every site.
- A system key is keyless: it uses the cloud identity of the environment
  (Vertex AI workload identity, Bedrock IAM, Azure Entra ID). There is one per
  provider, shared by all sites. `canCallHere(key)` is true only on sites whose
  environment enables that provider, and each site lists its keyless providers
  in its registry row (`capabilities.keylessProviders`).
- Where a site can't call a key: model pools and auto routing skip that
  member or tier (`routes/proxy/model-pool-failover.ts`,
  `auto-routing/router.ts`); a request on that key alone gets a 503 naming the
  site; the scheduled model sync leaves the key to a site that can call it.
- A site that disables a keyless provider deletes the shared key only when no
  other registered site enables it (`services/system-key-manager.ts`).
- Model pool health: a timeout or unreachable provider benches the member on
  this site only, since it is about this site's network path; rate limits,
  auth and quota errors bench it on every site.

To call a provider from a site in another cloud, give that site federated
credentials for it (see the user docs).

## Remote database (`remote-database.ts`, `database/read-cache.ts`)

`config.site.remoteDatabase` (`ARCHESTRA_SITE_REMOTE_DATABASE`) marks a site
whose database is in another cloud or region, so each statement is a
cross-cloud round trip. An LLM proxy request there makes none when warm:

- Reads: the auth plugin marks LLM proxy requests (`requestScope.cachesReads`)
  and `startRemoteDatabaseMode` wraps `pool.query`. A standalone SELECT whose
  tables are all in `CACHEABLE_TABLES` is read through `configCache` (5 s TTL,
  cleared by the `archestra_proxy_config` notifications, used only while
  notifications are proven to arrive). Transactions always read the database.
  A table without a notification trigger (budget usage, keys, tokens) is
  served at most 5 s stale. Add a table only if that staleness is acceptable.
- Writes: `persistProxyInteraction` goes through `writeAfterResponse`, which
  queues the write (retried for 2 minutes; the interaction id is fixed so a
  retry is idempotent) and runs it inline when 1,000 are pending in the
  process.

## Channel (`channel-auth.ts`, `channel-client.ts`, `routes/site-channel.ts`)

Endpoints live under `SITE_CHANNEL_PREFIX` (`/api/internal/sites`) on the
normal backend port. User auth is skipped for that prefix; each request
instead carries `x-archestra-site-token`, an HMAC over `{ sender, receiving
site, expiry, body hash }` with a key derived from the shared auth secret. A
token is valid 60 s (30 s clock skew), for one receiving site and one body.

To call another site:

```ts
const response = await postToSite({
  siteName: "gcp-us",
  path: "/my-feature/do-thing",
  body: { ... },
  what: `MCP server "${name}"`, // names the work in "needs site X, which ..." errors
  signal,
});
```

`postToSite` throws `SiteUnavailableError` (HTTP-like `status` 503, not an
`ApiError`) when the site is unknown, stale, draining or unreachable, with a
message an admin can act on.

To serve a call, register a route inside `routes/site-channel.ts` and start the
handler with `readSignedJson(request, reply)`: it verifies the token over the
raw body, answers 401 when it is refused, and returns the parsed body and the
sending site. Keep the work done there to the part only this site can do,
and record logs, limits and spend on one side only.

## Not here yet

Admin UI (Sites page, site filter on logs), the site on interactions and
spans, an outbound tunnel for sites that can't accept inbound connections,
a mode where a site needs no database login of its own, and per-site limit
allowances (a remote-database site checks limits against usage up to 5 s old).
