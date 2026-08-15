import { describe, expect } from "vitest";
import { GithubAppConfigModel } from "@/models";
import SecretModel from "@/models/secret";
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

  test("passes the stored admin API key through to runtime credentials", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secret = await secretManager().createSecret(
      {
        email: "user@example.com",
        apiToken: "user-token",
        adminApiKey: "org-admin-key",
      },
      "jira-secret",
    );

    const config: ConnectorConfig = {
      type: "jira",
      jiraBaseUrl: "https://test.atlassian.net",
      isCloud: true,
      projectKey: "TEST",
    };

    const credentials = await resolveConnectorCredentials({
      config,
      organizationId: org.id,
      secretId: secret.id,
    });

    // Dropping this field silently downgrades the admin email resolver to the
    // user API token, which Atlassian's admin APIs reject.
    expect(credentials.adminApiKey).toBe("org-admin-key");
    expect(credentials.apiToken).toBe("user-token");
  });

  test("uncached reads a rotation this process never handled", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const secret = await secretManager().createSecret(
      { apiToken: "t", adminApiKey: "old-password" },
      "perforce-secret",
    );
    const config: ConnectorConfig = {
      type: "perforce",
      serverUrl: "https://perforce.example.com:8080",
      depotPaths: ["//depot/docs"],
      adminUsername: "p4admin",
    };
    const connector = { config, organizationId: org.id, secretId: secret.id };
    await resolveConnectorCredentials(connector);

    // A rotation on another replica: this process's secrets cache still holds
    // the retired password and will for the rest of its TTL.
    await SecretModel.update(secret.id, {
      secret: { apiToken: "t", adminApiKey: "new-password" },
    });

    expect((await resolveConnectorCredentials(connector)).adminApiKey).toBe(
      "old-password",
    );
    // Perforce provisions a pod from this password and rolls that pod when it
    // changes, so the cached read would authenticate the fresh pod with the
    // credential the rotation retired.
    expect(
      (await resolveConnectorCredentials(connector, { uncached: true }))
        .adminApiKey,
    ).toBe("new-password");
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
