import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { createGitlabToken } from "@/services/git-credentials";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { syncAppaGithubPolicy } from "@/services/openappa-github-sync";
import {
  getOpenAppaPolicyChangeStatus,
  publishOpenAppaPolicyChange,
} from "@/services/openappa-policy-change";
import { beforeEach, describe, expect, test } from "@/test";
import { FakeGitlab } from "@/test/fake-gitlab";
import { useMswServer } from "@/test/msw";
import { registerRoutePermissions } from "@/test/route-permissions";
import routes from "./openappa-github-sync.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
const GITLAB = "https://gitlab.example.test";
const TOKEN = "glpat-test-token";

describe("APPA GitLab sync", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let userId: string;
  let gitlab: FakeGitlab;
  let gitlabTokenId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    userId = user.id;
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    registerRoutePermissions(app);
    await app.register(routes);
    gitlab = new FakeGitlab(GITLAB, TOKEN);
    server.use(...gitlab.handlers());
    gitlabTokenId = (
      await createGitlabToken({
        organizationId,
        data: { name: "Self-managed GitLab", gitlabUrl: GITLAB, token: TOKEN },
      })
    ).id;
  });

  test("creates a project in a nested group from the template and syncs it", async () => {
    gitlab.addGroup("platform/security");
    const local = await guardrailsPolicyService.get(organizationId);

    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "platform/security",
        name: "policies",
        gitlabTokenId,
        interval: "1h",
      },
    });

    expect(response.statusCode).toBe(200);
    const status = response.json();
    expect(status).toMatchObject({
      provider: "gitlab",
      githubWebUrl: GITLAB,
      source: {
        repo: "platform/security/policies",
        ref: "main",
        path: "appa.toml",
        gitlabTokenId,
        lastSyncError: null,
      },
    });
    expect(status.source.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    const files = gitlab.files("platform/security/policies", "main");
    expect(files["appa.toml"]).toBe(local.content);
    expect(Object.keys(files).some((path) => path.startsWith("traces/"))).toBe(
      true,
    );
  });

  test("connects an existing project that already holds a policy", async () => {
    const pulled = `${initialPolicy()}\n# Kept in GitLab\n`;
    gitlab.addProject({
      path: "platform/security/existing",
      files: { "guardrails/appa.toml": pulled },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "platform/security",
        name: "existing",
        gitlabTokenId,
        interval: "1h",
        existing: true,
        path: "guardrails/appa.toml",
      },
    });

    expect(response.statusCode).toBe(200);
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      pulled,
    );
  });

  test("reports what setup would do with a project", async () => {
    gitlab.addProject({ path: "team/empty" });
    gitlab.addProject({
      path: "team/with-policy",
      files: { "appa.toml": initialPolicy(), "traces/a.appa": "x" },
    });
    gitlab.addProject({
      path: "team/no-policy",
      files: { "README.md": "# Notes" },
    });
    const statusOf = async (repo: string) =>
      (
        await app.inject({
          method: "GET",
          url: `/api/openappa/github-app/repository?credentialId=${gitlabTokenId}&repo=${encodeURIComponent(repo)}`,
        })
      ).json();

    expect(await statusOf("team/empty")).toEqual({
      status: "empty",
      validations: null,
    });
    expect(await statusOf("team/with-policy")).toEqual({
      status: "policy",
      validations: true,
    });
    expect(await statusOf("team/no-policy")).toEqual({
      status: "other",
      validations: false,
    });
    expect(await statusOf("team/missing")).toEqual({
      status: "unreachable",
      validations: null,
    });
  });

  test("proposes policy changes as a merge request and syncs after the merge", async () => {
    gitlab.addGroup("platform");
    await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "platform",
        name: "policies",
        gitlabTokenId,
        interval: "1h",
      },
    });
    const before = await guardrailsPolicyService.get(organizationId);
    const changed = `${before.content}\n# Reviewed in GitLab\n`;

    const proposed = await publishOpenAppaPolicyChange({
      organizationId,
      userId,
      expectedRevision: before.revision,
      content: changed,
      title: "Tighten the policy",
      summary: "Adds a comment.",
    });

    expect(proposed).toMatchObject({
      delivery: "pull_request",
      number: 1,
      url: `${GITLAB}/platform/policies/-/merge_requests/1`,
    });
    // Nothing changes locally until the merge request merges.
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      before.content,
    );
    await expect(
      getOpenAppaPolicyChangeStatus({ organizationId, userId, number: 1 }),
    ).resolves.toMatchObject({ state: "open", mergeable: true });

    gitlab.merge("platform/policies", 1);
    await syncAppaGithubPolicy(organizationId);

    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      changed,
    );
    await expect(
      getOpenAppaPolicyChangeStatus({ organizationId, userId, number: 1 }),
    ).resolves.toMatchObject({ state: "merged" });
  });

  test("refuses a change when GitLab moved past the synced commit", async () => {
    gitlab.addGroup("platform");
    await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "platform",
        name: "policies",
        gitlabTokenId,
        interval: "1h",
      },
    });
    // Someone pushes to the branch after the last sync.
    const project = gitlab.projects.get("platform/policies");
    project?.branches.set("main", "f".repeat(40));
    const before = await guardrailsPolicyService.get(organizationId);

    await expect(
      publishOpenAppaPolicyChange({
        organizationId,
        userId,
        expectedRevision: before.revision,
        content: `${before.content}\n# stale\n`,
        title: "Stale change",
        summary: "",
      }),
    ).rejects.toThrow(/GitLab has changed since the last policy sync/);
    expect(project?.mergeRequests).toHaveLength(0);
  });

  test("pulls a saved GitLab source on its schedule", async () => {
    await OpenAppaGithubSyncModel.save(organizationId, {
      repo: "team/policies",
      ref: null,
      path: "appa.toml",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
      gitlabTokenId,
    });
    gitlab.addProject({
      path: "team/policies",
      files: { "appa.toml": initialPolicy() },
    });

    await syncAppaGithubPolicy(organizationId);

    expect(
      (await OpenAppaGithubSyncModel.find(organizationId))?.lastSyncError,
    ).toBeNull();
    expect(gitlab.requests.length).toBeGreaterThan(0);
  });
});
