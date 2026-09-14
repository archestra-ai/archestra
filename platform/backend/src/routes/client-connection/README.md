# Browser-approved client setup

The public `/connect.md` instructions let an existing coding agent bootstrap a
connection without installing a skill first. `/llms.txt` links to those instructions.
The frontend root document also links to `/llms.txt` with `rel="describedby"`.

## Protocol

1. Download `GET /api/client-connections/installer`. This is a public Node.js
   script with no deployment credentials. Run it with `--url`, `--client`, and
   optionally `--no-open`. It detects the terminal's operating system.
2. `POST /api/client-connections` with `{ clientId, platform }` starts a ten-minute
   request. It returns a random browser request ID, a separate 256-bit polling
   `deviceCode`, a display code, and a relative `verificationPath`.
3. Open the verification path on the deployment's frontend origin. The existing
   sign-in flow preserves the URL through login and SSO. The existing Connection
   page resolves permitted defaults and creates the user's setup ticket.
4. `GET /api/client-connections/:id` requires platform authentication and returns
   only client, platform, display code, and expiry. The browser requires explicit
   confirmation that the displayed code matches the terminal.
5. `POST /api/client-connections/:id/decision` requires platform authentication.
   An approval submits `{ decision: "approve", setupId }`; denial submits
   `{ decision: "deny" }`. The pending request is consumed atomically before
   transferring an owned, unused, unexpired, matching setup ticket to the installer.
6. The installer polls `POST /api/client-connections/poll` with `{ deviceCode }`.
   Polling returns only `pending`, `approved`, `denied`, or `expired`.
7. On approval it downloads `/api/connection-setups/script/archestra_con_<deviceCode>`.
   The existing script route atomically consumes the ticket and revalidates access
   before rendering. The installer saves the script in a private temporary
   directory, runs Bash or PowerShell, then removes the directory. Windows uses
   a process-scoped execution-policy bypass, matching the existing in-memory
   PowerShell setup flow; it does not change the machine execution policy.

This is an application-specific approval protocol, not an OAuth device-grant
implementation. The configured MCP client still performs native OAuth separately.
The installer never receives the browser's login cookie or an OAuth access token.
Cursor's existing model and marketplace setup remains manual.

## Claude Desktop

Use `--client claude-desktop` for the native app's Code and Cowork tabs.
The bootstrap opens a separate host terminal before starting the approval request.
That terminal passes `--desktop-terminal` to avoid opening another terminal and
continues running when the approved installer restarts Desktop.

This requires an allowed host-terminal tool. Computer use cannot be assumed
to type commands into a terminal. Cowork's execution
sandbox cannot configure the host app. Desktop Code can also deny localhost
network access. `/connect.md` directs agents to use ordinary permission flows
or provide the manual Connect command when host access is unavailable.
Do not infer the host OS from Cowork's sandbox or report sandbox edits as success.

## State and failure behavior

The shared PostgreSQL-backed cache holds pending requests and polling status with
an absolute expiry and TTL. It supports different replicas handling each step.
Only hashes of the polling secret and derived setup token are stored. Display
prefixes follow the existing setup-ticket convention. Raw setup scripts and raw
polling secrets are not stored in the cache. No new schema or migration is needed.

`cacheManager.getAndDelete` serializes competing approval/denial requests. It uses
an atomic database operation, so at most one decision succeeds. Transferring a
setup ticket checks user, organization, client, platform, expiry, and consumption
in a single model update. The browser's old setup command becomes invalid.

Polling is repeatable. Script redemption remains single-use. A lost script response
or a failure after the request is claimed requires starting again; no decision
retry can issue a second credential. Loss of pending cache state fails closed. Polling tolerates
network errors, HTTP 429, and HTTP 5xx until the original deadline. Initial creation
and script redemption are not automatically retried.

Public creation and polling have separate per-IP rate limits. Review and decision
use ordinary platform authentication and endpoint permissions. Success is audited
as `clientConnection.updated` with pending and approved/denied states, client, and
platform. The audit contains no polling proof or setup token. The `deviceCode`
logging field is redacted.

A reverse proxy must allow unauthenticated access to `/connect.md`, `/llms.txt`,
`GET /api/client-connections/installer`, `POST /api/client-connections`, and
`POST /api/client-connections/poll`. Script redemption uses the existing public,
one-time-token endpoint. Review and decision must remain authenticated. Use the
frontend origin for `--url`; it serves both browser routes and API rewrites.
HTTPS is required except on loopback addresses for local development.

## Validation

From `platform/`:

```sh
pnpm --dir backend exec vitest run src/routes/client-connection/decision.client-connection.route.test.ts src/services/client-connection-installer.test.ts
pnpm --dir frontend exec vitest run src/app/connection/client-connection-approval.test.tsx src/app/connection/connect-command-panel.test.tsx
```

For a real run, use Tilt, fetch the installer from the local frontend, and run it
inside a disposable container or VM. Use Chrome to approve or deny the printed URL.
Check the generated client configuration and complete native MCP OAuth. Do not run
setup against a developer's personal client configuration as a test fixture.

Test the signed-out redirect, matching code requirement, mismatched client/OS,
denial, expired request, duplicate decision, transient polling failures, and
single-use script download. Check the original connection page still works without
`connectRequest` in its URL.
