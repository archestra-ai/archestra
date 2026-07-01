import { describe, expect } from "vitest";
import { GithubAppConfigModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { test } from "@/test";

describe("GithubAppConfigModel", () => {
  test("create persists fields and defaults githubUrl", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const config = await GithubAppConfigModel.create({
      organizationId: org.id,
      name: "Primary app",
      appId: "12345",
      installationId: "67890",
    });

    expect(config.name).toBe("Primary app");
    expect(config.appId).toBe("12345");
    expect(config.installationId).toBe("67890");
    expect(config.githubUrl).toBe("https://api.github.com");
    expect(config.secretId).toBeNull();
  });

  test("findByOrganization only returns the org's configs", async ({
    makeOrganization,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    await GithubAppConfigModel.create({
      organizationId: orgA.id,
      name: "A",
      appId: "1",
      installationId: "1",
    });
    await GithubAppConfigModel.create({
      organizationId: orgB.id,
      name: "B",
      appId: "2",
      installationId: "2",
    });

    const listA = await GithubAppConfigModel.findByOrganization(orgA.id);
    expect(listA).toHaveLength(1);
    expect(listA[0].name).toBe("A");
  });

  test("findByIdForOrganization enforces org ownership", async ({
    makeOrganization,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const config = await GithubAppConfigModel.create({
      organizationId: orgA.id,
      name: "A",
      appId: "1",
      installationId: "1",
    });

    const sameOrg = await GithubAppConfigModel.findByIdForOrganization({
      id: config.id,
      organizationId: orgA.id,
    });
    const otherOrg = await GithubAppConfigModel.findByIdForOrganization({
      id: config.id,
      organizationId: orgB.id,
    });

    expect(sameOrg?.id).toBe(config.id);
    expect(otherOrg).toBeNull();
  });

  test("update changes mutable fields", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const config = await GithubAppConfigModel.create({
      organizationId: org.id,
      name: "Old",
      appId: "1",
      installationId: "1",
    });

    const updated = await GithubAppConfigModel.update(config.id, {
      name: "New",
      installationId: "999",
    });

    expect(updated?.name).toBe("New");
    expect(updated?.installationId).toBe("999");
  });

  test("delete removes the config", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const config = await GithubAppConfigModel.create({
      organizationId: org.id,
      name: "Doomed",
      appId: "1",
      installationId: "1",
    });

    expect(await GithubAppConfigModel.delete(config.id)).toBe(true);
    expect(
      await GithubAppConfigModel.findByIdForOrganization({
        id: config.id,
        organizationId: org.id,
      }),
    ).toBeNull();
  });

  test("findByIdForAudit omits the secret handle", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secret = await secretManager().createSecret(
      { apiToken: "pem" },
      "audited-app",
    );
    const config = await GithubAppConfigModel.create({
      organizationId: org.id,
      name: "Audited",
      appId: "1",
      installationId: "1",
      secretId: secret.id,
    });

    const snapshot = await GithubAppConfigModel.findByIdForAudit(
      config.id,
      org.id,
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot).not.toHaveProperty("secretId");
    expect(snapshot?.name).toBe("Audited");
  });
});
