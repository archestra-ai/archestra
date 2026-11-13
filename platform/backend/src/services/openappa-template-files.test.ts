import { generateKeyPairSync, randomUUID } from "node:crypto";
import { HttpResponse, http } from "msw";
import config from "@/config";
import GithubAppConfigModel from "@/models/github-app-config";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { OPENAPPA_TEMPLATE } from "@/openappa/template.generated";
import { secretManager } from "@/secrets-manager";
import { createGitlabToken } from "@/services/git-credentials";
import {
  checkDueAppaGithubSyncs,
  getAppaGithubSync,
  syncAppaGithubPolicy,
} from "@/services/openappa-github-sync";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { FakeGitlab } from "@/test/fake-gitlab";
import { useMswServer } from "@/test/msw";
import type {
  AppaPolicyCheck,
  AppaTemplateFiles,
} from "@/types/openappa-github-sync";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture
const server = useMswServer();
// The comparison's outcome is kept in the shared cache.
setupTestCacheManager();

const REPO = "https://api.github.com/repos/example/policies";
const HEAD = "1".repeat(40);
const PROPOSED = "9".repeat(40);
const POLICY = `[policy]
version = 2

[[policy.tool]]
name = "payments_api__export_ledger"
delta = {}

[externals]
timeout_ms = 2000
max_body_bytes = 65536
`;
const TEMPLATE_FILES = Object.fromEntries(
  OPENAPPA_TEMPLATE.files
    .filter((file) => file.path !== "appa.toml")
    .map((file) => [file.path, file.content]),
);
/** The status for a source that is connected: its files' state and its check. */
const syncStatus = async (organizationId: string) =>
  (await getAppaGithubSync(organizationId)) as Awaited<
    ReturnType<typeof getAppaGithubSync>
  > & { templateFiles?: AppaTemplateFiles; check?: AppaPolicyCheck };
const WORKFLOW = ".github/workflows/validate.yml";

/**
 * GitHub for `example/policies` at `HEAD`: the policy and whatever files
 * beside it the test says, the git data API a proposal writes through, and
 * the pull requests it opens, listed and read back.
 */
function serveGithub(state: {
  files: Record<string, string>;
  /** Whether writing a tree fails, as GitHub may for a while. */
  failTrees?: boolean;
}) {
  const pulls: Array<{
    number: number;
    state: "open" | "closed";
    title: string;
    body: string;
    head: string;
    base: string;
  }> = [];
  const trees: Array<Array<{ path: string; content: string }>> = [];
  const commits: Array<{ message: string; parents: string[] }> = [];
  const closed: Array<{ number: string; body: Record<string, unknown> }> = [];
  const edited: Array<{ number: string; body: Record<string, unknown> }> = [];
  const moves: Array<{ sha: string; force?: boolean }> = [];
  server.use(
    http.get("https://api.github.com/app", () =>
      HttpResponse.json({ slug: "acme-guardrails", name: "Policy App" }),
    ),
    http.get(REPO, () => HttpResponse.json({ default_branch: "main" })),
    // Self-service is off: each sync takes away a ruleset it may have left.
    http.get(`${REPO}/rulesets`, () => HttpResponse.json([])),
    http.get(`${REPO}/commits/main`, () => HttpResponse.json({ sha: HEAD })),
    http.get(
      ({ request }) => request.url.startsWith(`${REPO}/contents/`),
      ({ request }) => {
        const url = new URL(request.url);
        const path = decodeURIComponent(
          url.pathname.slice("/repos/example/policies/contents/".length),
        );
        const ref = url.searchParams.get("ref");
        const text = state.files[path];
        // The proposal's commit holds the template's files over the head's.
        const proposed =
          ref === PROPOSED ? (TEMPLATE_FILES[path] ?? text) : text;
        return proposed === undefined
          ? new HttpResponse(null, { status: 404 })
          : HttpResponse.text(proposed);
      },
    ),
    http.get(`${REPO}/pulls`, () =>
      HttpResponse.json(
        pulls
          .filter((pull) => pull.state === "open")
          .map((pull) => ({
            number: pull.number,
            html_url: `https://github.com/example/policies/pull/${pull.number}`,
            head: { sha: PROPOSED },
            merge_commit_sha: null,
            user: { id: 900, login: "acme-guardrails[bot]", type: "Bot" },
          })),
      ),
    ),
    http.get(`${REPO}/pulls/:number`, ({ params }) => {
      const pull = pulls.find(
        (entry) => entry.number === Number(params.number),
      );
      return pull
        ? HttpResponse.json({
            number: pull.number,
            state: pull.state,
            html_url: `https://github.com/example/policies/pull/${pull.number}`,
          })
        : new HttpResponse(null, { status: 404 });
    }),
    http.patch(`${REPO}/pulls/:number`, async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      (body.state === "closed" ? closed : edited).push({
        number: String(params.number),
        body,
      });
      const pull = pulls.find(
        (entry) => entry.number === Number(params.number),
      );
      if (pull && body.state === "closed") pull.state = "closed";
      return HttpResponse.json({});
    }),
    http.get(`${REPO}/pulls/:number/files`, () =>
      HttpResponse.json(
        Object.keys(TEMPLATE_FILES).map((filename) => ({ filename })),
      ),
    ),
    http.get(`${REPO}/commits/:sha/check-runs`, () =>
      HttpResponse.json({ check_runs: [] }),
    ),
    http.post(`${REPO}/check-runs`, () =>
      HttpResponse.json({ id: 1 }, { status: 201 }),
    ),
    http.get(`${REPO}/git/commits/:sha`, () =>
      HttpResponse.json({ tree: { sha: "e".repeat(40) } }),
    ),
    http.post(`${REPO}/git/trees`, async ({ request }) => {
      const body = (await request.json()) as {
        tree: Array<{ path: string; content: string }>;
      };
      // GitHub's rule: a workflow file takes a token minted with Workflows,
      // whatever the App was granted.
      const writesWorkflow = body.tree.some((file) =>
        file.path.startsWith(".github/workflows/"),
      );
      const mayWriteWorkflows = (
        request.headers.get("authorization") ?? ""
      ).includes("workflows");
      if (state.failTrees || (writesWorkflow && !mayWriteWorkflows))
        return HttpResponse.json(
          { message: "Resource not accessible by integration" },
          { status: 403 },
        );
      trees.push(body.tree);
      return HttpResponse.json({ sha: "f".repeat(40) });
    }),
    http.post(`${REPO}/git/commits`, async ({ request }) => {
      commits.push((await request.json()) as (typeof commits)[number]);
      return HttpResponse.json({ sha: PROPOSED });
    }),
    http.delete(
      ({ request }) => request.url.startsWith(`${REPO}/git/refs/heads/`),
      () => new HttpResponse(null, { status: 204 }),
    ),
    http.post(`${REPO}/git/refs`, () => HttpResponse.json({}, { status: 201 })),
    http.patch(
      ({ request }) => request.url.startsWith(`${REPO}/git/refs/heads/`),
      async ({ request }) => {
        moves.push((await request.json()) as (typeof moves)[number]);
        return HttpResponse.json({});
      },
    ),
    http.post(`${REPO}/pulls`, async ({ request }) => {
      const body = (await request.json()) as Omit<
        (typeof pulls)[number],
        "number" | "state"
      >;
      const pull = {
        number: pulls.length + 1,
        state: "open" as const,
        ...body,
      };
      pulls.push(pull);
      return HttpResponse.json({
        number: pull.number,
        html_url: `https://github.com/example/policies/pull/${pull.number}`,
      });
    }),
  );
  return { pulls, trees, commits, closed, edited, moves };
}

/**
 * A GitHub App source for `example/policies`. The installation grants every
 * permission but `lacking`: a token asked for one of those is refused as
 * GitHub refuses it (422), and each token request's permissions are kept.
 */
async function connectApp(
  organizationId: string,
  options: { lacking?: string[] } = {},
) {
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
  const app = await GithubAppConfigModel.create({
    organizationId,
    name: "Policy App",
    githubUrl: "https://api.github.com",
    appId: "123",
    installationId,
    secretId: secret.id,
  });
  await OpenAppaGithubSyncModel.save(organizationId, {
    repo: "example/policies",
    ref: "main",
    path: "appa.toml",
    interval: "1h",
    githubAppConfigId: app.id,
    githubPatId: null,
    validationDirectory: "",
  });
  const tokens: Array<Record<string, string>> = [];
  server.use(
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      async ({ request }) => {
        const text = await request.text();
        const body = text
          ? (JSON.parse(text) as { permissions?: Record<string, string> })
          : {};
        const permissions = body.permissions ?? {};
        tokens.push(permissions);
        if (
          Object.keys(permissions).some((name) =>
            options.lacking?.includes(name),
          )
        )
          return HttpResponse.json(
            {
              message:
                "The permissions requested are not granted to this installation.",
            },
            { status: 422 },
          );
        return HttpResponse.json({
          token: `token-${tokens.length}-${Object.keys(permissions).sort().join("+")}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      },
    ),
  );
  return { tokens, grant: () => options.lacking?.splice(0) };
}

test("a sync proposes the template's files a repository lacks or holds in an older version, once, and reports them current after the merge", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const app = await connectApp(org.id);
  // The repository was made from an older template: its workflow pins an
  // older appa and its README says something else; Dependabot's file and the
  // validations README are as the template has them.
  const files: Record<string, string> = {
    "appa.toml": POLICY,
    ...TEMPLATE_FILES,
    [WORKFLOW]: "name: Validate OpenAPPA policy\n# an older workflow\n",
    "README.md": "# Older README\n",
  };
  const github = serveGithub({ files });

  await syncAppaGithubPolicy(org.id);
  const first = await syncStatus(org.id);
  expect(first.source).toMatchObject({
    sourceCommit: HEAD,
    lastSyncError: null,
  });
  // One pull request, from one commit that writes exactly what differs.
  expect(github.pulls).toEqual([
    expect.objectContaining({
      state: "open",
      title: "Update the OpenAPPA policy repository files",
      head: "archestra/openappa-template",
      base: "main",
      body: expect.stringContaining(`\`${WORKFLOW}\``),
    }),
  ]);
  expect(github.trees[0]?.map((file) => file.path).sort()).toEqual([
    WORKFLOW,
    "README.md",
  ]);
  expect(github.trees[0]?.find((file) => file.path === WORKFLOW)?.content).toBe(
    TEMPLATE_FILES[WORKFLOW],
  );
  expect(github.commits[0]).toMatchObject({ parents: [HEAD] });
  // Written with a token that may write workflows, since the App may.
  expect(app.tokens).toContainEqual(
    expect.objectContaining({ workflows: "write" }),
  );
  expect(first.templateFiles).toMatchObject({
    templateCommit: OPENAPPA_TEMPLATE.commit,
    state: "pull_open",
    paths: [WORKFLOW, "README.md"].sort(),
    pull: { number: 1, url: "https://github.com/example/policies/pull/1" },
  });
  // The policy check goes on the pull request too, self-service or not.
  expect(first.check).toEqual({
    name: config.openappa.policyCheckName,
    state: "posted",
  });
  await checkDueAppaGithubSyncs();

  // The pull request waits: the next sync opens no second one.
  await syncAppaGithubPolicy(org.id);
  expect(github.pulls).toHaveLength(1);
  expect((await syncStatus(org.id)).templateFiles?.state).toBe("pull_open");

  // Merged (or brought current by hand): the files match, the pull request
  // is left as GitHub left it, and nothing more is proposed.
  Object.assign(files, TEMPLATE_FILES);
  for (const pull of github.pulls) pull.state = "closed";
  await syncAppaGithubPolicy(org.id);
  expect(github.pulls).toHaveLength(1);
  expect((await syncStatus(org.id)).templateFiles).toMatchObject({
    state: "current",
    paths: [],
  });
  expect(github.closed).toEqual([]);
});

test("without the Workflows permission the pull request carries the other files and names the workflow it leaves out, and a later sync adds it once granted", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const app = await connectApp(org.id, { lacking: ["workflows"] });
  const github = serveGithub({
    files: {
      "appa.toml": POLICY,
      ...TEMPLATE_FILES,
      [WORKFLOW]: "# older\n",
      "README.md": "# Older README\n",
    },
  });
  await syncAppaGithubPolicy(org.id);
  // The token asked for Workflows was refused: the README goes on its own,
  // with a token minted without it.
  expect(github.trees.map((tree) => tree.map((file) => file.path))).toEqual([
    ["README.md"],
  ]);
  expect(github.pulls).toEqual([
    expect.objectContaining({
      state: "open",
      body: expect.stringContaining(`Left out for now: \`${WORKFLOW}\``),
    }),
  ]);
  expect(await syncStatus(org.id)).toMatchObject({
    source: { lastSyncError: null },
    templateFiles: {
      state: "pull_open",
      paths: [WORKFLOW, "README.md"].sort(),
      withheld: [WORKFLOW],
      detail: expect.stringContaining("Workflows (read and write)"),
      pull: { number: 1 },
    },
  });

  // Granted: the same pull request takes the workflow, written with a token
  // that may write it; nothing is closed or opened anew.
  app.grant();
  await syncAppaGithubPolicy(org.id);
  expect(github.pulls.map((pull) => pull.state)).toEqual(["open"]);
  expect(github.closed).toEqual([]);
  expect(
    github.trees
      .at(-1)
      ?.map((file) => file.path)
      .sort(),
  ).toEqual([WORKFLOW, "README.md"].sort());
  expect(github.moves).toEqual([{ sha: PROPOSED, force: true }]);
  expect(github.edited).toEqual([
    {
      number: "1",
      body: expect.objectContaining({
        title: "Update the OpenAPPA policy repository files",
        body: expect.not.stringContaining("Left out for now"),
      }),
    },
  ]);
  expect((await syncStatus(org.id)).templateFiles).toMatchObject({
    state: "pull_open",
    withheld: [],
    pull: { number: 1 },
  });
  // It waits: the next sync leaves it as it is.
  await syncAppaGithubPolicy(org.id);
  expect(github.moves).toHaveLength(1);
});

test("a proposal GitHub refuses keeps the waiting pull request known, and the next sync updates it", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const app = await connectApp(org.id, { lacking: ["workflows"] });
  const state = {
    files: {
      "appa.toml": POLICY,
      ...TEMPLATE_FILES,
      [WORKFLOW]: "# older\n",
      "README.md": "# Older README\n",
    },
    failTrees: false,
  };
  const github = serveGithub(state);
  await syncAppaGithubPolicy(org.id);
  expect(github.pulls).toHaveLength(1);
  // Granted, but the write fails: nothing is closed, and the settings keep
  // pointing at the pull request that waits.
  app.grant();
  state.failTrees = true;
  await syncAppaGithubPolicy(org.id);
  expect(github.pulls.map((pull) => pull.state)).toEqual(["open"]);
  expect(github.closed).toEqual([]);
  expect((await syncStatus(org.id)).templateFiles).toMatchObject({
    state: "unavailable",
    detail: expect.stringContaining("HTTP 403"),
    pull: { number: 1 },
  });
  // The write works again: the same pull request takes the workflow.
  state.failTrees = false;
  await syncAppaGithubPolicy(org.id);
  expect(github.pulls.map((pull) => pull.state)).toEqual(["open"]);
  expect(github.moves).toHaveLength(1);
  expect((await syncStatus(org.id)).templateFiles).toMatchObject({
    state: "pull_open",
    withheld: [],
    pull: { number: 1 },
  });
});

test("when only the workflow differs and the App may not write it, no pull request opens and the settings say which permission to grant", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  await connectApp(org.id, { lacking: ["workflows"] });
  const github = serveGithub({
    files: { "appa.toml": POLICY, ...TEMPLATE_FILES, [WORKFLOW]: "# older\n" },
  });
  await syncAppaGithubPolicy(org.id);
  expect(github.pulls).toEqual([]);
  expect(await syncStatus(org.id)).toMatchObject({
    source: { lastSyncError: null },
    templateFiles: {
      state: "needs_permission",
      paths: [WORKFLOW],
      withheld: [WORKFLOW],
      detail: expect.stringContaining("Workflows (read and write)"),
    },
  });
});

test("a policy kept elsewhere than the template's layout is not compared with it", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  await connectApp(org.id);
  const saved = await OpenAppaGithubSyncModel.find(org.id);
  await OpenAppaGithubSyncModel.save(org.id, {
    repo: "example/policies",
    ref: "main",
    path: "guardrails/appa.toml",
    interval: "1h",
    githubAppConfigId: saved?.githubAppConfigId ?? null,
    githubPatId: null,
    validationDirectory: "",
  });
  const github = serveGithub({
    files: { "guardrails/appa.toml": POLICY },
  });
  await syncAppaGithubPolicy(org.id);
  expect(github.pulls).toEqual([]);
  expect((await syncStatus(org.id)).templateFiles).toMatchObject({
    state: "not_applicable",
    paths: [],
  });
});

test("on GitLab the template's files are proposed as a merge request, and a merge makes them current", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const GITLAB = "https://gitlab.example.test";
  const gitlab = new FakeGitlab(GITLAB, "glpat-policy");
  server.use(...gitlab.handlers());
  const project = "platform/policies";
  gitlab.addProject({
    path: project,
    files: { "appa.toml": POLICY, "README.md": "# Older README\n" },
  });
  const gitlabTokenId = (
    await createGitlabToken({
      organizationId: org.id,
      data: { name: "GitLab", gitlabUrl: GITLAB, token: "glpat-policy" },
    })
  ).id;
  await OpenAppaGithubSyncModel.save(org.id, {
    repo: project,
    ref: "main",
    path: "appa.toml",
    interval: "1h",
    githubAppConfigId: null,
    githubPatId: null,
    validationDirectory: "",
    gitlabTokenId,
  });

  await syncAppaGithubPolicy(org.id);
  const requests = gitlab.projects.get(project)?.mergeRequests ?? [];
  expect(requests).toEqual([
    expect.objectContaining({
      iid: 1,
      state: "opened",
      title: "Update the OpenAPPA policy repository files",
      targetBranch: "main",
    }),
  ]);
  expect(gitlab.files(project, gitlab.sourceBranch(project, 1))).toMatchObject({
    "appa.toml": POLICY,
    ...TEMPLATE_FILES,
  });
  const status = await syncStatus(org.id);
  expect(status.templateFiles).toMatchObject({
    state: "pull_open",
    paths: Object.keys(TEMPLATE_FILES).sort(),
    pull: { number: 1 },
  });
  // A GitLab token posts no check.
  expect(status.check).toEqual({
    name: config.openappa.policyCheckName,
    state: "none",
  });

  gitlab.merge(project, 1);
  await syncAppaGithubPolicy(org.id);
  expect((await syncStatus(org.id)).templateFiles).toMatchObject({
    state: "current",
    paths: [],
  });
  expect(gitlab.projects.get(project)?.mergeRequests).toHaveLength(1);
});
