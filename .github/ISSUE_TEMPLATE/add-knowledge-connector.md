---
name: Add Knowledge Connector
about: Request or propose adding a new knowledge connector to Archestra
title: "[Knowledge Connector] Add <Connector Name> support"
labels: enhancement, knowledge
assignees: ''

---

**Connector Name:** <!-- e.g., Linear, Asana, Zendesk -->

**Connector Website:** <!-- Link to the product's main page -->

**API Documentation:** <!-- Link to the API or developer docs -->

**Official SDK:** <!-- Link to the official SDK, if one exists. Prefer official SDKs over hand-rolled clients when available. -->

## Implementation Checklist

Adding a new connector usually requires backend, frontend, documentation, and test updates. For implementation guidance, see our [Adding Knowledge Connectors documentation](/docs/platform-adding-knowledge-connectors).

## Requirements

When submitting a PR to add this connector, please ensure:

### 1. Access and Credential Setup
Include clear instructions on how reviewers can create or obtain test credentials and what permissions are required. If the connector needs admin consent, special scopes, or a service account, document that in the PR.

### 2. Connector Scope
- [ ] The sync target is clearly defined (issues, pages, files, tickets, etc.)
- [ ] Required vs optional config fields are documented
- [ ] Authentication flow is documented
- [ ] Incremental sync strategy is documented

### 3. Implementation Completeness

**Backend:**
- Connector config and checkpoint Zod schemas
- Connector implementation (`validateConfig`, `testConnection`, `sync`)
- Registry wiring
- Official SDK is used when one is available, or the PR explains why not

**Frontend:**
- Connector type is selectable in the create connector dialog
- Connector-specific config fields are implemented
- Validation and error handling work correctly

### 4. Testing
- [ ] Connector tests cover `validateConfig`
- [ ] Connector tests cover `testConnection`
- [ ] Connector tests cover `sync`, including pagination or incremental sync behavior where relevant

If the connector relies on an external SDK, mock the SDK in tests rather than making live API calls.

### 5. Documentation
- [ ] Update [Adding Knowledge Connectors](/docs/platform-adding-knowledge-connectors) if the developer workflow changes
- [ ] Update [Knowledge Connectors](https://archestra.ai/docs/platform-knowledge-connectors) with user-facing setup instructions for the new connector

### 6. Demo Evidence
Please include screenshots or a short demo video showing the connector being created, connection-tested if applicable, and successfully synced.

**Acceptance Criteria:** We expect the connector to be fully wired through the backend and frontend, covered by tests, documented for users, and to prefer an official SDK over a custom client when the upstream system provides one.

## Additional Context

<!--
Any other information that might be helpful:
- Are you planning to implement this yourself?
- Do you already have access to a test instance?
- Are there any known API limitations, rate limits, or permission constraints?
-->
