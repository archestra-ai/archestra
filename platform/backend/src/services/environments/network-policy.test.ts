import { describe, expect } from "vitest";
import { createEnvironment } from "@/services/environments/environment";
import { resolveEffectiveNetworkPolicy } from "@/services/environments/network-policy";
import { test } from "@/test";
import type { NetworkPolicy } from "@/types";

const ENVIRONMENT_POLICY: NetworkPolicy = {
  egressMode: "restricted",
  domainPreset: "package_managers",
  allowedDomains: ["registry.npmjs.org"],
  allowedCidrs: ["203.0.113.0/24"],
};

const DEFAULT_POLICY: NetworkPolicy = {
  egressMode: "off",
  domainPreset: "none",
  allowedDomains: [],
  allowedCidrs: [],
};

describe("NetworkPolicyService", () => {
  test("resolveEffectiveNetworkPolicy prefers environment policy over default policy", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await createEnvironment({
      organizationId: org.id,
      data: { name: "Prod", networkPolicy: ENVIRONMENT_POLICY },
    });

    await expect(
      resolveEffectiveNetworkPolicy({
        organizationId: org.id,
        environmentId: env.id,
        defaultNetworkPolicy: DEFAULT_POLICY,
      }),
    ).resolves.toEqual({
      source: "environment",
      policy: ENVIRONMENT_POLICY,
    });
  });

  test("resolveEffectiveNetworkPolicy uses the organization default when environment has none", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await expect(
      resolveEffectiveNetworkPolicy({
        organizationId: org.id,
        defaultNetworkPolicy: DEFAULT_POLICY,
      }),
    ).resolves.toEqual({
      source: "organization_default",
      policy: DEFAULT_POLICY,
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

  test("resolveEffectiveNetworkPolicy throws when the environment is missing", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await expect(
      resolveEffectiveNetworkPolicy({
        organizationId: org.id,
        environmentId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
