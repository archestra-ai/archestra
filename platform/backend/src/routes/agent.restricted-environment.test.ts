import { type Mock, vi } from "vitest";
import { AgentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * Binding an agent to a *restricted* environment routes its code sandbox to that
 * environment's isolated runtime, so the agent create/update routes must gate it
 * on `environment:deploy-to-restricted` (or `environment:admin`) exactly like the
 * MCP-catalog assignment path — see
 * internal-mcp-catalog.restricted-environment.test.ts.
 *
 * `@/auth` is fully mocked so the agent-type permission stack always grants
 * (isolating the environment gate). Only the `environment` probe of
 * `userHasPermission` varies per test; the route ORs the admin + deploy probes
 * into `canDeployToRestricted` and feeds `assertCanAssignEnvironment`.
 */
vi.mock("@/auth", () => ({
  getAgentTypePermissionChecker: vi.fn(async () => ({
    require: vi.fn(),
    isAdmin: vi.fn(() => true),
    isTeamAdmin: vi.fn(() => true),
    getAgentTypesWithPermission: vi.fn(() => [
      "agent",
      "mcp_gateway",
      "llm_proxy",
    ]),
  })),
  hasAnyAgentTypeReadPermission: vi.fn(async () => true),
  requireAgentModifyPermission: vi.fn(() => {}),
  userHasPermission: vi.fn(),
}));

import { userHasPermission } from "@/auth";
import { createEnvironment } from "@/services/environments/environment";

const mockUserHasPermission = userHasPermission as Mock;

describe("Agent routes - restricted environment assignment guard", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let canDeployToRestricted: boolean;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    canDeployToRestricted = false;
    mockUserHasPermission.mockImplementation(
      async (_userId: string, _orgId: string, resource: string) =>
        resource === "environment" ? canDeployToRestricted : true,
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
    return AgentModel.create(
      {
        name: `env-guard-${crypto.randomUUID().slice(0, 8)}`,
        organizationId,
        scope: "org",
        teams: [],
        labels: [],
        knowledgeBaseIds: [],
        connectorIds: [],
      },
      user.id,
    );
  }

  test("updating to a RESTRICTED env without deploy-to-restricted is 403 and unchanged", async () => {
    canDeployToRestricted = false;
    const restricted = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: true },
    });
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

  test("updating to a RESTRICTED env WITH deploy-to-restricted persists (200)", async () => {
    canDeployToRestricted = true;
    const restricted = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: true },
    });
    const agent = await makeOrgAgent();

    const res = await app.inject({
      method: "PUT",
      url: `/api/agents/${agent.id}`,
      payload: { environmentId: restricted.id },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().environmentId).toBe(restricted.id);
  });

  test("updating to an UNRESTRICTED env without deploy-to-restricted succeeds (200)", async () => {
    canDeployToRestricted = false;
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
});
