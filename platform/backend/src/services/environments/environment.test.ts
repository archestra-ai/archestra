import {
  BUILT_IN_AGENT_IDS,
  BUILT_IN_AGENT_NAMES,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@archestra/shared";
import { describe, expect, vi } from "vitest";
import { syncBuiltInAgents } from "@/database/seed";
import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import {
  AgentModel,
  EnvironmentModel,
  InternalMcpCatalogModel,
  OrganizationModel,
  PlaywrightRuntimeModel,
} from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import {
  assertCanAssignEnvironment,
  assertValuesMatchEnvironmentRegex,
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  updateEnvironment,
} from "@/services/environments/environment";
import { test } from "@/test";
import {
  createRestrictedEnvironment,
  grantEnvironmentUse,
} from "@/test/environments";

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

/** These cases assert listing shape, not deploy authority. */
const LISTER_ID = "00000000-0000-0000-0000-0000000000ff";

describe("EnvironmentService", () => {
  test("createEnvironment rejects duplicate names with 409", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await createEnvironment({ organizationId: org.id, data: { name: "Prod" } });
    await expect(
      createEnvironment({ organizationId: org.id, data: { name: "Prod" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("environment create and delete leave the org-wide advisor alone", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await syncBuiltInAgents();
    const before = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.ADVISOR,
      org.id,
    );
    expect(before?.name).toBe(BUILT_IN_AGENT_NAMES.ADVISOR);
    expect(before?.environmentId).toBeNull();

    const created = await createEnvironment({
      organizationId: org.id,
      data: { name: "Staging" },
    });
    await deleteEnvironment({ id: created.id, organizationId: org.id });

    // The advisor is org-wide, so neither hook touches it.
    const after = await AgentModel.getBuiltInAgent(
      BUILT_IN_AGENT_IDS.ADVISOR,
      org.id,
    );
    expect(after?.id).toBe(before?.id);
    expect(after?.environmentId).toBeNull();
  });

  test("listEnvironments reports the default (no-environment) assigned count, excluding built-ins and env-assigned items", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const createItem = (
      name: string,
      environmentId: string | null,
      serverType: "remote" | "builtin" = "remote",
    ) =>
      InternalMcpCatalogModel.create(
        {
          name,
          serverType,
          serverUrl: "https://api.example.com/mcp/",
          scope: "org",
          environmentId,
        },
        { organizationId: org.id, authorId: user.id },
      );

    await createItem("no-env-1", null);
    await createItem("no-env-2", null);
    await createItem("builtin-no-env", null, "builtin"); // excluded
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod" },
    });
    await createItem("in-env", env.id); // excluded — assigned to an environment

    const listed = await listEnvironments({
      organizationId: org.id,
      userId: LISTER_ID,
    });
    expect(listed.defaultAssignedCatalogCount).toBe(2);
  });

  test("updateEnvironment throws 404 for unknown id", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await expect(
      updateEnvironment({
        id: MISSING_ID,
        organizationId: org.id,
        data: { namespace: "x" },
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("deleteEnvironment throws 404 for unknown id", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await expect(
      deleteEnvironment({ id: MISSING_ID, organizationId: org.id }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("deleteEnvironment rejects with 409 when catalog items are still assigned", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod" },
    });
    await InternalMcpCatalogModel.create(
      {
        name: "assigned-item",
        serverType: "remote",
        serverUrl: "https://api.example.com/mcp/",
        scope: "org",
        environmentId: env.id,
      },
      { organizationId: org.id, authorId: user.id },
    );

    await expect(
      deleteEnvironment({ id: env.id, organizationId: org.id }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // Still present after the blocked delete.
    const listed = await listEnvironments({
      organizationId: org.id,
      userId: LISTER_ID,
    });
    expect(listed.environments.some((e) => e.id === env.id)).toBe(true);
  });

  test("deleteEnvironment succeeds when no catalog items are assigned", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Sandbox" },
    });
    await expect(
      deleteEnvironment({ id: env.id, organizationId: org.id }),
    ).resolves.toBeUndefined();
    const listed = await listEnvironments({
      organizationId: org.id,
      userId: LISTER_ID,
    });
    expect(listed.environments.some((e) => e.id === env.id)).toBe(false);
  });

  test("deleteEnvironment removes its managed Playwright runtime without treating it as an assignment", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Browser environment",
    });
    await makeInternalMcpCatalog({
      id: PLAYWRIGHT_MCP_CATALOG_ID,
      organizationId: null,
      name: "microsoft__playwright-mcp",
      serverType: "local",
      localConfig: {
        command: "node",
        transportType: "streamable-http",
        httpPort: 8080,
      },
    });
    await PlaywrightRuntimeModel.reconcileAll();
    expect(
      await PlaywrightRuntimeModel.findForEnvironment(env.id),
    ).not.toBeNull();

    await expect(
      deleteEnvironment({ id: env.id, organizationId: org.id }),
    ).resolves.toBeUndefined();

    expect(await PlaywrightRuntimeModel.findForEnvironment(env.id)).toBeNull();
    expect(await EnvironmentModel.findById(env.id)).toBeNull();
  });

  test("deleteEnvironment tears down the environment's engine on success, not on a rejected delete", async ({
    makeOrganization,
  }) => {
    const teardown = vi
      .spyOn(daggerEnvironmentRuntimeManager, "teardownEnvironmentEngine")
      .mockResolvedValue();
    try {
      const org = await makeOrganization();
      const env = await createEnvironment({
        organizationId: org.id,
        data: { name: "Sandbox" },
      });

      await deleteEnvironment({ id: env.id, organizationId: org.id });
      expect(teardown).toHaveBeenCalledWith(
        expect.objectContaining({ id: env.id }),
      );

      // A rejected delete must not tear down anything.
      teardown.mockClear();
      await expect(
        deleteEnvironment({ id: MISSING_ID, organizationId: org.id }),
      ).rejects.toThrow();
      expect(teardown).not.toHaveBeenCalled();
    } finally {
      teardown.mockRestore();
    }
  });

  test("a new environment is open to every member, and restricting it keeps its creator", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const creator = await makeUser();
    await makeMember(creator.id, org.id, { role: "admin" });
    const member = await makeUser();
    await makeMember(member.id, org.id);
    const open = await createEnvironment({
      organizationId: org.id,
      userId: creator.id,
      data: { name: "Sandbox" },
    });
    const locked = await createRestrictedEnvironment({
      organizationId: org.id,
      userId: creator.id,
      data: { name: "Prod" },
    });

    const listed = await listEnvironments({
      organizationId: org.id,
      userId: member.id,
    });
    const canDeploy = (id: string) =>
      listed.environments.find((e) => e.id === id)?.canDeploy;
    expect(canDeploy(open.id)).toBe(true);
    expect(canDeploy(locked.id)).toBe(false);
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId: org.id,
      resource: "environment",
      scope: locked.id,
    });
    expect(policy?.grants).toEqual([
      expect.objectContaining({ subject: { type: "user", id: creator.id } }),
    ]);
  });

  /**
   * Deploying into a restricted environment is now `use` on that environment,
   * so these ask the question of two real members: one whose role carries the
   * grant and one whose role does not. The pair is what the retired
   * `deploy-to-restricted` action used to decide.
   */
  test("assertCanAssignEnvironment allows the default (null) environment to any member", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id);
    await expect(
      assertCanAssignEnvironment({
        environmentId: null,
        organizationId: org.id,
        userId: member.id,
      }),
    ).resolves.toBeUndefined();
  });

  test("assertCanAssignEnvironment allows an unrestricted environment without any grant", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Sandbox" },
    });
    const member = await makeUser();
    await makeMember(member.id, org.id);
    await expect(
      assertCanAssignEnvironment({
        environmentId: env.id,
        organizationId: org.id,
        userId: member.id,
      }),
    ).resolves.toBeUndefined();
  });

  test("assertCanAssignEnvironment rejects a restricted environment without a grant on it (403)", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const env = await createRestrictedEnvironment({
      organizationId: org.id,
      data: { name: "Prod" },
    });
    const member = await makeUser();
    await makeMember(member.id, org.id);
    await expect(
      assertCanAssignEnvironment({
        environmentId: env.id,
        organizationId: org.id,
        userId: member.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("assertCanAssignEnvironment allows a restricted environment with a wildcard grant", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const env = await createRestrictedEnvironment({
      organizationId: org.id,
      data: { name: "Prod" },
    });
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    await expect(
      assertCanAssignEnvironment({
        environmentId: env.id,
        organizationId: org.id,
        userId: admin.id,
      }),
    ).resolves.toBeUndefined();
  });

  /**
   * Every custom role holds `environment:read`. Deploying is `use`, and only
   * a stored grant confers it, so reading environments must never be taken
   * as licence to deploy into a restricted one.
   */
  test("a custom role holding only environment:read cannot use a restricted environment", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const env = await createRestrictedEnvironment({
      organizationId: org.id,
      data: { name: "Prod" },
    });
    const role = await makeCustomRole(org.id, {
      permission: { environment: ["read"] },
    });
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: role.role });
    await expect(
      assertCanAssignEnvironment({
        environmentId: env.id,
        organizationId: org.id,
        userId: member.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  /**
   * The axis the retired action could not express: authority over ONE
   * restricted environment, and not over its neighbour.
   */
  test("a grant on one restricted environment does not unlock another", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const granted = await createRestrictedEnvironment({
      organizationId: org.id,
      data: { name: "Prod EU" },
    });
    const other = await createRestrictedEnvironment({
      organizationId: org.id,
      data: { name: "Prod US" },
    });
    const member = await makeUser();
    await makeMember(member.id, org.id);
    await grantEnvironmentUse({
      organizationId: org.id,
      environmentId: granted.id,
      userId: member.id,
    });
    await expect(
      assertCanAssignEnvironment({
        environmentId: granted.id,
        organizationId: org.id,
        userId: member.id,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCanAssignEnvironment({
        environmentId: other.id,
        organizationId: org.id,
        userId: member.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("assertCanAssignEnvironment throws 404 for an unknown environment", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    await expect(
      assertCanAssignEnvironment({
        environmentId: MISSING_ID,
        organizationId: org.id,
        userId: admin.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

const BLOCK_PROD = "^(?!.*(prod|production)).*$";

describe("Environment validation regex", () => {
  test("assertValuesMatchEnvironmentRegex names the environment in the rejection", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "staging", validationRegex: BLOCK_PROD },
    });
    await expect(
      assertValuesMatchEnvironmentRegex({
        environmentId: env.id,
        organizationId: org.id,
        valueSets: [{ host: "prod-host" }],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('"staging"'),
    });
  });

  test("assertValuesMatchEnvironmentRegex allows values that match the rule", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "staging", validationRegex: BLOCK_PROD },
    });
    await expect(
      assertValuesMatchEnvironmentRegex({
        environmentId: env.id,
        organizationId: org.id,
        valueSets: [{ host: "staging-host" }, { region: "eu" }],
      }),
    ).resolves.toBeUndefined();
  });

  test("assertValuesMatchEnvironmentRegex rejects a forbidden value across any value set with 400", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "staging", validationRegex: BLOCK_PROD },
    });
    await expect(
      assertValuesMatchEnvironmentRegex({
        environmentId: env.id,
        organizationId: org.id,
        valueSets: [{ host: "ok-host" }, { DB: "my-prod-db" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("assertValuesMatchEnvironmentRegex is a no-op when the environment has no rule", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "open" },
    });
    await expect(
      assertValuesMatchEnvironmentRegex({
        environmentId: env.id,
        organizationId: org.id,
        valueSets: [{ host: "anything-prod" }],
      }),
    ).resolves.toBeUndefined();
  });

  test("assertValuesMatchEnvironmentRegex enforces the org default rule for a null environment", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentValidationRegex: BLOCK_PROD,
    });
    await expect(
      assertValuesMatchEnvironmentRegex({
        environmentId: null,
        organizationId: org.id,
        valueSets: [{ host: "prod-host" }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
