import { BUILT_IN_AGENT_NAMES } from "@archestra/shared";
import { describe, expect, vi } from "vitest";
import { syncBuiltInAgents } from "@/database/seed";
import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import {
  AgentModel,
  InternalMcpCatalogModel,
  OrganizationModel,
} from "@/models";
import {
  assertCanAssignEnvironment,
  assertValuesMatchEnvironmentRegex,
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  updateEnvironment,
} from "@/services/environments/environment";
import { test } from "@/test";

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

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

  test("createEnvironment gives the new environment its own advisor", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const created = await createEnvironment({
      organizationId: org.id,
      data: { name: "Staging" },
    });

    // Delegation never crosses environments, so an agent in Staging can only
    // reach an advisor that lives in Staging.
    const advisor = await AgentModel.getAdvisorForEnvironment({
      organizationId: org.id,
      environmentId: created.id,
    });
    expect(advisor).not.toBeNull();
    expect(advisor?.name).toBe(BUILT_IN_AGENT_NAMES.ADVISOR);
  });

  test("deleteEnvironment retires that environment's advisor with it", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    // Establishes the Default environment's advisor, so the survival assertion
    // below distinguishes a scoped delete from a blanket one.
    await syncBuiltInAgents();
    const created = await createEnvironment({
      organizationId: org.id,
      data: { name: "Staging" },
    });
    const advisor = await AgentModel.getAdvisorForEnvironment({
      organizationId: org.id,
      environmentId: created.id,
    });
    expect(advisor).not.toBeNull();

    await deleteEnvironment({ id: created.id, organizationId: org.id });

    expect(
      await AgentModel.getAdvisorForEnvironment({
        organizationId: org.id,
        environmentId: created.id,
      }),
    ).toBeNull();
    // The Default environment's advisor is a different row and must survive.
    expect(
      await AgentModel.getAdvisorForEnvironment({
        organizationId: org.id,
        environmentId: null,
      }),
    ).not.toBeNull();
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

    const listed = await listEnvironments(org.id);
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
    const listed = await listEnvironments(org.id);
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
    const listed = await listEnvironments(org.id);
    expect(listed.environments.some((e) => e.id === env.id)).toBe(false);
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

  test("createEnvironment persists restricted=true and lists it back", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const created = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod", restricted: true },
    });
    expect(created.restricted).toBe(true);

    const listed = await listEnvironments(org.id);
    const prod = listed.environments.find((e) => e.id === created.id);
    expect(prod?.restricted).toBe(true);
  });

  test("createEnvironment defaults restricted to false", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const created = await createEnvironment({
      organizationId: org.id,
      data: { name: "Sandbox" },
    });
    expect(created.restricted).toBe(false);
  });

  test("updateEnvironment toggles restricted", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const created = await createEnvironment({
      organizationId: org.id,
      data: { name: "Staging" },
    });
    const updated = await updateEnvironment({
      id: created.id,
      organizationId: org.id,
      data: { restricted: true },
    });
    expect(updated.restricted).toBe(true);
  });

  test("assertCanAssignEnvironment allows the default (null) environment when not restricted", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await expect(
      assertCanAssignEnvironment({
        environmentId: null,
        organizationId: org.id,
        canDeployToRestricted: false,
      }),
    ).resolves.toBeUndefined();
  });

  test("assertCanAssignEnvironment rejects the default (null) environment when restricted, without env-admin (403)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentRestricted: true,
    });
    await expect(
      assertCanAssignEnvironment({
        environmentId: null,
        organizationId: org.id,
        canDeployToRestricted: false,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("assertCanAssignEnvironment allows the restricted default (null) environment with env-admin", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentRestricted: true,
    });
    await expect(
      assertCanAssignEnvironment({
        environmentId: null,
        organizationId: org.id,
        canDeployToRestricted: true,
      }),
    ).resolves.toBeUndefined();
  });

  test("assertCanAssignEnvironment allows an unrestricted environment without env-admin", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Sandbox" },
    });
    await expect(
      assertCanAssignEnvironment({
        environmentId: env.id,
        organizationId: org.id,
        canDeployToRestricted: false,
      }),
    ).resolves.toBeUndefined();
  });

  test("assertCanAssignEnvironment rejects a restricted environment without env-admin (403)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod", restricted: true },
    });
    await expect(
      assertCanAssignEnvironment({
        environmentId: env.id,
        organizationId: org.id,
        canDeployToRestricted: false,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("assertCanAssignEnvironment allows a restricted environment with env-admin", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod", restricted: true },
    });
    await expect(
      assertCanAssignEnvironment({
        environmentId: env.id,
        organizationId: org.id,
        canDeployToRestricted: true,
      }),
    ).resolves.toBeUndefined();
  });

  test("assertCanAssignEnvironment throws 404 for an unknown environment", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await expect(
      assertCanAssignEnvironment({
        environmentId: MISSING_ID,
        organizationId: org.id,
        canDeployToRestricted: true,
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
