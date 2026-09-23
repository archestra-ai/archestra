import { type Mock, vi } from "vitest";
import { EnvironmentResourceDefaultModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/**
 * POST /api/agents binds a new agent to the org's configured landing
 * environment for that agent's type when the caller does not name one. Agents,
 * MCP gateways, and LLM proxies are configured separately, so a default set for
 * one type must not move the others.
 *
 * Harness mirrors agent.restricted-environment.test.ts: `@/auth` is fully
 * mocked so the agent-type permission stack always grants, and
 * Reaching a restricted environment is a `use` grant on that environment,
 * written per test.
 */
vi.mock("@/auth");
vi.mock("@/observability");

import {
  getAgentTypePermissionChecker,
  hasAnyAgentTypeReadPermission,
  requireAgentModifyPermission,
  userHasPermission,
} from "@/auth";
import { createEnvironment } from "@/services/environments/environment";

const mockUserHasPermission = userHasPermission as Mock;

describe("Agent routes - configured default environment", () => {
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
    // A plain member reaches no environment by role, so the one case that
    // expects the restricted default to apply has to be granted it.
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

  async function createAgent(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/agents",
      payload: {
        name: `default-env-${crypto.randomUUID().slice(0, 8)}`,
        ...payload,
      },
    });
  }

  test("an omitted environment lands in the configured default for the agent's type", async () => {
    const explore = await createEnvironment({
      organizationId,
      data: { name: "Explore" },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "agent",
      environmentId: explore.id,
    });

    const response = await createAgent({ agentType: "agent" });
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(explore.id);
  });

  test("a default set for agents does not move new MCP gateways", async () => {
    const explore = await createEnvironment({
      organizationId,
      data: { name: "Explore" },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "agent",
      environmentId: explore.id,
    });

    const response = await createAgent({ agentType: "mcp_gateway" });
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBeNull();
  });

  test("an explicit null still means the default environment", async () => {
    const explore = await createEnvironment({
      organizationId,
      data: { name: "Explore" },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "agent",
      environmentId: explore.id,
    });

    const response = await createAgent({
      agentType: "agent",
      environmentId: null,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBeNull();
  });

  test("a restricted default the caller may not deploy to falls back rather than failing the create", async () => {
    const locked = await createEnvironment({
      organizationId,
      data: { name: "Locked", restricted: true },
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "agent",
      environmentId: locked.id,
    });

    const response = await createAgent({ agentType: "agent" });
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBeNull();
  });

  test("a restricted default applies for a caller who may deploy there", async () => {
    const locked = await createEnvironment({
      organizationId,
      data: { name: "Locked", restricted: true },
    });
    await ResourcePermissionPolicyModel.replace({
      organizationId,
      resource: "environment",
      scope: locked.id,
      revision: 0,
      grants: [
        { subject: { type: "user", id: user.id }, actions: ["read", "use"] },
      ],
    });
    await EnvironmentResourceDefaultModel.setForResource({
      organizationId,
      resource: "agent",
      environmentId: locked.id,
    });

    const response = await createAgent({ agentType: "agent" });
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(locked.id);
  });
});
