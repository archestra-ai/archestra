import { describe, expect } from "vitest";
import { OrganizationModel } from "@/models";
import {
  createEnvironment,
  updateEnvironment,
} from "@/services/environments/environment";
import {
  createNetworkPolicy,
  deleteNetworkPolicy,
  listNetworkPolicies,
  resolveEffectiveNetworkPolicy,
  updateNetworkPolicy,
} from "@/services/environments/network-policy";
import { test } from "@/test";

const MISSING_ID = "00000000-0000-0000-0000-000000000000";

describe("NetworkPolicyService", () => {
  test("creates, lists, and updates a network policy", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const created = await createNetworkPolicy({
      organizationId: org.id,
      data: {
        name: "Package installs",
        egressMode: "restricted",
        domainPreset: "package_managers",
        allowedDomains: ["api.example.com", "*.example.org"],
      },
    });

    expect(created.name).toBe("Package installs");
    expect(created.allowedDomains).toEqual([
      "api.example.com",
      "*.example.org",
    ]);

    const updated = await updateNetworkPolicy({
      id: created.id,
      organizationId: org.id,
      data: { name: "Dependency installs" },
    });
    expect(updated.name).toBe("Dependency installs");

    const listed = await listNetworkPolicies(org.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.references.environments).toBe(0);
  });

  test("rejects duplicate policy names within an organization", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await createNetworkPolicy({ organizationId: org.id, data: { name: "A" } });

    await expect(
      createNetworkPolicy({ organizationId: org.id, data: { name: "A" } }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("delete rejects a referenced policy", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const policy = await createNetworkPolicy({
      organizationId: org.id,
      data: { name: "Sandbox egress" },
    });
    await createEnvironment({
      organizationId: org.id,
      data: { name: "Sandbox", networkPolicyId: policy.id },
    });

    await expect(
      deleteNetworkPolicy({ id: policy.id, organizationId: org.id }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("delete succeeds after references are cleared", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const policy = await createNetworkPolicy({
      organizationId: org.id,
      data: { name: "Sandbox egress" },
    });
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Sandbox", networkPolicyId: policy.id },
    });
    await updateEnvironment({
      id: env.id,
      organizationId: org.id,
      data: { networkPolicyId: null },
    });

    await expect(
      deleteNetworkPolicy({ id: policy.id, organizationId: org.id }),
    ).resolves.toBeUndefined();
  });

  test("resolveEffectiveNetworkPolicy prefers environment, then default", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const defaultPolicy = await createNetworkPolicy({
      organizationId: org.id,
      data: { name: "Default" },
    });
    const envPolicy = await createNetworkPolicy({
      organizationId: org.id,
      data: { name: "Environment" },
    });

    await OrganizationModel.patch(org.id, {
      defaultNetworkPolicyId: defaultPolicy.id,
    });
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod", networkPolicyId: envPolicy.id },
    });

    await expect(
      resolveEffectiveNetworkPolicy({
        organizationId: org.id,
        environmentId: env.id,
        defaultNetworkPolicyId: defaultPolicy.id,
      }),
    ).resolves.toMatchObject({
      source: "environment",
      policy: { id: envPolicy.id },
    });

    await expect(
      resolveEffectiveNetworkPolicy({
        organizationId: org.id,
        defaultNetworkPolicyId: defaultPolicy.id,
      }),
    ).resolves.toMatchObject({
      source: "organization_default",
      policy: { id: defaultPolicy.id },
    });
  });

  test("resolveEffectiveNetworkPolicy returns built-in when no policy applies", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await expect(
      resolveEffectiveNetworkPolicy({ organizationId: org.id }),
    ).resolves.toEqual({ source: "built_in", policy: null });
  });

  test("throws 404 when resolving an unknown policy id", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await expect(
      resolveEffectiveNetworkPolicy({
        organizationId: org.id,
        defaultNetworkPolicyId: MISSING_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
