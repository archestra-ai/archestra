import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
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
import { openappaRepositoryIncludes } from "@/services/openappa-github-access";
import { syncAppaGithubPolicy } from "@/services/openappa-github-sync";
import {
  getOpenAppaPolicyChangeStatus,
  publishOpenAppaPolicyChange,
} from "@/services/openappa-policy-change";
import { beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { FakeGitlab } from "@/test/fake-gitlab";
import { useMswServer } from "@/test/msw";
import { registerRoutePermissions } from "@/test/route-permissions";
import routes from "./openappa-github-sync.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
// The setup request's commit is kept in the shared cache.
setupTestCacheManager();
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

  test("proposes the current policy to a project that already holds one, and pulls what the merge lands", async () => {
    const theirs = `${initialPolicy()}\n# Kept in GitLab\n`;
    const repo = "platform/security/existing";
    gitlab.addProject({
      path: repo,
      files: { "guardrails/appa.toml": theirs },
    });
    const local = await guardrailsPolicyService.get(organizationId);

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

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().source).toMatchObject({
      repo,
      path: "guardrails/appa.toml",
      setupPullRequestNumber: 1,
      sourceCommit: null,
      lastSyncError: null,
    });
    // Neither policy changes until the merge request merges.
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      local.content,
    );
    expect(gitlab.files(repo, "main")["guardrails/appa.toml"]).toBe(theirs);

    gitlab.merge(repo, 1);
    await syncAppaGithubPolicy(organizationId);

    expect(gitlab.files(repo, "main")["guardrails/appa.toml"]).toBe(
      local.content,
    );
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      setupPullRequestNumber: null,
      lastSyncError: null,
    });
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      local.content,
    );
  });

  test("a new project gets the files the synced policy reads and its validations", async () => {
    const root =
      'include = ["rules/*.toml"]\n\n[policy]\nversion = 2\n\n[[policy.tool]]\nname = "read"\ndelta = {}\n';
    const ledger =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "ledger__export"\ndelta = {}\n';
    const trace = "# A refund that must be refused\n";
    gitlab.addGroup("platform");
    gitlab.addProject({
      path: "platform/old",
      files: {
        "appa.toml": root,
        "rules/ledger.toml": ledger,
        "rules/README.md": "# Not a rules file\n",
        "traces/refund.appa": trace,
      },
    });
    // Synced from the old project: the files are read at its accepted commit.
    await OpenAppaGithubSyncModel.save(organizationId, {
      repo: "platform/old",
      ref: "main",
      path: "appa.toml",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
      gitlabTokenId,
    });
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      lastSyncError: null,
      sourceCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      root,
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "platform",
        name: "policies",
        gitlabTokenId,
        interval: "1h",
        replace: true,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const files = gitlab.files("platform/policies", "main");
    expect(files).toMatchObject({
      "appa.toml": root,
      "rules/ledger.toml": ledger,
      "traces/refund.appa": trace,
    });
    expect(files["rules/README.md"]).toBeUndefined();
    expect(response.json().source).toMatchObject({
      repo: "platform/policies",
      lastSyncError: null,
    });
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      root,
    );
  });

  test("a project's own files the policy's globs would read go out with the merge request", async () => {
    const root =
      'include = ["rules/*.toml"]\n\n[policy]\nversion = 2\n\n[[policy.tool]]\nname = "read"\ndelta = {}\n';
    const current =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "ledger__export"\ndelta = {}\n';
    gitlab.addProject({
      path: "platform/old",
      files: { "appa.toml": root, "rules/current.toml": current },
    });
    await OpenAppaGithubSyncModel.save(organizationId, {
      repo: "platform/old",
      ref: "main",
      path: "appa.toml",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
      gitlabTokenId,
    });
    await syncAppaGithubPolicy(organizationId);
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      root,
    );
    const repo = "platform/security/existing";
    gitlab.addProject({
      path: repo,
      files: {
        "guardrails/appa.toml": `${initialPolicy()}\n# Kept in GitLab\n`,
        "guardrails/rules/legacy.toml":
          '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "legacy__anything"\ndelta = {}\n',
        "guardrails/rules/README.md": "# Not a rules file\n",
      },
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
        replace: true,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().source).toMatchObject({
      repo,
      ref: "main",
      setupPullRequestNumber: 1,
    });
    // While the request is open, the policy's files are read from its commit.
    expect(
      await openappaRepositoryIncludes.expand({
        organizationId,
        content: root,
      }),
    ).toMatchObject({
      errors: [],
      included: [{ path: "rules/current.toml", sha256: expect.any(String) }],
    });
    // A commit someone else pushed onto the request moves its branch, but
    // the read stays at the commit Archestra opened it with.
    const branch = gitlab.sourceBranch(repo, 1);
    const own = gitlab.branchHead(repo, branch);
    gitlab.commit(
      repo,
      branch,
      { "NOTES.md": "# Mine\n" },
      "someone@example.test",
    );
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    try {
      expect(
        await openappaRepositoryIncludes.expand({
          organizationId,
          content: root,
        }),
      ).toMatchObject({
        errors: [],
        included: [{ path: "rules/current.toml", sha256: expect.any(String) }],
      });
    } finally {
      vi.useRealTimers();
    }
    gitlab.setBranch(repo, branch, own);
    // Merged, its branch removed, not pulled yet: still read, at its head.
    // The open request's commit was kept for a minute; a minute later the
    // merged request is looked up again.
    gitlab.merge(repo, 1);
    gitlab.deleteSourceBranch(repo, 1);
    vi.useFakeTimers({ now: Date.now() + 122_000, toFake: ["Date"] });
    try {
      const before = gitlab.requests.length;
      expect(
        await openappaRepositoryIncludes.expand({
          organizationId,
          content: root,
        }),
      ).toMatchObject({
        errors: [],
        included: [{ path: "rules/current.toml", sha256: expect.any(String) }],
      });
      expect(
        gitlab.requests
          .slice(before)
          .some(
            (request) =>
              request.method === "GET" &&
              request.path.endsWith("/merge_requests/1"),
          ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    await syncAppaGithubPolicy(organizationId);
    const files = gitlab.files(repo, "main");
    expect(files).toMatchObject({
      "guardrails/appa.toml": root,
      "guardrails/rules/current.toml": current,
      "guardrails/rules/README.md": "# Not a rules file\n",
    });
    expect(files["guardrails/rules/legacy.toml"]).toBeUndefined();
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      setupPullRequestNumber: null,
      lastSyncError: null,
    });
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
