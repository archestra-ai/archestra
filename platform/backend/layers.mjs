/** Execution code and the route and server helpers lower layers import. */
const APP = "tsconfig.app.json";

/**
 * The layers of the backend program, lowest first. A file may import files of
 * its own layer and of layers below it, never above: the split of the backend
 * into referenced TypeScript projects (one per layer, or several) needs an
 * acyclic project graph, and each project must fit a 4 GiB container's check
 * budget. `pnpm check:layers` enforces the order against a baseline of the
 * imports that still break it; every slice of the split shrinks that baseline.
 * This module is also that check's dependency-cruiser configuration (below).
 *
 * `path` is a dependency-cruiser regex relative to `backend/`. `files` pins
 * files to a layer other than the one their path suggests: a small module that
 * lower layers need, or a helper whose imports belong higher. A file belongs to
 * the layer that pins it, else to the first layer whose `path` matches it
 * (`layerOf`). A layer without a `path` holds only the files it pins: a part
 * of a directory that sits above the rest of it. Tests (`*.test.ts`) and the
 * test helpers are not in a layer: they may import anything.
 *
 * `project` is the default TypeScript project for the layer. `projectFiles`
 * assigns its shared helpers to another compiler: routes and server entry
 * points consume those helpers' declarations, while the semantic import
 * order stays the same. scripts/check-projects.mjs verifies this ownership
 * against the actual projects listed by tsconfig.json.
 *
 * @type {{ name: string; path?: string; files?: string[]; project: string; projectFiles?: {project: string; files: string[]}[] }[]}
 */
const layerTable = [
  {
    // Drizzle tables and the types and zod schemas derived from them, and the
    // ambient declarations every TypeScript project includes.
    name: "schema",
    path: "^src/(ambient/|types/|database/schemas/|database/schema\\.ts$|agents/a2a/a2a-protocol\\.ts$|utils/(billable-usage|network|sanitize-svg|schedule-trigger|uuid)\\.ts$)",
    project: "tsconfig.schema.json",
  },
  {
    // Configuration, logging, the database client and the helpers below models.
    name: "core",
    path: "^src/((config|app-version|cache-manager|in-memory-lru-cache|process-local-cache-registry|constants|templating)\\.ts$|utils/|logging/|database/|log-content/|content-encryption/|secrets-manager/|observability/|integrations/|tokenizers/|git-hosts/|blob-providers/)",
    files: [
      // The API route table config.ts and the request metrics read.
      "src/routes/route-paths.ts",
      // The app name, used in copy across every layer.
      "src/archestra-mcp-server/branding.ts",
      // The stores of the cache manager, content encryption and secrets.
      "src/models/cache-entry.ts",
      "src/models/content-encryption-state.ee.ts",
      "src/models/encryption-key-canary.ts",
      "src/models/secret.ts",
      // A size-capped response reader the git host client uses.
      "src/plugins/bounded-response.ts",
      // The upload file name rules utils/upload-filename.ts applies.
      "src/skills-sandbox/file-path.ts",
      // Bedrock credentials, which the secrets manager resolves.
      "src/clients/bedrock-client.ts",
      "src/clients/bedrock-credentials.ts",
      // The upstream fetch the LLM metrics wrap, and the Responses API usage
      // reader they share with the proxy.
      "src/clients/llm-upstream-dispatcher.ts",
      "src/clients/llm-upstream-fetch.ts",
      "src/routes/proxy/adapters/responses-usage.ts",
    ],
    project: "tsconfig.core.json",
  },
  {
    // A new model that reads an agent model belongs in models-upper: pin it
    // there.
    name: "models",
    path: "^src/(models|auth)/",
    project: "tsconfig.models.json",
    files: [
      // The agent runtime health metric, backed by models.
      "src/observability/metrics/agent-runtime-health.ts",
      // The provider key mappings, and the keyless provider credentials that
      // key resolution (models-upper) falls back to.
      "src/utils/provider-key-mappings.ts",
      "src/clients/anthropic-keyless-auth.ts",
      "src/clients/anthropic-vertex.ts",
      "src/clients/anthropic-vertex-request.ts",
      "src/clients/anthropic-workload-identity.ts",
      "src/clients/azure-url.ts",
      "src/clients/azure-openai-credentials.ts",
      // What model resolution reads besides keys: the output budget an agent
      // gets, and whether Gemini runs on Vertex AI.
      "src/agents/agent-output-budget.ts",
      "src/clients/gemini-vertex-ai.ts",
      // Change notification the config-cached models subscribe to, and the
      // notify hubs it runs on.
      "src/services/config-cache.ts",
      "src/services/shared-notify-hub.ts",
      "src/services/pg-notify-hub.ts",
      // Environment isolation, which the catalog, server, skill and tool
      // models filter by.
      "src/services/environments/environment-isolation.ts",
      // Pricing and catalog data the model rows are enriched with, and the
      // price table the Bedrock pricing reads.
      "src/services/media-pricing.ts",
      "src/services/vendor-published-pricing.ts",
      "src/services/cross-provider-pricing.ts",
      "src/services/bedrock-aws-pricing.ts",
      "src/services/bedrock-aws-prices.json",
      "src/clients/models-dev-client.ts",
      // Contracts the agent run and app render diagnostics models store: the
      // runtime contract, and the app diagnostics with the native app runtime
      // they classify.
      "src/services/agent-runtime/runtime-contract.ts",
      "src/services/apps/app-diagnostics.ts",
      "src/services/apps/app-runtime-native.ts",
      // Credential and identity helpers the connected-client, provider key and
      // auth models call.
      "src/services/connected-client-oauth.ts",
      "src/services/github-app-copilot-token.ts",
      "src/services/apps/app-connector-resource.ts",
      // The request origin the auth middleware reads.
      "src/routes/request-origin.ts",
      // The SRE agent's definition the permission and runtime models read, and
      // the runtime image it names.
      "src/services/sre-agent/definition.ts",
      "src/skills-sandbox/runtime-image.ts",
      // The session id header the interaction and routing models parse, and
      // the meta header it is read from.
      "src/routes/proxy/utils/headers/session-id.ts",
      "src/routes/proxy/utils/headers/meta-header.ts",
      // The deployment names the catalog, server and Playwright runtime
      // models store (no Kubernetes client).
      "src/k8s/deployment-names.ts",
      // The ACL token format the knowledge base ACL models store.
      "src/knowledge-base/acl-tokens.ts",
      // The OpenAPPA records' encodings and identities.
      "src/openappa/plaintext-envelope.ts",
      "src/openappa/actor.ts",
      "src/openappa/session-token.ts",
      "src/openappa/subagent-binding.ts",
      "src/openappa/policy-test-hashes.ts",
      // The skill file format the skill model reads, and the guide content
      // the built-in skills catalogue (models-agents) embeds.
      "src/skills/built-in-skill-branding.ts",
      "src/skills/appa-guide-archestra-reference.ts",
      "src/skills/appa-guide-contracts.ts",
      "src/skills/appa-guide-validation.ts",
      "src/skills/appa-guide-workflows.ts",
      "src/archestra-mcp-server/app-authoring-guidance.ts",
      "src/services/apps/app-ui-policy.ts",
      "src/skills/parser.ts",
      "src/skills/skill-manifest-serializer.ts",
      // The Archestra tool metadata the tool model reads.
      "src/archestra-mcp-server/metadata.ts",
      // Constants the chatops config model validates against.
      "src/agents/chatops/constants.ts",
      "src/agents/incoming-email/constants.ts",
      // The run link the app MCP backing resync (models-upper) reads.
      "src/services/apps/app-run-link.ts",
    ],
  },
  {
    // The agent models and what they import back: agents with their tools,
    // skills and teams, the MCP servers and catalog they use, users and
    // service accounts, and the access checks over them. They import each
    // other, so they are one layer; the models layer is below them.
    name: "models-agents",
    files: [
      "src/models/agent-access-context.ts",
      "src/models/agent-excluded-skill.ts",
      "src/models/agent-skill.ts",
      "src/models/agent-team.ts",
      "src/models/agent-tool.ts",
      "src/models/agent.ts",
      "src/models/entity-labels.ts",
      "src/models/internal-mcp-catalog.ts",
      "src/models/limit.ts",
      "src/models/mcp-catalog-team.ts",
      "src/models/mcp-server.ts",
      "src/models/proxy-request-context.ts",
      "src/models/service-account.ts",
      "src/models/skill.ts",
      "src/models/tool.ts",
      "src/models/user.ts",
      // The access checks the agent models make and the enterprise tier
      // they count users for.
      "src/auth/permission-gated.ts",
      "src/auth/utils.ts",
      "src/enterprise-tier.ts",
      // The built-in skills catalogue the skill model reads.
      "src/skills/appa-guide.ts",
      "src/skills/built-in-skills.ts",
      "src/skills/runtime-handoff.ts",
    ],
    project: "tsconfig.models-agents.json",
  },
  {
    // What builds on the agent models: conversations and interactions, apps,
    // plugins, projects and environments, provider keys and OAuth clients,
    // tool calls and usage, and the models barrel.
    name: "models-upper",
    files: [
      "src/models/app.ts",
      "src/models/conversation-enabled-tool.ts",
      "src/models/conversation.ts",
      // Reads usage facts through the statistics model.
      "src/models/cost-export.ts",
      "src/models/environment.ts",
      "src/models/external-mcp-skill-usage-event.ts",
      "src/models/hook-file.ts",
      "src/models/index.ts",
      "src/models/interaction.ts",
      "src/models/invitation.ts",
      "src/models/llm-oauth-client.ts",
      "src/models/llm-provider-api-key.ts",
      "src/models/managed-oauth-client.ts",
      "src/models/mcp-oauth-client.ts",
      "src/models/mcp-tool-call.ts",
      "src/models/playwright-runtime.ts",
      "src/models/plugin-skill-usage-event.ts",
      "src/models/plugin.ts",
      "src/models/project.ts",
      "src/models/schedule-trigger.ts",
      "src/models/skill-usage-actors.ts",
      "src/models/skill-usage-event.ts",
      "src/models/statistics.ts",
      "src/models/usage-statistics.ts",
      "src/models/virtual-api-key.ts",
      // The auth helpers that check access to agents, catalogs, OAuth
      // clients and skills, and the auth barrel.
      "src/auth/agent-type-permissions.ts",
      "src/auth/idp.ee.ts",
      "src/auth/index.ts",
      "src/auth/linked-idp.ts",
      "src/auth/mcp-catalog-permissions.ts",
      "src/auth/oauth-client-permissions.ts",
      "src/auth/request-lookups.ts",
      "src/auth/skill-permissions.ts",
      // Observability setup and the active-user metric, which count through
      // the user model.
      "src/observability/index.ts",
      "src/observability/metrics/active-users.ts",
      // Resource permissions, which the auth helpers check and update, with
      // what an update runs: the credential and MCP server assignability
      // rules, the app MCP backing resync and member removal, and the MCP
      // advanced settings the auth plugin resolves. With them, the linked
      // identity provider check and the team access to a model.
      "src/routes/proxy/utils/model-team-access.ts",
      "src/services/apps/app-mcp-backing.ts",
      "src/services/credential-resource-permissions.ts",
      "src/services/identity-providers/linked-idp-auth.ts",
      "src/services/mcp-advanced-settings.ts",
      "src/services/mcp-server-assignability.ts",
      "src/services/member-removal.ts",
      "src/services/resource-permissions.ts",
      // Provider key and model resolution, which read agents.
      "src/utils/llm-api-key-resolution.ts",
      "src/utils/llm-resolution.ts",
    ],
    project: "tsconfig.models-upper.json",
  },
  {
    name: "llm-clients",
    // Provider SDKs and client construction sit below their knowledge-base,
    // policy, service and route consumers.
    files: [
      "src/clients/llm-client.ts",
      "src/clients/anthropic-endpoint.ts",
      "src/clients/azure-media-language-model.ts",
      "src/clients/gemini-client.ts",
      "src/clients/internal-call.ts",
      "src/clients/openrouter-attribution.ts",
      "src/clients/openrouter-response-healing.ts",
      "src/clients/openrouter-reported-cost.ts",
      "src/services/azure-model-capabilities.ts",
      "src/services/billable-usage.ts",
      "src/services/fireworks-model.ts",
      "src/routes/proxy/utils/cost-optimization.ts",
      "src/routes/chat/normalization/apply-prompt-cache.ts",
    ],
    project: "tsconfig.llm-clients.json",
  },
  {
    name: "runtime",
    path: "^src/(k8s|sandbox-runtime|skills-sandbox)/",
    files: [
      // Runtime-neutral contracts, failure vocabulary, sizing and placement.
      "src/services/agent-runtime/backends/types.ts",
      "src/services/agent-runtime/failure-reason.ts",
      "src/services/agent-runtime/run-failure.ts",
      "src/services/agent-runtime/runtime-tiers.ts",
      // Credential resolution and network policy are shared runtime inputs.
      "src/services/credentials.ts",
      "src/services/credential-access.ts",
      "src/services/github-user-connection.ts",
      "src/services/environments/network-policy.ts",
      "src/services/environments/network-policy-domains.ts",
      // The generic background queue stores work and dispatches registered
      // callbacks; domain-specific handlers stay above their services.
      "src/task-queue/index.ts",
      "src/task-queue/task-queue.ts",
      "src/task-queue/periodic-tasks.ts",
      // Active-use tracking belongs with the MCP runtime that owns hibernation.
      "src/services/mcp-active-use.ee.ts",
    ],
    project: "tsconfig.runtime.json",
  },
  {
    name: "llm-protocol",
    files: [
      "src/routes/mcp-gateway/grok-tool-names.ts",
      "src/routes/proxy/adapters/grok-native-catalog.ts",
      "src/knowledge-base/embedding-clients/bedrock-models.ts",
      "src/knowledge-base/embedding-clients/cohere-models.ts",
      "src/knowledge-base/embedding-clients/vertex-models.ts",
      "src/knowledge-base/embedding-clients/voyage-models.ts",
      "src/knowledge-base/connectors/pdf-utils.ts",

      "src/archestra-mcp-server/run-tool-target.ts",
      "src/archestra-mcp-server/search-text.ts",
      "src/archestra-mcp-server/tool-attestation.ts",
      "src/clients/realtime-audio.ts",
      "src/openappa/child-trajectory-receipt.ts",
      "src/openappa/child-trajectory-reference-format.ts",
      "src/openappa/grok-durable-history.ts",
      "src/openappa/compaction-carrier.ts",
      "src/openappa/notice.ts",
      "src/openappa/result-view.ts",
      "src/openappa/trajectory-stamp.ts",
      "src/openappa/wire.ts",
      "src/routes/chat/anthropic-provider-options.ts",
      "src/routes/chat/attachment-content-type.ts",
      "src/routes/chat/bedrock-provider-options.ts",
      "src/routes/chat/augment-last-user-message.ts",
      "src/routes/chat/error-message.ts",
      "src/routes/chat/gemini-provider-options.ts",
      "src/routes/chat/model-fetchers/anthropic-credit-probe.ts",
      "src/routes/chat/model-fetchers/anthropic.ts",
      "src/routes/chat/model-fetchers/archestra.ts",
      "src/routes/chat/model-fetchers/azure.ts",
      "src/routes/chat/model-fetchers/bearer-fetcher.ts",
      "src/routes/chat/model-fetchers/bedrock.ts",
      "src/routes/chat/model-fetchers/cohere.ts",
      "src/routes/chat/model-fetchers/deepseek.ts",
      "src/routes/chat/model-fetchers/gemini.ts",
      "src/routes/chat/model-fetchers/github-copilot.ts",
      "src/routes/chat/model-fetchers/index.ts",
      "src/routes/chat/model-fetchers/jev.ts",
      "src/routes/chat/model-fetchers/litellm.ts",
      "src/routes/chat/model-fetchers/microsoft-365-copilot.ts",
      "src/routes/chat/model-fetchers/ollama.ts",
      "src/routes/chat/model-fetchers/openai-compatible.ts",
      "src/routes/chat/model-fetchers/openai.ts",
      "src/routes/chat/model-fetchers/openrouter.ts",
      "src/routes/chat/model-fetchers/registry.ts",
      "src/routes/chat/model-fetchers/types.ts",
      "src/routes/chat/model-fetchers/vllm.ts",
      "src/routes/chat/model-fetchers/voyage.ts",
      "src/routes/chat/model-fetchers/xai.ts",
      "src/routes/chat/normalization/clone-attachments-for-fork.ts",
      "src/routes/chat/normalization/enforce-context-window-limit.ts",
      "src/routes/chat/normalization/enforce-request-size-limit.ts",
      "src/routes/chat/normalization/estimate-message-tokens.ts",
      "src/routes/chat/normalization/extract-inline-attachments.ts",
      "src/routes/chat/normalization/materialize-attachments.ts",
      "src/routes/chat/normalization/normalize-chat-messages.ts",
      "src/routes/chat/normalization/prepare-for-provider.ts",
      "src/routes/chat/normalization/strip-images-from-messages.ts",
      "src/routes/chat/ollama-native-params.ts",
      "src/routes/chat/openai-provider-options.ts",
      "src/routes/chat/openrouter-provider-options.ts",
      "src/routes/chat/tool-call-repair.ts",
      "src/routes/proxy/common.ts",
      "src/routes/proxy/model-router-cache-controls.ts",
      "src/routes/proxy/utils/approved-as-sent.ts",
      "src/routes/proxy/utils/audio-duration.ts",
      "src/routes/proxy/utils/auto-routing-context.ts",
      "src/routes/proxy/utils/azure-ingress.ts",
      "src/routes/proxy/utils/billing-mode.ts",
      "src/routes/proxy/utils/bounded-media-response.ts",
      "src/routes/proxy/utils/claude-desktop-subscription.ts",
      "src/routes/proxy/utils/client-runtime-evidence.ts",
      "src/routes/proxy/utils/declared-tool-names.ts",
      "src/routes/proxy/utils/encrypted-chat-session.ts",
      "src/routes/proxy/utils/gateway-tool-declarations.ts",
      "src/routes/proxy/utils/gateway-tool-names.ts",
      "src/routes/proxy/utils/headers/client-app.ts",
      "src/routes/proxy/utils/headers/external-agent-id.ts",
      "src/routes/proxy/utils/headers/index.ts",
      "src/routes/proxy/utils/headers/run-id.ts",
      "src/routes/proxy/utils/headers/session-metadata.ts",
      "src/routes/proxy/utils/headers/user-id.ts",
      "src/routes/proxy/utils/headers/virtual-key.ts",
      "src/routes/proxy/utils/image-edit-input.ts",
      "src/routes/proxy/utils/index.ts",
      "src/routes/proxy/utils/logged-audio.ts",
      "src/routes/proxy/utils/logged-media.ts",
      "src/routes/proxy/utils/mcp-image.ts",
      "src/routes/proxy/utils/media-multipart.ts",
      "src/routes/proxy/utils/media-provider-error.ts",
      "src/routes/proxy/utils/summarize-tool-results.ts",
      "src/routes/proxy/utils/tool-call-ids.ts",
      "src/routes/proxy/utils/tools.ts",
      "src/services/github-copilot-token.ts",
      "src/services/microsoft-365-copilot-token.ts",
      "src/services/openai-codex-credentials.ts",
      "src/services/openai-codex-token.ts",
      "src/services/subscription-authentication-status.ts",
      "src/services/subscription-credential-guard.ts",
      "src/services/xai-subscription-credentials.ts",
      "src/services/xai-subscription-token.ts",
    ],
    project: "tsconfig.llm-protocol.json",
  },
  {
    name: "provider-adapters",
    files: [
      "src/routes/proxy/adapters/xai-native-session.ts",
      "src/routes/proxy/adapters/anthropic-openai-translator.ts",
      "src/routes/proxy/adapters/anthropic-openai.ts",
      "src/routes/proxy/adapters/anthropic.ts",
      "src/routes/proxy/adapters/archestra.ts",
      "src/routes/proxy/adapters/audio.ts",
      "src/routes/proxy/adapters/azure-image-edits.ts",
      "src/routes/proxy/adapters/azure-images.ts",
      "src/routes/proxy/adapters/azure-realtime.ts",
      "src/routes/proxy/adapters/azure-responses.ts",
      "src/routes/proxy/adapters/azure.ts",
      "src/routes/proxy/adapters/bedrock-invoke.ts",
      "src/routes/proxy/adapters/bedrock-openai-translator.ts",
      "src/routes/proxy/adapters/bedrock-openai.ts",
      "src/routes/proxy/adapters/bedrock.ts",
      "src/routes/proxy/adapters/cerebras.ts",
      "src/routes/proxy/adapters/chat-completions-stream.ts",
      "src/routes/proxy/adapters/cohere-openai-translator.ts",
      "src/routes/proxy/adapters/cohere-openai.ts",
      "src/routes/proxy/adapters/cohere.ts",
      "src/routes/proxy/adapters/deepseek.ts",
      "src/routes/proxy/adapters/embeddings-wire.ts",
      "src/routes/proxy/adapters/gemini-embeddings.ts",
      "src/routes/proxy/adapters/gemini-images.ts",
      "src/routes/proxy/adapters/gemini-openai-translator.ts",
      "src/routes/proxy/adapters/gemini-openai.ts",
      "src/routes/proxy/adapters/gemini-schema.ts",
      "src/routes/proxy/adapters/gemini-tool-names.ts",
      "src/routes/proxy/adapters/gemini.ts",
      "src/routes/proxy/adapters/github-copilot-responses.ts",
      "src/routes/proxy/adapters/github-copilot.ts",
      "src/routes/proxy/adapters/groq.ts",
      "src/routes/proxy/adapters/image-generation.ts",
      "src/routes/proxy/adapters/index.ts",
      "src/routes/proxy/adapters/jev.ts",
      "src/routes/proxy/adapters/kimi-code.ts",
      "src/routes/proxy/adapters/kimi.ts",
      "src/routes/proxy/adapters/microsoft-365-copilot-graph-translator.ts",
      "src/routes/proxy/adapters/microsoft-365-copilot.ts",
      "src/routes/proxy/adapters/minimax.ts",
      "src/routes/proxy/adapters/mistral.ts",
      "src/routes/proxy/adapters/ollama-native.ts",
      "src/routes/proxy/adapters/ollama.ts",
      "src/routes/proxy/adapters/openai-anthropic-translator.ts",
      "src/routes/proxy/adapters/openai-codex-client.ts",
      "src/routes/proxy/adapters/openai-codex-responses-client.ts",
      "src/routes/proxy/adapters/openai-codex-session.ts",
      "src/routes/proxy/adapters/openai-codex-translator.ts",
      "src/routes/proxy/adapters/openai-compatible-adapter.ts",
      "src/routes/proxy/adapters/openai-image-edits.ts",
      "src/routes/proxy/adapters/openai-images.ts",
      "src/routes/proxy/adapters/openai-responses-from-chat.ts",
      "src/routes/proxy/adapters/openai-responses-translator.ts",
      "src/routes/proxy/adapters/openai-responses.ts",
      "src/routes/proxy/adapters/openai-sse-chunk.ts",
      "src/routes/proxy/adapters/openai-translator-utils.ts",
      "src/routes/proxy/adapters/openai.ts",
      "src/routes/proxy/adapters/openrouter.ts",
      "src/routes/proxy/adapters/perplexity-responses.ts",
      "src/routes/proxy/adapters/perplexity.ts",
      "src/routes/proxy/adapters/responses-stream-error-frame.ts",
      "src/routes/proxy/adapters/responses-tool-call-rewrite.ts",
      "src/routes/proxy/adapters/sampling-param-fallback.ts",
      "src/routes/proxy/adapters/sdk-retry-policy.ts",
      "src/routes/proxy/adapters/subscription-auth-error.ts",
      "src/routes/proxy/adapters/upstream-http-error.ts",
      "src/routes/proxy/adapters/vllm.ts",
      "src/routes/proxy/adapters/xai.ts",
      "src/routes/proxy/adapters/zhipuai.ts",
      "src/routes/proxy/translated-response-format.ts",
    ],
    project: "tsconfig.provider-adapters.json",
  },
  {
    // New orchestration that reaches a concrete connector belongs in kb.
    name: "kb-core",
    path: "^src/knowledge-base/",
    project: "tsconfig.kb-core.json",
  },
  {
    name: "kb-connectors",
    files: [
      "src/knowledge-base/connectors/asana/asana-connector.ts",
      "src/knowledge-base/connectors/confluence/confluence-connector.ts",
      "src/knowledge-base/connectors/dropbox/dropbox-connector.ts",
      "src/knowledge-base/connectors/gdrive/gdrive-connector.ts",
      "src/knowledge-base/connectors/github/github-connector.ts",
      "src/knowledge-base/connectors/gitlab/gitlab-connector.ts",
      "src/knowledge-base/connectors/jira/jira-connector.ts",
      "src/knowledge-base/connectors/linear/linear-connector.ts",
      "src/knowledge-base/connectors/mfiles/mfiles-connector.ts",
      "src/knowledge-base/connectors/notion/notion-connector.ts",
      "src/knowledge-base/connectors/onedrive/onedrive-connector.ts",
      "src/knowledge-base/connectors/outline/outline-connector.ts",
      "src/knowledge-base/connectors/perforce/perforce-connector.ts",
      "src/knowledge-base/connectors/registry.ts",
      "src/knowledge-base/connectors/salesforce/salesforce-connector.ts",
      "src/knowledge-base/connectors/servicenow/servicenow-connector.ts",
      "src/knowledge-base/connectors/sharepoint/sharepoint-connector.ts",
      "src/knowledge-base/connectors/web-crawler/web-crawler-connector.ts",
    ],
    project: "tsconfig.kb-connectors.json",
  },
  {
    name: "kb",
    files: [
      "src/knowledge-base/connector-sync.ts",
      "src/knowledge-base/index.ts",
      "src/knowledge-base/permission-sync-trigger.ts",
      "src/knowledge-base/permission-sync.ts",
      "src/knowledge-base/source-access-control.ts",
    ],
    project: "tsconfig.kb.json",
  },
  {
    // Connection/bootstrap artifacts, below live execution orchestration.
    name: "connections",
    files: [
      "src/services/agent-connection-setup/agents/grok.ts",
      "src/services/agent-connection-setup/guard/clients/grok.ts",
      "src/services/agent-connection-setup/payloads/grok-config-transaction.ts",
      "src/services/agent-connection-setup/payloads/grok-config.ts",
      "src/services/agent-connection-setup/payloads/grok-http.ts",
      "src/services/agent-connection-setup/payloads/grok-legacy-plugins.ts",
      "src/services/agent-connection-setup/payloads/grok-loopback-proxy.ts",
      "src/services/agent-connection-setup/payloads/grok-mcp-sign-in.ts",
      "src/services/agent-connection-setup/payloads/grok-model-discovery.ts",
      "src/services/agent-connection-setup/payloads/grok-native-transport.ts",
      "src/services/agent-connection-setup/payloads/grok-shell.ts",
      "src/services/agent-connection-setup/payloads/grok-skills.ts",
      "src/services/agent-connection-setup/payloads/grok-startup.ts",
      "src/services/agent-connection-setup/payloads/grok-toml.generated.ts",
      "src/services/agent-connection-setup/agents/claude-code.ts",
      "src/services/agent-connection-setup/agents/claude-desktop.ts",
      "src/services/agent-connection-setup/agents/codex.ts",
      "src/services/agent-connection-setup/agents/copilot-cli.ts",
      "src/services/agent-connection-setup/agents/cursor.ts",
      "src/services/agent-connection-setup/agents/kimi-code.ts",
      "src/services/agent-connection-setup/agents/opencode.ts",
      "src/services/agent-connection-setup/agents/pi.ts",
      "src/services/agent-connection-setup/bootstrap/client-connection-installer.ts",
      "src/services/agent-connection-setup/credentials/primary-providers.ts",
      "src/services/agent-connection-setup/desktop/connection-desktop-installer.ts",
      "src/services/agent-connection-setup/desktop/connection-setup-desktop-bundle.ts",
      "src/services/agent-connection-setup/desktop/windows-desktop-processes.ts",
      "src/services/agent-connection-setup/guard/clients/claude-code.ts",
      "src/services/agent-connection-setup/guard/clients/codex.ts",
      "src/services/agent-connection-setup/guard/clients/copilot-cli.ts",
      "src/services/agent-connection-setup/guard/clients/index.ts",
      "src/services/agent-connection-setup/guard/clients/kimi-code.ts",
      "src/services/agent-connection-setup/guard/clients/opencode.ts",
      "src/services/agent-connection-setup/guard/clients/pi.ts",
      "src/services/agent-connection-setup/guard/clients/verify.ts",
      "src/services/agent-connection-setup/guard/startup-guard-artifact.ts",
      "src/services/agent-connection-setup/guard/startup-guard.ts",
      "src/services/agent-connection-setup/guard/startup-guard.windows.ts",
      "src/services/agent-connection-setup/index.ts",
      "src/services/agent-connection-setup/opencode-family.ts",
      "src/services/agent-connection-setup/payloads/codex-handoff.ts",
      "src/services/agent-connection-setup/payloads/codex-sandbox-preflight.ts",
      "src/services/agent-connection-setup/payloads/codex-setup-preflight.ts",
      "src/services/agent-connection-setup/payloads/copilot-provider-config.ts",
      "src/services/agent-connection-setup/payloads/kimi-code-connection.ts",
      "src/services/agent-connection-setup/payloads/managed-instructions-refresh.ts",
      "src/services/agent-connection-setup/payloads/managed-instructions-refresh.windows.ts",
      "src/services/agent-connection-setup/payloads/managed-runtime-bootstrap.ts",
      "src/services/agent-connection-setup/payloads/managed-runtime-install.ts",
      "src/services/agent-connection-setup/payloads/managed-runtime.ts",
      "src/services/agent-connection-setup/payloads/marketplace-skills-sync.ts",
      "src/services/agent-connection-setup/payloads/opencode-handoff.ts",
      "src/services/agent-connection-setup/payloads/opencode-mcp-config.ts",
      "src/services/agent-connection-setup/payloads/opencode-primary-config.ts",
      "src/services/agent-connection-setup/payloads/opencode-question-tui.ts",
      "src/services/agent-connection-setup/payloads/opencode-routing-plugin.ts",
      "src/services/agent-connection-setup/payloads/pi-extension.ts",
      "src/services/agent-connection-setup/payloads/pi-launcher.ts",
      "src/services/agent-connection-setup/payloads/pi-lifecycle.ts",
      "src/services/agent-connection-setup/payloads/pi-mcp-sign-in.ts",
      "src/services/agent-connection-setup/payloads/startup-guard-refresh.ts",
      "src/services/agent-connection-setup/setup-command.ts",
      "src/services/agent-connection-setup/steps/ending.ts",
      "src/services/agent-connection-setup/steps/json-merge.ts",
      "src/services/agent-connection-setup/steps/marketplace-copy.ts",
      "src/services/agent-connection-setup/steps/mcp.ts",
      "src/services/agent-connection-setup/steps/node-script.ts",
      "src/services/agent-connection-setup/steps/powershell-json.ts",
      "src/services/agent-connection-setup/steps/quoting.ts",
      "src/services/agent-connection-setup/steps/script-frame.ts",
      "src/services/agent-connection-setup/steps/startup-guard.ts",
      "src/services/agent-connection-setup/types.ts",
      "src/services/archestra-mark.ts",
      "src/services/connection-instructions-token.ts",
      "src/services/connection-managed-instructions.ts",
      "src/services/connection-proxy-setup-context.ts",
      "src/services/connection-runtime-token.ts",
      "src/services/connection-runtime.ts",
      "src/services/connection-setup-scope.ts",
      "src/services/connection-setup.ts",
      "src/services/virtual-key-providers.ts",
    ],
    project: "tsconfig.connections.json",
  },
  {
    // Policy configuration and repository sync, below request enforcement.
    name: "policy-config",
    files: [
      "src/git-hosts/git-access.ts",
      "src/openappa/archestra-audience.ts",
      "src/openappa/batteries.ts",
      "src/openappa/battery-target.ts",
      "src/openappa/bound-github-api-url.ts",
      "src/openappa/composition-view.ts",
      "src/openappa/coverage.ts",
      "src/openappa/declarations.ts",
      "src/openappa/draft-helper-sources.ts",
      "src/openappa/failure.ts",
      "src/openappa/helper-bridge.ts",
      "src/openappa/helper-slots.ts",
      "src/openappa/host-tool-rules.ts",
      "src/openappa/policy-moved.ts",
      "src/openappa/policy-text.ts",
      "src/openappa/replay-owner.ts",
      "src/openappa/rule-targets.ts",
      "src/openappa/template.generated.ts",
      "src/services/agent-runtime/runtime-credentials.ts",
      "src/services/github-app-manifest-setup.ts",
      "src/services/github-copilot-app-setup.ts",
      "src/services/guardrails-deployment.ts",
      "src/services/guardrails-policy-proposal.ts",
      "src/services/guardrails-policy.ts",
      "src/services/integration-overrides.ts",
      "src/services/model-sync.ts",
      "src/services/openappa-external-consults.ts",
      "src/services/openappa-github-access.ts",
      "src/services/openappa-github-app-setup.ts",
      "src/services/openappa-github.ts",
      "src/services/openappa-github-sync.ts",
      "src/services/openappa-gitlab.ts",
      "src/services/openappa-label-changes.ts",
      "src/services/openappa-policy-change.ts",
      "src/services/openappa-policy-tests.ts",
      "src/services/openappa-template-files.ts",
      "src/services/openappa-validation-change.ts",
      "src/services/openappa-yells.ts",
      "src/skills/github-app-token.ts",
      "src/skills/github-source.ts",
    ],
    project: "tsconfig.policy-config.json",
  },
  {
    // Business operations that do not invoke MCP execution or route handlers.
    name: "services-support",
    files: [
      "src/plugins/delivery-budget.ts",
      "src/routes/mcp-gateway/protocol.ts",
      "src/routes/mcp-gateway/tasks.ts",
      "src/services/a2a-outbound-assignments.ts",
      "src/services/a2a-outbound-registry.ts",
      "src/services/blob-provider.ts",
      "src/services/cost-export/focus.ts",
      "src/services/cost-export/index.ts",
      "src/services/active-chat-run-notifier.ts",
      "src/services/active-chat-run.ts",
      "src/services/agent-credential-readiness.ts",
      "src/services/agent-export.ts",
      "src/services/agent-knowledge-source-exclusions.ts",
      "src/services/agent-ownership.ts",
      "src/services/agent-runtime/agent-config-validation.ts",
      "src/services/agent-runtime/agent-run-attachments.ts",
      "src/services/agent-runtime/backends/index.ts",
      "src/services/agent-runtime/backends/kubernetes.ts",
      "src/services/agent-runtime/claude-code-account.ts",
      "src/services/agent-runtime/claude-code-oauth.ts",
      "src/services/agent-runtime/credentials.ts",
      "src/services/agent-runtime/input-files.ts",
      "src/services/agent-runtime/model-compatibility.ts",
      "src/services/agent-runtime/output-capture.ts",
      "src/services/agent-runtime/run-access.ts",
      "src/services/agent-runtime/run-handle.ts",
      "src/services/agent-runtime/runtime-tier-settings.ts",
      "src/services/agent-runtime/title.ts",
      "src/services/agent-runtime/transcript-store.ts",
      "src/services/agent-skill-assignment.ts",
      "src/services/agent-skill-resolution.ts",
      "src/services/agent-subagent-exclusions.ts",
      "src/services/agent-tool-exclusions.ts",
      "src/services/apps/app-authorization.ts",
      "src/services/apps/app-sdk-injection.ts",
      "src/services/apps/app-tool-runtime-gate.ts",
      "src/services/apps/app-version-merge.ts",
      "src/services/apps/app-version-restore.ts",
      "src/services/apps/default-apps.ts",
      "src/services/apps/new-app-defaults.ts",
      "src/services/apps/opened-app-context.ts",
      "src/services/caller-catalog-access.ts",
      "src/services/chat-agent-visibility.ts",
      "src/services/chat-model-pools.ts",
      "src/services/claude-code-tool-token-count.ts",
      "src/services/client-connection.ts",
      "src/services/compaction-llm.ts",
      "src/services/connected-client.ts",
      "src/services/container-registry.ts",
      "src/services/context-compaction.ts",
      "src/services/conversation-attachment-source.ts",
      "src/services/conversation-files.ts",
      "src/services/credential-billing.ts",
      "src/services/default-admin-password.ts",
      "src/services/dev-feedback.ts",
      "src/services/discovered-model-enrichment.ts",
      "src/services/environments/deployment-reconciliation.ts",
      "src/services/environments/environment.ts",
      "src/services/environments/network-policy-match.ts",
      "src/services/environments/remote-server-network-policy.ts",
      "src/services/git-credentials.ts",
      "src/services/github-actions-access.ts",
      "src/services/github-app-config.ts",
      "src/services/github-pat.ts",
      "src/services/identity-providers/access-token-refresh.ts",
      "src/services/identity-providers/enterprise-managed/authorization.ts",
      "src/services/identity-providers/enterprise-managed/exchange-strategies/entra-obo-strategy.ts",
      "src/services/identity-providers/enterprise-managed/exchange-strategies/okta-managed-credential-exchange.ts",
      "src/services/identity-providers/enterprise-managed/exchange-strategies/rfc8693-token-exchange.ts",
      "src/services/identity-providers/enterprise-managed/exchange.ts",
      "src/services/identity-providers/oidc.ts",
      "src/services/identity-providers/session-token.ts",
      "src/services/instance-analytics.ts",
      "src/services/interaction-session-preview-backfill.ts",
      "src/services/jira-chatops-outbound.ts",
      "src/services/jwks-validator.ts",
      "src/services/knowledge-base-access.ts",
      "src/services/knowledge-file-ingestion.ts",
      "src/services/knowledge-settings.ts",
      "src/services/limit-access.ts",
      "src/services/limit.ts",
      "src/services/llm-throughput.ts",
      "src/services/llm-usage-rollup.ts",
      "src/services/mcp-catalog-secrets.ts",
      "src/services/mcp-deployment-statuses.ts",
      "src/services/mcp-gateway-task-reaper.ts",
      "src/services/mcp-install-policy.ts",
      "src/services/mcp-installation-access.ts",
      "src/services/mcp-oauth-access.ts",
      "src/services/mcp-oauth-credential-grant.ts",
      "src/services/mcp-oauth-fetch.ts",
      "src/services/mcp-registry-attention.ts",
      "src/services/mcp-server-list.ts",
      "src/services/mcp-tool-description-backfill.ts",
      "src/services/mcp-tool-token-estimate.ts",
      "src/services/model-cost-backfill.ts",
      "src/services/model-pool-grants.ts",
      "src/services/model-sync-schedule.ts",
      "src/services/oauth-client-credentials.ts",
      "src/services/oauth-client-providers.ts",
      "src/services/oauth-client-revocation.ts",
      "src/services/oauth-refresh-classification.ts",
      "src/services/oauth-refresh-replay.ts",
      "src/services/oauth-revocation-rate-limit.ts",
      "src/services/oauth-service-account.ts",
      "src/services/oauth-token-rate-limit.ts",
      "src/services/project.ts",
      "src/services/request-attribution-labels.ts",
      "src/services/resource-ownership.ts",
      "src/services/resource-permissions-cutover.ts",
      "src/services/role-assignment.ts",
      "src/services/routing-plan-cache.ts",
      "src/services/schedule-trigger-access.ts",
      "src/services/schedule-trigger-management.ts",
      "src/services/scheduled-run-conversation.ts",
      "src/services/skill-publication-backfill.ts",
      "src/services/skill-publication.ts",
      "src/services/skill-share-link.ts",
      "src/services/subscription-credential-rotation.ts",
      "src/services/system-key-manager.ts",
      "src/services/team-authorization.ts",
      "src/services/team-token-migration.ts",
      "src/services/title-generation.ts",
      "src/services/user-limit-usage.ts",
      "src/services/user.ts",
      "src/skills/marketplace/index.ts",
      "src/skills/marketplace/layout.ts",
      "src/skills/marketplace/manifest.ts",
      "src/skills/marketplace/materialize.ts",
    ],
    project: "tsconfig.services-support.json",
  },
  {
    name: "policy",
    path: "^src/(openappa|proxy|auto-routing|skills|task-queue|plugins|features|data-retention)/",
    project: APP,
  },
  {
    name: "services",
    path: "^src/(services|app-templates)/",
    // Reads the error tracker's report of the previous container's exit.
    files: ["src/observability/previous-termination-report.ts"],
    project: APP,
  },
  { name: "mcp", path: "^src/(archestra-mcp-server|agents|clients)/", project: APP },
  {
    name: "routes-proxy",
    path: "^src/routes/proxy/",
    projectFiles: [
      {
        project: APP,
        files: [
          "src/routes/proxy/utils/grok-deferred-tools.ts",
          "src/routes/proxy/image-edit-handler.ts",
          "src/routes/proxy/llm-proxy-auth.ts",
          "src/routes/proxy/llm-proxy-handler.ts",
          "src/routes/proxy/llm-proxy-helpers.ts",
          "src/routes/proxy/llm-proxy-resource-auth.ts",
          "src/routes/proxy/model-pool-capabilities.ts",
          "src/routes/proxy/model-pool-failover.ts",
          "src/routes/proxy/model-pool-transport.ts",
          "src/routes/proxy/model-router-access.ts",
          "src/routes/proxy/model-router-resolver.ts",
          "src/routes/proxy/passthrough-log.ts",
          "src/routes/proxy/provider-file-handler.ts",
          "src/routes/proxy/realtime/openai-realtime-proxy.ts",
          "src/routes/proxy/routes/audio.ts",
          "src/routes/proxy/routes/model-router.ts",
          "src/routes/proxy/stream-keepalive.ts",
          "src/routes/proxy/upstream-connection-retry.ts",
          "src/routes/proxy/utils/bedrock-prompt-budget.ts",
          "src/routes/proxy/utils/client-gateway-bindings.ts",
          "src/routes/proxy/utils/delegation-markers.ts",
        ],
      },
    ],
    project: "tsconfig.routes-proxy.json",
  },
  {
    name: "routes-chat",
    path: "^src/routes/(chat|mcp-gateway)/",
    projectFiles: [
      {
        project: APP,
        files: [
          "src/routes/chat/context-trimming.ts",
          "src/routes/chat/encrypted-chat.ts",
          "src/routes/chat/errors.ts",
          "src/routes/chat/token-bucket-refit.ts",
          "src/routes/mcp-gateway/mrtr.ts",
          "src/routes/mcp-gateway/reauth-elicitation.ts",
          "src/routes/mcp-gateway/skills.ts",
          "src/routes/mcp-gateway/undeclared-tool-call.ts",
          "src/routes/mcp-gateway/utils.ts",
        ],
      },
    ],
    project: "tsconfig.routes-chat.json",
  },
  {
    name: "routes-rest",
    path: "^src/routes/",
    projectFiles: [
      {
        project: APP,
        files: [
          "src/routes/mcp-app-gateway.utils.ts",
          "src/routes/oauth-issuer-binding.ts",
          "src/routes/oauth-issuer-validation.ts",
          "src/routes/oauth.ts",
        ],
      },
    ],
    project: "tsconfig.routes-rest.json",
  },
  {
    // The Fastify server, the websocket, middleware and the entry scripts.
    name: "server",
    path: "^src/((server|fastify-instance|websocket|startup-health|metrics-registration|middleware|ngrok-tunnel-manager)\\.ts$|server/|middleware/|hooks/|entrypoints/|openapi/|standalone-scripts/)",
    files: [
      // The Better Auth instance and what composes it into the server: the
      // Fastify plugin, the route registry and the routes that serve or wire
      // the instance (the auth handler, API keys, identity providers), the SSO
      // email reconciliation its hooks run, and the JWKS key check that reads
      // its context. Lower layers reach sessions, sign-up and the key check
      // through ports (models/ports.ts).
      "src/auth/better-auth.ts",
      "src/auth/sso-email-reconciliation.ee.ts",
      "src/auth/jwks-signing-key-guard.ts",
      "src/auth/fastify-plugin/index.ts",
      "src/auth/fastify-plugin/plugin.ts",
      "src/auth/fastify-plugin/middleware.ts",
      "src/routes/index.ts",
      "src/routes/index.ee.ts",
      "src/routes/auth.ts",
      "src/routes/api-key.ts",
      "src/routes/identity-provider.ee.ts",
    ],
    projectFiles: [
      {
        project: APP,
        files: [
          "src/auth/better-auth.ts",
          "src/auth/sso-email-reconciliation.ee.ts",
          "src/entrypoints/_shared/log-capture.ts",
          "src/fastify-instance.ts",
          "src/hooks/hook-dispatcher-service.ts",
          "src/hooks/hook-run-parts.ts",
          "src/hooks/hook-runner.ts",
          "src/middleware/audit-log-hook.ts",
          "src/middleware/audit-log-registry.ts",
          "src/middleware/browser-api-document.ts",
          "src/ngrok-tunnel-manager.ts",
          "src/server/error-handler.ts",
          "src/server/llm-proxy-drain.ts",
          "src/server/llm-proxy-timing.ts",
          "src/server/source-maps.ts",
          "src/websocket.ts",
        ],
      },
    ],
    project: "tsconfig.server.json",
  },
];

/** Every pinned file, as a regex alternative. */
const PINNED = layerTable
  .flatMap((layer) => layer.files ?? [])
  .map(escapeRegex)
  .join("|");

/**
 * The layers with the patterns dependency-cruiser and the checks match: a
 * layer's pinned files, or its `path` for any file no layer pins.
 *
 * @type {{ name: string; path: string; project: string }[]}
 */
const layers = layerTable.map((layer) => {
  // A layer with neither would match every file.
  if (!layer.path && !layer.files?.length) {
    throw new Error(`Layer ${layer.name} needs a path or pinned files`);
  }
  return {
    name: layer.name,
    project: layer.project,
    path: [
      ...(layer.files?.length
        ? [`^(?:${layer.files.map(escapeRegex).join("|")})$`]
        : []),
      ...(layer.path ? [`^(?!(?:${PINNED})$)(?:${layer.path})`] : []),
    ].join("|"),
  };
});

/** The layer of a source file, or undefined for tests and files in no layer. */
export function layerOf(file) {
  if (TEST_FILE.test(file)) return undefined;
  const match = LAYER_MATCHERS.find(({ regex }) => regex.test(file));
  if (!match) return undefined;
  const project = match.projects.get(file);
  return project ? { ...match.layer, project } : match.layer;
}

/** Tests and test helpers may import any layer. */
const TESTS = "(\\.test\\.ts$|\\.test-[a-z-]+\\.ts$|^src/test/|/__mocks__/)";

const TEST_FILE = new RegExp(TESTS);
const LAYER_MATCHERS = layers.map((layer, index) => ({
  layer,
  regex: new RegExp(layer.path),
  projects: projectPins(layerTable[index].projectFiles ?? []),
}));

/**
 * The dependency-cruiser configuration `pnpm check:layers` runs. It forbids
 * every import from a layer to a layer above it, type imports and `import()`
 * included: they put files into the TypeScript program just as runtime
 * imports do. scripts/check-layers.mjs compares the result with
 * layers.known-upward-imports.json.
 */
export default {
  forbidden: [
    ...layers.slice(0, -1).map((layer, index) => ({
      name: `${layer.name}-imports-no-higher-layer`,
      severity: "error",
      comment: `A ${layer.name} file may import only ${layers
        .slice(0, index + 1)
        .map((lower) => lower.name)
        .join(
          ", ",
        )} files. Move the imported code down, the importing code up, or invert the dependency (layers.mjs).`,
      // A file belongs to the first layer whose pattern matches it.
      from: {
        path: layer.path,
        pathNot: [TESTS, ...layers.slice(0, index).map((lower) => lower.path)],
      },
      to: {
        path: layers
          .slice(index + 1)
          .map((higher) => higher.path)
          .join("|"),
        // A file of a higher layer's directory may sit in a lower layer
        // (e.g. utils/uuid.ts in schema): it is not above the importer.
        pathNot: [
          TESTS,
          ...layers.slice(0, index + 1).map((lower) => lower.path),
        ],
      },
    })),
    {
      name: "source-file-in-a-layer",
      severity: "error",
      comment:
        "Every backend source file belongs to a layer, so the order covers it. Add its directory to a layer in layers.mjs.",
      from: {
        path: "^src/",
        pathNot: [TESTS, "^src/static/", ...layers.map((layer) => layer.path)],
      },
      to: {},
    },
    {
      name: "source-imports-no-test-code",
      severity: "error",
      comment:
        "Test helpers, mocks and tests are not part of any layer; source files may not import them.",
      from: { pathNot: TESTS },
      to: { path: TESTS },
    },
  ],
  required: [
    {
      name: "entry-point-binds-ports",
      severity: "error",
      comment:
        "Every entry point binds the ports of the layers below before anything uses them: import @/server/composition first, then call assertPortsBound().",
      module: {
        path: "^src/(server\\.ts|standalone-scripts/[^/]+\\.ts)$",
        // Helper modules that scripts or the test setup import, not entry points.
        pathNot: [
          TESTS,
          "^src/standalone-scripts/(hydration-schema|rebuild-interaction-user-activity-command|build-ext-apps-inline)\\.ts$",
        ],
      },
      to: { path: "^src/server/composition\\.ts$" },
    },
  ],
  options: {
    includeOnly: "^src/",
    // Tests are roots that nothing imports; their imports are not checked.
    doNotFollow: { path: TESTS },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    skipAnalysisNotInRules: true,
  },
};

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact-file compiler ownership within one semantic layer. */
function projectPins(groups) {
  const projects = new Map();
  for (const { project, files } of groups) {
    for (const file of files) {
      if (projects.has(file)) {
        throw new Error(`File ${file} has two project assignments`);
      }
      projects.set(file, project);
    }
  }
  return projects;
}
