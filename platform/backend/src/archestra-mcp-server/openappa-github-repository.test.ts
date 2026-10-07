import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { HttpResponse, http } from "msw";
import config from "@/config";
import { GithubAppConfigModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { secretManager } from "@/secrets-manager";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test, vi } from "@/test";
import { useMswServer } from "@/test/msw";
import { type ArchestraContext, executeArchestraTool } from ".";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
const CONNECT = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}connect_guardrails_repository`;
const commit = "d".repeat(40);
const repositoryPolicy =
  '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n[externals]\ntimeout_ms = 2000\nmax_body_bytes = 65536\n';

describe("connect_guardrails_repository", () => {
  let organizationId: string;
  let context: ArchestraContext;
  let githubAppConfigId: string;
  let currentPolicy: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    config.openappa.enabled = true;
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: "admin" });
    const agent = await makeAgent({ organizationId });
    context = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId,
    };
    currentPolicy = `${initialPolicy()}\n# Saved before the repository was connected\n`;
    await guardrailsPolicyService.update({
      organizationId,
      userId: user.id,
      content: currentPolicy,
      expectedRevision: 0,
    });
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-policy-app",
    );
    githubAppConfigId = (
      await GithubAppConfigModel.create({
        organizationId,
        name: "Policy App",
        githubUrl: "https://api.github.com",
        appId: "123",
        installationId,
        secretId: secret.id,
      })
    ).id;
    server.use(
      http.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        () =>
          HttpResponse.json({
            token: "test-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
      ),
      http.get(
        "https://api.github.com/repos/example/existing-policy/commits/:ref",
        ({ params }) => {
          expect(params.ref).toBe("HEAD");
          return HttpResponse.json({ sha: commit });
        },
      ),
    );
  });

  test("makes an existing repository's policy file the policy and keeps syncing it", async () => {
    server.use(
      http.get(
        "https://api.github.com/repos/example/existing-policy/contents/policies/appa.toml",
        ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer test-installation-token",
          );
          expect(new URL(request.url).searchParams.get("ref")).toBe(commit);
          return HttpResponse.text(repositoryPolicy);
        },
      ),
    );

    const response = await executeArchestraTool(
      CONNECT,
      {
        repo: "example/existing-policy",
        path: "policies/appa.toml",
        githubAppConfigId,
      },
      context,
    );

    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({
      source: {
        repo: "example/existing-policy",
        path: "policies/appa.toml",
        ref: null,
        interval: "1h",
        sourceCommit: commit,
        lastSyncError: null,
      },
      hasPolicy: true,
    });
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      repositoryPolicy,
    );
    await vi.waitFor(async () => {
      const { data } = await AuditLogModel.findPaginated({
        organizationId,
        resourceType: "organization",
        limit: 10,
        offset: 0,
      });
      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({
        action: "organization.updated",
        after: { repo: "example/existing-policy", hasPolicy: true },
      });
      expect(data[0].after).not.toHaveProperty("content");
    });
  });

  test("connects nothing and keeps the current policy when the first pull fails", async () => {
    server.use(
      http.get(
        "https://api.github.com/repos/example/existing-policy/contents/appa.toml",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );

    const response = await executeArchestraTool(
      CONNECT,
      { repo: "example/existing-policy", githubAppConfigId },
      context,
    );

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain(
      "Could not connect example/existing-policy: GitHub returned HTTP 404",
    );
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      currentPolicy,
    );
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      interval: null,
    });
  });

  test("refuses to replace a sync that is already running", async () => {
    await OpenAppaGithubSyncModel.save(organizationId, {
      repo: "example/current-policy",
      ref: null,
      path: "appa.toml",
      interval: "1d",
      githubPatId: null,
      githubAppConfigId,
    });

    const response = await executeArchestraTool(
      CONNECT,
      { repo: "example/existing-policy", githubAppConfigId },
      context,
    );

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain(
      "Stop the existing GitHub sync before connecting another repository",
    );
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      repo: "example/current-policy",
    });
  });
});
