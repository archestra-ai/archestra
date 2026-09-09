# Outbound A2A discovery and authentication

Research date: 2026-09-08

Source scope: the A2A v1 specification and protocol definitions, the official A2A discovery guidance, and the official `a2a-js` SDK/source. A2A sources are pinned to the revisions reviewed so that the wire-contract findings do not drift with `main`.

## Executive conclusion

Archestra should support both URL-based discovery and an advanced inline Agent Card import, but both paths should converge on the same validated Agent Card model. The normal setup should accept either a domain/base URL and resolve `/.well-known/agent-card.json`, or accept a full custom Agent Card URL. Inline JSON is useful for private and development deployments; a field-by-field “endpoint without an Agent Card” mode should not be the normal path because the protocol says A2A servers must make an Agent Card available and direct configuration already permits either a preconfigured card URL or card content. ([A2A specification, discovery](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#82-discovery-mechanisms), [official discovery guide](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/topics/agent-discovery.md#discovery-strategies))

Authentication is advertised, not provisioned, by A2A. An Agent Card describes supported security schemes and the combinations/scopes required to call the agent; the client obtains credentials out of band and attaches them to every request using the selected transport’s headers or metadata. Consequently, Archestra needs a credential-bearing connection record separate from the remote-agent/card record. ([A2A specification, client authentication](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#73-client-authentication-process), [A2A protocol security definitions](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/specification/a2a.proto#L495-L631))

The official `@a2a-js/sdk` is suitable for card normalization, interface selection, protocol transport, request operations, header injection, and authentication retries. It does not acquire API keys, complete OAuth/OIDC flows, issue certificates, or decide which credential an Archestra caller may use; those remain Archestra responsibilities. This is an inference from the SDK’s client surface: it exposes `ClientFactory`, a configurable card resolver/fetch implementation, request service parameters, and a generic `AuthenticationHandler` that supplies headers and reacts to responses. ([SDK client overview](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/README.md#clients), [SDK authentication handler](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/client/auth-handler.ts))

## 1. Discovery and configuration modes

### 1.1 Standard well-known discovery

The standardized public discovery location is:

```text
https://{agent-server-domain}/.well-known/agent-card.json
```

The well-known resource must return an Agent Card. This mode is recommended by the official discovery guide for public agents or agents intended for broad discovery within a domain. ([A2A specification, well-known registration](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#143-well-known-uri-registration), [official discovery guide, well-known URI](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/topics/agent-discovery.md#1-well-known-uri))

The official JavaScript resolver follows the same convention: `resolve(baseUrl, path?)` chooses the explicit `path`, then a configured path, then `/.well-known/agent-card.json`; it accepts a custom `fetchImpl`. ([SDK card resolver](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/client/card-resolver.ts#L47-L93))

### 1.2 Direct/custom Agent Card URL

The specification explicitly recognizes direct configuration of preconfigured Agent Card URLs or content. The SDK also supports a custom path and a full card URL through `ClientFactory.createFromUrl(baseUrl, path?)`. Therefore, Archestra should distinguish a base URL from a full card URL in its setup form instead of forcing every deployment onto the well-known path. ([A2A specification, discovery mechanisms](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#82-discovery-mechanisms), [SDK client factory](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/client/factory.ts#L184-L224))

### 1.3 Inline/manual Agent Card

Direct configuration can also use Agent Card content, and `ClientFactory.createFromAgentCard(card)` accepts an in-memory card. An advanced “paste Agent Card JSON” option is therefore protocol-aligned and supported by the SDK. It should be treated as an import of the complete card, not as permission to omit required Agent Card fields. ([official discovery guide, direct configuration](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/topics/agent-discovery.md#3-direct-configuration--private-discovery), [SDK `createFromAgentCard`](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/client/factory.ts#L102-L130))

An inline card has no authoritative retrieval URL or HTTP cache metadata. Archestra should mark it as manually managed, retain the original JSON, and require explicit replacement or a later conversion to URL discovery. This is an Archestra product recommendation based on the discovery guide’s warning that directly configured information must be reconfigured when it changes. ([official discovery guide](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/topics/agent-discovery.md#3-direct-configuration--private-discovery))

### 1.4 Recommended setup experience

Use two entry modes on the outbound A2A configuration screen:

1. **Connect by URL** (default)
   - A domain/base URL resolves the well-known path.
   - A full Agent Card URL is fetched as provided.
2. **Paste Agent Card JSON** (advanced)
   - The complete card is parsed and validated locally.

Both should then follow one review flow:

1. Fetch/parse the public card.
2. Validate its structure, interfaces, protocol versions, extensions, media modes, and security declarations.
3. Show discovered identity, provider, skills, supported transports, and authentication alternatives.
4. Let the operator select one satisfiable security requirement and configure credentials.
5. Verify a real authenticated A2A operation.
6. If `capabilities.extendedAgentCard` is true, retrieve and cache the authenticated extended card for that connection/session.
7. Save the remote-agent definition and credential-bearing connection separately.

This flow follows the protocol’s split between public discovery, out-of-band credential acquisition, and authenticated extended-card retrieval. ([A2A specification, extended-card workflow](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#69-fetching-authenticated-extended-agent-card), [A2A specification, extended-card operation](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#311-get-extended-agent-card))

## 2. Agent Card fields Archestra must understand

The normative protobuf marks fields with `google.api.field_behavior = REQUIRED`; the specification says required arrays must contain at least one element. Unknown fields should be ignored for forward compatibility rather than making the whole card unusable. ([A2A field presence rules](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#57-field-presence-and-optionality))

### 2.1 Agent Card

| Field | Requirement | Archestra use |
|---|---|---|
| `name` | Required | Discovered display name; allow a separate local alias rather than editing the card value. |
| `description` | Required | Subagent/tool description and operator review. |
| `supportedInterfaces` | Required, non-empty | Source of callable endpoints, protocol bindings, versions, and optional tenant routing. |
| `version` | Required | Discovery revision signal; not itself a protocol version. |
| `capabilities` | Required | Declares streaming, push notification, extensions, and extended-card support; the fields within it are optional. |
| `defaultInputModes` | Required, non-empty | Validate that Archestra can produce at least one accepted media type. |
| `defaultOutputModes` | Required, non-empty | Validate what Archestra is prepared to receive and classify. |
| `skills` | Required, non-empty | Discovered capability metadata; each skill requires `id`, `name`, `description`, and non-empty `tags`. |
| `provider` | Optional | If present, `url` and `organization` are required. Useful for operator trust review, not sufficient proof of identity. |
| `documentationUrl` | Optional | Display-only link after URL validation. |
| `securitySchemes` | Optional | Named definitions of possible authentication mechanisms. Does not contain credentials. |
| `securityRequirements` | Optional | The combinations of schemes and scopes required to call the agent. Skills can also carry their own requirements. |
| `signatures` | Optional | JWS signatures over the card. |
| `iconUrl` | Optional | Remote display asset; fetch only through Archestra’s safe remote-content policy. |

The complete field requirements and nested `AgentSkill`, `AgentProvider`, `AgentCapabilities`, and signature definitions are in the v1 protobuf. ([A2A Agent Card definitions](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/specification/a2a.proto#L337-L494))

### 2.2 `supportedInterfaces`

Every interface requires:

- `url`: an absolute HTTPS URL for HTTP transports in production, or `hostname:port` for gRPC.
- `protocolBinding`: an open-form binding name; standard bindings are `JSONRPC`, `GRPC`, and `HTTP+JSON`.
- `protocolVersion`: the A2A version exposed by that interface.

`tenant` is optional. When present, the client must copy it exactly into every request for the selected interface. Interfaces are ordered by server preference; clients select the first interface they support, preferring earlier compatible entries, and use that entry’s URL. ([A2A `AgentInterface`](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/specification/a2a.proto#L337-L357), [A2A protocol selection](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#83-protocol-declaration-requirements))

The SDK’s `ClientFactory` performs compatible interface/transport selection and decorates the selected transport with the advertised tenant. Archestra should still constrain the factory to the bindings and versions it has explicitly enabled, rather than treating every card-advertised interface as acceptable. ([SDK client factory selection](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/client/factory.ts#L102-L182))

## 3. Authentication model

### 3.1 Definitions versus requirements

`securitySchemes` is a named map of available authentication definitions. `securityRequirements` is the set of combinations the caller can satisfy, with required OAuth/OIDC scopes attached to scheme names. The current v1 protobuf wire model represents a requirement as `{ schemes: { <scheme-name>: { list: [<scope>...] } } }`. ([A2A v1 security definitions](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/specification/a2a.proto#L495-L520), [official SDK authenticated sample](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/samples/authentication/index.ts#L39-L54))

The intended OpenAPI-style semantics are: schemes within one requirement object are used together (AND), while separate requirement objects are alternatives (OR). The official SDK’s v0.3 type documentation states this explicitly, and its compatibility translator maps that representation one-for-one to the v1 `{schemes: ...}` representation; therefore the same combination semantics carry into v1. This is an inference from the official SDK’s documented legacy type and translator because the current v1 protobuf comment describes the map but does not restate AND/OR semantics. ([SDK compatibility type semantics](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/compat/v0_3/types/types.ts#L1186-L1205), [SDK security-requirement translator](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/compat/v0_3/translate/security.ts))

Archestra should persist which requirement alternative a connection satisfies, not merely an `authType`. That supports future combinations such as API key **and** mTLS and prevents selecting a credential that is advertised but insufficient for a particular agent or skill.

### 3.2 Supported scheme types

| A2A scheme | Protocol declaration | Credential acquisition | Likely Archestra mapping |
|---|---|---|---|
| API key | Name plus location: `header`, `query`, or `cookie` | Operator or external provisioning system supplies the value | Secret-backed connection. Header keys are suitable for an MVP; query/cookie keys need explicit injection and redaction support and should not be silently converted to headers. |
| HTTP authentication | Registered HTTP scheme used in `Authorization`, such as Basic or Bearer; `bearerFormat` is only a documentation hint | Operator, token issuer, or another auth flow supplies credentials | Static bearer/basic secret or a dynamically resolved token. |
| OAuth 2.0 | Authorization Code, Client Credentials, Device Code; legacy Implicit and Password flows are deprecated. A TLS OAuth authorization-server metadata URL may also be advertised. | Archestra acts as the OAuth client and runs the advertised out-of-band flow | Reuse the existing OAuth machinery for authorization-code and client-credentials flows, extending its resource model from MCP to A2A. Device Code requires additional generic product work. |
| OpenID Connect | OIDC discovery URL | Archestra/operator obtains a usable token according to the provider and remote agent’s policy | Interactive/dynamic token connection; do not assume an Archestra login token is valid for the remote agent merely because both use OIDC. |
| Mutual TLS | mTLS scheme with optional description | Operator or PKI provisions client certificate, private key, chain, and rotation | New HTTP/gRPC client-identity connection material stored through the secret manager; mTLS may be combined with another requirement. |

These scheme structures and OAuth flow fields are defined by the official protocol. ([A2A security schemes](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/specification/a2a.proto#L521-L631))

### 3.3 Credential acquisition responsibility

A2A deliberately leaves credential acquisition out of band. The client discovers requirements from the card, obtains credentials using the scheme-specific external process, and transmits them on every A2A request. The remote server authenticates every request and performs its own implementation-specific authorization. ([A2A authentication and authorization](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#7-authentication-and-authorization))

This means an Agent Card must never contain API keys, bearer tokens, client secrets, or private keys. Official discovery guidance recommends out-of-band dynamic credentials and says sensitive cards should be protected rather than embedding secrets. ([official discovery security guidance](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/topics/agent-discovery.md#securing-agent-cards))

The SDK’s authentication helper can request headers before each request and retry once with refreshed headers after inspecting a response. It is an attachment/refresh hook, not a credential issuer. Archestra should implement an `AuthenticationHandler` backed by its connection and secret-resolution services. ([SDK authentication handler](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/client/auth-handler.ts))

### 3.4 Authenticated/extended Agent Cards

A public card advertises support through `capabilities.extendedAgentCard: true`. The client first obtains credentials out of band, then calls the authenticated `GetExtendedAgentCard` operation using a scheme declared by the public card. The returned card may expose additional skills, capabilities, quotas, or identity-specific configuration; the client should replace its cached public card with the extended card for the authenticated session or until its version changes. ([A2A extended-card operation](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#311-get-extended-agent-card), [A2A extended-card access control](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#133-extended-agent-card-access-control))

Archestra should therefore cache an extended card at the **connection** level, or associate it with both remote-agent ID and connection/credential identity. Caching it globally on the remote-agent row could reveal privileged skills discovered by one credential to users of another credential.

There is a naming inconsistency in the current prose: extended-card sections refer to `AgentCard.security`, while the v1 protobuf and SDK use `securityRequirements`. Archestra should use the generated v1 model (`securityRequirements`) as the wire contract and avoid introducing a separate `security` field. ([specification prose](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#311-get-extended-agent-card), [v1 protobuf Agent Card](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/specification/a2a.proto#L359-L406), [SDK v1 type](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/types/pb/a2a.ts#L401-L424))

## 4. What an outbound A2A client must validate

### 4.1 Discovery-time validation

Archestra should reject or quarantine a configuration unless all of these checks pass:

1. **Discovery target policy:** The base/card URL and every redirect pass Archestra’s outbound URL, DNS, private-network, and egress policy. This is an application security requirement around the SDK; the SDK’s default resolver delegates directly to `fetch`, although it permits a custom `fetchImpl`. ([SDK card resolver](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/client/card-resolver.ts#L47-L93))
2. **Transport identity:** Production HTTP interfaces use HTTPS (gRPC uses TLS), and TLS certificates validate against trusted CAs. ([A2A protocol security](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#71-protocol-security))
3. **Card schema:** Required fields are present; required arrays are non-empty; nested required fields are present; payload size and JSON depth are bounded before parsing. ([A2A field presence rules](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#57-field-presence-and-optionality), [A2A Agent Card protobuf](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/specification/a2a.proto#L337-L494))
4. **Interface safety and compatibility:** At least one interface has an allowed URL/address, supported binding, and supported protocol version. Validate every candidate interface before selection, not only the discovery URL. Preserve the selected `tenant` exactly. ([A2A protocol selection](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#83-protocol-declaration-requirements))
5. **Security consistency:** Every scheme referenced by a global or skill-level requirement exists in `securitySchemes`; the chosen connection can satisfy every scheme and required scope in one complete requirement alternative. Unknown or unsupported mandatory schemes make that alternative unusable.
6. **Capability compatibility:** Archestra invokes streaming, push notifications, extended-card retrieval, or extensions only if advertised. A required extension that Archestra does not implement makes the affected interface/agent unusable rather than silently ignored. ([A2A capability validation](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#334-capability-validation), [A2A extension negotiation](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#46-protocol-extensions))
7. **Media compatibility:** At least one input and output mode is supported by Archestra, and skill-level overrides are checked when a particular skill is exposed.
8. **Card integrity:** If signatures are present, verify at least one before trusting the card; key retrieval must use secure channels and expired/revoked keys must not be accepted. The official SDK exposes signature verification helpers. ([A2A signature verification](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#843-signature-verification), [SDK signature verification](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/signature.ts#L54-L116))
9. **Credential destination:** Attach a connection’s credentials only to the validated selected interface and validated OAuth/OIDC endpoints. Do not forward credentials across an unapproved redirect or to an endpoint introduced by an unreviewed card refresh. This is an Archestra trust-boundary recommendation derived from the protocol’s out-of-band credential model and per-interface URLs.
10. **Cache behavior:** Store the card’s `ETag`, `Last-Modified`, fetch time, version, and content hash; honor HTTP caching and use conditional refreshes. ([A2A card caching](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#86-caching))

### 4.2 Runtime validation

At call time Archestra should:

- Re-resolve the authorized connection and secrets rather than trusting browser-supplied headers.
- Ensure the connection still satisfies the selected global and skill-level security requirement.
- Send credentials on every request through the protocol-appropriate channel. ([A2A client authentication](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#73-client-authentication-process))
- Send the selected protocol version and exact interface tenant.
- Validate all returned A2A objects against the selected protocol version and bound response sizes, file references, media types, and artifact sizes. The specification requires schema validation and calls out SSRF checks for file references. ([A2A media-type security](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#1411-applicationa2ajson))
- Treat remote messages, metadata, artifacts, URLs, and error descriptions as untrusted data; apply Archestra’s trust classification and redaction before returning them to the parent agent or logs.
- Never log credentials; the protocol’s security guidance also prohibits sensitive information in logs unless required and properly protected. ([A2A general security guidance](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#134-general-security-best-practices))
- Handle `TASK_STATE_AUTH_REQUIRED` as a new authorization request, not proof that any action is authorized. The protocol does not define the credential’s scope, representation, validity, or revocation, and warns against passing credentials in-band across agent chains. ([A2A in-task authorization](https://github.com/a2aproject/A2A/blob/98853be376c88df25e1704771cd3ea9ef8823a96/docs/specification.md#76-in-task-authorization))

## 5. Relationship to Archestra’s current authentication model

### 5.1 Reusable pieces

Archestra already has useful building blocks:

- The shared `secret` table supports database-backed values, Archestra-managed Vault values, and BYOS Vault references. ([local schema](../platform/backend/src/database/schemas/secret.ts#L11-L31))
- MCP already separates catalog/server metadata from a credential-bearing installation: `internal_mcp_catalog` carries remote URL and OAuth configuration, while `mcp_server` carries a secret reference plus personal/team/org ownership scope. ([local catalog schema](../platform/backend/src/database/schemas/internal-mcp-catalog.ts#L35-L113), [local MCP connection schema](../platform/backend/src/database/schemas/mcp-server.ts#L35-L84))
- The current generic OAuth configuration supports authorization-code and client-credentials grants, explicit or discovered endpoints, scopes, audience/resource, and client secrets. ([local OAuth configuration](../platform/shared/mcp-server-config.ts#L3-L43))
- Enterprise-managed credential configuration already models static/dynamic/enterprise-managed resolution, bearer/header injection, scopes, audiences, and token-exchange-like behavior. ([local enterprise credential types](../platform/backend/src/types/enterprise-managed-credentials.ts#L6-L64))

These components should be reused behind an A2A-specific connection abstraction. The MCP catalog schema itself should not be reused as the A2A Agent Card schema: MCP OAuth configuration is manually curated for an MCP endpoint, whereas A2A security requirements and per-skill requirements are discovered protocol data.

### 5.2 Important distinction from current inbound A2A authentication

Archestra’s existing inbound A2A endpoint advertises three Bearer credential sources—platform token, external IdP JWT, and platform OAuth access token—and validates them as credentials presented **to Archestra**. ([local inbound A2A card code](../platform/backend/src/routes/a2a/v2.ts#L57-L88), [local inbound schemes](../platform/backend/src/routes/a2a/v2.ts#L782-L809))

That does not automatically make those credentials valid for an external agent. Outbound connections must use a credential accepted by the remote Agent Card. Reuse the token/vault/OAuth infrastructure, not the assumption that an Archestra-issued token can be forwarded.

### 5.3 Recommended connection model

Keep two persistence concepts:

```text
outbound_a2a_agent
  identity and discovery source
  public card and refresh metadata
  locally reviewed/allowed interfaces

outbound_a2a_connection
  one selected security-requirement alternative
  credential resolution mode and scope
  secret/OAuth/mTLS references
  connection-specific extended card
  verification and refresh status
```

Suggested remote-agent discovery fields:

- `discovery_mode`: `well_known | card_url | inline_card`
- `discovery_url` nullable for inline cards
- `public_agent_card` JSONB
- `public_card_version`, `public_card_hash`, `etag`, `last_modified`
- `last_discovered_at`, `next_refresh_at`, `discovery_error`
- `allowed_interface` or selected protocol constraints, stored as operator policy rather than overwriting card data
- local `display_name`/`icon` overrides kept separate from discovered fields

Suggested connection fields:

- `outbound_a2a_agent_id`
- personal/team/org scope and owner/team identifiers
- `security_requirement_index` plus a normalized snapshot of selected scheme names/scopes
- `credential_resolution_mode`: static, per-caller/dynamic, or enterprise-managed
- `secret_id` for API key, Basic/Bearer, OAuth token bundle, or certificate material
- OAuth client/config reference where applicable
- mTLS certificate/key/CA references where applicable
- `extended_agent_card`, `extended_card_hash`, `extended_card_expires_at`
- `last_verified_at`, `last_auth_error`, `disabled_at`

Do not store secrets in either Agent Card JSON. Resolve secret material only when creating the authenticated SDK transport/request.

### 5.4 MVP authentication scope

A practical first release can support:

1. No authentication.
2. Header API key.
3. Static HTTP Bearer.
4. OAuth 2.0 Client Credentials.
5. OAuth 2.0 Authorization Code using Archestra’s existing per-user connection pattern.

Defer, with explicit “unsupported authentication scheme” feedback:

- query/cookie API keys until logging and transport injection are verified;
- generic Device Code;
- mTLS until certificate lifecycle and transport configuration are implemented;
- multi-scheme AND requirements until a connection can safely compose multiple credential mechanisms;
- in-task authorization flows;
- custom protocol bindings.

This is intentionally a product-scope recommendation, not a protocol restriction. The Agent Card must still preserve and display all advertised schemes so operators understand why a connection cannot yet be created.

## 6. Implementation implications for `a2a-js`

Use the SDK, but place it behind an Archestra adapter:

1. Fetch cards through an Archestra-controlled `fetchImpl` or fetch/validate them first and call `createFromAgentCard`.
2. Configure only approved transport factories and protocol versions.
3. Implement `AuthenticationHandler` using connection resolution and secret retrieval.
4. Use per-call service parameters/interceptors for tracing and approved headers, not arbitrary browser-provided headers.
5. Recreate or invalidate clients when connection/card policy revisions change; do not serialize SDK clients or embed long-lived secrets in cached client objects.

The SDK defaults to JSON-RPC and HTTP+JSON/REST, accepts a custom resolver, selects from `supportedInterfaces`, and exposes interceptors and authentication hooks. ([SDK client factory options](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/src/client/factory.ts#L15-L100), [SDK client customization](https://github.com/a2aproject/a2a-js/blob/69d88990113cf42f9ac34e3fcde0c5a3c1ceae24/README.md#client-customization))

## Final answers

- **Well-known or manual?** Both. Default to a base URL/well-known flow, allow a full custom card URL, and offer inline Agent Card JSON as an advanced private/development option. Do not make a manually synthesized endpoint-only card the normal configuration model.
- **How does auth normally work?** The public card advertises security definitions and acceptable requirement combinations. Archestra obtains the credential out of band, binds it to a connection, and transmits it on every request. A public card can advertise an authenticated extended card with connection-specific capabilities.
- **What should Archestra persist?** A reusable remote-agent/card definition plus one or more scoped credential-bearing connections. Keep extended cards connection-scoped and retain the exact selected security requirement/scopes.
- **What can be reused?** Secret manager/Vault integration, MCP-like personal/team/org connection scoping, authorization-code and client-credentials OAuth machinery, enterprise dynamic credential resolution, and the official `a2a-js` client.
- **What must be added?** Agent Card discovery/cache/validation, requirement selection, A2A connection records, safe interface and credential-destination enforcement, optional mTLS material, and connection-specific extended-card handling.
