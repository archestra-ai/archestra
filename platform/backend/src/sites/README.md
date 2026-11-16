# Sites

A **site** is one Archestra install (one Helm release, usually one cluster or
cloud). Several sites can share one PostgreSQL database. This module is the
shared layer they coordinate through: who each site is, which sites are alive,
and a signed channel to send work to another site. Features build on it; the
LLM proxy's relay (`routes/proxy/remote-site-transport.ts`) is the first.

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
relayed work (`siteUnavailableReason`). `listSites()` caches the table for 5 s
per process, since a site may be far from the database.

Capabilities are detected from the site's own environment
(`detectCapabilities`). Today: the keyless LLM providers it enables. Add what
your feature needs to route on (for example whether the site can run
Kubernetes workloads) to `SiteCapabilities` in `types/site.ts`.

## Ownership

A row that only one site can act on names that site. `isServedHere(siteName)`
is true for `null` (any site) and for this site's own name. For LLM provider
keys (`chat_api_keys.site_name`):

- a keyless system key names the site whose environment provides its cloud
  identity, set by `services/system-key-manager.ts`; a site only creates,
  renames, syncs and deletes its own (a key from before sites existed has no
  site and is claimed by the first site that enables the provider);
- the scheduled model sync (`services/model-sync-schedule.ts`) only syncs keys
  this site serves;
- keys with a stored secret have no site: any site may call with them.

Apply the same rule to your own reconcilers: act only on rows this site serves.

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
  what: `MCP server "${name}"`, // names the work in "is served by site X, which ..." errors
  signal,
});
```

`postToSite` throws `SiteUnavailableError` (HTTP-like `status` 503, not an
`ApiError`) when the site is unknown, stale, draining or unreachable, with a
message an admin can act on. For streams, answer with server-sent events and
read them with `readSseJson`.

To serve a call, register a route inside `routes/site-channel.ts` and start the
handler with `readSignedJson(request, reply)`: it verifies the token over the
raw body, answers 401 when it is refused, and returns the parsed body and the
sending site. Keep the work done there to the part only this site can do;
logging, limits and spend stay on the site that received the user's request,
so nothing is recorded twice.

## Not here yet

Admin UI (Sites page, site field on provider keys, site filter on logs),
`servedBySite` on interactions and spans, an outbound tunnel for sites that
can't accept inbound connections, and a mode where a site needs no database
login of its own.
