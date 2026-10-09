import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { GithubAppConfigModel } from "@/models";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaCredentialBindingModel from "@/models/openappa-credential-binding";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { secretManager } from "@/secrets-manager";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import {
  checkDueAppaGithubSyncs,
  syncAppaGithubPolicy,
} from "@/services/openappa-github-sync";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { registerRoutePermissions } from "@/test/route-permissions";
import routes from "./openappa-github-sync.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
const commit = "a".repeat(40);
const policy =
  '[policy]\nversion = 2\n[[policy.tool]]\nname = "read"\ndelta = {}\n[externals]\ntimeout_ms = 2000\nmax_body_bytes = 65536\n';
const source = {
  repo: "example/policies",
  ref: "policy/main",
  path: "guardrails/appa.toml",
  interval: "1h" as const,
  githubPatId: null,
  githubAppConfigId: null,
};

describe("APPA GitHub sync", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let adminId: string;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    adminId = user.id;
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    registerRoutePermissions(app);
    await app.register(routes);
    server.use(
      http.get(
        "https://api.github.com/repos/example/new-policy/git/ref/heads/main",
        () => HttpResponse.json({ object: { sha: commit } }),
      ),
      http.post(
        "https://api.github.com/repos/example/new-policy/git/refs",
        async ({ request }) => {
          expect(await request.json()).toMatchObject({
            ref: expect.stringMatching(
              /^refs\/heads\/archestra\/openappa-setup-/,
            ),
            sha: commit,
          });
          return HttpResponse.json({});
        },
      ),
      http.post(
        "https://api.github.com/repos/example/new-policy/pulls",
        async ({ request }) => {
          expect(await request.json()).toMatchObject({
            base: "main",
            head: expect.stringMatching(/^archestra\/openappa-setup-/),
          });
          return HttpResponse.json({ number: 1 });
        },
      ),
      http.get("https://api.github.com/repos/example/new-policy/pulls/1", () =>
        HttpResponse.json({ merged: false, state: "open" }),
      ),
      http.get(
        "https://api.github.com/repos/example/policies/commits/:ref",
        ({ params }) => {
          expect(params.ref).toBe("policy/main");
          return HttpResponse.json({ sha: commit });
        },
      ),
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("ref")).toBe(commit);
          return HttpResponse.text(policy);
        },
      ),
    );
  });
  afterEach(async () => {
    await app.close();
  });
  const configure = (body: unknown = source) =>
    app.inject({
      method: "PUT",
      url: "/api/openappa/github-sync",
      payload: body as Record<string, unknown>,
    });
  const action = (body: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: "/api/openappa/github-sync",
      payload: body,
    });
  test("checks the validation folder at the proposed ref before atomically saving both settings", async () => {
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/checks",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("ref")).toBe(commit);
          return HttpResponse.json([
            { type: "file", path: "checks/.gitkeep", size: 0 },
          ]);
        },
      ),
    );
    const response = await configure({
      ...source,
      validationDirectory: "checks",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().validationDirectory).toBe("checks");
    expect(await OpenAppaPolicyTestsModel.find(organizationId)).toMatchObject({
      directory: "checks",
      files: [],
    });
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/missing",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    const previous = await OpenAppaGithubSyncModel.find(organizationId);
    expect(
      (
        await configure({
          ...source,
          path: "new/appa.toml",
          validationDirectory: "missing",
        })
      ).statusCode,
    ).toBe(404);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toEqual(
      previous,
    );
    expect(await OpenAppaPolicyTestsModel.find(organizationId)).toMatchObject({
      directory: "checks",
    });
  });
  test("an empty validation folder disables Git tests without fetching a folder or disabling policy sync", async () => {
    const response = await configure({ ...source, validationDirectory: "" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      validationDirectory: "",
      source: { interval: "1h" },
    });
    expect(await OpenAppaPolicyTestsModel.find(organizationId)).toMatchObject({
      directory: "",
      files: [],
    });
  });
  test("source edits from older clients preserve the configured directory", async () => {
    await configure({ ...source, validationDirectory: "" });
    const response = await configure();
    expect(response.json().validationDirectory).toBe("");
  });
  test("a file is rejected as a validation directory without changing the source", async () => {
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/checks",
        () => HttpResponse.json({ type: "file", path: "checks" }),
      ),
    );
    const response = await configure({
      ...source,
      validationDirectory: "checks",
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
  });
  /** The state the declaration migration leaves: declarations the repository never learned. */
  const flagDeclarationsPendingPublish = () =>
    db
      .update(schema.openappaGithubSyncTable)
      .set({ declarationsPendingPublish: true })
      .where(eq(schema.openappaGithubSyncTable.organizationId, organizationId));

  test("saves, audits and pulls a pinned, natively validated policy without exposing its content", async () => {
    expect((await configure()).statusCode).toBe(200);
    await syncAppaGithubPolicy(organizationId);
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
    const row = await OpenAppaGithubSyncModel.find(organizationId);
    expect(row).toMatchObject({
      content: policy,
      sourceCommit: commit,
      lastSyncError: null,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/openappa/github-sync",
    });
    expect(response.json()).toMatchObject({
      hasPolicy: true,
      source: { repo: source.repo, sourceCommit: commit },
    });
    expect(response.json().source).not.toHaveProperty("content");
    await vi.waitFor(async () => {
      const records = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.organizationId, organizationId),
            eq(schema.auditLogsTable.action, "organization.updated"),
          ),
        );
      expect(records.length).toBe(1);
      expect(records[0].after).toMatchObject({ repo: source.repo });
      expect(records[0].after).not.toEqual(records[0].before);
      expect(records[0].after).not.toHaveProperty("content");
    });
  });

  test.each([
    "initial PR",
    "matching template",
    "PR failure",
    "template not ready",
    "direct commit",
    "permission denied",
    "unrelated conflict",
    "upstream failure",
    "protected branch 403",
    "required PR 422",
  ])("creates a policy repository safely: %s", async (scenario) => {
    const current = `${initialPolicy()}\n# Existing battery choices stay in the repository\n`;
    await guardrailsPolicyService.update({
      organizationId,
      userId: adminId,
      content: current,
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
      "test-template-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    let seeded = "";
    let templateReads = 0;
    let pullRequests = 0;
    const matchingTemplate = scenario === "matching template";
    const templateSha = matchingTemplate
      ? createHash("sha1")
          .update(`blob ${Buffer.byteLength(current)}\0`)
          .update(current)
          .digest("hex")
      : "b".repeat(40);
    server.use(
      http.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        () =>
          HttpResponse.json({
            token: "test-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
      ),
      http.post(
        "https://api.github.com/repos/archestra-ai/openappa-config/generate",
        async ({ request }) => {
          expect(await request.json()).toMatchObject({
            owner: "example",
            name: "new-policy",
            private: true,
          });
          return HttpResponse.json(
            { full_name: "example/new-policy", default_branch: "main" },
            { status: 201 },
          );
        },
      ),
      http.put(
        "https://api.github.com/repos/example/new-policy/contents/appa.toml",
        async ({ request }) => {
          const body = (await request.json()) as {
            content: string;
            sha: string;
            branch: string;
          };
          if (body.branch === "main" && scenario !== "direct commit") {
            if (scenario === "permission denied")
              return HttpResponse.json(
                { message: "Resource not accessible by integration" },
                { status: 403 },
              );
            if (scenario === "unrelated conflict")
              return HttpResponse.json(
                { message: "Conflict: file SHA does not match" },
                { status: 409 },
              );
            if (scenario === "upstream failure")
              return HttpResponse.json(
                { message: "Internal Server Error" },
                { status: 500 },
              );
            return HttpResponse.json(
              {
                message:
                  scenario === "protected branch 403"
                    ? "Protected branch update failed for refs/heads/main"
                    : scenario === "required PR 422"
                      ? "Changes must be made through a pull request"
                      : "Repository rule violations found: Required workflow is not satisfied",
              },
              {
                status:
                  scenario === "protected branch 403"
                    ? 403
                    : scenario === "required PR 422"
                      ? 422
                      : 409,
              },
            );
          }
          expect(body.branch).toMatch(
            scenario === "direct commit"
              ? /^main$/
              : /^archestra\/openappa-setup-/,
          );
          expect(body.sha).toBe(templateSha);
          seeded = Buffer.from(body.content, "base64").toString();
          return HttpResponse.json({ content: { sha: "c".repeat(40) } });
        },
      ),
      http.get(
        "https://api.github.com/repos/example/new-policy/commits/main",
        () => HttpResponse.json({ sha: commit }),
      ),
      http.get(
        "https://api.github.com/repos/example/new-policy/contents/appa.toml",
        ({ request }) => {
          if (new URL(request.url).searchParams.get("ref") === commit)
            return HttpResponse.text(matchingTemplate ? current : seeded);
          templateReads++;
          if (scenario === "template not ready" && templateReads === 1)
            return new HttpResponse(null, { status: 404 });
          return HttpResponse.json({ sha: templateSha });
        },
      ),
    );
    server.use(
      http.post(
        "https://api.github.com/repos/example/new-policy/pulls",
        async ({ request }) => {
          pullRequests++;
          expect(await request.json()).toMatchObject({
            base: "main",
            head: expect.stringMatching(/^archestra\/openappa-setup-/),
          });
          return scenario === "PR failure"
            ? HttpResponse.json({ message: "Forbidden" }, { status: 403 })
            : HttpResponse.json({ number: 1 });
        },
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "new-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
      },
    });
    if (
      [
        "PR failure",
        "permission denied",
        "unrelated conflict",
        "upstream failure",
      ].includes(scenario)
    ) {
      expect(response.statusCode).toBe(502);
      expect(pullRequests).toBe(scenario === "PR failure" ? 1 : 0);
      expect(response.json().error.message).toContain(
        "initial policy setup failed",
      );
      expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
      expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
        current,
      );
      return;
    }
    expect(response.statusCode, response.body).toBe(200);
    if (matchingTemplate || scenario === "direct commit") {
      expect(pullRequests).toBe(0);
      expect(seeded).toBe(matchingTemplate ? "" : current);
      expect(response.json().source).toMatchObject({
        setupPullRequestNumber: null,
        sourceCommit: commit,
        lastSyncError: null,
      });
      expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
        current,
      );
      return;
    }
    expect(pullRequests).toBe(1);
    expect(templateReads).toBe(scenario === "template not ready" ? 2 : 1);
    expect(seeded).toBe(current);
    expect(response.json()).toMatchObject({
      source: {
        repo: "example/new-policy",
        sourceCommit: null,
        setupPullRequestNumber: 1,
        interval: "1h",
        lastSyncError: null,
      },
    });
    // A later scheduled pull also waits, even if the template branch changes.
    await syncAppaGithubPolicy(organizationId);
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      current,
    );
    expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(
      1,
    );
    server.use(
      http.get("https://api.github.com/repos/example/new-policy/pulls/1", () =>
        HttpResponse.json({ merged: false, state: "closed" }),
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      setupPullRequestNumber: 1,
      lastSyncError: expect.stringContaining("closed without merging"),
    });
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      current,
    );
    server.use(
      http.get("https://api.github.com/repos/example/new-policy/pulls/1", () =>
        HttpResponse.json({ merged: true, state: "closed" }),
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      setupPullRequestNumber: null,
      sourceCommit: commit,
      content: current,
      lastSyncError: null,
    });
    expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(
      1,
    );
    await vi.waitFor(async () => {
      const records = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.organizationId, organizationId),
            eq(schema.auditLogsTable.action, "organization.updated"),
          ),
        );
      expect(
        records.some(
          (record) =>
            (record.after as { repo?: string } | null)?.repo ===
            "example/new-policy",
        ),
      ).toBe(true);
    });
  });

  test.each([
    {
      githubStatus: 404,
      apiStatus: 502,
      message: "installed on that exact account",
    },
    {
      githubStatus: 422,
      apiStatus: 409,
      message: "retry setup",
    },
  ])("explains GitHub repository creation HTTP $githubStatus", async ({
    githubStatus,
    apiStatus,
    message,
  }) => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-template-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    server.use(
      http.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        () =>
          HttpResponse.json({
            token: "test-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
      ),
      http.post(
        "https://api.github.com/repos/archestra-ai/openappa-config/generate",
        () =>
          HttpResponse.json(
            { message: "GitHub rejected request" },
            { status: githubStatus },
          ),
      ),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "new-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
      },
    });
    expect(response.statusCode).toBe(apiStatus);
    expect(response.json().error.message).toContain(message);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
  });

  test.each([
    {
      scenario: "pristine private template",
      isPrivate: true,
      template: "archestra-ai/openappa-config",
      fileSha: "b",
      resumes: true,
    },
    {
      scenario: "modified policy",
      isPrivate: true,
      template: "archestra-ai/openappa-config",
      fileSha: "d",
      resumes: false,
    },
    {
      scenario: "public repository",
      isPrivate: false,
      template: "archestra-ai/openappa-config",
      fileSha: "b",
      resumes: false,
    },
    {
      scenario: "unrelated repository",
      isPrivate: true,
      template: "example/other",
      fileSha: "b",
      resumes: false,
    },
  ])("setup recovery protects existing work: $scenario", async ({
    isPrivate,
    template,
    fileSha,
    resumes,
  }) => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-template-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    let seeded = "";
    let seedAttempts = 0;
    server.use(
      http.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        () =>
          HttpResponse.json({
            token: "test-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
      ),
      http.post(
        "https://api.github.com/repos/archestra-ai/openappa-config/generate",
        () => HttpResponse.json({ message: "exists" }, { status: 422 }),
      ),
      http.get("https://api.github.com/repos/example/new-policy", () =>
        HttpResponse.json({
          full_name: "example/new-policy",
          default_branch: "main",
          private: isPrivate,
          template_repository: { full_name: template },
        }),
      ),
      http.get(
        "https://api.github.com/repos/archestra-ai/openappa-config/contents/appa.toml",
        () => HttpResponse.json({ sha: "b".repeat(40) }),
      ),
      http.get(
        "https://api.github.com/repos/example/new-policy/contents/appa.toml",
        ({ request }) =>
          new URL(request.url).searchParams.get("ref") === commit
            ? HttpResponse.text(seeded)
            : HttpResponse.json({ sha: fileSha.repeat(40) }),
      ),
      http.put(
        "https://api.github.com/repos/example/new-policy/contents/appa.toml",
        async ({ request }) => {
          seedAttempts++;
          seeded = Buffer.from(
            ((await request.json()) as { content: string }).content,
            "base64",
          ).toString();
          return HttpResponse.json({ content: { sha: "c".repeat(40) } });
        },
      ),
      http.get(
        "https://api.github.com/repos/example/new-policy/commits/main",
        () => HttpResponse.json({ sha: commit }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "new-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
      },
    });
    if (!resumes) {
      expect(response.statusCode).toBe(409);
      expect(seedAttempts).toBe(0);
      expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
      return;
    }
    expect(response.statusCode, response.body).toBe(200);
    expect(seedAttempts).toBe(1);
    expect(seeded).toBe(
      (await guardrailsPolicyService.get(organizationId)).content,
    );
    expect(response.json().source.repo).toBe("example/new-policy");
  });

  test("an invalid upstream policy preserves the last accepted bytes and commit", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        () => HttpResponse.text("not a policy"),
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      content: policy,
      sourceCommit: commit,
      lastSyncError: expect.stringContaining("APPA rejected"),
    });
  });

  test("a disconnect during download prevents the stale result from publishing", async () => {
    await configure();
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        async () => {
          expect((await action({ action: "disconnect" })).statusCode).toBe(200);
          return HttpResponse.text(policy);
        },
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      interval: null,
      content: null,
      lastSyncedAt: null,
    });
    expect(await GuardrailsPolicyModel.findLatest(organizationId)).toBeNull();
  });

  test("a changed source during download prevents the old source from publishing", async () => {
    await configure();
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        async () => {
          expect(
            (await configure({ ...source, path: "new.toml" })).statusCode,
          ).toBe(200);
          return HttpResponse.text(policy);
        },
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      path: "new.toml",
      content: null,
    });
    expect(await GuardrailsPolicyModel.findLatest(organizationId)).toBeNull();
  });

  test("disconnect keeps accepted policy, records the change, and stops scheduled pulls", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    const response = await action({ action: "disconnect" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      hasPolicy: true,
      source: { interval: null },
    });
    expect(await OpenAppaGithubSyncModel.findDue()).toEqual([]);
    expect((await action({ action: "sync" })).statusCode).toBe(409);
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.organizationId, organizationId),
            eq(schema.auditLogsTable.action, "organization.updated"),
          ),
        );
      expect(
        rows.some(
          (row) =>
            (row.before as { interval?: string })?.interval === "1h" &&
            (row.after as { interval?: string | null })?.interval === null,
        ),
      ).toBe(true);
    });
  });

  test("manual sync returns the completed pull and its failures immediately", async () => {
    await configure();
    const success = await action({ action: "sync" });
    expect(success.statusCode).toBe(200);
    expect(success.json().source).toMatchObject({
      sourceCommit: commit,
      lastSyncError: null,
    });
    expect(success.json().source.lastSyncedAt).toBeTruthy();
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/commits/:ref",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    const failure = await action({ action: "sync" });
    expect(failure.statusCode).toBe(200);
    expect(failure.json().source.lastSyncError).toContain("404");
    expect(failure.json().source.sourceCommit).toBe(commit);
  });

  test("concurrent scheduled requests enqueue one pull", async () => {
    await configure();
    await Promise.all([
      checkDueAppaGithubSyncs(),
      checkDueAppaGithubSyncs(),
      checkDueAppaGithubSyncs(),
    ]);
    const tasks = await db
      .select()
      .from(schema.tasksTable)
      .where(eq(schema.tasksTable.taskType, "openappa_github_sync"));
    expect(tasks).toHaveLength(1);
  });

  test("schedule changes persist and successful recent syncs are not due", async () => {
    await configure();
    expect(
      (await action({ action: "schedule", interval: "15m" })).json().source
        .interval,
    ).toBe("15m");
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.findDue()).toEqual([]);
  });

  test("rejects malformed paths, conflicting credentials and disabled APPA", async () => {
    for (const body of [
      { ...source, path: "../secret.toml" },
      { ...source, repo: "https://attacker.test/repo" },
      {
        ...source,
        githubPatId: "00000000-0000-4000-8000-000000000001",
        githubAppConfigId: "00000000-0000-4000-8000-000000000002",
      },
    ])
      expect((await configure(body)).statusCode).toBe(400);
    config.openappa.enabled = false;
    expect((await configure()).statusCode).toBe(409);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
  });

  test("refuses non-administrators and does not read another organization's source", async ({
    makeOrganization,
  }) => {
    await configure();
    const other = await makeOrganization();
    expect(await OpenAppaGithubSyncModel.find(other.id)).toBeNull();
    // Remove management access while keeping the same authenticated request identity.
    await db
      .delete(schema.membersTable)
      .where(eq(schema.membersTable.userId, adminId));
    expect((await configure()).statusCode).toBe(403);
    expect((await action({ action: "disconnect" })).statusCode).toBe(403);
  });

  test("oversized or failed GitHub downloads preserve the active policy", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        () =>
          new HttpResponse("", {
            headers: { "content-length": String(2 * 1024 * 1024) },
          }),
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      content: policy,
      lastSyncError: expect.stringContaining("1 MiB"),
    });
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/commits/:ref",
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      content: policy,
      lastSyncError: expect.stringContaining("404"),
    });
  });
  test("synced policies cannot be manually overwritten, disconnect enables editing", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    const write = () =>
      guardrailsPolicyService.update({
        organizationId,
        userId: adminId,
        content: `${policy}# manual`,
        expectedRevision: 1,
      });
    await expect(write()).rejects.toThrow("Stop GitHub syncing");
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
    // The database guard also covers callers whose validation raced a new sync configuration.
    expect(
      await GuardrailsPolicyModel.save({
        organizationId,
        updatedBy: adminId,
        content: "stale edit",
        contentHash: "stale",
        expectedRevision: 1,
      }),
    ).toBeNull();
    await action({ action: "disconnect" });
    expect(await write()).toMatchObject({
      content: `${policy}# manual`,
      revision: 2,
    });
  });

  /** Serve different upstream bytes under a different commit. */
  const upstream = (content: string, sha: string) => {
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/commits/:ref",
        () => HttpResponse.json({ sha }),
      ),
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        () => HttpResponse.text(content),
      ),
    );
  };

  test("a pull handing a battery a credential is held, and accepting it takes credential update", async ({
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    const granted = `include = ["batteries/github/appa.toml"]\n\n[credentials]\nAPPA_PROVIDER_GITHUB_TOKEN = "github-token"\n\n${policy}`;
    const grantedHash = createHash("sha256").update(granted).digest("hex");
    const second = "b".repeat(40);
    upstream(granted, second);
    await syncAppaGithubPolicy(organizationId);

    expect(
      (
        await db
          .select()
          .from(schema.tasksTable)
          .where(eq(schema.tasksTable.taskType, "openappa_policy_validation"))
      ).some(
        (job) =>
          job.payload.policyHash === grantedHash &&
          job.payload.policyRevision === 2,
      ),
    ).toBe(false);
    // The bytes are kept, not published: the repository cannot grant this.
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      heldContent: granted,
      heldSourceCommit: second,
      heldReasons: ["changes_credentials"],
      sourceCommit: commit,
    });
    const status = await app.inject({
      method: "GET",
      url: "/api/openappa/github-sync",
    });
    expect(status.json().source).not.toHaveProperty("heldContent");

    const manager = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: {
        organizationSettings: ["update"],
        openappaPolicy: ["read", "update"],
      },
    });
    await makeMember(manager.id, organizationId, { role: role.role });
    const managerApp = createFastifyInstance();
    managerApp.addHook("onRequest", async (request) => {
      Object.assign(request, { user: manager, organizationId });
    });
    registerRoutePermissions(managerApp);
    await managerApp.register(routes);
    try {
      expect(
        (
          await managerApp.inject({
            method: "POST",
            url: "/api/openappa/github-sync/accept-held",
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await managerApp.close();
    }
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ revision: 1 });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/accept-held",
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      (
        await db
          .select()
          .from(schema.tasksTable)
          .where(eq(schema.tasksTable.taskType, "openappa_policy_validation"))
      ).some(
        (job) =>
          job.payload.policyHash === grantedHash &&
          job.payload.policyRevision === 2,
      ),
    ).toBe(true);
    expect(accepted.json()).toMatchObject({
      sourceCommit: second,
      reasons: ["changes_credentials"],
      changedVariables: ["APPA_PROVIDER_GITHUB_TOKEN"],
    });
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: granted, revision: 2, updatedBy: adminId });
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      heldContent: null,
      heldReasons: [],
      content: granted,
      sourceCommit: second,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/openappa/github-sync/accept-held",
        })
      ).statusCode,
    ).toBe(409);
  });

  test("a pull is measured against the stored bindings: including a reader of one is held, spelling its own key is not", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    await OpenAppaCredentialBindingModel.upsert({
      organizationId,
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      credentialKey: "github-token",
      updatedBy: adminId,
    });
    const included = `include = ["batteries/github/appa.toml"]\n\n${policy}`;
    upstream(included, "b".repeat(40));
    await syncAppaGithubPolicy(organizationId);
    // The text names no credential, but the battery it includes reads a bound one.
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      heldContent: included,
      heldReasons: ["changes_credentials"],
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/openappa/github-sync/accept-held",
        })
      ).statusCode,
    ).toBe(200);

    const spelled = `include = ["batteries/github/appa.toml"]\n\n[credentials]\nAPPA_PROVIDER_GITHUB_TOKEN = "github-token"\n\n${policy}`;
    upstream(spelled, "c".repeat(40));
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      heldContent: null,
      heldReasons: [],
      content: spelled,
    });
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: spelled, revision: 3 });
  });

  test("a pull handing a root profile a credential is held", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    const granted = `${policy}\n[credentials]\nAPPA_PROVIDER_JEV_API_KEY = "jev-key"\n[externals.jev]\ntoken_env = "APPA_PROVIDER_JEV_API_KEY"\n`;
    upstream(granted, "b".repeat(40));
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      heldContent: granted,
      heldReasons: ["changes_credentials"],
    });
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
  });

  test("accepting a held pull takes credential update for a grant a binding made since the hold", async ({
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    await configure();
    const declared = `include = ["batteries/github/appa.toml", "batteries/jev/appa.toml"]\n\n${policy}`;
    upstream(declared, commit);
    await syncAppaGithubPolicy(organizationId);
    await flagDeclarationsPendingPublish();
    // The pull drops jev and points the root jev profile at the github battery's
    // variable, which nothing binds yet: it is held only for the dropped battery.
    const pulled = `include = ["batteries/github/appa.toml"]\n\n${policy}\n[externals.jev]\ntoken_env = "APPA_PROVIDER_GITHUB_TOKEN"\n`;
    upstream(pulled, "c".repeat(40));
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      heldContent: pulled,
      heldReasons: ["drops_batteries"],
    });
    await OpenAppaCredentialBindingModel.upsert({
      organizationId,
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      credentialKey: "github-token",
      updatedBy: adminId,
    });

    const manager = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: {
        organizationSettings: ["update"],
        openappaPolicy: ["read", "update"],
      },
    });
    await makeMember(manager.id, organizationId, { role: role.role });
    const managerApp = createFastifyInstance();
    managerApp.addHook("onRequest", async (request) => {
      Object.assign(request, { user: manager, organizationId });
    });
    registerRoutePermissions(managerApp);
    await managerApp.register(routes);
    try {
      expect(
        (
          await managerApp.inject({
            method: "POST",
            url: "/api/openappa/github-sync/accept-held",
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await managerApp.close();
    }
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: declared, revision: 1 });

    const accepted = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/accept-held",
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: pulled, revision: 2 });
  });

  test("a pull dropping a battery this deployment has not published yet is held", async () => {
    await configure();
    const declared = `include = ["batteries/github/appa.toml"]\n\n${policy}`;
    upstream(declared, commit);
    await syncAppaGithubPolicy(organizationId);
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: declared, revision: 1 });
    // Declarations written here are not in the repository yet, so a pull that
    // lacks them is a rollback nobody asked for.
    await flagDeclarationsPendingPublish();
    const second = "c".repeat(40);
    upstream(policy, second);
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      heldContent: policy,
      heldSourceCommit: second,
      heldReasons: ["drops_batteries"],
    });
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: declared, revision: 1 });
    // Accepting it is the operator's call, and it clears the pending flag.
    const accepted = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/accept-held",
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    // What the repository drops is named, in the answer and in the record.
    expect(accepted.json()).toMatchObject({
      reasons: ["drops_batteries"],
      droppedBatteries: ["github"],
    });
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      declarationsPendingPublish: false,
      heldContent: null,
    });
    await vi.waitFor(async () => {
      const records = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.organizationId, organizationId),
            eq(schema.auditLogsTable.action, "organization.updated"),
          ),
        );
      expect(
        records.some((record) =>
          (
            (record.after as { droppedBatteries?: string[] })
              ?.droppedBatteries ?? []
          ).includes("github"),
        ),
      ).toBe(true);
    });
  });

  test("a disconnect drops the held pull with the schedule that fetched it", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    const granted = `include = ["batteries/github/appa.toml"]\n\n[credentials]\nAPPA_PROVIDER_GITHUB_TOKEN = "github-token"\n\n${policy}`;
    upstream(granted, "d".repeat(40));
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      heldReasons: ["changes_credentials"],
    });

    expect((await action({ action: "disconnect" })).statusCode).toBe(200);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      heldContent: null,
      heldReasons: [],
    });
    // Nothing is left to accept, and the text is its authors' again.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/openappa/github-sync/accept-held",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
  });

  test("a pull that loses the revision race publishes nothing and keeps the declarations pending", async () => {
    await configure();
    await flagDeclarationsPendingPublish();
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/guardrails/appa.toml",
        async () => {
          // The schedule moves while the document downloads.
          expect(
            (await action({ action: "schedule", interval: "15m" })).statusCode,
          ).toBe(200);
          return HttpResponse.text(policy);
        },
      ),
    );
    await syncAppaGithubPolicy(organizationId);
    expect(await GuardrailsPolicyModel.findLatest(organizationId)).toBeNull();
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      content: null,
      declarationsPendingPublish: true,
    });
  });

  test("unchanged upstream bytes do not create redundant policy revisions", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    await syncAppaGithubPolicy(organizationId);
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ revision: 1, content: policy });
  });
});
