# Connecting to / installing Archestra

The migration needs a reachable Archestra instance and an API key. Two paths.

## Path A — point at an existing instance (preferred when the user has one)
Ask for the base URL (e.g. `https://archestra.acme.com` or `http://localhost:9000`).
Then mint an API key (see "Authentication" below). Nothing to install.

## Path B — local docker (single all-in-one image, KinD inside)
There is no compose file; this `docker run` *is* the local-docker path. It bundles backend,
frontend, Postgres, and a KinD cluster (so local stdio MCP servers can actually run).

```bash
docker pull archestra/platform:latest
docker run -d -p 127.0.0.1:9000:9000 -p 127.0.0.1:3000:3000 \
  -e ARCHESTRA_QUICKSTART=true \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v archestra-postgres-data:/var/lib/postgresql/data \
  -v archestra-app-data:/app/data \
  archestra/platform
```

Ports: API `9000`, UI `3000`. First boot takes a while (it builds a KinD cluster).

## Readiness
Poll until the DB is connected (the client does this for you):
```bash
curl -s http://localhost:9000/ready    # -> {"status":"ok","database":"connected"}
```
`archestra_client.ArchestraClient(base_url).wait_ready()` polls this with a timeout.

## Bootstrap credentials (local docker)
A default admin and a default organization are seeded on first boot:
- email: `admin@example.com`  (override: `ARCHESTRA_AUTH_ADMIN_EMAIL`)
- password: `password`        (override: `ARCHESTRA_AUTH_ADMIN_PASSWORD`)

For an existing instance, ask the user for their own credentials — never assume defaults.

## Authentication (how the scripts get in)
1. Sign in with email+password → better-auth sets a session cookie.
2. Mint an API key (returned exactly once).
3. Send it as the raw `Authorization: <key>` header (no `Bearer`).

The client (`archestra_client.py`) is zero-dependency — it uses stdlib `urllib` with a cookie jar
(so the sign-in session cookie carries to the key-mint call) and does **not** follow redirects (a 3xx
on the fixed base URL is surfaced as an error, never silently followed). It encapsulates the flow:
```python
from archestra_client import ArchestraClient
c = ArchestraClient("http://localhost:9000")
c.wait_ready()
c.sign_in("admin@example.com", "password")
key = c.mint_api_key("migration")     # store this; apply.py reads it from ARCHESTRA_API_KEY
```

Then for `apply.py`, export:
```bash
export ARCHESTRA_BASE_URL=http://localhost:9000
export ARCHESTRA_API_KEY=<minted key>
```

Never log the key, never send it anywhere but the instance the user pointed at.
