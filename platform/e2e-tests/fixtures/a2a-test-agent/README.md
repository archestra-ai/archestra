# Deterministic A2A test agent

This dependency-free Node fixture exposes a small, stateful A2A v1.0 JSON-RPC
server for Archestra end-to-end tests. It is intentionally deterministic and
opaque: it behaves like a remote agent without running an LLM.

## Run it

From the repository root:

```bash
node platform/e2e-tests/fixtures/a2a-test-agent/server.mjs
```

It listens on `http://127.0.0.1:9191` by default. Configuration is through
environment variables:

| Variable | Default | Values / purpose |
| --- | --- | --- |
| `A2A_FIXTURE_HOST` | `127.0.0.1` | Listen address |
| `A2A_FIXTURE_PORT` | `9191` | Listen port |
| `A2A_FIXTURE_BASE_URL` | derived from request | Public URL written into the Agent Card |
| `A2A_FIXTURE_AUTH_MODE` | `none` | `none`, `bearer`, `api-key`, or `either` |
| `A2A_FIXTURE_BEARER_TOKEN` | `fixture-bearer-token` | Accepted bearer token |
| `A2A_FIXTURE_API_KEY` | `fixture-api-key` | Accepted `X-API-Key` value |

For example:

```bash
A2A_FIXTURE_AUTH_MODE=bearer node platform/e2e-tests/fixtures/a2a-test-agent/server.mjs
```

## HTTP surface

- `GET /.well-known/agent-card.json` — public A2A v1.0 Agent Card.
- `POST /a2a` — JSON-RPC A2A endpoint.
- `GET /health` — liveness check.
- `GET /journal` or `GET /__fixture/requests` — ordered requests captured by
  the fixture. `Authorization` and `X-API-Key` values are always redacted.
- `POST /reset` or `POST /__fixture/reset` — clears tasks, request history,
  and deterministic ID counters.

The JSON-RPC endpoint implements `SendMessage`, `SendStreamingMessage`,
`GetTask`, and `CancelTask`. It also recognizes the older method spellings
`message/send`, `message/stream`, `tasks/get`, and `tasks/cancel` as aliases,
but responses use the advertised v1.0 shapes.

## Deterministic scenarios

Choose a scenario by prefixing the first text part, or by setting
`message.metadata.fixtureMode` / request `metadata.fixtureMode`:

| Marker / mode | Result |
| --- | --- |
| `[fixture:immediate]` | Direct A2A `Message` response |
| `[fixture:task]` | Completed `Task` with a text artifact (default) |
| `[fixture:working]` | Non-terminal task that can be fetched and canceled |
| `[fixture:delayed]` | Working task that completes when fetched, for client polling tests |
| `[fixture:failed]` | Failed task |
| `[fixture:artifact]` | Completed task with text and structured-data artifact parts |
| `[fixture:untrusted]` | Direct message containing a stable prompt-injection-shaped payload |

`SendStreamingMessage` emits a task snapshot, one artifact update, and a
terminal status update over SSE. Push notifications and extended cards are not
advertised or implemented.

## Validate it

```bash
node --test platform/e2e-tests/fixtures/a2a-test-agent/server.test.mjs
```

The tests cover discovery, immediate and task responses, structured artifacts,
task fetch/cancel, A2A error codes, bearer and API-key rejection/acceptance,
credential redaction, journal reset, and SSE framing.
