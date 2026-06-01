import { describe, expect } from "vitest";
import { InternalMcpCatalogModel, OrganizationModel } from "@/models";
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
        allowedHttpMethods: "read_only",
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
      data: { name: "Dependency installs", allowedHttpMethods: "all" },
    });
    expect(updated.name).toBe("Dependency installs");
    expect(updated.allowedHttpMethods).toBe("all");

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

  test("resolveEffectiveNetworkPolicy prefers installation, then catalog, then environment, then default", async ({
    makeMcpServer,
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const defaultPolicy = await createNetworkPolicy({
      organizationId: org.id,
      data: { name: "Default" },
    });
    const envPolicy = await createNetworkPolicy({
      organizationId: org.id,
      data: { name: "Environment" },
    });
    const catalogPolicy = await createNetworkPolicy({
      organizationId: org.id,
      data: { name: "Catalog" },
    });
    const installPolicy = await createNetworkPolicy({
      organizationId: org.id,
      data: { name: "Install" },
    });

    await OrganizationModel.patch(org.id, {
      defaultNetworkPolicyId: defaultPolicy.id,
    });
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod", networkPolicyId: envPolicy.id },
    });
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: "resolved-catalog",
        serverType: "remote",
        serverUrl: "https://api.example.com/mcp/",
        scope: "org",
        environmentId: env.id,
        networkPolicyId: catalogPolicy.id,
      },
      { organizationId: org.id, authorId: user.id },
    );
    const install = await makeMcpServer({
      catalogId: catalog.id,
      networkPolicyId: installPolicy.id,
    });

    await expect(
      resolveEffectiveNetworkPolicy({
        organizationId: org.id,
        installationNetworkPolicyId: install.networkPolicyId,
        catalogNetworkPolicyId: catalog.networkPolicyId,
        environmentId: catalog.environmentId,
        defaultNetworkPolicyId: defaultPolicy.id,
      }),
    ).resolves.toMatchObject({
      source: "installation",
      policy: { id: installPolicy.id },
    });

    await expect(
      resolveEffectiveNetworkPolicy({
        organizationId: org.id,
        catalogNetworkPolicyId: catalog.networkPolicyId,
        environmentId: catalog.environmentId,
        defaultNetworkPolicyId: defaultPolicy.id,
      }),
    ).resolves.toMatchObject({
      source: "catalog",
      policy: { id: catalogPolicy.id },
    });

    await expect(
      resolveEffectiveNetworkPolicy({
        organizationId: org.id,
        environmentId: catalog.environmentId,
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
        installationNetworkPolicyId: MISSING_ID,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
