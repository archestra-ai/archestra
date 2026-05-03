# Model Router Keyless Auth and Attribution

## Summary

Teams want a single model gateway endpoint that aggregates models across cloud inference platforms while avoiding direct exposure of provider keys to application developers. Archestra already has most of the foundation through the Model Router, virtual API keys, external IdP JWT validation, provider key scoping, usage observability, and Slack agent triggers.

The main gaps are OAuth-based consumption of the Model Router, first-class app attribution for machine-to-machine callers, and keyless Azure provider authentication. Solving those gaps would let administrators configure provider access once, then let users and applications call the Model Router with enterprise identity instead of long-lived API keys.

## Requirements

1. Provide a single OpenAI-compatible Model Router endpoint for applications that need to call models across OpenAI, Azure OpenAI, Azure Foundry, Vertex AI, Gemini, Bedrock, and similar provider backends.
2. Let platform administrators configure provider credentials centrally and prevent raw provider keys from being distributed to application teams.
3. Support keyless provider authentication where cloud platforms allow it, especially Vertex AI workload identity and Azure workload identity or managed identity for Azure OpenAI and Azure Foundry.
4. Support user-authenticated Model Router calls so individual developers can use local tools, notebooks, scripts, or IDE integrations without receiving static API keys.
5. Support application-authenticated Model Router calls so production apps can authenticate as registered applications instead of embedding virtual API keys in source code or deployment config.
6. Attribute usage to the resolved user, registered application, model router profile, provider, model, source, and client-provided app or agent identifier.
7. Enforce authorization at the user and application level, including allowed providers, allowed models, virtual key mappings, teams, scopes, and cost or token limits.
8. Keep virtual API keys as a supported transitional path for clients that cannot perform OAuth or JWT-based auth.
9. Provide a clear blueprint for Slack bots and other channel apps: either use Archestra-managed agents with server-side provider credentials, or register external apps as machine-to-machine Model Router callers.
10. Preserve per-user attribution for built-in Slack agent interactions by resolving the channel user to an Archestra user where possible.

## What Exists Today

| Area | Current support |
| --- | --- |
| Unified model endpoint | Model Router exposes OpenAI-compatible `/responses`, `/chat/completions`, and `/models` routes under `/v1/model-router/{llm-proxy-id}`. |
| Provider aggregation | Model Router can route provider-qualified model IDs such as `openai:<model>` and `anthropic:<model>` through mapped provider keys. |
| Provider key hiding | Virtual API keys map to stored provider API keys. Model Router routes require Model Router-enabled virtual keys. |
| Provider key scoping | LLM provider keys can be personal, team, or organization scoped, with primary-key resolution. |
| User JWT auth | LLM Proxy supports external IdP JWT validation through JWKS and resolves the matched Archestra user. |
| MCP OAuth | MCP Gateway supports OAuth 2.1 and OAuth client credentials, including enterprise-managed downstream token exchange patterns. |
| Vertex keyless auth | Gemini Vertex mode can use Application Default Credentials, including GKE Workload Identity. |
| Usage attribution | LLM spans and metrics include provider, model, source, internal agent, external app or agent ID, user ID, user email, token counts, and cost when configured. |
| App-provided identifiers | `X-Archestra-Agent-Id`, `X-Archestra-Execution-Id`, `X-Archestra-Session-Id`, and `X-Archestra-Meta` let clients attach app, execution, and session context. |
| Slack channel agents | Slack triggers route channel and DM messages to configured Archestra agents, support agent selection, and autoprovision users from Slack identity. |

## Gaps

| Area | Gap |
| --- | --- |
| Model Router OAuth | Model Router does not currently accept OAuth authorization-code tokens issued by Archestra as the authorization method for user callers. |
| Model Router client credentials | Model Router does not currently support OAuth client credentials for registered machine-to-machine applications. |
| App identity model | There is no first-class LLM consumer application record with owner, allowed scopes, allowed model router profiles, allowed models, and cost limits. |
| App attribution | Usage can include client-provided external IDs, but there is no cryptographically authenticated application identity tied to that usage. |
| OAuth consent for local tools | There is no Model Router-specific consent and token issuance flow for IDEs, notebooks, CLIs, or custom tools that can open a browser for user login. |
| Azure keyless provider auth | Azure OpenAI and Azure Foundry provider configuration still needs first-class managed identity or workload identity support. |
| Azure Foundry model coverage | Azure OpenAI is covered, but non-OpenAI Azure Foundry model endpoint behavior needs provider support and tests. |
| Slack external app blueprint | Built-in Slack agents are covered, but external Slack apps that call the Model Router directly need a recommended app-auth pattern. |
| Policy UX | Admins need one place to grant a user or app access to a Model Router profile, providers, models, and budgets without handing out static keys. |

## Proposed Solution

### 1. Add Model Router OAuth for users

Extend the LLM Proxy auth layer so Model Router routes can accept Archestra-issued OAuth access tokens from authorization-code + PKCE flows. The token should resolve to an Archestra user and organization, then reuse the existing LLM provider key resolution path and policy pipeline.

This path serves local development, notebooks, CLIs, IDE extensions, and internal tools that can send users through browser login.

Acceptance criteria:

- A user can create or authorize a Model Router OAuth client without seeing provider keys.
- A valid user token can call `/v1/model-router/{llm-proxy-id}/models`, `/responses`, and `/chat/completions`.
- Metrics, traces, logs, and cost records include the resolved user identity.
- Existing JWKS and virtual key auth continue to work.

### 2. Add Model Router OAuth client credentials for applications

Introduce a first-class LLM application registration that can authenticate with OAuth client credentials. Each app should have an owner, optional team assignment, allowed Model Router profiles, allowed providers/models, scopes, token lifetime, and optional budgets.

This path serves production services, Slack bots, automation jobs, and apps that should be attributed as applications rather than individual users.

Acceptance criteria:

- A registered app can exchange client credentials for a short-lived access token.
- The token can call Model Router routes only for allowed profiles, providers, and models.
- Metrics, traces, logs, and cost records include application identity separate from user identity.
- Admins can revoke or rotate app credentials without changing provider keys.

### 3. Add authenticated app attribution headers

Keep `X-Archestra-Agent-Id` for client-provided labels, but add authenticated application attribution derived from the OAuth client or external IdP application claims. Treat caller-supplied app IDs as labels, not authorization facts.

Acceptance criteria:

- Observability distinguishes `external_agent_id` from authenticated application identity.
- Policy checks use authenticated user or app identity, not only headers.
- Logs can answer "which app used which model and how much did it cost?"

### 4. Add Azure keyless provider authentication

Add provider credential modes for Azure OpenAI and Azure Foundry that use managed identity or workload identity instead of stored API keys. Keep API-key mode for compatibility.

Acceptance criteria:

- Admins can configure Azure OpenAI or Azure Foundry with keyless auth.
- The backend can acquire and refresh Azure access tokens server-side.
- Model Router can call Azure-backed models without provider keys stored in Archestra.
- Tests cover token acquisition, provider request signing, and fallback errors.

### 5. Document app integration blueprints

Publish two recommended integration blueprints:

- Built-in channel agents: use Archestra Slack/MS Teams triggers, map channel users to Archestra users, and run agents with server-side provider credentials.
- External apps: register the app as a Model Router OAuth client, use client credentials for app-level usage, and optionally pass end-user context separately when the app has a trusted user mapping.

Acceptance criteria:

- Developers know when to use built-in agents, user OAuth, app OAuth, JWKS, or virtual keys.
- Slack bot builders have a clear route that avoids static provider keys in app code.
- Admins can audit user-level and app-level usage separately.

## Suggested Implementation Order

1. Reuse the existing OAuth server and token models to allow Model Router routes to authenticate Archestra-issued user access tokens.
2. Add LLM application registrations and client-credentials tokens for Model Router machine-to-machine callers.
3. Add authenticated application identity fields to LLM request context, tracing, metrics, and interaction records.
4. Add policy checks for app-level profile/model/provider access and budgets.
5. Add Azure managed identity/workload identity provider credential modes.
6. Add Azure Foundry non-OpenAI model-router provider support after keyless Azure auth is in place.
7. Update public docs with the new auth matrix and Slack/external app blueprints once the implementation exists.

## Test Plan

- Backend route tests for Model Router user OAuth tokens, expired tokens, wrong scopes, and wrong organization.
- Backend route tests for Model Router client-credentials tokens, revoked apps, disallowed profiles, and disallowed models.
- Model tests for LLM application registration, credential rotation, team ownership, and budget configuration.
- Observability tests confirming user and application attributes are emitted without trusting arbitrary headers for authorization.
- Provider tests for Azure keyless auth token acquisition and Azure Foundry request routing.
- E2E smoke tests for creating an app registration, acquiring a token, listing models, and making a routed completion.

