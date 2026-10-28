import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { KnowledgeBaseConnectorModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import { secretManager } from "@/secrets-manager";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import type { GithubConfig } from "@/types/knowledge-connector";
import { drainBackgroundWork } from "@/utils/background-work";
import knowledgeBaseRoutes from "./knowledge-base";

describe("PUT /api/connectors/:id GitHub settings compatibility", () => {
  const ctx = useRouteTestApp(async (app) => {
    registerAuditLogHook(app);
    await app.register(knowledgeBaseRoutes);
  });
  const defaults: GithubConfig = {
    type: "github",
    githubUrl: "https://api.github.com",
    owner: "example-org",
    repos: ["repo-a", "repo-b"],
    includeIssues: false,
    includePullRequests: true,
    includeRepositoryFiles: true,
    includePaths: ["docs"],
    labelsToSkip: ["internal"],
  };
  const checkpoint = {
    type: "github" as const,
    lastSyncedAt: "2026-01-15T12:00:00.000Z",
  };

  beforeEach(async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  async function savedConnector(config: GithubConfig) {
    const secret = await secretManager().createSecret(
      { apiToken: "synthetic-local-token" },
      "GitHub compatibility fixture",
    );
    const connector = await KnowledgeBaseConnectorModel.create({
      organizationId: ctx.organizationId,
      name: "Representative legacy GitHub fixture",
      connectorType: "github",
      config,
      secretId: secret.id,
      enabled: false,
    });
    await KnowledgeBaseConnectorModel.update(connector.id, { checkpoint });
    return connector;
  }

  test("unchanged legacy settings preserve checkpoint, identity and credentials", async () => {
    const connector = await savedConnector(defaults);
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: {
        name: "Renamed representative legacy fixture",
        config: defaults,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(saved?.checkpoint).toEqual(checkpoint);
    expect(saved?.id).toBe(connector.id);
    expect(saved?.secretId).toBe(connector.secretId);
    expect(saved?.config).toEqual(defaults);
  });

  test("a legacy full-config writer cannot erase repository overrides", async () => {
    const config = {
      ...defaults,
      repositoryOverrides: [
        { repository: "example-org/repo-a", includePullRequests: false },
      ],
    };
    const connector = await savedConnector(config);
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: { config: defaults },
    });
    expect(response.statusCode, response.body).toBe(409);
    const saved = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(saved?.config).toEqual(config);
    expect(saved?.checkpoint).toEqual(checkpoint);
    expect(saved?.secretId).toBe(connector.secretId);
  });

  test("explicit empty defaults preserve the legacy sync checkpoint", async () => {
    const connector = await savedConnector(defaults);
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: {
        config: {
          ...defaults,
          fileTypes: [],
          excludePaths: [],
          repositoryOverrides: [],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(saved?.checkpoint).toEqual(checkpoint);
    expect(saved?.secretId).toBe(connector.secretId);
  });

  test("an intentional selection change still resets the checkpoint", async () => {
    const connector = await savedConnector(defaults);
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: { config: { ...defaults, includeIssues: true } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await KnowledgeBaseConnectorModel.findById(connector.id))?.checkpoint,
    ).toBeNull();
  });

  test("an old writer cannot discard global exclusions without repository overrides", async () => {
    const config = {
      ...defaults,
      excludePaths: ["docs/private"],
      repositoryOverrides: [],
    };
    const connector = await savedConnector(config);
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: { config: defaults },
    });
    expect(response.statusCode, response.body).toBe(409);
    const saved = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(saved?.config).toEqual(config);
    expect(saved?.checkpoint).toEqual(checkpoint);
  });

  test("explicitly empty global exclusions are an intentional supported reset", async () => {
    const connector = await savedConnector({
      ...defaults,
      excludePaths: ["docs/private"],
    });
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: { config: { ...defaults, excludePaths: [] } },
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = await KnowledgeBaseConnectorModel.findById(connector.id);
    expect(saved?.config).toMatchObject({ excludePaths: [] });
    expect(saved?.checkpoint).toBeNull();
    expect(saved?.secretId).toBe(connector.secretId);
  });

  test("audit distinguishes inherited settings from explicit false and empty without credentials", async () => {
    const connector = await savedConnector(defaults);
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: {
        config: {
          ...defaults,
          repositoryOverrides: [
            {
              repository: "example-org/repo-a",
              includePullRequests: false,
              labelsToSkip: [],
              includePaths: [],
            },
          ],
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    await drainBackgroundWork();
    const { data } = await AuditLogModel.findPaginated({
      organizationId: ctx.organizationId,
      resourceType: "connector",
      limit: 20,
      offset: 0,
    });
    const audit = data.find(
      (entry) =>
        entry.resourceId === connector.id && entry.httpMethod === "PUT",
    );
    expect(audit?.after?.githubRepositorySettings).toMatchObject({
      defaults: {
        includeIssues: false,
        includePaths: ["docs"],
        labelsToSkip: ["internal"],
      },
      repositories: [
        {
          repository: "example-org/repo-a",
          includeIssues: null,
          includePullRequests: false,
          labelsToSkip: [],
          includePaths: [],
        },
      ],
    });
    expect(JSON.stringify(audit)).not.toContain("synthetic-local-token");
  });
});
