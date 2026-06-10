import { describe, expect } from "vitest";
import { GithubAppConfigModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { test } from "@/test";
import type { ConnectorConfig } from "@/types";
import { resolveConnectorCredentials } from "./connector-credentials";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----";

describe("resolveConnectorCredentials", () => {
  test("resolves GitHub App connectors from the referenced config", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secret = await secretManager().createSecret(
      { apiToken: PEM },
      "app-secret",
    );
    const appConfig = await GithubAppConfigModel.create({
      organizationId: org.id,
      name: "App",
      githubUrl: "https://api.github.com",
      appId: "12345",
      installationId: "67890",
      secretId: secret.id,
    });

    const config: ConnectorConfig = {
      type: "github",
      githubUrl: "https://api.github.com",
      owner: "test-org",
      authMethod: "github_app",
      githubAppConfigId: appConfig.id,
    };

    const credentials = await resolveConnectorCredentials({
      config,
      organizationId: org.id,
      secretId: null,
    });

    expect(credentials.apiToken).toBe(PEM);
    expect(credentials.githubApp).toEqual({
      githubUrl: "https://api.github.com",
      appId: "12345",
      installationId: "67890",
    });
  });

  test("resolves non-App connectors from their own secret", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secret = await secretManager().createSecret(
      { apiToken: "ghp_token" },
      "pat-secret",
    );

    const config: ConnectorConfig = {
      type: "github",
      githubUrl: "https://api.github.com",
      owner: "test-org",
      authMethod: "pat",
    };

    const credentials = await resolveConnectorCredentials({
      config,
      organizationId: org.id,
      secretId: secret.id,
    });

    expect(credentials.apiToken).toBe("ghp_token");
    expect(credentials.githubApp).toBeUndefined();
  });

  test("throws when the referenced App config is missing", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const config: ConnectorConfig = {
      type: "github",
      githubUrl: "https://api.github.com",
      owner: "test-org",
      authMethod: "github_app",
      githubAppConfigId: "00000000-0000-0000-0000-000000000000",
    };

    await expect(
      resolveConnectorCredentials({
        config,
        organizationId: org.id,
        secretId: null,
      }),
    ).rejects.toThrow("GitHub App configuration not found");
  });
});
