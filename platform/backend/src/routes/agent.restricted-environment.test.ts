import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { AgentModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createRestrictedEnvironment,
  grantEnvironmentUse,
} from "@/test/environments";
import type { User } from "@/types";

/**
 * Binding an agent to a *restricted* environment routes its code sandbox to
 * that environment's isolated runtime, so the agent create/update routes gate
 * it on a `use` grant for that environment — exactly like the MCP-catalog
 * assignment path, see internal-mcp-catalog.restricted-environment.test.ts.
 *
 * The axis under test is the environment, not the kind of thing deployed: a
 * grant on one restricted environment must not unlock its neighbour, and the
 * same grant serves an agent and an MCP gateway alike.
 *
 * `@/auth` is fully mocked so the agent-type permission stack always grants,
 * isolating the environment gate.
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

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
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

    mockUserHasPermission.mockResolvedValue(true);

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    // A plain member: no role-level reach into any environment, so every
    // allowed case below has to come from a grant written by the test.
    await makeMember(user.id, organizationId, { role: "member" });

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
    return createRestrictedEnvironment({
      organizationId,
      data: {
        name: `Prod-${crypto.randomUUID().slice(0, 8)}`,
      },
    });
  }

  /** Let this user deploy into exactly one environment. */
  async function grantDeploy(environmentId: string) {
    await grantEnvironmentUse({
      organizationId,
      environmentId: environmentId,
      userId: user.id,
    });
  }

  test("updating to a RESTRICTED env without a grant on it is 403 and unchanged", async () => {
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

  test("updating to a RESTRICTED env WITH a grant on that environment persists (200)", async () => {
    const restricted = await makeRestrictedEnvironment();
    await grantDeploy(restricted.id);
    const agent = await makeOrgAgent();

    const res = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { environmentId: restricted.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().environmentId).toBe(restricted.id);
  });

  test("a grant on a DIFFERENT restricted environment does not unlock this one (403)", async () => {
    const restricted = await makeRestrictedEnvironment();
    const elsewhere = await makeRestrictedEnvironment();
    await grantDeploy(elsewhere.id);
    const agent = await makeOrgAgent();

    const res = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { environmentId: restricted.id },
    });

    expect(res.statusCode).toBe(403);
  });

  test("updating to an UNRESTRICTED env without any grant succeeds (200)", async () => {
    const open = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
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

  test("one environment grant serves an MCP gateway as well as an agent (403 → 200)", async () => {
    const restricted = await makeRestrictedEnvironment();

    const payload = {
      name: `gw-${crypto.randomUUID().slice(0, 8)}`,
      agentType: "mcp_gateway",
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

    await grantDeploy(restricted.id);
    const granted = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { ...payload, name: `gw-${crypto.randomUUID().slice(0, 8)}` },
    });
    expect(granted.statusCode).toBe(200);
    expect(granted.json().environmentId).toBe(restricted.id);
  });
});
