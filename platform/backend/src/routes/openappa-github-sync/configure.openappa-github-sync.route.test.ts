import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { vi } from "vitest";
import { cacheManager } from "@/cache-manager";
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
import { openappaBatteriesService } from "@/openappa/batteries";
import { OPENAPPA_TEMPLATE } from "@/openappa/template.generated";
import { secretManager } from "@/secrets-manager";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import {
  openappaRepositoryIncludes,
  templateExampleBlob,
} from "@/services/openappa-github-access";
import {
  checkDueAppaGithubSyncs,
  syncAppaGithubPolicy,
} from "@/services/openappa-github-sync";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { useMswServer } from "@/test/msw";
import { registerRoutePermissions } from "@/test/route-permissions";
import routes from "./openappa-github-sync.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
// The setup request's commit is kept in the shared cache.
setupTestCacheManager();
const commit = "a".repeat(40);
/** The commit setup writes with the git data API. */
const SETUP_COMMIT = "c".repeat(40);
/** The tree a branch head carries before setup writes. */
const HEAD_TREE = "e".repeat(40);

/**
 * GitHub's git data API for one repository, as setup writes through it: the
 * head commit's tree, a tree written over it, a commit of that tree, and the
 * branch advanced onto it. `head` holds the files the branch has; a tree
 * that writes the same bytes is the head's tree again, as GitHub's would be.
 */
function fakeGitData(
  repo: string,
  options: {
    head: Record<string, string>;
    /** Paths among `head` that are symbolic links (mode 120000). */
    symlinks?: string[];
    advance?: () => Response | undefined;
  },
) {
  const base = `https://api.github.com/repos/${repo}`;
  const written: Record<string, string>[] = [];
  const removed: string[][] = [];
  const state = { commits: 0, treeReads: 0, recursiveReads: 0 };
  server.use(
    http.get(`${base}/git/commits/:sha`, () =>
      HttpResponse.json({ tree: { sha: HEAD_TREE } }),
    ),
    // The head's files, as setup lists them before writing over them.
    // The head's tree: the whole of it when asked recursively, else one
    // tree's entries, the root's for the commit or any folder's by its id.
    http.get(`${base}/git/trees/:sha`, ({ request, params }) => {
      state.treeReads++;
      const mode = (path: string) =>
        options.symlinks?.includes(path) ? "120000" : "100644";
      if (new URL(request.url).searchParams.get("recursive")) {
        state.recursiveReads++;
        return HttpResponse.json({
          truncated: false,
          tree: Object.keys(options.head).map((path) => ({
            path,
            type: "blob",
            mode: mode(path),
          })),
        });
      }
      const folderId = (folder: string) =>
        createHash("sha1").update(`tree ${folder}`).digest("hex");
      const folders = new Set<string>();
      for (const path of Object.keys(options.head)) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++)
          folders.add(parts.slice(0, index).join("/"));
      }
      const at =
        [...folders].find((folder) => folderId(folder) === params.sha) ?? "";
      const prefix = at ? `${at}/` : "";
      const direct = (path: string) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes("/");
      return HttpResponse.json({
        truncated: false,
        tree: [
          ...[...folders].filter(direct).map((folder) => ({
            path: folder.slice(prefix.length),
            type: "tree",
            mode: "040000",
            sha: folderId(folder),
          })),
          ...Object.keys(options.head)
            .filter(direct)
            .map((path) => ({
              path: path.slice(prefix.length),
              type: "blob",
              mode: mode(path),
              sha: blobSha(options.head[path] as string),
            })),
        ],
      });
    }),
    http.post(`${base}/git/trees`, async ({ request }) => {
      const body = (await request.json()) as {
        base_tree: string;
        tree: {
          path: string;
          content?: string;
          sha?: string | null;
          mode: string;
          type: string;
        }[];
      };
      expect(body.base_tree).toBe(HEAD_TREE);
      for (const entry of body.tree)
        expect(entry).toMatchObject({ mode: "100644", type: "blob" });
      const files = Object.fromEntries(
        body.tree
          .filter((entry) => entry.content !== undefined)
          .map((entry) => [entry.path, entry.content as string]),
      );
      const gone = body.tree
        .filter((entry) => entry.sha === null)
        .map((entry) => entry.path);
      written.push(files);
      removed.push(gone);
      const same =
        gone.every((path) => options.head[path] === undefined) &&
        Object.entries(files).every(
          ([path, content]) => options.head[path] === content,
        );
      return HttpResponse.json({ sha: same ? HEAD_TREE : "f".repeat(40) });
    }),
    http.post(`${base}/git/commits`, async ({ request }) => {
      expect(await request.json()).toMatchObject({
        tree: "f".repeat(40),
        parents: [expect.stringMatching(/^[a-f0-9]{40}$/)],
      });
      state.commits++;
      return HttpResponse.json({ sha: SETUP_COMMIT });
    }),
    http.patch(`${base}/git/refs/heads/:branch`, async ({ request }) => {
      expect(await request.json()).toEqual({ sha: SETUP_COMMIT });
      return options.advance?.() ?? HttpResponse.json({});
    }),
  );
  return {
    state,
    /** What the branch holds once setup's commit lands: the head plus the last tree written, minus what it removed. */
    files: () => {
      const held = { ...options.head, ...written.at(-1) };
      for (const path of removed.at(-1) ?? []) delete held[path];
      return held;
    },
    /** What the last tree wrote, by path. */
    written: () => written.at(-1) ?? {},
    /** What the last tree removed. */
    removed: () => removed.at(-1) ?? [],
  };
}

/** GitHub's contents API over `files`: folders list their direct files, files answer raw or with their blob id. */
function contentsOf(
  repo: string,
  files: () => Record<string, string>,
  /** The refs the files are served at; any unless given. */
  refs?: () => string[],
) {
  const prefix = `https://api.github.com/repos/${repo}/contents/`;
  return http.get(
    ({ request }) => request.url.startsWith(prefix),
    ({ request }) => {
      const url = new URL(request.url);
      if (refs && !refs().includes(url.searchParams.get("ref") ?? ""))
        return new HttpResponse(null, { status: 404 });
      const path = decodeURIComponent(
        url.pathname.slice(`/repos/${repo}/contents/`.length),
      );
      const held = files();
      const content = held[path];
      if (content !== undefined)
        return request.headers.get("accept")?.includes("raw")
          ? HttpResponse.text(content)
          : HttpResponse.json({ sha: blobSha(content), path });
      const direct = Object.keys(held).filter(
        (file) =>
          file.startsWith(`${path}/`) &&
          !file.slice(path.length + 1).includes("/"),
      );
      if (direct.length === 0) return new HttpResponse(null, { status: 404 });
      return HttpResponse.json(
        direct.map((file) => ({
          type: "file",
          name: file.slice(path.length + 1),
          path: file,
          sha: blobSha(held[file] as string),
          size: Buffer.byteLength(held[file] as string),
        })),
      );
    },
  );
}

function blobSha(content: string): string {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
}
const NOTARY_TOKEN = "APPA_PROVIDER_NOTARY_TOKEN";
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
            sha: SETUP_COMMIT,
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
  });
  test("a validation folder not created yet is kept, so validations run once it exists", async () => {
    let listed = 0;
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/missing",
        ({ request }) => {
          listed++;
          expect(new URL(request.url).searchParams.get("ref")).toBe(commit);
          return new HttpResponse(null, { status: 404 });
        },
      ),
    );
    const response = await configure({
      ...source,
      validationDirectory: "missing",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(listed).toBe(1);
    expect(response.json().validationDirectory).toBe("missing");
    expect(await OpenAppaPolicyTestsModel.find(organizationId)).toMatchObject({
      directory: "missing",
      files: [],
    });
  });
  test("a GitHub refusal other than a missing folder still rejects the source", async () => {
    server.use(
      http.get(
        "https://api.github.com/repos/example/policies/contents/checks",
        () => new HttpResponse(null, { status: 403 }),
      ),
    );
    const response = await configure({
      ...source,
      validationDirectory: "checks",
    });
    expect(response.statusCode).toBe(400);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
  });
  test("editing the repository that awaits its setup pull request keeps waiting on it; another repository does not", async () => {
    await OpenAppaGithubSyncModel.save(organizationId, {
      ...source,
      setupPullRequestNumber: 7,
    });
    // Same repository, new schedule: the template's policy must not be pulled before the merge.
    const same = await configure({ ...source, interval: "1d" });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json().source).toMatchObject({
      repo: source.repo,
      interval: "1d",
      setupPullRequestNumber: 7,
    });
    const other = await configure({ ...source, repo: "example/other" });
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json().source).toMatchObject({
      repo: "example/other",
      setupPullRequestNumber: null,
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
  /** An uploaded battery whose one helper reads NOTARY_TOKEN. */
  const uploadNotary = () =>
    openappaBatteriesService.uploadPackage({
      userId: adminId,
      organizationId,
      name: "notary",
      files: [
        {
          path: "appa-package.toml",
          text: 'schema = 1\nname = "notary"\ndescription = "Checks every call"\n\n[battery]\npolicy = "appa.toml"\nhosts = ["claude-code"]\nhelpers = ["check.py"]\n',
        },
        {
          path: "appa.toml",
          text: `[policy]\nversion = 2\n\n[[policy.annotator]]\nname = "notary.check"\nranks = ["suspicious", "trusted"]\naudiences = ["self"]\nmarks = []\n\n[externals.annotators."notary.check"]\ncommand = ["python3", "check.py"]\ntoken_env = "${NOTARY_TOKEN}"\n`,
        },
        { path: "check.py", text: "print('{}')\n" },
      ],
    });

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
    let templateReads = 0;
    let pullRequests = 0;
    const matchingTemplate = scenario === "matching template";
    const git = fakeGitData("example/new-policy", {
      head: {
        "appa.toml": matchingTemplate ? current : "# The template's example\n",
      },
      advance: () => {
        if (scenario === "direct commit") return undefined;
        if (scenario === "permission denied")
          return HttpResponse.json(
            { message: "Resource not accessible by integration" },
            { status: 403 },
          );
        if (scenario === "unrelated conflict")
          return HttpResponse.json(
            { message: "Reference update failed" },
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
      },
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
      // The branch of a repository GitHub is still creating is not there yet.
      http.get(
        "https://api.github.com/repos/example/new-policy/git/ref/heads/main",
        () => {
          templateReads++;
          if (scenario === "template not ready" && templateReads === 1)
            return new HttpResponse(null, { status: 404 });
          return HttpResponse.json({ object: { sha: commit } });
        },
      ),
      http.get(
        "https://api.github.com/repos/example/new-policy/commits/main",
        () => HttpResponse.json({ sha: commit }),
      ),
      contentsOf("example/new-policy", git.files),
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
      // Bytes the template already holds make no commit at all.
      expect(git.state.commits).toBe(matchingTemplate ? 0 : 1);
      expect(git.files()["appa.toml"]).toBe(current);
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
    expect(git.written()).toEqual({ "appa.toml": current });
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
      fileSha: "b".repeat(40),
      resumes: true,
    },
    {
      scenario: "modified policy",
      isPrivate: true,
      template: "archestra-ai/openappa-config",
      fileSha: "d".repeat(40),
      resumes: false,
    },
    {
      scenario: "public repository",
      isPrivate: false,
      template: "archestra-ai/openappa-config",
      fileSha: "b".repeat(40),
      resumes: false,
    },
    {
      // Not GitHub's copy of the template, but the bundled example's bytes: fresh.
      scenario: "another template, the example unchanged",
      isPrivate: true,
      template: "example/other",
      fileSha: templateExampleBlob(),
      resumes: true,
    },
    {
      scenario: "another template, another policy",
      isPrivate: true,
      template: "example/other",
      fileSha: "d".repeat(40),
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
    const git = fakeGitData("example/new-policy", {
      head: { "appa.toml": "# The template's example\n" },
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
            ? HttpResponse.text(git.files()["appa.toml"] ?? "")
            : HttpResponse.json({ sha: fileSha }),
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
      expect(git.state.commits).toBe(0);
      expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
      return;
    }
    expect(response.statusCode, response.body).toBe(200);
    expect(git.state.commits).toBe(1);
    expect(git.written()).toEqual({
      "appa.toml": (await guardrailsPolicyService.get(organizationId)).content,
    });
    expect(response.json().source.repo).toBe("example/new-policy");
  });

  test("replace switches a running sync to an existing repository with its own validation folder, audited", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-replace-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    await OpenAppaGithubSyncModel.save(organizationId, source);
    const current = (await guardrailsPolicyService.get(organizationId)).content;
    // The repository's own policy stays until the proposal is merged.
    const git = fakeGitData("example/other-policy", {
      head: { "appa.toml": policy },
    });
    let pull: { merged: boolean; state: string } = {
      merged: false,
      state: "open",
    };
    server.use(
      http.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        () =>
          HttpResponse.json({
            token: "test-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
      ),
      http.get("https://api.github.com/repos/example/other-policy", () =>
        HttpResponse.json({ default_branch: "main" }),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/git/ref/heads/main",
        () => HttpResponse.json({ object: { sha: commit } }),
      ),
      http.post(
        "https://api.github.com/repos/example/other-policy/git/refs",
        async ({ request }) => {
          expect(await request.json()).toMatchObject({
            ref: expect.stringMatching(
              /^refs\/heads\/archestra\/openappa-setup-/,
            ),
            sha: SETUP_COMMIT,
          });
          return HttpResponse.json({});
        },
      ),
      http.post(
        "https://api.github.com/repos/example/other-policy/pulls",
        async ({ request }) => {
          expect(await request.json()).toMatchObject({
            title: "Seed current OpenAPPA policy",
            body: expect.stringContaining("in place of the one in this"),
            base: "main",
            head: expect.stringMatching(/^archestra\/openappa-setup-/),
          });
          return HttpResponse.json({ number: 7 });
        },
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/pulls/7",
        () => HttpResponse.json(pull),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/commits/main",
        () => HttpResponse.json({ sha: commit }),
      ),
      contentsOf("example/other-policy", git.files),
    );
    const payload = {
      owner: "example",
      name: "other-policy",
      githubAppConfigId: githubApp.id,
      interval: "1h",
      existing: true,
      validationDirectory: "checks",
    };
    const refused = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload,
    });
    expect(refused.statusCode).toBe(409);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      repo: source.repo,
    });
    expect(git.state.commits).toBe(0);

    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: { ...payload, replace: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    // The current policy is proposed over the repository's, never pulled over.
    expect(git.written()).toEqual({ "appa.toml": current });
    // A policy with no include glob needs no listing of the whole tree, only
    // the trees along the paths it writes.
    expect(git.state.recursiveReads).toBe(0);
    expect(response.json()).toMatchObject({
      validationDirectory: "checks",
      source: {
        repo: "example/other-policy",
        // The branch the pull request merges into, not a default that may move.
        ref: "main",
        path: "appa.toml",
        interval: "1h",
        sourceCommit: null,
        setupPullRequestNumber: 7,
        lastSyncError: null,
      },
    });
    expect(await OpenAppaPolicyTestsModel.find(organizationId)).toMatchObject({
      directory: "checks",
    });
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      current,
    );
    // Merged: what the reviewer merged is pulled, as with any setup pull request.
    pull = { merged: true, state: "closed" };
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      repo: "example/other-policy",
      sourceCommit: commit,
      setupPullRequestNumber: null,
      lastSyncError: null,
    });
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      current,
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
      const switched = records.find(
        (record) =>
          (record.after as { repo?: string } | null)?.repo ===
          "example/other-policy",
      );
      expect(switched?.before).toMatchObject({ repo: source.repo });
      expect(switched?.after).not.toHaveProperty("content");
    });
  });

  test("setting up another repository carries the files the policy reads and its validations", async () => {
    const root = `include = ["rules/*.toml", "teams/ops.toml"]\n\n${policy}`;
    const ledger =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "ledger__export"\ndelta = {}\n';
    const billing =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "billing__refund"\nrequires = { trust = "trusted" }\n';
    const ops =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "ops__restart"\ndelta = {}\n';
    const trace = "# A refund that must be refused\n";
    // The repository the policy is synced from, with the files it reads
    // beside the policy file and the validations in the validation folder.
    // A server's file the policy does not include yet: self-service, which
    // the new repository starts with, includes mcp/*.toml, so it comes along.
    const payments =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "payments_api__refund"\ndelta = {}\n';
    const previous: Record<string, string> = {
      "guardrails/appa.toml": root,
      "guardrails/rules/ledger.toml": ledger,
      "guardrails/rules/billing.toml": billing,
      "guardrails/rules/README.md": "# Not a rules file\n",
      "guardrails/teams/ops.toml": ops,
      "guardrails/mcp/payments_api.toml": payments,
      "traces/refund.appa": trace,
      "traces/README.md": "# Not a validation\n",
    };
    server.use(contentsOf("example/policies", () => previous));
    await OpenAppaGithubSyncModel.save(organizationId, source);
    const row = await OpenAppaGithubSyncModel.find(organizationId);
    expect(
      await OpenAppaGithubSyncModel.finish({
        organizationId,
        revision: row?.revision as string,
        outcome: {
          content: root,
          contentHash: createHash("sha256").update(root).digest("hex"),
          sourceCommit: commit,
        },
      }),
    ).toBe(true);
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-transfer-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    const git = fakeGitData("example/new-policy", {
      head: { "appa.toml": "# The template's example\n" },
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
            { full_name: "example/new-policy", default_branch: "main" },
            { status: 201 },
          ),
      ),
      http.get(
        "https://api.github.com/repos/example/new-policy/commits/main",
        () => HttpResponse.json({ sha: commit }),
      ),
      contentsOf("example/new-policy", git.files),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "new-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
        replace: true,
        selfService: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    // Every included file and validation, at its place beside appa.toml at
    // the root, the servers' file the seed starts including among them; a
    // file no include names stays behind.
    const written = git.written();
    expect(written["appa.toml"]).toContain('"mcp/*.toml"');
    expect(written).toMatchObject({
      "rules/billing.toml": billing,
      "rules/ledger.toml": ledger,
      "teams/ops.toml": ops,
      "mcp/payments_api.toml": payments,
      "traces/refund.appa": trace,
    });
    expect(Object.keys(written).sort()).toEqual([
      "appa.toml",
      "mcp/payments_api.toml",
      "rules/billing.toml",
      "rules/ledger.toml",
      "teams/ops.toml",
      "traces/refund.appa",
    ]);
    expect(git.state.commits).toBe(1);
    // The first pull composes the same policy from the new repository.
    expect(response.json().source).toMatchObject({
      repo: "example/new-policy",
      sourceCommit: commit,
      setupPullRequestNumber: null,
      lastSyncError: null,
    });
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      written["appa.toml"],
    );
  });

  test("a repository's own files the policy's globs would read go out with the proposal, where the reviewer sees them", async () => {
    const root = `include = ["rules/*.toml"]\n\n${policy}`;
    const current =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "ledger__export"\ndelta = {}\n';
    const legacy =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "legacy__anything"\ndelta = {}\n';
    server.use(
      contentsOf("example/policies", () => ({
        "guardrails/appa.toml": root,
        "guardrails/rules/current.toml": current,
      })),
    );
    await OpenAppaGithubSyncModel.save(organizationId, source);
    const row = await OpenAppaGithubSyncModel.find(organizationId);
    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: row?.revision as string,
      outcome: {
        content: root,
        contentHash: createHash("sha256").update(root).digest("hex"),
        sourceCommit: commit,
      },
    });
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-stray-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    // The target holds its own policy, an older copy of the current rules
    // file, and a rules file the policy never had.
    const git = fakeGitData("example/other-policy", {
      head: {
        "appa.toml": policy,
        "rules/current.toml": "# older\n",
        "rules/legacy.toml": legacy,
        "rules/README.md": "# Not a rules file\n",
      },
    });
    let pull: { merged: boolean; state: string; head?: { sha: string } } = {
      merged: false,
      state: "open",
    };
    server.use(
      http.post(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        () =>
          HttpResponse.json({
            token: "test-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
      ),
      http.get("https://api.github.com/repos/example/other-policy", () =>
        HttpResponse.json({ default_branch: "main" }),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/commits",
        () => HttpResponse.json([{ sha: commit }]),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/git/ref/heads/main",
        () => HttpResponse.json({ object: { sha: commit } }),
      ),
      http.post(
        "https://api.github.com/repos/example/other-policy/git/refs",
        () => HttpResponse.json({}),
      ),
      http.post("https://api.github.com/repos/example/other-policy/pulls", () =>
        HttpResponse.json({ number: 8 }),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/pulls/8",
        () => HttpResponse.json({ head: { sha: SETUP_COMMIT }, ...pull }),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/commits/main",
        () => HttpResponse.json({ sha: commit }),
      ),
      // Before the merge the files exist at the request's commit only.
      contentsOf("example/other-policy", git.files, () =>
        pull.merged ? [commit, SETUP_COMMIT] : [SETUP_COMMIT],
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "other-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
        existing: true,
        replace: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(git.written()).toEqual({
      "appa.toml": root,
      "rules/current.toml": current,
    });
    // Removed in the same commit; a file the glob does not read stays.
    expect(git.removed()).toEqual(["rules/legacy.toml"]);
    expect(response.json().source).toMatchObject({
      setupPullRequestNumber: 8,
      ref: "main",
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
    // A commit someone else pushed onto the request moves its head, but the
    // read stays at the commit Archestra opened it with: nothing unmerged
    // reaches the composition.
    expect(git.state.treeReads).toBeGreaterThan(0);
    pull = { ...pull, head: { sha: "d".repeat(40) } };
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
      // A replica that has not kept the request's commit reads nothing.
      vi.setSystemTime(Date.now() + 61_000);
      const get = vi
        .spyOn(cacheManager, "get")
        .mockResolvedValueOnce(undefined);
      try {
        expect(
          await openappaRepositoryIncludes.expand({
            organizationId,
            content: root,
          }),
        ).toMatchObject({
          errors: [expect.stringContaining("accepted no repository commit")],
        });
      } finally {
        get.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
    pull = { merged: true, state: "closed" };
    await syncAppaGithubPolicy(organizationId);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      sourceCommit: commit,
      setupPullRequestNumber: null,
      lastSyncError: null,
    });
    expect(git.files()["rules/legacy.toml"]).toBeUndefined();
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      root,
    );
  });

  test("a repository whose policy file is a symbolic link is refused, with no include glob to list a tree for", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-linked-policy-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    const git = fakeGitData("example/other-policy", {
      head: { "appa.toml": "policies/prod.toml", "policies/prod.toml": policy },
      symlinks: ["appa.toml"],
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
      http.get("https://api.github.com/repos/example/other-policy", () =>
        HttpResponse.json({ default_branch: "main" }),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/commits",
        () => HttpResponse.json([{ sha: commit }]),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/git/ref/heads/main",
        () => HttpResponse.json({ object: { sha: commit } }),
      ),
      contentsOf("example/other-policy", git.files),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "other-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
        existing: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("not a regular file");
    expect(git.state.commits).toBe(0);
    expect(git.state.recursiveReads).toBe(0);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
  });

  test("a repository whose included folder holds a symbolic link is refused, as any proposal is, and nothing is written", async () => {
    const root = `include = ["rules/*.toml"]\n\n${policy}`;
    const current =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "ledger__export"\ndelta = {}\n';
    server.use(
      contentsOf("example/policies", () => ({
        "guardrails/appa.toml": root,
        "guardrails/rules/current.toml": current,
      })),
    );
    await OpenAppaGithubSyncModel.save(organizationId, source);
    const row = await OpenAppaGithubSyncModel.find(organizationId);
    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: row?.revision as string,
      outcome: {
        content: root,
        contentHash: createHash("sha256").update(root).digest("hex"),
        sourceCommit: commit,
      },
    });
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-link-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    const git = fakeGitData("example/other-policy", {
      head: {
        "appa.toml": policy,
        "rules/legacy.toml": "../elsewhere/legacy.toml",
      },
      symlinks: ["rules/legacy.toml"],
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
      http.get("https://api.github.com/repos/example/other-policy", () =>
        HttpResponse.json({ default_branch: "main" }),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/commits",
        () => HttpResponse.json([{ sha: commit }]),
      ),
      http.get(
        "https://api.github.com/repos/example/other-policy/git/ref/heads/main",
        () => HttpResponse.json({ object: { sha: commit } }),
      ),
      contentsOf("example/other-policy", git.files),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "other-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
        existing: true,
        replace: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("not a regular file");
    expect(git.state.commits).toBe(0);
    // The source is left where it was.
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toMatchObject({
      repo: source.repo,
    });
  });

  test("a private repository holding the template's example and a stray rules file is seeded over, the stray file removed", async () => {
    const root = `include = ["rules/*.toml"]\n\n${policy}`;
    const current =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "ledger__export"\ndelta = {}\n';
    const example =
      OPENAPPA_TEMPLATE.files.find((file) => file.path === "appa.toml")
        ?.content ?? "";
    server.use(
      contentsOf("example/policies", () => ({
        "guardrails/appa.toml": root,
        "guardrails/rules/current.toml": current,
      })),
    );
    await OpenAppaGithubSyncModel.save(organizationId, source);
    const row = await OpenAppaGithubSyncModel.find(organizationId);
    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: row?.revision as string,
      outcome: {
        content: root,
        contentHash: createHash("sha256").update(root).digest("hex"),
        sourceCommit: commit,
      },
    });
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-example-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    const git = fakeGitData("example/new-policy", {
      head: {
        "appa.toml": example,
        "rules/legacy.toml":
          '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "legacy__anything"\ndelta = {}\n',
      },
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
      http.get("https://api.github.com/repos/example/new-policy/commits", () =>
        HttpResponse.json([{ sha: commit }]),
      ),
      // Not GitHub's copy of the template: no link, the example's bytes.
      http.get("https://api.github.com/repos/example/new-policy", () =>
        HttpResponse.json({
          full_name: "example/new-policy",
          default_branch: "main",
          private: true,
        }),
      ),
      http.get(
        "https://api.github.com/repos/example/new-policy/commits/main",
        () => HttpResponse.json({ sha: commit }),
      ),
      contentsOf("example/new-policy", git.files),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "new-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
        existing: true,
        replace: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(git.written()).toEqual({
      "appa.toml": root,
      "rules/current.toml": current,
    });
    expect(git.removed()).toEqual(["rules/legacy.toml"]);
    expect(response.json().source).toMatchObject({
      repo: "example/new-policy",
      sourceCommit: commit,
      setupPullRequestNumber: null,
      lastSyncError: null,
    });
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      root,
    );
  });

  test("an empty repository gets the template, the policy and its files; an App without the Workflows permission gets all but the workflow", async () => {
    const root = `include = ["rules/*.toml"]\n\n${policy}`;
    const current =
      '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "ledger__export"\ndelta = {}\n';
    const trace = "# A refund that must be refused\n";
    server.use(
      contentsOf("example/policies", () => ({
        "guardrails/appa.toml": root,
        "guardrails/rules/current.toml": current,
        "traces/refund.appa": trace,
      })),
    );
    await OpenAppaGithubSyncModel.save(organizationId, source);
    const row = await OpenAppaGithubSyncModel.find(organizationId);
    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: row?.revision as string,
      outcome: {
        content: root,
        contentHash: createHash("sha256").update(root).digest("hex"),
        sourceCommit: commit,
      },
    });
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-empty-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    let advances = 0;
    const git = fakeGitData("example/new-policy", {
      head: {},
      advance: () =>
        advances++ === 0
          ? HttpResponse.json(
              {
                message:
                  "Resource not accessible by integration: refusing to allow a GitHub App to create or update workflow `.github/workflows/validate.yml` without `workflows` permission",
              },
              { status: 403 },
            )
          : undefined,
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
      // No commits yet: GitHub answers 409.
      http.get("https://api.github.com/repos/example/new-policy/commits", () =>
        HttpResponse.json(
          { message: "Git Repository is empty." },
          { status: 409 },
        ),
      ),
      http.put(
        "https://api.github.com/repos/example/new-policy/contents/README.md",
        () => HttpResponse.json({ commit: { sha: commit } }),
      ),
      http.get("https://api.github.com/repos/example/new-policy", () =>
        HttpResponse.json({ default_branch: "main" }),
      ),
      http.get(
        "https://api.github.com/repos/example/new-policy/commits/main",
        () => HttpResponse.json({ sha: commit }),
      ),
      contentsOf("example/new-policy", git.files),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "new-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
        existing: true,
        replace: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(advances).toBe(2);
    expect(git.state.commits).toBe(2);
    const files = git.written();
    expect(files[".github/workflows/validate.yml"]).toBeUndefined();
    expect(files).toMatchObject({
      "appa.toml": root,
      "rules/current.toml": current,
      "traces/refund.appa": trace,
    });
    expect(response.json().source).toMatchObject({
      repo: "example/new-policy",
      sourceCommit: commit,
      setupPullRequestNumber: null,
      lastSyncError: null,
    });
  });

  test("a first repository with self-service on seeds the policy with the servers' include, with no commit accepted yet", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-first-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    const git = fakeGitData("example/new-policy", {
      head: { "appa.toml": "# The template's example\n" },
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
            { full_name: "example/new-policy", default_branch: "main" },
            { status: 201 },
          ),
      ),
      http.get(
        "https://api.github.com/repos/example/new-policy/commits/main",
        () => HttpResponse.json({ sha: commit }),
      ),
      contentsOf("example/new-policy", git.files),
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/openappa/github-sync/repository",
      payload: {
        owner: "example",
        name: "new-policy",
        githubAppConfigId: githubApp.id,
        interval: "1h",
        selfService: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    // The seed's own glob names no file yet: nothing to carry, nothing refused.
    expect(Object.keys(git.written())).toEqual(["appa.toml"]);
    expect(git.written()["appa.toml"]).toContain('"mcp/*.toml"');
    expect(response.json().source).toMatchObject({
      repo: "example/new-policy",
      sourceCommit: commit,
      lastSyncError: null,
    });
  });

  test("a policy that reads repository files no commit was accepted for is not moved, and nothing is created", async () => {
    const root = `include = ["teams/ops.toml"]\n\n${policy}`;
    // Kept as the latest revision without a source: nowhere to read teams/ops.toml from.
    expect(
      await GuardrailsPolicyModel.save({
        organizationId,
        content: root,
        contentHash: createHash("sha256").update(root).digest("hex"),
        updatedBy: adminId,
        expectedRevision: 0,
      }),
    ).not.toBeNull();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const installationId = randomUUID();
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-refused-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId,
      secretId: secret.id,
    });
    let created = 0;
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
        () => {
          created++;
          return HttpResponse.json(
            { full_name: "example/new-policy", default_branch: "main" },
            { status: 201 },
          );
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
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain(
      "includes teams/ops.toml from its repository",
    );
    expect(created).toBe(0);
    expect(await OpenAppaGithubSyncModel.find(organizationId)).toBeNull();
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      root,
    );
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
    // A deleted repository reads as one, with the way out, not as a status code.
    expect(failure.json().source.lastSyncError).toMatch(
      /^Repository not found: example\/policies.*deleted or renamed.*Edit source/,
    );
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

  test("auto-merge takes self-service, is off by default, is saved by the action and audited, and the environment variable locks it", async () => {
    const status = () =>
      app.inject({ method: "GET", url: "/api/openappa/github-sync" });
    // A source without self-service: auto-merge has nothing to merge.
    await configure();
    expect((await status()).json().selfService).toMatchObject({
      autoMerge: { enabled: false, setting: false },
    });
    const refused = await action({
      action: "self_service_auto_merge",
      enabled: true,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/needs self-service/);

    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const secret = await secretManager().createSecret(
      { apiToken: privateKey },
      "test-auto-merge-app",
    );
    const githubApp = await GithubAppConfigModel.create({
      organizationId,
      name: "Policy App",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId: randomUUID(),
      secretId: secret.id,
    });
    await OpenAppaGithubSyncModel.save(organizationId, {
      ...source,
      githubAppConfigId: githubApp.id,
      selfService: true,
    });
    const on = await action({
      action: "self_service_auto_merge",
      enabled: true,
    });
    expect(on.statusCode).toBe(200);
    expect(on.json().selfService.autoMerge).toEqual({
      enabled: true,
      setting: true,
    });
    expect(on.json().source.selfServiceAutoMerge).toBe(true);
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, organizationId));
      expect(
        rows.some(
          (row) =>
            (row.before as { selfServiceAutoMerge?: boolean })
              ?.selfServiceAutoMerge === false &&
            (row.after as { selfServiceAutoMerge?: boolean })
              ?.selfServiceAutoMerge === true,
        ),
      ).toBe(true);
    });

    // While the environment variable sets it, it decides, and the setting
    // cannot be edited; unset, the saved setting applies again.
    config.openappa.selfServiceAutoMerge = "disabled";
    try {
      const locked = await action({
        action: "self_service_auto_merge",
        enabled: false,
      });
      expect(locked.statusCode).toBe(400);
      expect(locked.json().error.message).toBe(
        "ARCHESTRA_OPENAPPA_SELF_SERVICE_AUTO_MERGE sets auto-merge for this deployment. Unset it to edit this setting.",
      );
      expect((await status()).json().selfService.autoMerge).toEqual({
        enabled: false,
        setting: true,
        environment: {
          variable: "ARCHESTRA_OPENAPPA_SELF_SERVICE_AUTO_MERGE",
          value: "disabled",
        },
      });
    } finally {
      delete config.openappa.selfServiceAutoMerge;
    }
    const off = await action({
      action: "self_service_auto_merge",
      enabled: false,
    });
    expect(off.json().selfService.autoMerge).toEqual({
      enabled: false,
      setting: false,
    });
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
      lastSyncError: expect.stringContaining("Repository not found"),
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
    await expect(write()).rejects.toThrow("Stop Git sync");
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

  test("a pull whose text names a credential is refused with what to change", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    const lined = `include = ["batteries/github/appa.toml"]\n\n[credentials]\nAPPA_PROVIDER_GITHUB_TOKEN = "github-token"\n\n${policy}`;
    upstream(lined, "b".repeat(40));
    await syncAppaGithubPolicy(organizationId);
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
    const row = await OpenAppaGithubSyncModel.find(organizationId);
    expect(row?.lastSyncError).toContain(
      "remove APPA_PROVIDER_GITHUB_TOKEN from the policy text and bind it with bind_guardrails_credential",
    );

    const profiled = `${policy}\n[externals.jev]\ntoken_env = "APPA_PROVIDER_JEV_API_KEY"\n`;
    upstream(profiled, "c".repeat(40));
    await syncAppaGithubPolicy(organizationId);
    expect(
      (await OpenAppaGithubSyncModel.find(organizationId))?.lastSyncError,
    ).toContain('remove token_env = "APPA_PROVIDER_JEV_API_KEY"');
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
  });

  test("a pull including a bundled battery that reads a stored binding publishes", async () => {
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
    expect(
      (await OpenAppaGithubSyncModel.find(organizationId))?.lastSyncError,
    ).toBeNull();
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: included, revision: 2 });
  });

  test("a pull including an uploaded battery that reads a stored binding is refused", async () => {
    await configure();
    await syncAppaGithubPolicy(organizationId);
    const { entry } = await uploadNotary();
    await OpenAppaCredentialBindingModel.upsert({
      organizationId,
      variable: NOTARY_TOKEN,
      credentialKey: "notary-token",
      updatedBy: adminId,
    });
    upstream(`include = ["${entry}"]\n\n${policy}`, "b".repeat(40));
    await syncAppaGithubPolicy(organizationId);
    expect(
      (await OpenAppaGithubSyncModel.find(organizationId))?.lastSyncError,
    ).toBe(
      `The repository's policy would hand ${NOTARY_TOKEN} to the uploaded notary battery. A pull cannot give a credential to new code; remove the include, or unbind the variable.`,
    );
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ content: policy, revision: 1 });
  });

  test("a pull that loses the revision race publishes nothing", async () => {
    await configure();
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
