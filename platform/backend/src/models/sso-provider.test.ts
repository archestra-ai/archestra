import { describe, expect, test } from "@/test";
import SsoProviderModel from "./sso-provider";

describe("SsoProviderModel", () => {
  test("should find all SSO providers for an organization", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const providers = await SsoProviderModel.findAll(org.id);

    expect(providers).toEqual([]);
  });

  test("should return null when SSO provider not found", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const provider = await SsoProviderModel.findById("non-existent", org.id);

    expect(provider).toBeNull();
  });

  test("should delete SSO provider successfully", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const success = await SsoProviderModel.delete("non-existent", org.id);

    expect(success).toBe(false);
  });
});
