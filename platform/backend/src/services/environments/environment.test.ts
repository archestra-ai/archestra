import { describe, expect } from "vitest";
import { OrganizationModel } from "@/models";
import {
  assertCanAssignEnvironment,
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
    const prod = listed.find((e) => e.id === created.id);
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
        hasEnvironmentAdmin: false,
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
        hasEnvironmentAdmin: false,
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
        hasEnvironmentAdmin: true,
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
        hasEnvironmentAdmin: false,
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
        hasEnvironmentAdmin: false,
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
        hasEnvironmentAdmin: true,
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
        hasEnvironmentAdmin: true,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
