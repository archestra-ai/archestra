import IdentityProviderModel from "@/models/identity-provider.ee";
import { describe, expect, test } from "@/test";

describe("IdentityProviderModel.findByIdForAudit — redaction (EE)", () => {
  test("never exposes oidcConfig, samlConfig, roleMapping, or teamSyncConfig", async ({
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const org = await makeOrganization();
    const provider = await makeIdentityProvider(org.id, {
      oidcConfig: {
        clientId: "client-123",
        clientSecret: "super-secret-client-secret",
        scopes: ["openid", "email"],
      },
      samlConfig: {
        x509Certificate:
          "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
      },
      roleMapping: { rules: [] },
    });

    const snapshot = await IdentityProviderModel.findByIdForAudit(
      provider.id,
      org.id,
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot).not.toHaveProperty("oidcConfig");
    expect(snapshot).not.toHaveProperty("samlConfig");
    expect(snapshot).not.toHaveProperty("roleMapping");
    expect(snapshot).not.toHaveProperty("teamSyncConfig");
    expect(JSON.stringify(snapshot)).not.toContain(
      "super-secret-client-secret",
    );
    expect(JSON.stringify(snapshot)).not.toContain("BEGIN CERTIFICATE");
    expect(snapshot).toHaveProperty("id", provider.id);
    expect(snapshot).toHaveProperty("organizationId", org.id);
    expect(snapshot).toHaveProperty("providerId");
    expect(snapshot).toHaveProperty("domain");
    expect(snapshot).toHaveProperty("ssoLoginEnabled");
  });

  test("returns null for wrong organization", async ({
    makeOrganization,
    makeIdentityProvider,
  }) => {
    const org1 = await makeOrganization();
    const org2 = await makeOrganization();
    const provider = await makeIdentityProvider(org1.id);

    const snapshot = await IdentityProviderModel.findByIdForAudit(
      provider.id,
      org2.id,
    );

    expect(snapshot).toBeNull();
  });
});
