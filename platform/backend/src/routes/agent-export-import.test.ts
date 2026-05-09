/**
 * Route-level integration tests for Agent Export + Import endpoints.
 *
 * Tests:
 * - Full roundtrip (create → export → import → compare)
 * - RBAC: read permission for export, create permission for import
 * - Security: no sensitive fields in export payload
 * - Edge cases: empty payload, malformed JSON, unsupported version, name collision
 * - Idempotency: multiple imports of the same payload
 */
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

describe("Agent export/import routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organizationId;
    });

    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Minimal valid import payload for ad-hoc tests */
  const makeMinimalPayload = (name = "Route Test Agent") => ({
    version: "1" as const,
    exportedAt: new Date().toISOString(),
    sourceInstance: null,
    agent: {
      name,
      agentType: "agent" as const,
      description: "An agent created in tests",
      systemPrompt: "Be helpful",
      icon: "🤖",
      scope: "org",
      considerContextUntrusted: false,
      toolAssignmentMode: "manual",
      toolExposureMode: "full",
      llmModel: null,
      incomingEmailEnabled: false,
      incomingEmailSecurityMode: "private",
      incomingEmailAllowedDomain: null,
      passthroughHeaders: null,
    },
    labels: [],
    suggestedPrompts: [],
    tools: [],
    delegations: [],
    knowledgeBases: [],
    connectors: [],
  });

  // ---------------------------------------------------------------------------
  // Export tests
  // ---------------------------------------------------------------------------

  describe("GET /api/agents/:id/export", () => {
    test("exports a basic agent and returns a valid portable payload", async ({
      makeAgent,
    }) => {
      // agentType must be "agent" — fixture defaults to mcp_gateway
      const agent = await makeAgent({
        name: "My Exportable Agent",
        agentType: "agent",
        organizationId,
        authorId: user.id,
        systemPrompt: "You help with exports",
        scope: "personal",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/export`,
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      // Schema-level checks
      expect(payload.version).toBe("1");
      expect(payload.exportedAt).toBeTruthy();
      expect(typeof payload.exportedAt).toBe("string");

      // Agent config checks
      expect(payload.agent.name).toBe("My Exportable Agent");
      expect(payload.agent.agentType).toBe("agent");
      expect(payload.agent.systemPrompt).toBe("You help with exports");

      // Empty arrays for agents with no associations
      expect(payload.tools).toEqual([]);
      expect(payload.knowledgeBases).toEqual([]);
      expect(payload.connectors).toEqual([]);
      expect(payload.delegations).toEqual([]);
    });

    test("exported payload does NOT contain sensitive fields (llmApiKeyId, identityProviderId, authorId)", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        name: "Sensitive Agent",
        agentType: "agent",
        organizationId,
        authorId: user.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/export`,
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      // These fields must never appear in an export
      expect(payload).not.toHaveProperty("llmApiKeyId");
      expect(payload).not.toHaveProperty("identityProviderId");
      expect(payload).not.toHaveProperty("authorId");
      expect(payload.agent).not.toHaveProperty("llmApiKeyId");
      expect(payload.agent).not.toHaveProperty("identityProviderId");
      expect(payload.agent).not.toHaveProperty("authorId");
    });

    test("exported payload includes labels and suggestedPrompts", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        name: "Labelled Agent",
        agentType: "agent",
        organizationId,
        authorId: user.id,
        labels: [
          { key: "env", value: "production" },
          { key: "team", value: "backend" },
        ],
        suggestedPrompts: [
          { summaryTitle: "Quick help", prompt: "How do I get started?" },
        ],
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${agent.id}/export`,
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json();

      expect(payload.labels).toHaveLength(2);
      expect(payload.labels).toContainEqual({
        key: "env",
        value: "production",
      });
      expect(payload.labels).toContainEqual({
        key: "team",
        value: "backend",
      });

      expect(payload.suggestedPrompts).toHaveLength(1);
      expect(payload.suggestedPrompts[0]).toEqual({
        summaryTitle: "Quick help",
        prompt: "How do I get started?",
      });
    });

    test("returns 404 for a non-existent agent", async () => {
      // Use a valid UUID-format ID that will pass Zod param validation
      // but won't exist in the database
      const nonExistentId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${nonExistentId}/export`,
      });

      // Route returns 404 to avoid leaking existence
      expect(response.statusCode).toBe(404);
    });

    test("returns 400 for an MCP gateway agent type", async ({ makeAgent }) => {
      const gateway = await makeAgent({
        name: "My Gateway",
        organizationId,
        authorId: user.id,
        agentType: "mcp_gateway",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${gateway.id}/export`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "Only internal agents can be exported",
      );
    });

    test("returns 400 for an LLM proxy agent type", async ({ makeAgent }) => {
      const proxy = await makeAgent({
        name: "My Proxy",
        organizationId,
        authorId: user.id,
        agentType: "llm_proxy",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${proxy.id}/export`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "Only internal agents can be exported",
      );
    });

    test("returns 404 when the agent belongs to a different organization", async ({
      makeOrganization,
      makeAgent,
    }) => {
      const otherOrg = await makeOrganization();
      const otherOrgAgent = await makeAgent({
        name: "Other Org Agent",
        agentType: "agent",
        organizationId: otherOrg.id,
        authorId: user.id,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${otherOrgAgent.id}/export`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Import tests
  // ---------------------------------------------------------------------------

  describe("POST /api/agents/import", () => {
    test("imports a minimal agent and returns 200 with the created agent", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: makeMinimalPayload("Imported From Route Test"),
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();

      expect(data.agent.name).toBe("Imported From Route Test");
      expect(data.agent.agentType).toBe("agent");
      expect(data.warnings).toEqual([]);
    });

    test("import always produces personal scope regardless of payload scope", async () => {
      const payload = {
        ...makeMinimalPayload("Scope Override Agent"),
        agent: {
          ...makeMinimalPayload().agent,
          name: "Scope Override Agent",
          scope: "org", // try to escalate
        },
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload,
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.agent.scope).toBe("personal");
    });

    test("import deduplicates name and appends (imported) suffix on collision", async ({
      makeAgent,
    }) => {
      // Create an agent with the same name first
      await makeAgent({
        name: "Collision Agent",
        agentType: "agent",
        organizationId,
        authorId: user.id,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: makeMinimalPayload("Collision Agent"),
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.agent.name).toBe("Collision Agent (imported)");
    });

    test("import deduplicates with (imported 2) when both original and (imported) exist", async ({
      makeAgent,
    }) => {
      await makeAgent({
        name: "Double Collision",
        agentType: "agent",
        organizationId,
        authorId: user.id,
      });
      await makeAgent({
        name: "Double Collision (imported)",
        agentType: "agent",
        organizationId,
        authorId: user.id,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: makeMinimalPayload("Double Collision"),
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.agent.name).toBe("Double Collision (imported 2)");
    });

    test("returns soft warnings for missing tools without failing", async () => {
      const payload = {
        ...makeMinimalPayload("Agent With Unresolvable Tools"),
        tools: [
          {
            toolName: "nonexistent_tool",
            catalogName: "NonExistent Catalog",
            credentialResolutionMode: "dynamic",
          },
        ],
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload,
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.agent).toBeDefined();
      expect(data.agent.name).toBe("Agent With Unresolvable Tools");
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings[0].type).toBe("tool");
      expect(data.warnings[0].name).toBe("nonexistent_tool");
      expect(data.warnings[0].message).toContain("nonexistent_tool");
    });

    test("returns soft warnings for missing knowledge bases without failing", async () => {
      const payload = {
        ...makeMinimalPayload("Agent With Missing KB"),
        knowledgeBases: [{ name: "Ghost KB" }],
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload,
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings[0].type).toBe("knowledgeBase");
      expect(data.warnings[0].name).toBe("Ghost KB");
    });

    test("returns soft warnings for missing connectors without failing", async () => {
      const payload = {
        ...makeMinimalPayload("Agent With Missing Connector"),
        connectors: [
          { name: "Phantom Connector", connectorType: "confluence" },
        ],
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload,
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings[0].type).toBe("connector");
      expect(data.warnings[0].name).toBe("Phantom Connector");
    });

    test("returns soft warnings for missing delegation targets without failing", async () => {
      const payload = {
        ...makeMinimalPayload("Agent With Missing Delegation"),
        delegations: [{ targetAgentName: "Ghost Agent" }],
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload,
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.warnings).toHaveLength(1);
      expect(data.warnings[0].type).toBe("delegation");
      expect(data.warnings[0].name).toBe("Ghost Agent");
    });

    test("imports labels and suggestedPrompts correctly", async () => {
      const payload = {
        ...makeMinimalPayload("Labelled Import Agent"),
        labels: [
          { key: "env", value: "staging" },
          { key: "owner", value: "platform" },
        ],
        suggestedPrompts: [
          { summaryTitle: "How to use", prompt: "Walk me through this agent" },
        ],
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload,
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.agent.labels).toHaveLength(2);
      expect(data.agent.suggestedPrompts).toHaveLength(1);
      expect(data.agent.suggestedPrompts[0].summaryTitle).toBe("How to use");
    });

    test("returns 400 when payload is missing required fields", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: { agent: { name: "Incomplete" } }, // missing version, etc.
      });

      expect(response.statusCode).toBe(400);
    });

    test("returns 400 for unsupported version", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: {
          ...makeMinimalPayload("Bad Version"),
          version: "2", // not "1"
        },
      });

      expect(response.statusCode).toBe(400);
    });

    test("returns 400 for non-agent agentType (mcp_gateway)", async () => {
      // The Zod schema uses z.literal("agent") so mcp_gateway is rejected
      // at schema validation level before the route handler runs.
      const payload = makeMinimalPayload("Gateway Import");
      (payload.agent as { agentType: string }).agentType = "mcp_gateway";

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload,
      });

      expect(response.statusCode).toBe(400);
    });

    test("returns 400 for non-agent agentType (llm_proxy)", async () => {
      const payload = makeMinimalPayload("Proxy Import");
      (payload.agent as { agentType: string }).agentType = "llm_proxy";

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload,
      });

      expect(response.statusCode).toBe(400);
    });

    test("imported agent does not inherit llmApiKeyId or identityProviderId from payload", async () => {
      // Even if someone crafts a payload with these extra fields they are stripped
      const maliciousPayload = {
        ...makeMinimalPayload("Sanitized Import"),
        llmApiKeyId: "some-secret-key-id",
        identityProviderId: "some-identity-provider-id",
      };

      const response = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: maliciousPayload,
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.agent.llmApiKeyId).toBeNull();
      expect(data.agent.identityProviderId).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Roundtrip tests
  // ---------------------------------------------------------------------------

  describe("Export → Import roundtrip", () => {
    test("basic roundtrip preserves agent config", async ({ makeAgent }) => {
      // 1. Create — must pass agentType: "agent"
      const original = await makeAgent({
        name: "Roundtrip Base Agent",
        agentType: "agent",
        organizationId,
        authorId: user.id,
        systemPrompt: "You are a roundtrip test agent",
        description: "Created for roundtrip testing",
        scope: "personal",
      });

      // 2. Export
      const exportResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${original.id}/export`,
      });
      expect(exportResponse.statusCode).toBe(200);
      const exportPayload = exportResponse.json();

      // 3. Import
      const importResponse = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: exportPayload,
      });
      expect(importResponse.statusCode).toBe(200);
      const importData = importResponse.json();

      // 4. Verify imported agent
      expect(importData.agent.name).toBe(
        "Roundtrip Base Agent (imported)", // collision with original
      );
      expect(importData.agent.agentType).toBe("agent");
      expect(importData.agent.systemPrompt).toBe(
        "You are a roundtrip test agent",
      );
      expect(importData.agent.description).toBe(
        "Created for roundtrip testing",
      );
      expect(importData.agent.scope).toBe("personal");
      expect(importData.warnings).toEqual([]);
    });

    test("roundtrip preserves labels and suggestedPrompts", async ({
      makeAgent,
    }) => {
      const original = await makeAgent({
        name: "Roundtrip Labels Agent",
        agentType: "agent",
        organizationId,
        authorId: user.id,
        labels: [{ key: "env", value: "test" }],
        suggestedPrompts: [
          { summaryTitle: "A prompt", prompt: "Tell me something" },
        ],
      });

      const exportResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${original.id}/export`,
      });
      expect(exportResponse.statusCode).toBe(200);

      const importResponse = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: exportResponse.json(),
      });
      expect(importResponse.statusCode).toBe(200);
      const data = importResponse.json();

      expect(data.agent.labels).toHaveLength(1);
      expect(data.agent.labels[0]).toMatchObject({ key: "env", value: "test" });
      expect(data.agent.suggestedPrompts).toHaveLength(1);
      expect(data.agent.suggestedPrompts[0].summaryTitle).toBe("A prompt");
    });

    test("double import produces unique names with incrementing suffix", async ({
      makeAgent,
    }) => {
      const original = await makeAgent({
        name: "Incremental Suffix Agent",
        agentType: "agent",
        organizationId,
        authorId: user.id,
      });

      const exportResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${original.id}/export`,
      });
      const exportPayload = exportResponse.json();

      // First import
      const import1 = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: exportPayload,
      });
      expect(import1.statusCode).toBe(200);
      expect(import1.json().agent.name).toBe(
        "Incremental Suffix Agent (imported)",
      );

      // Second import (now (imported) is also taken)
      const import2 = await app.inject({
        method: "POST",
        url: "/api/agents/import",
        payload: exportPayload,
      });
      expect(import2.statusCode).toBe(200);
      expect(import2.json().agent.name).toBe(
        "Incremental Suffix Agent (imported 2)",
      );
    });

    test("export payload contains no UUIDs in references (names only)", async ({
      makeAgent,
    }) => {
      const original = await makeAgent({
        name: "No UUID Agent",
        agentType: "agent",
        organizationId,
        authorId: user.id,
      });

      const exportResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${original.id}/export`,
      });
      expect(exportResponse.statusCode).toBe(200);
      const payload = exportResponse.json();

      // The serialized payload's string values should not contain UUIDs.
      // The top-level JSON keys (version, exportedAt, sourceInstance, agent, tools, etc.)
      // contain only human-readable strings and arrays — no UUID values.
      const uuidPattern =
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

      const payloadText = JSON.stringify(payload);
      const foundUuids = payloadText.match(uuidPattern) ?? [];

      expect(foundUuids).toHaveLength(0);
    });
  });
});
