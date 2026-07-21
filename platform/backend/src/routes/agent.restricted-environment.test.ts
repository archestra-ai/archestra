import { type Mock, vi } from "vitest";
import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * Binding an agent to a *restricted* environment routes its code sandbox to
 * that environment's isolated runtime, so the agent create/update routes must
 * gate it on the resource-specific deploy-to-restricted permission for the
 * agent's type — agent, mcpGateway, or llmProxy — exactly like the
 * MCP-catalog assignment path — see
 * internal-mcp-catalog.restricted-environment.test.ts.
 *
 * `@/auth` is fully mocked so the agent-type permission stack always grants
 * (isolating the environment gate). `userHasPermission` grants everything
 * except `deploy-to-restricted` actions, which are controlled per test via
 * `deployGrants` (a set of resources).
 */
vi.mock("@/auth");
// The create route records agent metrics on success; the real registry rejects
// exemplars under the test env, which is noise for this permission gate.
vi.mock("@/observability");

import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeReadPermission,
  requireAgentModifyPermission,
  userHasPermission,
} from "@/auth";
import { createEnvironment } from "@/services/environments/environment";

const mockUserHasPermission = userHasPermission as Mock;

describe("Agent routes - restricted environment assignment guard", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let deployGrants: Set<string>;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    (getAgentTypePermissionChecker as Mock).mockImplementation(async () => ({
      require: vi.fn(),
      isAdmin: vi.fn(() => true),
      isTeamAdmin: vi.fn(() => true),
      getAgentTypesWithPermission: vi.fn(() => [
        "agent",
        "mcp_gateway",
        "llm_proxy",
      ]),
    }));
    (hasAnyAgentTypeReadPermission as Mock).mockResolvedValue(true);
    (requireAgentModifyPermission as Mock).mockImplementation(() => {});

    deployGrants = new Set();
    mockUserHasPermission.mockImplementation(
      async (
        _userId: string,
        _orgId: string,
        resource: string,
        action: string,
      ) => {
        if (action === "deploy-to-restricted")
          return deployGrants.has(resource);
        return true;
      },
    );

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./agent");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function makeOrgAgent() {
    // agentType is explicit: the DB default is "mcp_gateway", and these tests
    // pin the *agent* resource gate.
    return AgentModel.create(
      {
        name: `env-guard-${crypto.randomUUID().slice(0, 8)}`,
        organizationId,
        agentType: "agent",
        scope: "org",
        teams: [],
        labels: [],
        knowledgeBaseIds: [],
        connectorIds: [],
      },
      user.id,
    );
  }

  async function makeRestrictedEnvironment() {
    return createEnvironment({
      organizationId,
      data: {
        name: `Prod-${crypto.randomUUID().slice(0, 8)}`,
        restricted: true,
      },
    });
  }

  test("updating to a RESTRICTED env without deploy-to-restricted is 403 and unchanged", async () => {
    const restricted = await makeRestrictedEnvironment();
    const agent = await makeOrgAgent();

    const res = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { environmentId: restricted.id },
    });

    expect(res.statusCode).toBe(403);
    const after = await AgentModel.findById(agent.id, user.id, true);
    expect(after?.environmentId ?? null).toBeNull();
  });

  test("updating to a RESTRICTED env WITH agent:deploy-to-restricted persists (200)", async () => {
    deployGrants = new Set(["agent"]);
    const restricted = await makeRestrictedEnvironment();
    const agent = await makeOrgAgent();

    const res = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { environmentId: restricted.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().environmentId).toBe(restricted.id);
  });

  test("a deploy-to-restricted grant on a DIFFERENT resource does not unlock agents (403)", async () => {
    deployGrants = new Set(["mcpRegistry", "mcpGateway", "llmProxy"]);
    const restricted = await makeRestrictedEnvironment();
    const agent = await makeOrgAgent();

    const res = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { environmentId: restricted.id },
    });

    expect(res.statusCode).toBe(403);
  });

  test("updating to an UNRESTRICTED env without deploy-to-restricted succeeds (200)", async () => {
    const open = await createEnvironment({
      organizationId,
      data: { name: "Staging", restricted: false },
    });
    const agent = await makeOrgAgent();

    const res = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { environmentId: open.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().environmentId).toBe(open.id);
  });

  test("creating an MCP gateway in a RESTRICTED env is gated by mcpGateway, not agent (403 → 200)", async () => {
    deployGrants = new Set(["agent"]);
    const restricted = await makeRestrictedEnvironment();

    const payload = {
      name: `gw-${crypto.randomUUID().slice(0, 8)}`,
      agentType: "mcp_gateway",
      scope: "personal",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      environmentId: restricted.id,
    };

    const denied = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload,
    });
    expect(denied.statusCode).toBe(403);

    deployGrants = new Set(["mcpGateway"]);
    const granted = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { ...payload, name: `gw-${crypto.randomUUID().slice(0, 8)}` },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().environmentId).toBe(restricted.id);
  });

  test("creating an LLM proxy in a RESTRICTED env is gated by llmProxy (403 → 200)", async () => {
    deployGrants = new Set(["agent", "mcpGateway"]);
    const restricted = await makeRestrictedEnvironment();

    const payload = {
      name: `proxy-${crypto.randomUUID().slice(0, 8)}`,
      agentType: "llm_proxy",
      scope: "personal",
      teams: [],
      labels: [],
      knowledgeBaseIds: [],
      connectorIds: [],
      environmentId: restricted.id,
    };

    const denied = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload,
    });
    expect(denied.statusCode).toBe(403);

    deployGrants = new Set(["llmProxy"]);
    const granted = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { ...payload, name: `proxy-${crypto.randomUUID().slice(0, 8)}` },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().environmentId).toBe(restricted.id);
  });
});
