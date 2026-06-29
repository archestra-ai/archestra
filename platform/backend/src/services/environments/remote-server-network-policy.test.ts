import { EnvironmentModel } from "@/models";
import { describe, expect, test } from "@/test";
import { evaluateRemoteServerUrlAgainstNetworkPolicy } from "./remote-server-network-policy";

describe("evaluateRemoteServerUrlAgainstNetworkPolicy", () => {
  test("allows a host in the environment allowlist and blocks others", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "restricted",
      networkPolicy: {
        egressMode: "restricted",
        domainPreset: "none",
        allowedDomains: ["allowed.example.com"],
        allowedCidrs: [],
      },
    });

    await expect(
      evaluateRemoteServerUrlAgainstNetworkPolicy({
        serverType: "remote",
        serverUrl: "https://allowed.example.com/mcp",
        environmentId: env.id,
        organizationId: org.id,
      }),
    ).resolves.toEqual({ allowed: true });

    const blocked = await evaluateRemoteServerUrlAgainstNetworkPolicy({
      serverType: "remote",
      serverUrl: "https://evil.example.com/mcp",
      environmentId: env.id,
      organizationId: org.id,
    });
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.message).toContain("not permitted");
    }
  });

  test("off mode blocks with an egress-disabled message", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "no-egress",
      networkPolicy: {
        egressMode: "off",
        domainPreset: "none",
        allowedDomains: [],
        allowedCidrs: [],
      },
    });

    const verdict = await evaluateRemoteServerUrlAgainstNetworkPolicy({
      serverType: "remote",
      serverUrl: "https://anything.example.com/mcp",
      environmentId: env.id,
      organizationId: org.id,
    });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.message).toContain("blocks all outbound");
    }
  });

  test("allows self-hosted servers and remote servers with no environment", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    await expect(
      evaluateRemoteServerUrlAgainstNetworkPolicy({
        serverType: "local",
        serverUrl: null,
        environmentId: null,
        organizationId: org.id,
      }),
    ).resolves.toEqual({ allowed: true });

    await expect(
      evaluateRemoteServerUrlAgainstNetworkPolicy({
        serverType: "remote",
        serverUrl: "https://anything.example.com/mcp",
        environmentId: null,
        organizationId: org.id,
      }),
    ).resolves.toEqual({ allowed: true });
  });
});
