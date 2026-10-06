---
title: Configuration
description: Every environment variable that configures an Archestra deployment
order: 2
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra reads its configuration from environment variables. Pass them with `-e` to `docker run`, or set them under `archestra.env` in the Helm values. Sections follow the order you configure a deployment in; see [Deployment](/docs/admin/deployment) for the install itself.

## Database

- **`ARCHESTRA_DATABASE_URL`** - PostgreSQL connection string.
  - Default: the bundled PostgreSQL (Docker quickstart and Helm)
  - Values: `postgresql://user:password@host:5432/database`
  - Required when you use an external database.

- **`ARCHESTRA_DATABASE_RUN_MIGRATIONS_ON_STARTUP`** - Runs database migrations before the backend starts.
  - Default: `true`
  - Set `false` only when your deployment pipeline applies migrations before rollout.

- **`ARCHESTRA_DATABASE_POOL_MAX`** - Maximum PostgreSQL connections per backend process.
  - Default: `50`
  - Values: `1`–`500`
  - In Helm, `archestra.database.connectionBudget` sizes the pool across all pods. This variable and `archestra.database.poolMax` override it. See [Database Configuration](/docs/admin/deployment#database-configuration).

- **`ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS`** - PostgreSQL `statement_timeout` for every pooled connection, in milliseconds.
  - Default: `30000`
  - Values: `0` disables the timeout.
  - Raise it if you run legitimate long queries.

## Server and Network

- **`ARCHESTRA_API_BASE_URL`** - Public URL of the Archestra API, shown in the connection instructions for the LLM Proxy, MCP Gateway, and A2A Gateway.
  - Default: unset (the UI shows `http://127.0.0.1:9000`)
  - Values: one URL, or a comma-separated list, for example `http://archestra.default.svc:9000,https://api.example.com`
  - Set it when clients reach the API through an ingress or load balancer. List every public host you serve the gateways on.

- **`ARCHESTRA_INTERNAL_API_BASE_URL`** - URL the backend listens on inside the container. In-cluster workloads use it to reach the backend.
  - Default: `http://127.0.0.1:9000`
  - The port in this URL sets the API listen port.
  - [Agent Runtime](#agent-runtime) pods use it to reach the API unless [`ARCHESTRA_AGENT_RUNTIME_PLATFORM_BASE_URL`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_PLATFORM_BASE_URL) is set.

- **`ARCHESTRA_FRONTEND_URL`** - Public URL of the Archestra web app. Setting it turns on origin validation for CORS and sign-in.
  - Default: unset (all origins accepted)
  - Values: an origin, for example `https://archestra.example.com`
  - Set it in production. Users who open the app on a LAN IP need that URL here, for example `http://192.168.1.5:3000`.

- **`ARCHESTRA_PUBLIC_ENDPOINTS_PORT`** - Extra port that serves only the endpoints meant for the Internet: the Microsoft Teams webhook (`/api/webhooks/chatops/ms-teams`).
  - Default: unset (no extra port)
  - Values: `1`–`65535`. Any other value disables the extra port and logs a warning.
  - The main API port keeps serving these endpoints. In Helm, set `archestra.publicEndpointsPort`, which also exposes the port on the Service.

- **`ARCHESTRA_TRUST_PROXY`** - Trusts the `X-Forwarded-*` headers of a reverse proxy or load balancer. Rate limits and audit logs then see each client's IP.
  - Default: `false`
  - Values: `true`, `false`, or a comma-separated list of proxy IPs or CIDRs, for example `35.191.0.0/16,130.211.0.0/22`
  - Prefer the IP list. With `true`, any caller can set `X-Forwarded-For` and pick the IP it is rate-limited and audited under.

- **`ARCHESTRA_HTTP_KEEP_ALIVE_TIMEOUT_MS`** - How long the API and web servers keep an idle keep-alive connection open, in milliseconds.
  - Default: `620000`
  - Values: a positive whole number of milliseconds, digits only, such as `620000`
  - Keep it above the keep-alive timeout of every proxy and load balancer in front of Archestra. See [Keep-Alive Timeouts](/docs/admin/deployment#keep-alive-timeouts).

- **`ARCHESTRA_API_BODY_LIMIT`** - Maximum request body size for LLM Proxy and chat requests.
  - Default: `70MB`
  - Values: bytes (`73400320`) or a size with `KB`, `MB`, or `GB` (`100MB`)
  - All attachments of one chat message share this limit. Raise it when you raise [`ARCHESTRA_CHAT_ATTACHMENT_STORAGE_BYTES_LIMIT`](/docs/reference/configuration#ARCHESTRA_CHAT_ATTACHMENT_STORAGE_BYTES_LIMIT), or for very long conversations.

- **`ARCHESTRA_PROCESS_TYPE`** - Which part of the backend this process runs.
  - Default: `all`
  - Values: `all`, `web`, `worker`, `renderer`
  - The Helm chart sets it for each deployment. Set it yourself only when you split processes without the chart.

## General

- **`ARCHESTRA_BETA`** - Turns on beta features.
  - Default: `false`
  - Values: `true`, `false`
  - Turns on [Guardrails](#guardrails) and plugins directly.
  - Also turns on [`ARCHESTRA_KNOWLEDGE_BASE_MFILES_CONNECTOR_ENABLED`](/docs/reference/configuration#ARCHESTRA_KNOWLEDGE_BASE_MFILES_CONNECTOR_ENABLED) when it is left blank. Set to `false`, it stays off.

- **`ARCHESTRA_QUICKSTART`** - Runs MCP servers in a small Kubernetes (KinD) cluster inside the Docker container.
  - Default: `false`
  - Values: `true`, `false`
  - Requires the Docker socket mounted into the container. For evaluation only. See [Quickstart Deployment](/docs/admin/deployment#quickstart-deployment).

- **`ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED`** - Activates the enterprise license.
  - Default: `false`
  - Values: `true`, `false`
  - See [Licensing](/docs/get-started#licensing) for what it unlocks.

- **`ARCHESTRA_ENTERPRISE_LICENSE_KNOWLEDGE_BASE_ACTIVATED`** - Activates the enterprise Knowledge Base features, such as team-scoped connectors.
  - Default: `false`
  - Values: `true`, `false`
  - Requires [`ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED=true`](/docs/reference/configuration#ARCHESTRA_ENTERPRISE_LICENSE_ACTIVATED).

- **`ARCHESTRA_ENTERPRISE_LICENSE_FULL_WHITE_LABELING`** - Removes the "Powered by Archestra" branding and the community links.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_LOGGING_LEVEL`** - Minimum level of log messages.
  - Default: `info`
  - Values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`

- **`ARCHESTRA_LOGGING_FORMAT`** - Format of the logs written to stdout.
  - Default: `json`. The Docker quickstart uses `pretty`.
  - Values: `json` (one JSON object per line), `pretty` (colorized text)
  - The OTLP log exporter always receives structured records.

- **`ARCHESTRA_ANALYTICS`** - Sends product analytics to Archestra, and forwards [Guardrails](#guardrails) diagnostic reports to the shared OpenAPPA reporting service.
  - Default: on in production builds, including the released Docker images; off in development
  - Values: `disabled` turns it off. Any other value turns it on.

- **`ARCHESTRA_ANALYTICS_POSTHOG_KEY`** - PostHog project key for analytics.
  - Default: Archestra's PostHog project
  - Set it with [`ARCHESTRA_ANALYTICS_POSTHOG_HOST`](/docs/reference/configuration#ARCHESTRA_ANALYTICS_POSTHOG_HOST) to send analytics to your own PostHog.

- **`ARCHESTRA_ANALYTICS_POSTHOG_HOST`** - PostHog API host for analytics.
  - Default: `https://eu.i.posthog.com`

- **`ARCHESTRA_MAINTENANCE_MODE_MESSAGE`** - Blocks the app for all users with a full-screen message.
  - Default: unset (maintenance mode off)
  - Values: the message text
  - While it is set, the container skips database migrations on startup.

- **`ARCHESTRA_SITE_NOTIFICATION_MESSAGE`** - Shows a banner at the top of every page, including the sign-in page. The app stays usable.
  - Default: unset (no banner)
  - Values: Markdown text
  - Users can dismiss the banner. A changed message shows again.

## Authentication

- **`ARCHESTRA_AUTH_ADMIN_EMAIL`** - Email of the default admin user, created on first startup.
  - Default: `admin@example.com`

- **`ARCHESTRA_AUTH_ADMIN_PASSWORD`** - Password of the default admin user, set on first startup.
  - Default: `password`
  - Change it for any deployment other people can reach.

- **`ARCHESTRA_AUTH_ADDITIONAL_TRUSTED_ORIGINS`** - Extra origins allowed for CORS and sign-in, besides [`ARCHESTRA_FRONTEND_URL`](/docs/reference/configuration#ARCHESTRA_FRONTEND_URL).
  - Default: unset
  - Values: comma-separated origins, for example `https://idp.example.com,http://192.168.1.5:3000`
  - Setting it turns on origin validation, even without [`ARCHESTRA_FRONTEND_URL`](/docs/reference/configuration#ARCHESTRA_FRONTEND_URL). Add your SSO identity provider and any other URL users open the app on.

- **`ARCHESTRA_AUTH_COOKIE_DOMAIN`** - Domain the session cookie is scoped to. Set it when the frontend and backend run on different subdomains.
  - Default: unset (the cookie stays on the exact frontend host)
  - Values: the narrowest domain covering both hosts. For `frontend.example.com` and `backend.example.com`, use `example.com`.
  - The cookie then reaches every subdomain. Give each other Archestra instance on that domain its own [`ARCHESTRA_AUTH_COOKIE_PREFIX`](/docs/reference/configuration#ARCHESTRA_AUTH_COOKIE_PREFIX). Otherwise sign-in loops back to the sign-in page.

- **`ARCHESTRA_AUTH_COOKIE_PREFIX`** - Prefix of the auth cookie names, for example `archestra.session_token`.
  - Default: `archestra`
  - Give each instance a unique prefix when two instances run on one host on different ports, or on sibling subdomains that share a [cookie domain](/docs/reference/configuration#ARCHESTRA_AUTH_COOKIE_DOMAIN). Otherwise their session cookies overwrite each other.

- **`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH`** - Turns off email and password sign-in. Users sign in only through SSO.
  - Default: `false`
  - Values: `true`, `false`
  - Configure an [identity provider](/docs/admin/identity) before you set it to `true`.

- **`ARCHESTRA_AUTH_DISABLE_INVITATIONS`** - Turns off user invitations in the UI and the API.
  - Default: `false`
  - Values: `true`, `false`
  - Use it when an identity provider provisions users.

- **`ARCHESTRA_AUTH_DISABLE_IMPERSONATION`** - Turns off **View as user**, so nobody can start an impersonated session.
  - Default: `false`
  - Values: `true`, `false`
  - With `false`, impersonation still requires the [`member:impersonate`](/docs/reference/permissions#member:impersonate) permission. See [Available Permissions](/docs/admin/access-control#available-permissions).

- **`ARCHESTRA_AUTH_DCR_ENABLED`** - Allows OAuth clients to register themselves (Dynamic Client Registration and CIMD).
  - Default: `true`
  - Values: `true`, `false`
  - With `false`, only [OAuth clients you register](/docs/mcp/authentication) can run OAuth flows.

- **`ARCHESTRA_AUTH_REFRESH_TOKEN_REUSE_GRACE_SECONDS`** - Window, in seconds, in which a replayed OAuth refresh token gets a fresh token pair instead of revoking the grant.
  - Default: `60`
  - Values: `0` or more. `0` treats every replay as reuse.
  - The window lets a client retry after a lost token response.

- **`ARCHESTRA_AUTH_RATE_LIMIT_DISABLED`** - Turns off rate limiting on the sign-in and auth endpoints.
  - Default: `false`
  - Values: `true`, `false`
  - Use it only for load tests or automated test runs.

- **`ARCHESTRA_AUTH_DEV_AUTO_AUTHENTICATE_EMAIL`** - Skips the sign-in page in development by signing in as the user with this email.
  - Default: unset
  - Ignored in production builds. The session has that user's normal permissions.

## Encryption and Secrets

- **`ARCHESTRA_AUTH_SESSION_SECRET`** - Signs session cookies and encrypts JWT signing keys and two-factor secrets.
  - Default: Helm generates one in the `<release>-auth` Secret under `session-secret`. Without Helm, it falls back to [`ARCHESTRA_AUTH_SECRET`](/docs/reference/configuration#ARCHESTRA_AUTH_SECRET).
  - Values: a random string of at least 32 characters, for example from `openssl rand -base64 32`
  - Changing it signs out every user, invalidates issued JWTs, and makes users with two-factor authentication enroll again.

- **`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`** - Encrypts secrets stored in the database, such as API keys and tokens.
  - Default: Helm generates one in the `<release>-auth` Secret under `secrets-encryption-secret`. Without Helm, it falls back to [`ARCHESTRA_AUTH_SECRET`](/docs/reference/configuration#ARCHESTRA_AUTH_SECRET).
  - Values: a random string of at least 32 characters
  - Startup stops if this key cannot decrypt the stored secrets. To rotate it, set the old value in [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS`](/docs/reference/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS) and restart. See [Secrets Management](/docs/admin/security/secrets-management).

- **`ARCHESTRA_SECRETS_ENCRYPTION_SECRET_PREVIOUS`** - Previous encryption secret, used on startup to re-encrypt stored secrets under the new one.
  - Default: [`ARCHESTRA_AUTH_SECRET`](/docs/reference/configuration#ARCHESTRA_AUTH_SECRET)
  - Unset it once re-encryption completes.

- **`ARCHESTRA_SECRETS_ACCEPT_NEW_ENCRYPTION_KEY`** - Lets startup continue with an encryption secret that cannot decrypt the stored secrets.
  - Default: `false`
  - Values: `true`, `false`
  - Set it for one boot, then unset it. Secrets encrypted with the old key stay unreadable. Enter them again.

- **`ARCHESTRA_AUTH_SECRET`** - Combined secret used for both [`ARCHESTRA_AUTH_SESSION_SECRET`](/docs/reference/configuration#ARCHESTRA_AUTH_SESSION_SECRET) and [`ARCHESTRA_SECRETS_ENCRYPTION_SECRET`](/docs/reference/configuration#ARCHESTRA_SECRETS_ENCRYPTION_SECRET) when either is unset.
  - Default: generated on first start. Helm stores it in the `<release>-auth` Secret; the Docker image saves it to `/app/data/.auth_secret`.
  - Set the two dedicated secrets instead, so you can rotate them separately.

- **`ARCHESTRA_CONTENT_ENCRYPTION_SECRET`** - Turns on encryption at rest for LLM Logs, chat messages, and MCP tool call arguments and results. Requires an enterprise license.
  - Default: unset (content encryption off)
  - Startup fails if you set it without an enterprise license. Once content is encrypted, startup also fails if the secret is missing or wrong. See [Content Encryption at Rest](/docs/admin/security/content-encryption).

- **`ARCHESTRA_CONTENT_ENCRYPTION_SECRET_PREVIOUS`** - Additional key that decrypts content but never encrypts it.
  - Default: unset
  - Set it during key rotation or a rolling enablement, as [Content Encryption at Rest](/docs/admin/security/content-encryption) describes. Unset it when re-encryption completes.

- **`ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY`** - Turns on [encrypted chats](/docs/chat#encrypted-chats). Archestra escrows each chat key to this RSA public key for recovery.
  - Default: unset (encrypted chats unavailable)
  - Values: an RSA public key of at least 2048 bits, as PEM or base64-encoded PEM. Startup fails on any other value.
  - Set it in its own rollout, after the release is deployed. See [Key Escrow](/docs/chat#key-escrow) and [Recovering an Encrypted Chat](/docs/admin/security/content-encryption#recovering-an-encrypted-chat).

- **`ARCHESTRA_SECRETS_MANAGER`** - Where Archestra stores secrets such as API keys and tokens.
  - Default: `DB`
  - Values: `DB`, `VAULT`, `READONLY_VAULT`. Both Vault values require an enterprise license.
  - With an invalid Vault configuration or no license, Archestra logs a warning and uses `DB`. See [Secrets Management](/docs/admin/security/secrets-management).

- **`ARCHESTRA_HASHICORP_VAULT_ADDR`** - Address of the HashiCorp Vault server.
  - Required when: [`ARCHESTRA_SECRETS_MANAGER=VAULT`](/docs/reference/configuration#ARCHESTRA_SECRETS_MANAGER) or `READONLY_VAULT`
  - Values: a URL, for example `https://vault.example.com:8200`

- **`ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD`** - How Archestra authenticates to Vault.
  - Default: `TOKEN`
  - Values: `TOKEN`, `K8S`, `AWS`

- **`ARCHESTRA_HASHICORP_VAULT_TOKEN`** - Vault token.
  - Required when: [`ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=TOKEN`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD)

- **`ARCHESTRA_HASHICORP_VAULT_K8S_ROLE`** - Vault role bound to the Archestra Kubernetes service account.
  - Required when: [`ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=K8S`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD)

- **`ARCHESTRA_HASHICORP_VAULT_K8S_TOKEN_PATH`** - Path of the service account token used for Kubernetes auth.
  - Default: `/var/run/secrets/kubernetes.io/serviceaccount/token`

- **`ARCHESTRA_HASHICORP_VAULT_K8S_MOUNT_POINT`** - Mount point of Vault's Kubernetes auth method.
  - Default: `kubernetes`

- **`ARCHESTRA_HASHICORP_VAULT_AWS_ROLE`** - Vault role bound to the AWS IAM principal Archestra runs as.
  - Required when: [`ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD=AWS`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_AUTH_METHOD)

- **`ARCHESTRA_HASHICORP_VAULT_AWS_MOUNT_POINT`** - Mount point of Vault's AWS auth method.
  - Default: `aws`

- **`ARCHESTRA_HASHICORP_VAULT_AWS_REGION`** - AWS region used to sign the STS request.
  - Default: `us-east-1`

- **`ARCHESTRA_HASHICORP_VAULT_AWS_STS_ENDPOINT`** - STS endpoint used for AWS auth.
  - Default: `https://sts.amazonaws.com`

- **`ARCHESTRA_HASHICORP_VAULT_AWS_IAM_SERVER_ID`** - Value of the `X-Vault-AWS-IAM-Server-ID` header, when your Vault role requires one.
  - Default: unset

- **`ARCHESTRA_HASHICORP_VAULT_KV_VERSION`** - Version of Vault's KV secrets engine.
  - Default: `2`
  - Values: `1`, `2`

- **`ARCHESTRA_HASHICORP_VAULT_SECRET_PATH`** - Path prefix under which Archestra stores its secrets.
  - Default: `secret/data/archestra` (KV v2) or `secret/archestra` (KV v1)
  - A secret named `github_token` is stored at `<prefix>/github_token`.

- **`ARCHESTRA_HASHICORP_VAULT_SECRET_METADATA_PATH`** - Path prefix for KV v2 list and delete operations.
  - Default: [`ARCHESTRA_HASHICORP_VAULT_SECRET_PATH`](/docs/reference/configuration#ARCHESTRA_HASHICORP_VAULT_SECRET_PATH) with `/data/` replaced by `/metadata/`
  - Set it only when your paths do not follow that pattern.

- **`ARCHESTRA_DATABASE_URL_VAULT_REF`** - Reads the database connection string from Vault instead of [`ARCHESTRA_DATABASE_URL`](/docs/reference/configuration#ARCHESTRA_DATABASE_URL).
  - Default: unset
  - Values: `path:key`, for example `secret/data/archestra/database:connection_string`
  - Used only when [`ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT`](/docs/reference/configuration#ARCHESTRA_SECRETS_MANAGER).

- **`ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY`** - Compatibility name for the encrypted-chat recovery public key.
  - Default: unset
  - Used only when [`ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY`](/docs/reference/configuration#ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY) is unset.

- **`ARCHESTRA_CHAT_INCOGNITO_ESCROW_PUBLIC_KEY`** - Compatibility name for the encrypted-chat recovery public key.
  - Default: unset
  - Used only when both [`ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY`](/docs/reference/configuration#ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY) and [`ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY`](/docs/reference/configuration#ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY) are unset.

## LLM Providers

These variables set each provider's deployment-wide endpoint and authentication. A base URL saved on a key in **Settings → LLM → Model providers** overrides the variable for that key. See [Supported LLM Providers](/docs/llm-proxy/providers) for setup.

### OpenAI

- **`ARCHESTRA_OPENAI_BASE_URL`** - Base URL for OpenAI API requests.
  - Default: `https://api.openai.com/v1`

- **`ARCHESTRA_OPENAI_CODEX_API_BASE_URL`** - Codex backend that serves ChatGPT-subscription requests.
  - Default: `https://chatgpt.com/backend-api/codex`

- **`ARCHESTRA_OPENAI_CODEX_ISSUER`** - OAuth issuer for the ChatGPT subscription sign-in.
  - Default: `https://auth.openai.com`

- **`ARCHESTRA_OPENAI_CODEX_CLIENT_ID`** - OAuth client ID for the ChatGPT subscription sign-in.
  - Default: the Codex CLI client ID

- **`ARCHESTRA_OPENAI_CODEX_ORIGINATOR`** - `originator` header sent to the Codex backend.
  - Default: `archestra`
  - Set `codex_cli_rs` if the Codex backend rejects the default.

### Anthropic

- **`ARCHESTRA_ANTHROPIC_BASE_URL`** - Base URL for Anthropic API requests.
  - Default: `https://api.anthropic.com`
  - For Claude on Microsoft Foundry, use `https://<resource-name>.services.ai.azure.com/anthropic`.

- **`ARCHESTRA_ANTHROPIC_AZURE_FOUNDRY_ENTRA_ID_ENABLED`** - Authenticates to Claude on Microsoft Foundry with Microsoft Entra ID instead of an API key.
  - Default: `false`
  - Values: `true`, `false`
  - Requires [`ARCHESTRA_ANTHROPIC_BASE_URL`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_BASE_URL) set to a Foundry `/anthropic` URL. Credentials come from Azure `DefaultAzureCredential`.

- **`ARCHESTRA_ANTHROPIC_VERTEX_AI_PROJECT`** - Google Cloud project ID that turns on Claude on Vertex AI.
  - Default: unset (Vertex AI off)
  - Credentials come from [`ARCHESTRA_ANTHROPIC_VERTEX_AI_CREDENTIALS_FILE`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_VERTEX_AI_CREDENTIALS_FILE) or Application Default Credentials.
  - Turn on only one keyless Anthropic mode: Vertex AI, Workload Identity Federation, or Foundry Entra ID.

- **`ARCHESTRA_ANTHROPIC_VERTEX_AI_LOCATION`** - Vertex AI location for Claude requests.
  - Default: `global`

- **`ARCHESTRA_ANTHROPIC_VERTEX_AI_CREDENTIALS_FILE`** - Path to a Google Cloud service account JSON key for Claude on Vertex AI.
  - Default: unset (uses Application Default Credentials)

- **`ARCHESTRA_ANTHROPIC_FEDERATION_RULE_ID`** - Federation rule ID (`fdrl_...`) for keyless [Workload Identity Federation](https://platform.claude.com/docs/en/manage-claude/workload-identity-federation).
  - Default: unset
  - Required with [`ARCHESTRA_ANTHROPIC_ORGANIZATION_ID`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_ORGANIZATION_ID), [`ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID), and an identity token. If any of them is missing, federation stays off and Archestra logs a warning.
  - Create the rule in the Claude Console under **Settings → Workload identity**.

- **`ARCHESTRA_ANTHROPIC_ORGANIZATION_ID`** - Anthropic organization ID for Workload Identity Federation.
  - Default: unset

- **`ARCHESTRA_ANTHROPIC_SERVICE_ACCOUNT_ID`** - Anthropic service account ID (`svac_...`) for Workload Identity Federation.
  - Default: unset

- **`ARCHESTRA_ANTHROPIC_WORKSPACE_ID`** - Anthropic workspace ID (`wrkspc_...`) for Workload Identity Federation.
  - Default: unset
  - Required only when the federation rule covers more than one workspace.

- **`ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN_FILE`** - Path to the OIDC identity token file for Workload Identity Federation, such as a Kubernetes projected service account token.
  - Default: unset
  - Values: a file path, for example `/var/run/secrets/anthropic.com/token`
  - Rotated tokens apply without a restart. It overrides [`ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN`](/docs/reference/configuration#ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN).

- **`ARCHESTRA_ANTHROPIC_IDENTITY_TOKEN`** - Inline OIDC identity token for Workload Identity Federation.
  - Default: unset
  - Identity tokens are short-lived. Use this for testing, and the file variant in production.

### Google Gemini

- **`ARCHESTRA_GEMINI_BASE_URL`** - Base URL for Google AI Studio (Gemini API) requests.
  - Default: `https://generativelanguage.googleapis.com`
  - Ignored when [`ARCHESTRA_GEMINI_VERTEX_AI_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_GEMINI_VERTEX_AI_ENABLED).

- **`ARCHESTRA_GEMINI_VERTEX_AI_ENABLED`** - Sends Gemini requests to Vertex AI instead of Google AI Studio, with Google Cloud credentials instead of API keys.
  - Default: `false`
  - Values: `true`, `false`
  - See [Using Vertex AI](/docs/llm-proxy/providers/gemini#using-vertex-ai).

- **`ARCHESTRA_GEMINI_VERTEX_AI_PROJECT`** - Google Cloud project ID for Gemini on Vertex AI.
  - Default: unset
  - Required when: [`ARCHESTRA_GEMINI_VERTEX_AI_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_GEMINI_VERTEX_AI_ENABLED)

- **`ARCHESTRA_GEMINI_VERTEX_AI_LOCATION`** - Vertex AI region for Gemini requests.
  - Default: `us-central1`
  - Values: a Vertex AI location, for example `europe-west1` or `global`
  - Some regions, including `us-east1`, list an incomplete model catalog. `us-central1` and `global` list the full catalog.

- **`ARCHESTRA_GEMINI_VERTEX_AI_ALLOW_GLOBAL_ENDPOINT`** - Sends requests for models that Vertex AI serves only from `global`, such as Gemini 3 and newer, to the global endpoint.
  - Default: `false`
  - Values: `true`, `false`
  - While `false`, those models do not appear in the model list. Other models keep using [`ARCHESTRA_GEMINI_VERTEX_AI_LOCATION`](/docs/reference/configuration#ARCHESTRA_GEMINI_VERTEX_AI_LOCATION).
  - Leave it `false` when your region is a data residency requirement. Google routes global-endpoint requests to any region.

- **`ARCHESTRA_GEMINI_VERTEX_AI_CREDENTIALS_FILE`** - Path to a Google Cloud service account JSON key for Gemini on Vertex AI.
  - Default: unset (uses [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials))
  - Needed only outside Google Cloud or without Workload Identity.

### Amazon Bedrock

- **`ARCHESTRA_BEDROCK_BASE_URL`** - Custom Bedrock runtime endpoint.
  - Default: unset (`https://bedrock-runtime.<region>.amazonaws.com`)

- **`ARCHESTRA_BEDROCK_REGION`** - AWS region for Bedrock requests.
  - Default: the region in [`ARCHESTRA_BEDROCK_BASE_URL`](/docs/reference/configuration#ARCHESTRA_BEDROCK_BASE_URL), otherwise `us-east-1`
  - A region selected on a key overrides this.

- **`ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED`** - Authenticates to Bedrock with the AWS credential chain (IRSA, instance profile, or AWS environment variables) instead of an API key.
  - Default: `false`
  - Values: `true`, `false`
  - See [IAM Authentication Setup (IRSA)](/docs/llm-proxy/providers/bedrock#iam-authentication-setup-irsa).

- **`ARCHESTRA_BEDROCK_ALLOWED_PROVIDERS`** - Lists only the Bedrock inference profiles from these model providers.
  - Default: unset (all providers)
  - Values: comma-separated provider prefixes, for example `anthropic,amazon`

- **`ARCHESTRA_BEDROCK_ALLOWED_INFERENCE_REGIONS`** - Lists only the Bedrock inference profiles for these regions.
  - Default: unset (all regions)
  - Values: comma-separated region prefixes, for example `us,global`

### Azure AI Foundry

- **`ARCHESTRA_AZURE_OPENAI_BASE_URL`** - Azure AI Foundry endpoint URL.
  - Default: unset
  - Values: a deployment URL, `https://<resource-name>.openai.azure.com/openai/deployments/<deployment-name>`, or a Foundry v1 URL, `https://<resource-name>.services.ai.azure.com/openai/v1`
  - Use a Foundry v1 URL for Azure-sold OpenAI-compatible models such as Grok.

- **`ARCHESTRA_AZURE_OPENAI_API_VERSION`** - Azure OpenAI API version for Chat Completions and deployment discovery.
  - Default: `2024-02-01`

- **`ARCHESTRA_AZURE_OPENAI_RESPONSES_API_VERSION`** - Azure OpenAI API version for Responses API requests.
  - Default: `2025-04-01-preview`

- **`ARCHESTRA_AZURE_OPENAI_ENTRA_ID_ENABLED`** - Authenticates to Azure AI Foundry with Microsoft Entra ID instead of an API key.
  - Default: `false`
  - Values: `true`, `false`
  - Requires [`ARCHESTRA_AZURE_OPENAI_BASE_URL`](/docs/reference/configuration#ARCHESTRA_AZURE_OPENAI_BASE_URL). Credentials come from Azure `DefaultAzureCredential`.

### xAI

- **`ARCHESTRA_XAI_BASE_URL`** - Base URL for xAI API-key requests.
  - Default: `https://api.x.ai/v1`

- **`ARCHESTRA_XAI_SUBSCRIPTION_BASE_URL`** - Endpoint for SuperGrok subscription requests.
  - Default: `https://cli-chat-proxy.grok.com/v1`

- **`ARCHESTRA_XAI_SUBSCRIPTION_ISSUER`** - OAuth issuer for the SuperGrok sign-in.
  - Default: `https://auth.x.ai`

- **`ARCHESTRA_XAI_SUBSCRIPTION_VERIFICATION_ORIGIN`** - Only browser origin accepted for the SuperGrok sign-in verification page.
  - Default: `https://accounts.x.ai`

- **`ARCHESTRA_XAI_SUBSCRIPTION_CLIENT_ID`** - OAuth client ID for the SuperGrok sign-in.
  - Default: the Grok CLI client ID

- **`ARCHESTRA_XAI_SUBSCRIPTION_CLIENT_VERSION`** - Grok CLI version reported to the SuperGrok endpoint.
  - Default: the Grok CLI version pinned in your Archestra release
  - If SuperGrok chat fails with HTTP 426, set this to the version at `https://x.ai/cli/stable`.

- **`ARCHESTRA_XAI_SUBSCRIPTION_SCOPES`** - OAuth scopes requested at SuperGrok sign-in.
  - Default: `openid profile email offline_access api:access grok-cli:access`
  - Values: space-separated scopes. Keep `offline_access`. Remove `grok-cli:access` if xAI refuses it for your accounts.

### GitHub Copilot

- **`ARCHESTRA_GITHUB_COPILOT_BASE_URL`** - Base URL for GitHub Copilot API requests.
  - Default: `https://api.githubcopilot.com`
  - For GitHub Enterprise, use `https://copilot-api.<ghe-domain>`.

- **`ARCHESTRA_GITHUB_COPILOT_TOKEN_EXCHANGE_URL`** - Endpoint that exchanges a user's GitHub OAuth token for a Copilot API token.
  - Default: `https://api.github.com/copilot_internal/v2/token`
  - For GitHub Enterprise, use `https://copilot-api.<ghe-domain>/copilot_internal/v2/token`.

- **`ARCHESTRA_GITHUB_COPILOT_DEVICE_AUTH_BASE_URL`** - GitHub host for the **Sign in with GitHub** device flow.
  - Default: `https://github.com`

- **`ARCHESTRA_GITHUB_COPILOT_CLIENT_ID`** - GitHub App client ID for the **Sign in with GitHub** device flow.
  - Default: `Iv1.b507a08c87ecfe98` (the VS Code Copilot client ID)
  - Set your own GitHub App's client ID if it has Copilot API access.

### Microsoft 365 Copilot

- **`ARCHESTRA_MICROSOFT_365_COPILOT_CLIENT_ID`** - Application (client) ID of your Entra app registration for **Sign in with Microsoft**.
  - Default: unset (sign-in unavailable)
  - See [Microsoft 365 Copilot](/docs/llm-proxy/providers/microsoft-365-copilot) for the app registration.

- **`ARCHESTRA_MICROSOFT_365_COPILOT_TENANT_ID`** - Entra tenant that users sign in to.
  - Default: `organizations` (any work or school account)
  - Set your tenant ID to restrict sign-in to one directory.

- **`ARCHESTRA_MICROSOFT_365_COPILOT_BASE_URL`** - Microsoft Graph base URL for the Microsoft 365 Copilot Chat API.
  - Default: `https://graph.microsoft.com/beta`

- **`ARCHESTRA_MICROSOFT_365_COPILOT_AUTH_BASE_URL`** - Entra ID host for the sign-in and token endpoints.
  - Default: `https://login.microsoftonline.com`
  - Change it for a sovereign cloud.

### OpenRouter

- **`ARCHESTRA_JEV_BASE_URL`** - Full Jev decisions endpoint. See [Jev](/docs/llm-proxy/providers#jev).
  - Default: `https://api.typesafe.ai/v1/systemone`

- **`ARCHESTRA_OPENROUTER_BASE_URL`** - Base URL for OpenRouter API requests.
  - Default: `https://openrouter.ai/api/v1`

- **`ARCHESTRA_OPENROUTER_REFERER`** - `HTTP-Referer` attribution header sent to OpenRouter.
  - Default: `https://archestra.ai`
  - A client's own header takes precedence.

- **`ARCHESTRA_OPENROUTER_TITLE`** - App title attribution header sent to OpenRouter.
  - Default: `Archestra`
  - A client's own header takes precedence.

- **`ARCHESTRA_OPENROUTER_CATEGORIES`** - OpenRouter marketplace categories attribution header.
  - Default: `general-chat,personal-agent`
  - Values: comma-separated categories

### Ollama

- **`ARCHESTRA_OLLAMA_BASE_URL`** - Base URL of your Ollama server's OpenAI-compatible API.
  - Default: `http://localhost:11434/v1`
  - Ollama is always on. See [Ollama](/docs/llm-proxy/providers/ollama).

- **`ARCHESTRA_OLLAMA_NATIVE_BASE_URL`** - Root URL of your Ollama server for the **Ollama (Native)** provider, which uses Ollama's `/api/chat` endpoint.
  - Default: [`ARCHESTRA_OLLAMA_BASE_URL`](/docs/reference/configuration#ARCHESTRA_OLLAMA_BASE_URL) without the `/v1` suffix
  - Set it only when the native endpoint runs on another host. Omit `/v1`.

### Other Providers

- **`ARCHESTRA_VLLM_BASE_URL`** - Base URL of your OpenAI-compatible server (vLLM, llama.cpp, LM Studio, SGLang, TGI, LocalAI).
  - Default: unset (provider off)
  - Values: a URL, for example `http://localhost:8000/v1`
  - See [OpenAI-Compatible Servers](/docs/llm-proxy/providers/openai-compatible).

- **`ARCHESTRA_ARCHESTRA_BASE_URL`** - LLM proxy URL of another Archestra instance, for the Archestra provider.
  - Default: unset
  - Set the URL on each key instead. This variable only turns on raw passthrough at the `/v1/archestra` proxy prefix. See [Archestra](/docs/llm-proxy/providers/archestra).

- **`ARCHESTRA_CEREBRAS_BASE_URL`** - Base URL for Cerebras API requests.
  - Default: `https://api.cerebras.ai/v1`

- **`ARCHESTRA_COHERE_BASE_URL`** - Base URL for Cohere API requests.
  - Default: `https://api.cohere.ai`

- **`ARCHESTRA_DEEPSEEK_BASE_URL`** - Base URL for DeepSeek API requests.
  - Default: `https://api.deepseek.com`

- **`ARCHESTRA_GROQ_BASE_URL`** - Base URL for Groq API requests.
  - Default: `https://api.groq.com/openai/v1`

- **`ARCHESTRA_KIMI_BASE_URL`** - Base URL for Kimi (Moonshot AI) API requests.
  - Default: `https://api.moonshot.ai/v1`

- **`ARCHESTRA_MINIMAX_BASE_URL`** - Base URL for MiniMax API requests.
  - Default: `https://api.minimax.io/v1`

- **`ARCHESTRA_MISTRAL_BASE_URL`** - Base URL for Mistral AI API requests.
  - Default: `https://api.mistral.ai/v1`

- **`ARCHESTRA_PERPLEXITY_BASE_URL`** - Base URL for Perplexity API requests.
  - Default: `https://api.perplexity.ai`

- **`ARCHESTRA_VOYAGE_BASE_URL`** - Base URL for Voyage AI embedding requests.
  - Default: `https://api.voyageai.com/v1`

- **`ARCHESTRA_ZHIPUAI_BASE_URL`** - Base URL for Zhipu AI API requests.
  - Default: `https://api.z.ai/api/paas/v4`

## LLM Proxy

- **`ARCHESTRA_LLM_PROXY_MAX_VIRTUAL_KEYS`** - Maximum number of virtual keys per provider API key.
  - Default: `10`
  - See [LLM Proxy Authentication](/docs/llm-proxy/authentication).

- **`ARCHESTRA_LLM_PROXY_VIRTUAL_KEYS_DEFAULT_EXPIRATION_SECONDS`** - Default lifetime of a new virtual key, in seconds.
  - Default: `2592000` (30 days)
  - Values: `0` (never expires) up to `31536000` (one year); larger values are capped at one year
  - Users can set a different expiration on each key.

- **`ARCHESTRA_LLM_PROXY_UPSTREAM_TIMEOUT_MS`** - How long an LLM request waits for response headers or the next stream chunk, in milliseconds.
  - Default: unset (5 minutes)
  - Raise it when a model can take more than 5 minutes to start or continue a response.
  - Keep it below your load balancer's request or idle timeout. For a 600-second load balancer timeout, use `540000`.

- **`ARCHESTRA_LLM_PROXY_STREAM_KEEPALIVE_INTERVAL_MS`** - Longest a streaming response stays silent before Archestra sends an SSE keep-alive comment, in milliseconds.
  - Default: `10000` (10 seconds)
  - Values: `0` turns it off
  - Keep it below the shortest stall timeout of your clients. Claude Code reports a stall after 20 seconds.
  - Bedrock and Ollama native streams get no keep-alive.

- **`ARCHESTRA_LLM_COST_SUBSCRIPTION_AUTODETECT`** - Records traffic sent with a subscription credential, such as a Claude Pro or Max login, as subscription usage with $0 billed spend.
  - Default: `true`
  - Values: `true`, `false` (all traffic is metered)
  - Archestra records Anthropic requests paid from extra usage credits, after the subscription allowance runs out, as metered. See [Subscription vs Metered Cost](/docs/llm-proxy/costs-and-limits#subscription-vs-metered-cost).

- **`ARCHESTRA_LLM_PROXY_PLUGINS`** - LLM proxy plugins loaded at startup.
  - Default: unset (no plugins)
  - Values: comma-separated; the only plugin is `appa`. An unknown name or a duplicate stops startup.
  - [`ARCHESTRA_BETA=true`](/docs/reference/configuration#ARCHESTRA_BETA) adds `appa` automatically. Listing `appa` without [`ARCHESTRA_BETA=true`](/docs/reference/configuration#ARCHESTRA_BETA) has no effect.

## Chat

### Provider API Keys

At startup, Archestra creates an organization-wide key from each `ARCHESTRA_CHAT_<PROVIDER>_API_KEY` unless one already exists for that provider. Changing a variable later does not update the existing key. Edit it in **Settings → LLM → Model providers** instead. The variable is also the last fallback when no stored key matches.

- **`ARCHESTRA_CHAT_ANTHROPIC_API_KEY`** - Anthropic API key.
  - Default: unset

- **`ARCHESTRA_CHAT_OPENAI_API_KEY`** - OpenAI API key.
  - Default: unset

- **`ARCHESTRA_CHAT_GEMINI_API_KEY`** - Google AI Studio (Gemini) API key.
  - Default: unset

- **`ARCHESTRA_CHAT_BEDROCK_API_KEY`** - Amazon Bedrock API key.
  - Default: unset

- **`ARCHESTRA_CHAT_AZURE_OPENAI_API_KEY`** - Azure AI Foundry API key.
  - Default: unset
  - Ignored unless [`ARCHESTRA_AZURE_OPENAI_BASE_URL`](/docs/reference/configuration#ARCHESTRA_AZURE_OPENAI_BASE_URL) is set.

- **`ARCHESTRA_CHAT_OPENROUTER_API_KEY`** - OpenRouter API key.
  - Default: unset

- **`ARCHESTRA_CHAT_CEREBRAS_API_KEY`** - Cerebras API key.
  - Default: unset

- **`ARCHESTRA_CHAT_COHERE_API_KEY`** - Cohere API key.
  - Default: unset

- **`ARCHESTRA_CHAT_DEEPSEEK_API_KEY`** - DeepSeek API key.
  - Default: unset

- **`ARCHESTRA_CHAT_GROQ_API_KEY`** - Groq API key.
  - Default: unset

- **`ARCHESTRA_CHAT_KIMI_API_KEY`** - Kimi (Moonshot AI) API key.
  - Default: unset

- **`ARCHESTRA_CHAT_MINIMAX_API_KEY`** - MiniMax API key.
  - Default: unset

- **`ARCHESTRA_CHAT_MISTRAL_API_KEY`** - Mistral AI API key.
  - Default: unset

- **`ARCHESTRA_CHAT_PERPLEXITY_API_KEY`** - Perplexity API key.
  - Default: unset

- **`ARCHESTRA_CHAT_VOYAGE_API_KEY`** - Voyage AI API key, used for knowledge base embeddings.
  - Default: unset

- **`ARCHESTRA_CHAT_XAI_API_KEY`** - xAI API key.
  - Default: unset

- **`ARCHESTRA_CHAT_ZHIPUAI_API_KEY`** - Zhipu AI API key.
  - Default: unset

- **`ARCHESTRA_CHAT_VLLM_API_KEY`** - API key for your OpenAI-compatible server.
  - Default: unset
  - Ignored unless [`ARCHESTRA_VLLM_BASE_URL`](/docs/reference/configuration#ARCHESTRA_VLLM_BASE_URL) is set. Most servers need no key.

- **`ARCHESTRA_CHAT_OLLAMA_API_KEY`** - API key for your Ollama server, used by both the **Ollama** and **Ollama (Native)** providers.
  - Default: unset
  - Most Ollama servers need no key.

- **`ARCHESTRA_CHAT_ARCHESTRA_API_KEY`** - API key for another Archestra instance's LLM proxy.
  - Default: unset
  - Ignored unless [`ARCHESTRA_ARCHESTRA_BASE_URL`](/docs/reference/configuration#ARCHESTRA_ARCHESTRA_BASE_URL) is set.

- **`ARCHESTRA_CHAT_GITHUB_COPILOT_API_KEY`** - Has no effect.
  - GitHub Copilot keys are personal. Each user connects their own GitHub account.

### Defaults and Limits

- **`ARCHESTRA_CHAT_DEFAULT_PROVIDER`** - Provider of the last-resort default model, used when the organization has no default model, no synced models, and no provider API key variable.
  - Default: `anthropic`
  - Values: a provider ID, for example `anthropic`, `openai`, `gemini`, `bedrock`, `azure`, `ollama`. An unknown value falls back to `anthropic`.

- **`ARCHESTRA_CHAT_DEFAULT_MODEL`** - Model ID of the last-resort default model.
  - Default: the default Anthropic model of your Archestra release
  - Set it together with [`ARCHESTRA_CHAT_DEFAULT_PROVIDER`](/docs/reference/configuration#ARCHESTRA_CHAT_DEFAULT_PROVIDER).

- **`ARCHESTRA_CHAT_MAX_OUTPUT_TOKENS`** - Upper limit on output tokens for one agent turn, in chat and in A2A runs.
  - Default: `32768`
  - Values: `1` to `1000000`
  - A turn uses the lower of this value and the model's own output limit. Models without a known limit use `8192`.

- **`ARCHESTRA_CHAT_RATE_METERED_MAX_OUTPUT_TOKENS`** - Output token limit for Groq, which charges the requested output budget against a per-minute token allowance.
  - Default: `4096`
  - Values: `1` to `1000000`
  - On low Groq tiers, a larger request fails with HTTP 413 before generating anything. Raise it on higher tiers.

- **`ARCHESTRA_CHAT_ATTACHMENT_STORAGE_BYTES_LIMIT`** - Largest file a user can attach to a chat message, in bytes.
  - Default: `52428800` (50 MiB)
  - Archestra stores a file the model cannot read in the conversation's Files panel and tells the agent it is there.
  - Raise [`ARCHESTRA_API_BODY_LIMIT`](/docs/reference/configuration#ARCHESTRA_API_BODY_LIMIT) with it. Archestra sends attachments base64-encoded, at about 4/3 of their size, in the same request as the conversation.

- **`ARCHESTRA_CHAT_ATTACHMENT_INLINE_BYTES_LIMIT`** - Largest attachment sent to the model in a request, in bytes.
  - Default: `16777216` (16 MiB)
  - A larger attachment is stored but never sent to the model. The provider's own request limit applies too: 32 MiB for Anthropic, 20 MiB for Bedrock.

- **`ARCHESTRA_CHAT_SECRET_SCAN_ENABLED`** - Asks for confirmation before sending a chat message that appears to contain a secret, such as an API key, token, password, or private key.
  - Default: `true`
  - Values: `true`, `false`
  - The scan runs in the browser, and users can choose **Send anyway**. It is not a data loss prevention control.

### Active Run Updates

Chat streams and A2A task streams wake through PostgreSQL `LISTEN/NOTIFY` across replicas, with polling as a fallback. Change these only to tune database load or to work behind a connection pooler.

- **`ARCHESTRA_CHAT_ACTIVE_RUN_REPLAY_POLL_INTERVAL_MS`** - How often a reconnecting client checks for new events of a running chat, in milliseconds.
  - Default: `500`

- **`ARCHESTRA_CHAT_ACTIVE_RUN_STOP_POLL_INTERVAL_MS`** - Fallback interval for checking whether a running chat was stopped, in milliseconds.
  - Default: `30000`

- **`ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL`** - PostgreSQL connection string used only for `LISTEN/NOTIFY`.
  - Default: [`ARCHESTRA_DATABASE_URL`](/docs/reference/configuration#ARCHESTRA_DATABASE_URL)
  - Set it when regular traffic uses PgBouncer transaction pooling, which cannot hold a listener. Point it at a direct or session-pooled connection.

- **`ARCHESTRA_CHAT_ACTIVE_RUN_POLLING_COMPATIBILITY_ENABLED`** - Turns off the `LISTEN/NOTIFY` listener, so chat and A2A task streams use polling only.
  - Default: `false`
  - Values: `true`, `false`
  - Archestra detects an endpoint that cannot deliver notifications and polls faster on its own. Set this only to avoid opening a listener connection that cannot work.

## MCP Gateway

- **`ARCHESTRA_MCP_GATEWAY_TOOL_CALL_TIMEOUT_MS`** - Timeout for one upstream MCP tool call made through the gateway, in milliseconds.
  - Default: `60000` (60 seconds)
  - Raise it for slow tools, such as a scraper or a report builder, that fail with a request-timeout error.
  - A call from a client that supports MCP Tasks becomes a background task after half this value, capped at 10 seconds.

- **`ARCHESTRA_MCP_GATEWAY_WAKE_WAIT_TIMEOUT_MS`** - How long a tool call waits for a hibernated MCP server to wake before it returns a retryable "still starting" result, in milliseconds.
  - Default: `30000` (30 seconds)
  - Keep it below your clients' own request timeouts. Otherwise the client aborts first and sees a transport error.

## MCP Servers

- **`ARCHESTRA_MCP_SERVER_TOOLS_REFRESH_INTERVAL_MINUTES`** - Re-syncs every installed MCP server's tools and Skills from the live server at this interval, in minutes.
  - Default: unset (no periodic refresh)
  - Values: a positive whole number, for example `30`. `0` disables it.
  - To refresh one server on demand, use its **Inspector** tab in the MCP Registry.

## MCP Server Orchestrator

- **`ARCHESTRA_ORCHESTRATOR_LOAD_KUBECONFIG_FROM_CURRENT_CLUSTER`** - Uses the in-cluster service account to reach Kubernetes.
  - Default: `false`. The Helm chart sets `true`.
  - When Archestra runs outside the target cluster, leave it `false` and set [`ARCHESTRA_ORCHESTRATOR_KUBECONFIG`](/docs/reference/configuration#ARCHESTRA_ORCHESTRATOR_KUBECONFIG).

- **`ARCHESTRA_ORCHESTRATOR_KUBECONFIG`** - Path to a kubeconfig file mounted in the container.
  - Default: unset (default kubeconfig locations)
  - Example: `/etc/archestra/kubeconfig`

- **`ARCHESTRA_ORCHESTRATOR_K8S_NAMESPACE`** - Namespace that MCP server pods run in.
  - Default: `default`. The Helm chart sets the release namespace.

- **`ARCHESTRA_ORCHESTRATOR_ENVIRONMENT_NAMESPACES`** - Namespaces the platform service account has permissions in, offered as a dropdown in the [environment](/docs/admin/environments) editor.
  - Default: unset (the editor takes free text)
  - Values: comma-separated namespaces, for example `staging,production`

- **`ARCHESTRA_ORCHESTRATOR_K8S_CLUSTER_DOMAIN`** - Cluster DNS domain used to build in-cluster Service addresses.
  - Default: `cluster.local`

- **`ARCHESTRA_ORCHESTRATOR_K8S_NODE_HOST`** - Host Archestra uses to reach NodePort Services when it runs outside the cluster.
  - Default: `localhost`

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_BASE_IMAGE`** - Base image for MCP servers that do not set their own image.
  - Default: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/mcp-server-base:<platform version>`

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_CPU_REQUEST`** - CPU request for each MCP server container.
  - Default: `50m`
  - Values: Kubernetes quantity

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_REQUEST`** - Memory request for each MCP server container.
  - Default: `128Mi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_MEMORY_LIMIT`** - Memory limit for each MCP server container.
  - Default: `512Mi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_REQUEST`** - Ephemeral-storage request for each MCP server container.
  - Default: `256Mi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_ORCHESTRATOR_MCP_SERVER_EPHEMERAL_STORAGE_LIMIT`** - Ephemeral-storage limit for each MCP server container.
  - Default: `1Gi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_ORCHESTRATOR_FAILED_POD_REAP_INTERVAL_SECONDS`** - How often Archestra deletes Failed or Evicted MCP server pods, in seconds.
  - Default: `600`
  - Values: a positive whole number. `0` disables it.

- **`ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_SECONDS`** - How long an MCP server pod sits unused before it hibernates, in seconds.
  - Default: `1800` (30 minutes)
  - Values: `0`, or `120` and above. Lower values are raised to `120`.
  - `0` turns hibernation off for the whole deployment, whatever the organization setting.

- **`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_ENABLED`** - Caches MCP server images on every node with a DaemonSet, so hibernated servers wake without pulling from the registry.
  - Default: `true`
  - Runs only while idle hibernation is on. Set `false` to keep hibernation without the DaemonSet, which takes a pod slot on every eligible node.

- **`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_BOOTSTRAP_IMAGE`** - Image for the pre-pull DaemonSet's own containers.
  - Default: `docker.io/library/busybox:1.36-musl`
  - The image must provide a statically linked `/bin/busybox`. Point it at a mirror when your cluster cannot pull from Docker Hub.

- **`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_BOOTSTRAP_IMAGE_PULL_SECRETS`** - Image pull secrets for the bootstrap image.
  - Default: unset
  - Values: comma-separated secret names in the MCP server namespace

- **`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_PRIORITY_CLASS_NAME`** - Priority class for the pre-pull DaemonSet pods.
  - Default: unset (namespace default)
  - Use a low-priority class so caching images never preempts real workloads.

- **`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_CPU_REQUEST`** - CPU request for each pre-pull pod.
  - Default: `10m`
  - Values: Kubernetes quantity

- **`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_MEMORY_REQUEST`** - Memory request for each pre-pull pod.
  - Default: `16Mi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_PREPULL_MEMORY_LIMIT`** - Memory limit for each pre-pull pod.
  - Default: `64Mi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_ORCHESTRATOR_MCP_RUNTIME_OWNER_ROLE`** - Role in each runtime namespace that Archestra uses to remove the MCP resources it created when the chart is uninstalled.
  - Default: set by the Helm chart when it manages orchestrator permissions
  - With your own RBAC, create a Role with this name in every runtime namespace, and delete each one during uninstall.

- **`ARCHESTRA_ORCHESTRATOR_HELM_RELEASE_NAME`** - Release name used to name cluster objects Archestra creates outside the chart, such as the image pre-pull DaemonSet.
  - Default: set by the Helm chart. Set it yourself only when you deploy without the chart.
  - When unset, those objects are not created.

## MCP Apps Sandbox

MCP Apps render in sandboxed iframes. Without a sandbox domain, apps still work. They cannot use `localStorage`, cookies, or origin-restricted APIs. See [Deployment](/docs/admin/deployment) for setup.

- **`ARCHESTRA_MCP_SANDBOX_DOMAIN`** - Wildcard domain that gives each MCP server's apps their own origin.
  - Default: unset (opaque iframe origin)
  - Example: `mcp.example.com`
  - Requires a wildcard DNS record and TLS certificate for `*.mcp.example.com` that route to the backend.

## A2A Gateway

- **`ARCHESTRA_A2A_TASK_RETENTION_DAYS`** - Days a finished A2A task is kept before it is deleted with its artifacts, stream events, and execution transcript.
  - Default: `90`
  - Values: a whole number of days. `0` keeps tasks forever.
  - Running tasks are never deleted. The conversation history the task belongs to is kept.

- **`ARCHESTRA_MCP_CATALOG_API_BASE_URL`** - API URL for the online MCP server catalog.
  - Default: `https://archestra.ai/mcp-catalog/api`
  - Set it when your deployment uses a catalog mirror.

## Code Sandbox

Archestra creates one Dagger engine per organization and per environment. Each engine needs a node that admits privileged pods and a storage class for `ReadWriteOnce` volumes. See [Deployment](/docs/admin/deployment).

- **`ARCHESTRA_CODE_RUNTIME_ENABLED`** - Enables the per-conversation [code sandbox](/docs/agents#code-sandbox), where agents run shell commands and Python.
  - Default: `false`. The Docker quickstart image and the Helm chart (`archestra.codeRuntime.enabled`) default to `true`.
  - Values: `true`, `false`. `false` turns the sandbox off even when [`ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST) is set.
  - Requires the orchestrator. When off, [`run_command`](/docs/reference/archestra-mcp-server#run_command) and the other sandbox tools are unavailable and skill scripts cannot run.

- **`ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST`** - Address of a Dagger engine you run yourself, used instead of an Archestra-managed engine.
  - Default: unset (Archestra manages every engine)
  - Values: a `tcp://` or `kube-pod://` URL, for example `tcp://dagger-engine:8080`. Any other value turns the code sandbox off.
  - Setting it enables the code sandbox. Agents bound to an [environment](/docs/admin/environments) still run on that environment's managed engine.

- **`ARCHESTRA_DAGGER_RUNTIME_IMAGE`** - Base image for sandbox containers.
  - Default: `ghcr.io/astral-sh/uv:0.9.17-python3.12-bookworm-slim`
  - Values: a Debian-based image

- **`ARCHESTRA_CODE_RUNTIME_BASE_PREBUILT`** - Skips the per-sandbox package install because [`ARCHESTRA_DAGGER_RUNTIME_IMAGE`](/docs/reference/configuration#ARCHESTRA_DAGGER_RUNTIME_IMAGE) is a pre-built sandbox base image.
  - Default: `false`
  - Values: `true`, `false`
  - With `true`, engines with restricted egress need to reach only the base image's registry, not `ghcr.io`, Debian mirrors, or PyPI. Sandboxes fail if the image is not the pre-built base.

- **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_CPU_REQUEST`** - CPU request for each engine Archestra creates.
  - Default: `2`
  - Values: Kubernetes quantity
  - Engine resource settings apply to new engines only. Delete an engine to resize it.

- **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_REQUEST`** - Memory request for each engine Archestra creates. It reserves node capacity for the engine and its sandboxes.
  - Default: `6Gi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_LIMIT`** - Memory limit for each engine process. It does not cover the sandboxes; see [`ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX`](/docs/reference/configuration#ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX).
  - Default: `6Gi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_CACHE_STORAGE`** - Size of each engine's build-cache volume.
  - Default: `50Gi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_SANDBOX_MEMORY_MAX`** - Total memory all of an engine's sandboxes can use at once. A run that exceeds it is killed; other runs continue.
  - Default: `5Gi`
  - Values: Kubernetes quantity. Keep it below [`ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_REQUEST`](/docs/reference/configuration#ARCHESTRA_DAGGER_RUNTIME_ENGINE_MEMORY_REQUEST).
  - For heavy concurrent work, raise it with the memory request, or lower [`ARCHESTRA_DAGGER_RUNTIME_MAX_CONCURRENT`](/docs/reference/configuration#ARCHESTRA_DAGGER_RUNTIME_MAX_CONCURRENT).

- **`ARCHESTRA_DAGGER_RUNTIME_ENGINE_ADDITIONAL_DENIED_CIDRS`** - Extra IPv4 ranges that sandboxed code cannot reach.
  - Default: unset
  - Values: comma-separated CIDRs, for example `100.68.0.0/16,34.118.224.0/20`. Invalid entries are ignored and logged.
  - Engines without a [network policy](/docs/admin/environments) already block private, link-local, and cloud-metadata ranges. Add your cluster's Service and Pod CIDRs when they fall outside those ranges.

- **`ARCHESTRA_DAGGER_RUNTIME_MAX_CONCURRENT`** - Sandbox commands that run at once across the deployment.
  - Default: `10`
  - Raise it together with the engine's CPU and memory.

- **`ARCHESTRA_DAGGER_RUNTIME_MAX_QUEUE_LENGTH`** - Sandbox commands that can wait for a free slot. Beyond this, a command fails with a runtime-at-capacity error.
  - Default: `50`

- **`ARCHESTRA_SKILLS_SANDBOX_CPU_LIMIT_SECONDS`** - CPU time one sandbox command can use, in seconds.
  - Default: `30`

- **`ARCHESTRA_SKILLS_SANDBOX_MEMORY_LIMIT_BYTES`** - Memory one sandbox command can use, in bytes.
  - Default: `1073741824` (1 GiB)

- **`ARCHESTRA_SKILLS_SANDBOX_WALL_CLOCK_SECONDS`** - Wall-clock time one sandbox command can run, in seconds. Longer timeouts that callers request are lowered to this.
  - Default: `120`

- **`ARCHESTRA_SKILLS_SANDBOX_OUTPUT_BYTES_LIMIT`** - Output (stdout and stderr) kept per command, in bytes. The rest is truncated.
  - Default: `262144` (256 KiB)

- **`ARCHESTRA_SKILLS_SANDBOX_ARTIFACT_BYTES_LIMIT`** - Largest file the sandbox can read, save, or export to the conversation's Files panel, and the largest chat attachment it can stage, in bytes.
  - Default: `52428800` (50 MiB), equal to the [`ARCHESTRA_CHAT_ATTACHMENT_STORAGE_BYTES_LIMIT`](/docs/reference/configuration#ARCHESTRA_CHAT_ATTACHMENT_STORAGE_BYTES_LIMIT) default
  - Chat still stores a larger attachment; it is not staged in the sandbox.

- **`ARCHESTRA_DAGGER_RUNTIME_CLI_BIN`** - Path to the Dagger CLI executable used by the sandbox.
  - Default: unset (uses the bundled or discovered CLI)
  - Takes precedence over [`ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN`](/docs/reference/configuration#ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN).

- **`ARCHESTRA_CODE_RUNTIME_DAGGER_CLI_BIN`** - Compatibility name for the Dagger CLI executable path.
  - Default: unset
  - Prefer [`ARCHESTRA_DAGGER_RUNTIME_CLI_BIN`](/docs/reference/configuration#ARCHESTRA_DAGGER_RUNTIME_CLI_BIN).

## Agent Runtime

Agent Runtime needs the orchestrator configured. Agents can override the settings described as defaults. See [Agent Runtime](/docs/agents/runtime) for cluster setup.

- **`ARCHESTRA_AGENT_RUNTIME_ENABLED`** - Enables Agent Runtime.
  - Default: `false`
  - Values: `true`, `false`
  - Does not follow [`ARCHESTRA_BETA`](/docs/reference/configuration#ARCHESTRA_BETA).

- **`ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY`** - Registry the maintained Claude Code, Codex, OpenCode, Hermes, and OpenClaw images are pulled from.
  - Default: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public`
  - Set it when you mirror these images to a private registry.

- **`ARCHESTRA_AGENT_RUNTIME_IMAGE_TAG`** - Tag of the maintained images.
  - Default: `latest` on stable releases, otherwise the platform version

- **`ARCHESTRA_AGENT_RUNTIME_ALLOW_PRIVILEGED`** - Lets Agent administrators enable privileged runtime pods, which have node-level access.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_AGENT_RUNTIME_PLATFORM_BASE_URL`** - URL a runtime pod uses to reach the LLM proxy and MCP gateway. It must be reachable from inside the cluster.
  - Default: [`ARCHESTRA_INTERNAL_API_BASE_URL`](/docs/reference/configuration#ARCHESTRA_INTERNAL_API_BASE_URL)
  - When neither is set, runs fail to start.

- **`ARCHESTRA_AGENT_RUNTIME_DEFAULT_TTL_HOURS`** - Default maximum lifetime of a run, in hours.
  - Default: `72`

- **`ARCHESTRA_AGENT_RUNTIME_DEFAULT_IDLE_TIMEOUT_MINUTES`** - Default time an idle run waits for the next instruction before it stops, in minutes.
  - Default: `180`
  - Custom images must implement the wait, using the `ARCHESTRA_AGENT_RUNTIME_IDLE_TIMEOUT_SECONDS` variable passed to the pod.

- **`ARCHESTRA_AGENT_RUNTIME_CPU_REQUEST`** - Default CPU request for a run's pod. Runs have no CPU limit.
  - Default: `500m`
  - Values: Kubernetes quantity

- **`ARCHESTRA_AGENT_RUNTIME_MEMORY_REQUEST`** - Default memory request for a run's pod.
  - Default: `1Gi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_AGENT_RUNTIME_MEMORY_LIMIT`** - Default memory limit for a run's pod.
  - Default: `4Gi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_SIZE`** - Size of each run's persistent volume, which holds `/home/node` and, for privileged runs, `/var/lib/docker`.
  - Default: `20Gi`
  - Values: Kubernetes quantity

- **`ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_CLASS`** - Storage class for run volumes.
  - Default: unset (the cluster's default storage class)
  - Use a CSI-backed class with `WaitForFirstConsumer` binding when nodes span zones.

- **`ARCHESTRA_AGENT_RUNTIME_WARM_POOL_SIZE`** - Spare containers kept ready per group of Agents with matching container settings, so new runs start faster.
  - Default: `0` (warm pools off)
  - Spare containers reserve CPU, memory, and storage while idle. See [Agent Runtime](/docs/agents/runtime).

- **`ARCHESTRA_AGENT_RUNTIME_WARM_POOL_MAX_POOLS`** - Maximum number of warm pools. Agents outside them start containers on demand.
  - Default: `4`

- **`ARCHESTRA_AGENT_RUNTIME_NODE_SELECTOR`** - Schedules runtime pods onto a dedicated node pool.
  - Default: unset (scheduled like any other pod)
  - Values: comma-separated `key=value` pairs, for example `archestra-agent-runtime=true`. Each pair also adds a matching `NoSchedule` toleration.

- **`ARCHESTRA_AGENT_RUNTIME_PLATFORM_POD_SELECTOR`** - Label selector for the platform's API pods. Runtime pods may send traffic only to pods that match.
  - Default: `archestra.io/platform-api=true` (set on API pods by the Helm chart)
  - Values: comma-separated `key=value` pairs
  - With custom manifests, add this label to the API pods or set a selector that matches them.

- **`ARCHESTRA_AGENT_RUNTIME_POD_START_TIMEOUT_SECONDS`** - How long a run's pod can stay pending before the run fails, in seconds.
  - Default: `600`
  - Raise it for autoscaled node pools, where node creation and a large image pull can exceed the default.

- **`ARCHESTRA_AGENT_RUNTIME_RECONCILE_INTERVAL_SECONDS`** - How often Archestra syncs run state and applies the lifetime and idle limits, in seconds.
  - Default: `30`

- **`ARCHESTRA_AGENT_RUNTIME_TRANSCRIPT_MAX_BYTES`** - Largest run output kept as a complete transcript, in uncompressed bytes.
  - Default: `262144000` (250 MiB)
  - A larger run keeps only its last 1 MiB, labeled **Retained tail only** in the terminal. Transcripts are deleted with their A2A task; see [`ARCHESTRA_A2A_TASK_RETENTION_DAYS`](/docs/reference/configuration#ARCHESTRA_A2A_TASK_RETENTION_DAYS).

## Knowledge Base

Embedding, reranking, and OCR models for the [Knowledge Base](/docs/knowledge) are chosen in **Settings → Knowledge**, not here.

- **`ARCHESTRA_KNOWLEDGE_BASE_HYBRID_SEARCH_ENABLED`** - Combines vector search with keyword (BM25) search and merges the results.
  - Default: `true`
  - Values: `true`, `false` (vector search only)

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_K1`** - Deployment default for BM25 term saturation: how much a repeated word keeps raising a passage's score.
  - Default: `1.2`
  - Values: `0`–`10`. `0` scores a word the same whether it appears once or many times.
  - An organization's value under **Settings → Knowledge → Search ranking → Advanced options** overrides it.

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_B`** - Deployment default for BM25 length normalization: how much long passages are ranked below short ones that match the same words.
  - Default: `0.75`
  - Values: `0` (length ignored) to `1` (full normalization)
  - An organization's value under **Settings → Knowledge → Search ranking → Advanced options** overrides it.

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_RECALL_CAP`** - Maximum number of keyword-matching chunks that BM25 rescores per query.
  - Default: `2000`
  - Values: `10`–`100000`
  - Query cost grows with the cap. Raise it when broad queries matter more than latency.

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_STATS_REFRESH_INTERVAL_SECONDS`** - How often the corpus statistics that BM25 ranks with are rebuilt.
  - Default: `3600`
  - Values: `60`–`86400`
  - Each rebuild reads every chunk. Keyword search uses a simpler ranking until the first rebuild succeeds.

- **`ARCHESTRA_KNOWLEDGE_BASE_BM25_STATS_REFRESH_TIMEOUT_MS`** - How long one BM25 statistics rebuild may run before it is cancelled.
  - Default: `900000` (15 minutes)
  - Values: `30000`–`21600000`
  - Raise it if rebuilds on a very large corpus are cancelled.

- **`ARCHESTRA_KNOWLEDGE_BASE_SEARCH_STATEMENT_TIMEOUT_MILLIS`** - Timeout for each knowledge search query (vector and keyword run separately).
  - Default: `8000`
  - Values: `0`–`120000`. `0` uses [`ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS`](/docs/reference/configuration#ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS).
  - Archestra drops a timed-out search and returns the other results. The query fails only when all of them time out.

- **`ARCHESTRA_KNOWLEDGE_BASE_QUOTE_VERIFICATION_ENABLED`** - In the built-in chat, asks the model to back claims with verbatim quotes and logs each quote that does not match the cited chunk.
  - Default: `true`
  - Values: `true`, `false`
  - Log-only: it never blocks or changes an answer. Misses are counted in the [`rag_quote_verification_total`](/docs/admin/observability/metrics#rag_quote_verification_total) metric.

- **`ARCHESTRA_KNOWLEDGE_BASE_CHUNK_SIZE_TOKENS`** - Token budget for one chunk, including its title and metadata.
  - Default: `512`
  - Values: `128`–`2048`
  - Applies at ingest. Existing chunks keep their size until their connector re-syncs.

- **`ARCHESTRA_KNOWLEDGE_BASE_CHILD_CHUNK_SIZE_TOKENS`** - Token budget for child chunks. Search matches the smaller children and returns their parent passage.
  - Default: `0` (off)
  - Values: `0`, or `32`–`2048`. Set it below [`ARCHESTRA_KNOWLEDGE_BASE_CHUNK_SIZE_TOKENS`](/docs/reference/configuration#ARCHESTRA_KNOWLEDGE_BASE_CHUNK_SIZE_TOKENS).
  - Stored vectors grow by about the ratio of the two sizes. Applies at ingest.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONTEXT_EXPANSION_RADIUS`** - Number of neighboring chunks on each side of a search hit that are returned with it.
  - Default: `1`
  - Values: `0`–`4`. `0` returns the hit alone.
  - Each step adds up to two chunks per result, so the model reads more tokens.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONTEXTUAL_RETRIEVAL_ENABLED`** - Default [contextual retrieval](/docs/knowledge/settings#contextual-retrieval) mode for organizations that have not chosen one in **Settings → Knowledge**.
  - Default: `false` (no context)
  - Values: `true` (per-document context), `false`
  - Per-document context makes one call to the reranking model per changed document.

- **`ARCHESTRA_KNOWLEDGE_BASE_OCR_MAX_PAGES_PER_DOCUMENT`** - Maximum number of pages without text that [Document OCR](/docs/knowledge/settings#document-ocr) transcribes in one PDF.
  - Default: `100`
  - Each page is one call to the OCR model. Pages past the limit stay untranscribed. The document shows a partial-extraction warning.

- **`ARCHESTRA_KNOWLEDGE_BASE_CRAWLER_CHROMIUM_PATH`** - Path to the Chromium executable that the [Web Crawler](/docs/knowledge/connectors/web-crawler) uses to render JavaScript pages.
  - Default: unset (the default Chromium location)
  - The standard image does not include Chromium. See [Web Crawler](/docs/knowledge/connectors/web-crawler).

- **`ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_MAX_CONCURRENT`** - Number of connector sync and embedding tasks each worker runs at once.
  - Default: `2`

- **`ARCHESTRA_KNOWLEDGE_BASE_PERMISSION_SYNC_WORKER_MAX_CONCURRENT`** - Number of [permission sync](/docs/knowledge/connectors#auto-sync-permissions) tasks each worker runs at once.
  - Default: `1`
  - Permission sync has its own slots and never waits for content sync.

- **`ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_POLL_INTERVAL_SECONDS`** - How often a worker checks for new background tasks.
  - Default: `5`

- **`ARCHESTRA_KNOWLEDGE_BASE_TASK_WORKER_SHUTDOWN_TIMEOUT_SECONDS`** - How long a stopping worker waits for running tasks to finish.
  - Default: `30`

- **`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_SYNC_MAX_DURATION_SECONDS`** - Maximum time one connector sync run works before it saves a checkpoint and continues in a new run.
  - Default: `3300` (55 minutes)
  - Values: seconds. `0` lets a sync finish in one run.

- **`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_RUN_LEASE_TTL_SECONDS`** - How long a sync run may go without a heartbeat before it is treated as crashed and resumed from its checkpoint.
  - Default: `300`
  - Keep it several times [`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_RUN_HEARTBEAT_INTERVAL_SECONDS`](/docs/reference/configuration#ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_RUN_HEARTBEAT_INTERVAL_SECONDS).

- **`ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_RUN_HEARTBEAT_INTERVAL_SECONDS`** - How often a running sync sends a heartbeat.
  - Default: `90`

- **`ARCHESTRA_KNOWLEDGE_BASE_STALLED_EMBEDDING_AGE_SECONDS`** - How long a document may wait for embedding before it is queued again.
  - Default: `900` (15 minutes)
  - Keep it above 8 minutes, the full retry span of an embedding task. A lower value re-embeds documents that are still in progress.

- **`ARCHESTRA_KNOWLEDGE_FILES_MAX_UPLOAD_BYTES`** - Largest single file you can upload to [Knowledge Files](/docs/knowledge/files).
  - Default: `26214400` (25 MiB)

- **`ARCHESTRA_KNOWLEDGE_FILES_MAX_FILES_PER_INDEX_REQUEST`** - Maximum number of files one directory selection expands to when you index Knowledge Files.
  - Default: `500`

### Google Drive

These configure the OAuth client for the Google Drive connector's [individual auth mode](/docs/knowledge/connectors/google-drive). Service-account modes do not use them.

- **`ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID`** - Client ID of the deployment's Google OAuth client.
  - Default: unset (individual mode disabled)
  - Changing it invalidates existing authorizations. Each affected connector must reconnect.

- **`ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`** - Client secret of the deployment's Google OAuth client.
  - Default: unset (individual mode disabled)
  - Rotating only the secret needs no reconnect.

### M-Files

- **`ARCHESTRA_KNOWLEDGE_BASE_MFILES_CONNECTOR_ENABLED`** - Turns on the beta [M-Files connector](/docs/knowledge/connectors/m-files).
  - Default: unset (follows [`ARCHESTRA_BETA`](/docs/reference/configuration#ARCHESTRA_BETA))
  - Values: `true`, `false`. Existing M-Files connectors keep syncing while it is off.

- **`ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_PACKAGE_DIR`** - Directory that serves the VAF Add On package to the install script and the connector form.
  - Default: `/app/mfiles-vaf-add-on`

- **`ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_SOURCE_REF`** - Development override: a git ref of `archestra-ai/archestra` whose VAF Add On the install script installs instead of the packaged one.
  - Default: unset. Leave it unset in production.
  - Values: a commit SHA, branch, or tag, or `local` for the HEAD of the local checkout

- **`ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_GITHUB_TOKEN`** - GitHub token for downloading the add-on built from [`ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_SOURCE_REF`](/docs/reference/configuration#ARCHESTRA_KNOWLEDGE_BASE_MFILES_VAF_ADD_ON_SOURCE_REF).
  - Default: unset (the install script compiles the add-on from source)

### Perforce

[Perforce permission sync](/docs/knowledge/connectors/perforce) runs the `p4` CLI in a per-connector pod and needs the Kubernetes orchestrator. Archestra downloads the `p4` binary from Perforce and checks its SHA-256. Air-gapped installs point the URLs at an internal mirror and set matching checksums.

- **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_SHIM_IMAGE`** - Image of the pod that runs `p4` for permission sync.
  - Default: `europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/p4-shim:<platform version>`

- **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_URL_AMD64`** - Download URL of the `p4` binary for x86-64 nodes.
  - Default: `https://cdist2.perforce.com/perforce/r25.2/bin.linux26x86_64/p4`

- **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_SHA256_AMD64`** - Expected SHA-256 of the x86-64 `p4` binary. A download that does not match is rejected.
  - Default: the checksum of the r25.2 build

- **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_URL_ARM64`** - Download URL of the `p4` binary for ARM64 nodes.
  - Default: `https://cdist2.perforce.com/perforce/r25.2/bin.linux26aarch64/p4`

- **`ARCHESTRA_KNOWLEDGE_BASE_PERFORCE_P4_SHA256_ARM64`** - Expected SHA-256 of the ARM64 `p4` binary. A download that does not match is rejected.
  - Default: the checksum of the r25.2 build

## File Storage

A change of [`ARCHESTRA_FILE_STORAGE_PROVIDER`](/docs/reference/configuration#ARCHESTRA_FILE_STORAGE_PROVIDER) applies to new files only. Existing files stay readable where they were written.

- **`ARCHESTRA_FILE_STORAGE_PROVIDER`** - Storage backend for My Files contents.
  - Default: `db`
  - Values: `db` (PostgreSQL), `filesystem` (a mounted volume), `s3` (an S3-compatible object store)

- **`ARCHESTRA_FILE_STORAGE_FILESYSTEM_ROOT`** - Absolute path of the directory that stores files, for example a persistent volume mount.
  - Required when: [`ARCHESTRA_FILE_STORAGE_PROVIDER=filesystem`](/docs/reference/configuration#ARCHESTRA_FILE_STORAGE_PROVIDER)
  - Example: `/var/archestra/files`

- **`ARCHESTRA_FILE_STORAGE_S3_BUCKET`** - Bucket that stores files.
  - Required when: [`ARCHESTRA_FILE_STORAGE_PROVIDER=s3`](/docs/reference/configuration#ARCHESTRA_FILE_STORAGE_PROVIDER)

- **`ARCHESTRA_FILE_STORAGE_S3_REGION`** - Region of the bucket.
  - Default: `us-east-1`

- **`ARCHESTRA_FILE_STORAGE_S3_ENDPOINT`** - Endpoint of an S3-compatible store such as MinIO or Cloudflare R2.
  - Default: unset (AWS S3)
  - Example: `http://minio:9000`

- **`ARCHESTRA_FILE_STORAGE_S3_FORCE_PATH_STYLE`** - Uses path-style bucket addressing instead of virtual-hosted style.
  - Default: `false`
  - Values: `true`, `false`
  - MinIO requires `true`.

- **`ARCHESTRA_FILE_STORAGE_S3_ACCESS_KEY_ID`** - Access key ID for the bucket.
  - Default: unset (the AWS default credential chain, including instance profiles and IRSA)
  - Startup fails if it is set without [`ARCHESTRA_FILE_STORAGE_S3_SECRET_ACCESS_KEY`](/docs/reference/configuration#ARCHESTRA_FILE_STORAGE_S3_SECRET_ACCESS_KEY).

- **`ARCHESTRA_FILE_STORAGE_S3_SECRET_ACCESS_KEY`** - Secret access key for the bucket.
  - Default: unset
  - Startup fails if it is set without [`ARCHESTRA_FILE_STORAGE_S3_ACCESS_KEY_ID`](/docs/reference/configuration#ARCHESTRA_FILE_STORAGE_S3_ACCESS_KEY_ID).

- **`ARCHESTRA_FILE_STORAGE_S3_KEY_PREFIX`** - Folder inside the bucket that stores files.
  - Default: unset (bucket root)
  - Example: `archestra-prod/`
  - To share one bucket between instances, give each its own prefix.

## Skills Marketplace

- **`ARCHESTRA_GIT_BINARY_PATH`** - Path to the `git` binary that serves marketplace clones.
  - Default: `git`

- **`ARCHESTRA_SKILL_MARKETPLACE_CACHE_DIR`** - Directory that caches the marketplace git repositories.
  - Default: `~/.archestra/skill-marketplace-cache`
  - Put it on a persistent volume in production.

## Incoming Email

These variables connect an Outlook mailbox so people can [email agents](/docs/agents/triggers-and-channels/email).

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER`** - Provider of the agent mailbox.
  - Default: unset (incoming email off)
  - Values: `outlook`

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_TENANT_ID`** - Microsoft Entra tenant ID of the app registration that reads the mailbox.
  - Required when: [`ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook`](/docs/reference/configuration#ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER)

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_ID`** - Application (client) ID of that app registration.
  - Required when: [`ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook`](/docs/reference/configuration#ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER)

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_CLIENT_SECRET`** - Client secret of that app registration.
  - Required when: [`ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook`](/docs/reference/configuration#ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER)

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_MAILBOX_ADDRESS`** - Mailbox that receives agent email through plus-addressing.
  - Required when: [`ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER=outlook`](/docs/reference/configuration#ARCHESTRA_AGENTS_INCOMING_EMAIL_PROVIDER)
  - Values: an email address, for example `agents@example.com`

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_EMAIL_DOMAIN`** - Domain used in agent email addresses.
  - Default: the domain of [`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_MAILBOX_ADDRESS`](/docs/reference/configuration#ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_MAILBOX_ADDRESS)

- **`ARCHESTRA_AGENTS_INCOMING_EMAIL_OUTLOOK_WEBHOOK_URL`** - Public URL that receives new-mail notifications. When set, Archestra creates the subscription on startup.
  - Default: unset (create the subscription in **Settings → Messaging Channels → Email**)
  - Values: a URL ending in `/api/webhooks/incoming-email`, for example `https://archestra.example.com/api/webhooks/incoming-email`

## ChatOps

The Microsoft Teams, Slack, and Telegram variables apply only on first startup, when no channel settings exist yet. After that, change a channel in **Settings → Messaging Channels**.

- **`ARCHESTRA_CHATOPS_SIGNUP_WELCOME_ENABLED`** - Sends a welcome message to users who are created automatically when they first message an agent.
  - Default: `true`
  - Values: `true`, `false`. With `false`, users are still created.
  - With SSO configured, the welcome links to sign-in. Without SSO, it is skipped when [`ARCHESTRA_AUTH_DISABLE_INVITATIONS`](/docs/reference/configuration#ARCHESTRA_AUTH_DISABLE_INVITATIONS) or [`ARCHESTRA_AUTH_DISABLE_BASIC_AUTH`](/docs/reference/configuration#ARCHESTRA_AUTH_DISABLE_BASIC_AUTH) is `true`.

- **`ARCHESTRA_CHATOPS_MAX_CONCURRENT_FILE_TRANSFERS`** - Maximum number of Slack attachment downloads each backend process handles at once.
  - Default: `4`
  - Lower it on memory-constrained deployments.

### Microsoft Teams

See [Microsoft Teams](/docs/agents/triggers-and-channels/ms-teams) for setup.

- **`ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED`** - Turns on the Microsoft Teams channel.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID`** - Application (client) ID of the Azure Bot registration.
  - Required when: [`ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED)

- **`ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET`** - Client secret of the Azure Bot registration.
  - Required when: [`ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_CHATOPS_MS_TEAMS_ENABLED)

- **`ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID`** - Microsoft Entra tenant ID of a single-tenant bot.
  - Default: unset (multi-tenant bot)

- **`ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_TENANT_ID`** - Tenant ID for reading thread history through Microsoft Graph.
  - Default: [`ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID`](/docs/reference/configuration#ARCHESTRA_CHATOPS_MS_TEAMS_TENANT_ID)

- **`ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_ID`** - Client ID for reading thread history through Microsoft Graph.
  - Default: [`ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID`](/docs/reference/configuration#ARCHESTRA_CHATOPS_MS_TEAMS_APP_ID)

- **`ARCHESTRA_CHATOPS_MS_TEAMS_GRAPH_CLIENT_SECRET`** - Client secret for reading thread history through Microsoft Graph.
  - Default: [`ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET`](/docs/reference/configuration#ARCHESTRA_CHATOPS_MS_TEAMS_APP_SECRET)

### Slack

See [Slack](/docs/agents/triggers-and-channels/slack) for setup.

- **`ARCHESTRA_CHATOPS_SLACK_ENABLED`** - Turns on the Slack channel.
  - Default: `false`
  - Values: `true`, `false`

- **`ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE`** - How Slack delivers events to Archestra.
  - Default: `socket`
  - Values: `socket` (no public URL needed), `webhook` (needs a public URL)

- **`ARCHESTRA_CHATOPS_SLACK_BOT_TOKEN`** - Bot User OAuth Token, from the app's **OAuth & Permissions** page.
  - Required when: [`ARCHESTRA_CHATOPS_SLACK_ENABLED=true`](/docs/reference/configuration#ARCHESTRA_CHATOPS_SLACK_ENABLED)
  - Values: starts with `xoxb-`

- **`ARCHESTRA_CHATOPS_SLACK_APP_LEVEL_TOKEN`** - App-Level Token with the `connections:write` scope, from the app's **Basic Information** page.
  - Required when: [`ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE=socket`](/docs/reference/configuration#ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE)
  - Values: starts with `xapp-`

- **`ARCHESTRA_CHATOPS_SLACK_SIGNING_SECRET`** - Signing secret that verifies webhook requests, from the app's **Basic Information** page.
  - Required when: [`ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE=webhook`](/docs/reference/configuration#ARCHESTRA_CHATOPS_SLACK_CONNECTION_MODE)

- **`ARCHESTRA_CHATOPS_SLACK_APP_ID`** - Slack App ID, used for direct-message deep links.
  - Default: unset (no deep links)

### Telegram

See [Telegram](/docs/agents/triggers-and-channels/telegram) for setup. Telegram needs no public URL.

- **`ARCHESTRA_CHATOPS_TELEGRAM_ENABLED`** - Makes the Telegram channel available.
  - Default: `true`
  - Values: `true`, `false`. With `false`, the channel is hidden and never starts.

- **`ARCHESTRA_CHATOPS_TELEGRAM_BOT_TOKEN`** - Bot token from [@BotFather](https://t.me/BotFather).
  - Default: unset (save the token on the Telegram channel page instead)
  - Values: `123456789:ABC...` format

### Public URL

Microsoft Teams and Slack webhook mode need Archestra reachable from the internet. These variables open an [ngrok](https://ngrok.com) tunnel to Archestra on startup.

- **`ARCHESTRA_NGROK_AUTH_TOKEN`** - ngrok auth token.
  - Default: unset (no tunnel)

- **`ARCHESTRA_NGROK_DOMAIN`** - Reserved ngrok domain for a stable public URL.
  - Default: unset (a new random domain on each restart)
  - Set it for Microsoft Teams: its messaging endpoint is registered in Azure and breaks when the domain changes.

## Observability

See [Observability](/docs/admin/observability) for metrics, tracing, and dashboards.

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT`** - OTLP/HTTP endpoint that receives traces and logs.
  - Default: `http://localhost:4318/v1/traces`
  - Values: a collector URL. Archestra adds `/v1/traces` for traces and `/v1/logs` for logs.

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME`** - Username for basic authentication to the OTLP endpoint.
  - Default: unset. Used only together with [`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD`](/docs/reference/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD).

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD`** - Password for basic authentication to the OTLP endpoint.
  - Default: unset. Used only together with [`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME`](/docs/reference/configuration#ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME).

- **`ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER`** - Bearer token for the OTLP endpoint.
  - Default: unset
  - Takes precedence over basic authentication.

- **`ARCHESTRA_OTEL_CAPTURE_CONTENT`** - Records prompts, completions, and tool arguments and results in trace spans.
  - Default: `true`, or `false` when [`ARCHESTRA_CONTENT_ENCRYPTION_SECRET`](/docs/reference/configuration#ARCHESTRA_CONTENT_ENCRYPTION_SECRET) is set
  - Values: `true`, `false`
  - With content encryption on, `true` sends that content to your telemetry backend in plaintext and logs a startup warning.

- **`ARCHESTRA_OTEL_CONTENT_MAX_LENGTH`** - Maximum characters of each captured content field. Longer content is truncated and ends with `...[truncated]`.
  - Default: `10000`

- **`ARCHESTRA_OTEL_TRACES_SAMPLE_RATE`** - Fraction of traces to record.
  - Default: `1.0` (all traces)
  - Values: `0`–`1`. Child spans follow their parent's decision.

- **`ARCHESTRA_OTEL_VERBOSE_TRACING`** - Adds infrastructure spans (HTTP routes and outgoing requests) to traces.
  - Default: `false` (LLM and MCP tool call spans only)
  - Values: `true`, `false`

- **`ARCHESTRA_METRICS_PORT`** - Port of the Prometheus metrics server, which serves `/metrics`.
  - Default: `9050`
  - Values: `1`–`65535`

- **`ARCHESTRA_METRICS_SECRET`** - Bearer token that clients must send to read `/metrics`.
  - Default: unset (no authentication)
  - Clients send `Authorization: Bearer <token>`.

- **`ARCHESTRA_METRICS_ACTIVE_USERS_REFRESH_INTERVAL_MS`** - How often the [`llm_active_users`](/docs/admin/observability/metrics#llm_active_users) gauge is recomputed.
  - Default: `300000` (5 minutes)
  - Values: `0` (off), or `30000` and above

- **`ARCHESTRA_RUM_EXPORTER_OTLP_ENDPOINT`** - OTLP/HTTP endpoint that receives [Real User Monitoring](/docs/admin/observability#real-user-monitoring) events from the web UI. Setting it turns RUM on.
  - Default: unset (RUM off)
  - Requires an [Enterprise license](/docs/get-started#licensing). The backend does not start when this is set without one.

- **`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_USERNAME`** - Username for basic authentication to the RUM endpoint.
  - Default: unset. Used only together with [`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_PASSWORD`](/docs/reference/configuration#ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_PASSWORD).

- **`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_PASSWORD`** - Password for basic authentication to the RUM endpoint.
  - Default: unset. Used only together with [`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_USERNAME`](/docs/reference/configuration#ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_USERNAME).

- **`ARCHESTRA_RUM_EXPORTER_OTLP_AUTH_BEARER`** - Bearer token for the RUM endpoint.
  - Default: unset
  - Takes precedence over basic authentication.

- **`ARCHESTRA_RUM_SAMPLE_RATE`** - Fraction of user sessions RUM records. Whole sessions are kept or skipped; client errors are always reported.
  - Default: `1` (all sessions)
  - Values: `0`–`1`

- **`ARCHESTRA_RUM_EXPORTER_MAX_QUEUE_SIZE`** - Maximum RUM events held in memory while they wait for export.
  - Default: `2048`

- **`ARCHESTRA_RUM_EXPORTER_MAX_EXPORT_BATCH_SIZE`** - Maximum RUM events sent in one export request.
  - Default: `512`
  - Raise it for deployments with thousands of concurrent users.

- **`ARCHESTRA_RUM_EXPORTER_SCHEDULE_DELAY_MS`** - Delay between RUM export requests.
  - Default: `5000`
  - Lower it for deployments with thousands of concurrent users.

- **`ARCHESTRA_RUM_INGEST_MAX_BATCHES_PER_MINUTE`** - Maximum RUM event batches one user may submit per minute. Batches over the limit are dropped.
  - Default: `120`

- **`ARCHESTRA_BROWSER_STREAM_LOG_SCREENSHOTS`** - Enables screenshot-related debug logging for browser streaming.
  - Default: `false`
  - Values: `true` or `false`

- **`ARCHESTRA_BROWSER_STREAM_LOG_TAB_SYNC`** - Enables tab-synchronization debug logging for browser streaming.
  - Default: `false`
  - Values: `true` or `false`

## Data Retention

Retention is an Enterprise feature: the backend does not start when a window is set without an [Enterprise license](/docs/get-started#licensing). Each value is a whole number of days; any other value turns that window off.

- **`ARCHESTRA_LLM_LOGS_RETENTION_DAYS`** - Days to keep LLM proxy logs and Guardrails consult records.
  - Default: `0` (keep forever)
  - Under 32 days logs a startup warning: monthly cost limits count these records, so usage can be under-counted.

- **`ARCHESTRA_MCP_LOGS_RETENTION_DAYS`** - Days to keep MCP gateway tool call logs.
  - Default: `0` (keep forever)

- **`ARCHESTRA_CHAT_CONVERSATIONS_RETENTION_DAYS`** - Days without a new message before a conversation is deleted with its messages, attachments, and files.
  - Default: `0` (keep forever)

- **`ARCHESTRA_AUDIT_LOG_RETENTION_DAYS`** - Days to keep audit log records.
  - Default: `0` (keep forever)

## Guardrails

[Guardrails](/docs/agents/guardrails) are a beta feature: set [`ARCHESTRA_BETA=true`](/docs/reference/configuration#ARCHESTRA_BETA) to show them. Enforcement is a separate switch on the Guardrails page and starts off.

- **`ARCHESTRA_OPENAPPA_OFFER_SIGNING_SECRET`** - Key that signs Guardrails remedy offers and session receipts.
  - Default: generated and kept across upgrades by the Helm chart. Without Helm, derived from [`ARCHESTRA_AUTH_SESSION_SECRET`](/docs/reference/configuration#ARCHESTRA_AUTH_SESSION_SECRET).
  - Values: at least 32 characters. Every replica must use the same value.
  - Set it to rotate the key independently of the session secret.

- **`ARCHESTRA_OPENAPPA_YELL_ENABLED`** - Lets agents report confusing blocks with the [`yell`](/docs/reference/archestra-mcp-server#yell) tool. Reports are stored locally. They also go to the shared OpenAPPA reporting service when [`ARCHESTRA_ANALYTICS`](/docs/reference/configuration#ARCHESTRA_ANALYTICS) is enabled.
  - Default: `true` (when Guardrails are on)
  - Values: `true`, `false`

- **`ARCHESTRA_OPENAPPA_POSTGRES_MAX_CONNECTIONS`** - PostgreSQL connections each backend process opens for guardrail checks.
  - Default: `4`
  - Values: `1`–`64`
  - A check that waits more than 30 seconds for a connection fails. Raise it when policies consult slow external authorities.
