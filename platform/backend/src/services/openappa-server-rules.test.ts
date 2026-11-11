import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import GithubAppConfigModel from "@/models/github-app-config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import ToolModel from "@/models/tool";
import { openappaBatteriesService } from "@/openappa/batteries";
import { packageContentHash } from "@/openappa/declarations";
import { secretManager } from "@/secrets-manager";
import { createGitlabToken } from "@/services/git-credentials";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import {
  checkDueAppaGithubSyncs,
  getAppaGithubSync,
  getAppaSelfService,
  getRepositoryProtection,
  syncAppaGithubPolicy,
  updateAppaGithubSync,
} from "@/services/openappa-github-sync";
import { expect, test, vi } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { FakeGitlab } from "@/test/fake-gitlab";
import { useMswServer } from "@/test/msw";
import {
  ensureSelfServiceInclude,
  getServerRules,
  getServerRulesChangeStatus,
  previewServerRulesChange,
  proposeServerRulesChange,
  selfServiceIncludeState,
} from "./openappa-server-rules";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture
const server = useMswServer();
// The real cache, stored in this file's test database: what one replica
// checked, every replica sees.
setupTestCacheManager();
const REPO = "https://api.github.com/repos/example/policies";
const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);
const TREE = "3".repeat(40);
const THIRD = "7".repeat(40);

const RULES = `[policy]
version = 2

[[policy.tool]]
name = "payments_api__export_ledger"
delta = {}

[externals]
timeout_ms = 2000
max_body_bytes = 65536
`;
/** The policy check's name for the tests' App, from the default template. */
const CHECK = "Check OpenAPPA Guardrails";
const INCLUDING = `include = ["mcp/payments_api.toml"]\n${RULES}`;
const REFUNDS = `[policy]
version = 2

[[policy.tool]]
name = "payments_api__refund_payment"
requires = { trust = "trusted" }
`;
const INVOICES = `${REFUNDS}
[[policy.tool]]
name = "payments_api__get_invoice"
delta = { trust = "suspicious" }
`;

/**
 * A repository whose branch head and files the test moves. `reads` counts
 * each file's reads, and the `mcp` folder lists its files with blob ids.
 */
function serveRepository(state: {
  head: string;
  files: Record<string, Record<string, string>>;
  reads?: Record<string, number>;
}) {
  const paths = [
    "appa.toml",
    ".github/CODEOWNERS",
    "mcp/payments_api.toml",
    "mcp/helpdesk.toml",
    "mcp/github.toml",
    "mcp/README.toml",
  ];
  const at = (request: Request) =>
    state.files[new URL(request.url).searchParams.get("ref") ?? ""];
  server.use(
    http.get(`${REPO}/commits/:ref`, () =>
      HttpResponse.json({ sha: state.head }),
    ),
    http.get(`${REPO}/contents`, ({ request }) =>
      HttpResponse.json(
        Object.entries(at(request) ?? {})
          .filter(([path]) => !path.includes("/"))
          .map(([path, text]) => ({
            type: "file",
            name: path,
            path,
            sha: createHash("sha1").update(text).digest("hex"),
          })),
      ),
    ),
    // A folder the repository does not have.
    http.get(`${REPO}/contents/docs`, () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
    http.get(`${REPO}/contents/.github`, ({ request }) => {
      const listed = Object.entries(at(request) ?? {}).filter(([path]) =>
        path.startsWith(".github/"),
      );
      return listed.length === 0
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.json(
            listed.map(([path, text]) => ({
              type: "file",
              name: path.slice(".github/".length),
              path,
              sha: createHash("sha1").update(text).digest("hex"),
            })),
          );
    }),
    http.get(`${REPO}/contents/mcp`, ({ request }) => {
      const listed = Object.entries(at(request) ?? {}).filter(([path]) =>
        path.startsWith("mcp/"),
      );
      return listed.length === 0
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.json([
            ...listed.map(([path, text]) => ({
              type: "file",
              name: path.slice("mcp/".length),
              path,
              sha: createHash("sha1").update(text).digest("hex"),
            })),
            { type: "dir", name: "drafts", path: "mcp/drafts", sha: TREE },
          ]);
    }),
    ...paths.map((path) =>
      http.get(`${REPO}/contents/${path}`, ({ request }) => {
        if (state.reads) state.reads[path] = (state.reads[path] ?? 0) + 1;
        const text = at(request)?.[path];
        return text === undefined
          ? new HttpResponse(null, { status: 404 })
          : HttpResponse.text(text);
      }),
    ),
  );
}

/**
 * A GitHub App source for `example/policies`: every token request is
 * recorded, and one asking for a permission in `refuse` is refused as GitHub
 * refuses a permission the installation was not granted.
 */
async function connectApp(params: {
  organizationId: string;
  refuse?: string[];
  /** The policy file's path; a folder puts the policy in a shared repository. */
  path?: string;
  /** Whether the servers' editors change their own rules; on unless told otherwise. */
  selfService?: boolean;
}) {
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
    organizationId: params.organizationId,
    name: "Policy App",
    githubUrl: "https://api.github.com",
    appId: "123",
    installationId,
    secretId: secret.id,
  });
  await OpenAppaGithubSyncModel.save(params.organizationId, {
    repo: "example/policies",
    ref: "main",
    path: params.path ?? "appa.toml",
    interval: "1h",
    githubAppConfigId: app.id,
    githubPatId: null,
    validationDirectory: "",
    selfService: params.selfService ?? true,
  });
  const tokens: Array<{
    repositories?: string[];
    permissions?: Record<string, string>;
  }> = [];
  server.use(
    // The App as GitHub names it: the policy check is named after it.
    http.get("https://api.github.com/app", () =>
      HttpResponse.json({ slug: "acme-guardrails", name: "Policy App" }),
    ),
    http.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      async ({ request }) => {
        const asked = (await request.json()) as (typeof tokens)[number];
        tokens.push(asked);
        if (
          Object.keys(asked.permissions ?? {}).some((name) =>
            params.refuse?.includes(name),
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
          token: `token-${Object.keys(asked.permissions ?? {})
            .sort()
            .join("-")}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      },
    ),
  );
  return { tokens };
}

/** A sync, which brings the repository's protection in line, and what it found. */
async function syncAndProtect(organizationId: string) {
  await syncAppaGithubPolicy(organizationId);
  return getRepositoryProtection(organizationId);
}

/** A public source read without a credential: the pull alone, no self-service. */
async function connect(params: { organizationId: string }) {
  await OpenAppaGithubSyncModel.save(params.organizationId, {
    repo: "example/policies",
    ref: "main",
    path: "appa.toml",
    interval: "1h",
    githubAppConfigId: null,
    githubPatId: null,
    validationDirectory: "",
  });
}

test("a pull folds in each server file the policy includes, and a change to that file alone recomposes", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  await connect({ organizationId: org.id });
  const state = {
    head: FIRST,
    files: {
      [FIRST]: { "appa.toml": INCLUDING, "mcp/payments_api.toml": REFUNDS },
      [SECOND]: { "appa.toml": INCLUDING, "mcp/payments_api.toml": INVOICES },
    },
  };
  serveRepository(state);

  await syncAppaGithubPolicy(org.id);
  expect(await OpenAppaGithubSyncModel.find(org.id)).toMatchObject({
    sourceCommit: FIRST,
    lastSyncError: null,
  });
  // The policy text is stored as the repository holds it.
  expect(await GuardrailsPolicyModel.findLatest(org.id)).toMatchObject({
    revision: 1,
    content: INCLUDING,
  });
  const first = await openappaBatteriesService.getEffectivePolicy(org.id);
  expect(first.lastError).toBeNull();
  expect(first.content).toContain("payments_api__refund_payment");
  expect(first.content).not.toContain("payments_api__get_invoice");
  expect(first.content).not.toContain("mcp/payments_api.toml");

  state.head = SECOND;
  await syncAppaGithubPolicy(org.id);
  // appa.toml did not change, so neither does its revision; the composition does.
  expect((await GuardrailsPolicyModel.findLatest(org.id))?.revision).toBe(1);
  const second = await openappaBatteriesService.getEffectivePolicy(org.id);
  expect(second.content).toContain("payments_api__get_invoice");
  expect(second.contentHash).not.toBe(first.contentHash);

  // Editing the source forgets the accepted commit until the next pull, so
  // the files cannot be read: the last composition stays enforced, refused
  // with the reason, rather than every governed call failing.
  await connect({ organizationId: org.id });
  const kept = await openappaBatteriesService.recompile(org.id);
  expect(kept.contentHash).toBe(second.contentHash);
  expect(kept.lastError).toContain(
    "Git sync has accepted no repository commit",
  );
});

test("a pull whose policy includes a missing or invalid server file is refused and the accepted policy stays", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  await connect({ organizationId: org.id });
  const state = {
    head: FIRST,
    files: { [FIRST]: { "appa.toml": INCLUDING } } as Record<
      string,
      Record<string, string>
    >,
  };
  serveRepository(state);

  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError).toBe(
    'include: "mcp/payments_api.toml" names no file in the policy repository at this commit',
  );
  expect(await GuardrailsPolicyModel.findLatest(org.id)).toBeNull();

  // Commits never change, so the fixed file arrives in a new one.
  state.head = SECOND;
  state.files[SECOND] = {
    "appa.toml": INCLUDING,
    "mcp/payments_api.toml": "[externals]\ntimeout_ms = 1\n",
  };
  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError).toMatch(
    /^mcp\/payments_api\.toml: an included file may set only .*it sets externals$/,
  );
  expect(await GuardrailsPolicyModel.findLatest(org.id)).toBeNull();
});

test("Git sync refuses a merged server file that reaches beyond its own server, whoever approved it", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  await connect({ organizationId: org.id });
  const state = {
    head: FIRST,
    files: {
      [FIRST]: {
        "appa.toml": INCLUDING,
        "mcp/payments_api.toml": `${REFUNDS}
[[policy.tool]]
name = "helpdesk__reply_to_customer"
delta = {}

[[policy.tool]]
name = "*"
delta = {}

[[policy.sanitizer]]
name = "payments_api.clean"
on = ["tool_output"]
`,
      },
    } as Record<string, Record<string, string>>,
  };
  serveRepository(state);

  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError).toBe(
    "mcp/payments_api.toml may hold only rules for the tools of the MCP server it is named for (payments_api__<tool>) and annotators named payments_api.<name>, and declares no authority or sanitizer; it sets helpdesk__reply_to_customer, *, [[policy.sanitizer]] payments_api.clean",
  );
  expect(await GuardrailsPolicyModel.findLatest(org.id)).toBeNull();
});

test("mcp/*.toml folds in every server's file, which reaches the organization's reviewers and sanitizers, and a new commit reads only the files it changed", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  await connect({ organizationId: org.id });
  const root = `include = ["mcp/*.toml"]
[policy]
version = 2

[[policy.tool]]
name = "payments_api__export_ledger"
delta = {}

[[policy.authority]]
name = "human-approval"

[policy.authority.permits]
attention = ["*"]

[[policy.sanitizer]]
name = "clean-invoice"
on = ["tool_output"]
tags = ["payments"]

[policy.sanitizer.permits]
trust = { from = "suspicious", to = "trusted" }

[externals.sanitizers.clean-invoice]
url = "https://sanitizer.example.com/clean"
`;
  // Human approval through an attention mark the organization's authority
  // permits, and its sanitizer through a tag and a confined result.
  const payments = `[policy]
version = 2

[[policy.tool]]
name = "payments_api__refund_payment"
requires = { attention = ["payments-refund"] }
delta = {}

[[policy.tool]]
name = "mcp/payments_api/get_invoice"
tags = ["payments"]
delta = { trust = "suspicious" }

[policy.deployment]
confined_results = ["mcp/payments_api/get_invoice"]
`;
  const helpdesk = `[policy]
version = 2

[[policy.tool]]
name = "read_ticket"
server = "helpdesk"
delta = { trust = "suspicious" }
`;
  const state = {
    head: FIRST,
    files: {
      [FIRST]: {
        "appa.toml": root,
        "mcp/payments_api.toml": payments,
        "mcp/helpdesk.toml": helpdesk,
      },
      [SECOND]: {
        "appa.toml": root,
        "mcp/payments_api.toml": payments,
        "mcp/helpdesk.toml": `${helpdesk}\n[[policy.tool]]\nname = "helpdesk__close_ticket"\ndelta = {}\n`,
      },
      [THIRD]: {
        "appa.toml": root,
        "mcp/payments_api.toml": payments,
        "mcp/helpdesk.toml": helpdesk,
        "mcp/README.toml": "[policy]\nversion = 2\n",
      },
    } as Record<string, Record<string, string>>,
    reads: {} as Record<string, number>,
  };
  serveRepository(state);

  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError).toBe(
    null,
  );
  const first = await openappaBatteriesService.getEffectivePolicy(org.id);
  expect(first.lastError).toBeNull();
  expect(first.content).toContain("payments-refund");
  expect(first.content).toContain("read_ticket");
  expect(first.content).toMatch(
    /confined_results = \[\s*"mcp\/payments_api\/get_invoice"\s*\]/,
  );

  state.head = SECOND;
  await syncAppaGithubPolicy(org.id);
  const second = await openappaBatteriesService.getEffectivePolicy(org.id);
  expect(second.content).toContain("helpdesk__close_ticket");
  // Payments' file did not change, so it was read once, for the first commit.
  expect(state.reads).toMatchObject({
    "mcp/payments_api.toml": 1,
    "mcp/helpdesk.toml": 2,
  });

  // A file in mcp/ is one server's rules file, named by its tools' prefix.
  state.head = THIRD;
  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError).toBe(
    'mcp/README.toml: mcp/ holds one file per MCP server, named by its tools\' prefix; "README" is not a tool prefix',
  );
});

test("a server's own catch-all covers each of its tools without a rule, and a tool it gains on the next composition", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const catalog = await InternalMcpCatalogModel.create(
    {
      name: "payments_api",
      serverType: "remote",
      serverUrl: "https://payments.example.com/mcp",
      scope: "org",
    },
    {
      organizationId: org.id,
      initialPermissionGrants: [
        {
          subject: { type: "organization", id: "*" },
          actions: ["read", "use"],
        },
      ],
    },
  );
  for (const name of ["refund_payment", "get_invoice"])
    await ToolModel.createToolIfNotExists({
      name: `payments_api__${name}`,
      description: name,
      parameters: {},
      catalogId: catalog.id,
    });
  await connect({ organizationId: org.id });
  serveRepository({
    head: FIRST,
    files: {
      [FIRST]: {
        "appa.toml": `include = ["mcp/*.toml"]\n${RULES}`,
        "mcp/payments_api.toml": `${REFUNDS}
[[policy.tool]]
name = "payments_api__*"
delta = { audience = ["internal"] }
`,
      },
    },
  });

  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError).toBe(
    null,
  );
  const first = await openappaBatteriesService.getEffectivePolicy(org.id);
  expect(first.lastError).toBeNull();
  expect(first.content).toContain('"payments_api__get_invoice"');
  expect(first.content).not.toContain("payments_api__*");
  expect(first.content).not.toContain("payments_api__void_payment");

  await ToolModel.createToolIfNotExists({
    name: "payments_api__void_payment",
    description: "void_payment",
    parameters: {},
    catalogId: catalog.id,
  });
  const second = await openappaBatteriesService.recompile(org.id);
  expect(second.lastError).toBeNull();
  expect(second.content).toContain('"payments_api__void_payment"');
  expect(second.contentHash).not.toBe(first.contentHash);
});

test("each open pull request carries the checks a pull would make on its merge result, posted once per commit", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  await connectApp({ organizationId: org.id });
  const root = `include = ["mcp/*.toml"]\n${RULES}`;
  const goodHead = "9".repeat(40);
  const badHead = "8".repeat(40);
  serveRepository({
    head: FIRST,
    files: {
      [FIRST]: { "appa.toml": root, "mcp/payments_api.toml": REFUNDS },
      // The merge result of a pull request that changes Payments' own rules.
      [THIRD]: { "appa.toml": root, "mcp/payments_api.toml": INVOICES },
      // A pull request GitHub has no merge result for: its head is checked.
      [badHead]: {
        "appa.toml": root,
        "mcp/payments_api.toml": `${REFUNDS}\n[[policy.tool]]\nname = "helpdesk__close_ticket"\ndelta = {}\n`,
      },
    },
  });
  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.sourceCommit).toBe(
    FIRST,
  );

  const runs: Array<{ head_sha: string; conclusion: string; name: string }> =
    [];
  const statuses: Array<{
    sha: string;
    state: string;
    context: string;
    description: string;
  }> = [];
  // The App opened both, so each is read from its commits; the administrator
  // asked for the first, and may change the policy.
  const owner = { id: 900, login: "acme-guardrails[bot]", type: "Bot" };
  server.use(
    http.get("https://api.github.com/app", () =>
      HttpResponse.json({ slug: "acme-guardrails", name: "Policy App" }),
    ),
    http.get(`${REPO}/pulls`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("base")).toBe("main");
      return HttpResponse.json([
        {
          number: 1,
          head: { sha: goodHead },
          merge_commit_sha: THIRD,
          user: owner,
        },
        {
          number: 2,
          head: { sha: badHead },
          merge_commit_sha: null,
          user: owner,
        },
      ]);
    }),
    http.get(`${REPO}/pulls/:number/files`, () =>
      HttpResponse.json([{ filename: "mcp/payments_api.toml" }]),
    ),
    http.get(`${REPO}/pulls/:number/commits`, () =>
      HttpResponse.json([
        {
          sha: goodHead,
          commit: {
            message: `Payments rules\n\nRequested-by: ${admin.email}`,
            verification: { verified: true, reason: "valid" },
          },
          author: { login: "acme-guardrails[bot]", type: "Bot" },
          committer: { login: "acme-guardrails[bot]", type: "Bot" },
        },
      ]),
    ),
    // The App already posted a run on the first head under an earlier name:
    // it is renamed and updated in place, not joined by a second run.
    http.get(`${REPO}/commits/:sha/check-runs`, ({ params, request }) => {
      expect(new URL(request.url).searchParams.get("app_id")).toBe("123");
      return HttpResponse.json({
        check_runs:
          params.sha === goodHead
            ? [{ id: 77, name: "Guardrails policy" }]
            : [],
      });
    }),
    http.patch(`${REPO}/check-runs/77`, async ({ request }) => {
      runs.push({
        head_sha: goodHead,
        ...((await request.json()) as Omit<(typeof runs)[number], "head_sha">),
      });
      return HttpResponse.json({ id: 77 });
    }),
    http.post(`${REPO}/check-runs`, async ({ request }) => {
      runs.push((await request.json()) as (typeof runs)[number]);
      return HttpResponse.json({ id: 1 }, { status: 201 });
    }),
    http.post(`${REPO}/statuses/:sha`, async ({ request, params }) => {
      statuses.push({
        sha: String(params.sha),
        ...((await request.json()) as Omit<(typeof statuses)[number], "sha">),
      });
      return HttpResponse.json({ id: 2 }, { status: 201 });
    }),
  );

  await checkDueAppaGithubSyncs();
  expect(runs).toEqual([
    expect.objectContaining({
      name: CHECK,
      head_sha: goodHead,
      conclusion: "success",
    }),
    expect.objectContaining({
      name: CHECK,
      head_sha: badHead,
      conclusion: "failure",
      output: expect.objectContaining({
        summary: expect.stringMatching(
          /^mcp\/payments_api\.toml may hold only rules for the tools of the MCP server it is named for/,
        ),
      }),
    }),
  ]);
  // Nothing goes out as a commit status: the App posts check runs.
  expect(statuses).toEqual([]);
  // Checking again posts nothing until a commit moves.
  await checkDueAppaGithubSyncs();
  expect(runs).toHaveLength(2);
  // Nothing was applied: the accepted commit is still the first.
  expect((await OpenAppaGithubSyncModel.find(org.id))?.sourceCommit).toBe(
    FIRST,
  );

  // An App that may not post is not asked again every minute.
  let listed = 0;
  server.use(
    http.get(`${REPO}/pulls`, () => {
      listed++;
      return HttpResponse.json([
        { head: { sha: "6".repeat(40) }, merge_commit_sha: null },
      ]);
    }),
    http.post(`${REPO}/check-runs`, () =>
      HttpResponse.json({}, { status: 403 }),
    ),
    http.post(`${REPO}/statuses/:sha`, () =>
      HttpResponse.json({}, { status: 403 }),
    ),
  );
  await checkDueAppaGithubSyncs();
  await checkDueAppaGithubSyncs();
  expect(listed).toBe(1);
});

test("a pull request check retries what failed for now, and checks again when the deployment it was checked against changes", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  await connectApp({ organizationId: org.id });
  const root = `include = ["mcp/*.toml"]\n${RULES}`;
  serveRepository({
    head: FIRST,
    files: {
      [FIRST]: { "appa.toml": root, "mcp/payments_api.toml": REFUNDS },
      [THIRD]: { "appa.toml": root, "mcp/payments_api.toml": INVOICES },
    },
  });
  await syncAppaGithubPolicy(org.id);
  let listed = 0;
  let failPost = true;
  const statuses: Array<{ state: string }> = [];
  server.use(
    http.get(`${REPO}/pulls`, () => {
      listed++;
      return HttpResponse.json([
        { head: { sha: "9".repeat(40) }, merge_commit_sha: THIRD },
      ]);
    }),
    // The App posts check runs; `statuses` records their conclusions.
    http.post(`${REPO}/check-runs`, async ({ request }) => {
      if (failPost) {
        failPost = false;
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }
      const run = (await request.json()) as { conclusion: string };
      statuses.push({ state: run.conclusion });
      return HttpResponse.json({ id: 1 }, { status: 201 });
    }),
  );
  const validate = vi.spyOn(guardrailsPolicyService, "validate");

  // APPA could not check the policy: an outage, not a refusal, so nothing
  // is posted and the next pass checks it.
  validate.mockRejectedValueOnce(new Error("runtime unavailable"));
  await checkDueAppaGithubSyncs();
  expect(statuses).toEqual([]);
  // GitHub failed to take the check: no pause, and the next pass posts it.
  await checkDueAppaGithubSyncs();
  expect(statuses).toEqual([]);
  await checkDueAppaGithubSyncs();
  expect(statuses).toEqual([expect.objectContaining({ state: "success" })]);
  expect(listed).toBe(3);
  // Checked: another pass, on any replica, checks nothing again.
  const checks = validate.mock.calls.length;
  await checkDueAppaGithubSyncs();
  expect(validate.mock.calls.length).toBe(checks);

  // The composition changed: the result is checked again, and an outcome
  // that stays the same posts nothing new.
  await OpenAppaEffectivePolicyModel.invalidate(org.id);
  await checkDueAppaGithubSyncs();
  expect(validate.mock.calls.length).toBe(checks + 1);
  expect(statuses).toHaveLength(1);
  // A change that refuses the result posts the refusal.
  validate.mockResolvedValueOnce({ valid: false, errors: [], warnings: [] });
  await openappaBatteriesService.recompile(org.id);
  await checkDueAppaGithubSyncs();
  expect(statuses).toEqual([
    expect.objectContaining({ state: "success" }),
    expect.objectContaining({ state: "failure" }),
  ]);

  // A credential GitHub refuses outright is left alone for ten minutes.
  let refusedLists = 0;
  server.use(
    http.get(`${REPO}/pulls`, () => {
      refusedLists++;
      return HttpResponse.json({ message: "Bad credentials" }, { status: 401 });
    }),
  );
  await checkDueAppaGithubSyncs();
  await checkDueAppaGithubSyncs();
  expect(refusedLists).toBe(1);
});

test("a server's file cannot replace an annotator of a battery the policy includes", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  await connect({ organizationId: org.id });
  const root = `include = ["batteries/github/appa.toml", "mcp/*.toml"]\n${RULES}`;
  serveRepository({
    head: FIRST,
    files: {
      [FIRST]: {
        "appa.toml": root,
        // An escaped key is still policy.annotator once parsed.
        "mcp/github.toml": `[policy]
version = 2

[[policy."annot\\u0061tor"]]
name = "github.repository-visibility"
builtin = "archestra"
`,
      },
    },
  });

  await syncAppaGithubPolicy(org.id);
  expect(await OpenAppaGithubSyncModel.find(org.id)).toMatchObject({
    sourceCommit: null,
    lastSyncError:
      'mcp/github.toml: the github battery also declares annotator "github.repository-visibility", and a server file cannot replace a battery\'s annotator. Name it github.<another name>.',
  });
});

test("on GitLab, a pull reads every page of mcp/, and the servers' rules stay the organization's: no merge request gets the check, and no rules are proposed", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  const payments = await makeTeam(org.id, admin.id, { name: "Payments" });
  const pat = await makeUser({ name: "Pat" });
  await makeTeamMember(payments.id, pat.id);
  const catalog = await InternalMcpCatalogModel.create(
    {
      name: "payments_api",
      serverType: "remote",
      serverUrl: "https://payments.example.com/mcp",
      scope: "org",
    },
    {
      organizationId: org.id,
      initialPermissionGrants: [
        {
          subject: { type: "team", id: payments.id },
          actions: ["read", "use", "update"],
        },
      ],
    },
  );
  for (const name of ["refund_payment", "get_invoice"])
    await ToolModel.createToolIfNotExists({
      name: `payments_api__${name}`,
      description: name,
      parameters: {},
      catalogId: catalog.id,
    });
  const GITLAB = "https://gitlab.example.test";
  const gitlab = new FakeGitlab(GITLAB, "glpat-policy");
  // Two files a page, so mcp/ spans two pages.
  gitlab.treePageSize = 2;
  server.use(...gitlab.handlers());
  const project = "platform/policies";
  gitlab.addProject({
    path: project,
    files: {
      "appa.toml": `include = ["mcp/*.toml"]\n${RULES}`,
      "mcp/helpdesk.toml": `[policy]\nversion = 2\n\n[[policy.tool]]\nname = "helpdesk__read_ticket"\ndelta = {}\n`,
      "mcp/ledger.toml": `[policy]\nversion = 2\n\n[[policy.tool]]\nname = "ledger__export"\ndelta = {}\n`,
      "mcp/payments_api.toml": REFUNDS,
    },
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
  const accepted = (await OpenAppaGithubSyncModel.find(org.id))?.sourceCommit;
  expect(accepted).toMatch(/^[a-f0-9]{40}$/);
  const effective = await openappaBatteriesService.getEffectivePolicy(org.id);
  expect(effective.lastError).toBeNull();
  // Payments' file is on the second page of mcp/, read from the Link header.
  for (const tool of [
    "helpdesk__read_ticket",
    "ledger__export",
    "payments_api__refund_payment",
  ])
    expect(effective.content).toContain(tool);

  // Self-service is the GitHub App's: a GitLab token posts no check, and
  // keeps no branch rules, so a server's rules are not proposed through it.
  await checkDueAppaGithubSyncs();
  expect(gitlab.statuses).toEqual([]);
  expect(await getRepositoryProtection(org.id)).toBeNull();
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: false });
  await expect(
    proposeServerRulesChange({
      organizationId: org.id,
      userId: pat.id,
      catalogId: catalog.id,
      content: INVOICES,
      expectedCommit: accepted as string,
      summary: "Invoices are suspicious",
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

test("a refused pull request check is checked again once the battery it names is uploaded, and every fifteen minutes", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  await connectApp({ organizationId: org.id });
  // A battery with no helper and no credential: its rules alone.
  const files = [
    {
      path: "appa-package.toml",
      text: `schema = 1
name = "acme"
description = "Acme rules"

[battery]
policy = "appa.toml"
hosts = ["claude-code"]
namespaces = ["acme"]
`,
    },
    {
      path: "appa.toml",
      text: `[policy]
version = 2

[[policy.tool]]
name = "mcp/acme/list"
delta = {}
`,
    },
  ];
  const entry = `batteries/acme@sha256-${packageContentHash(files)}/appa.toml`;
  serveRepository({
    head: FIRST,
    files: {
      [FIRST]: { "appa.toml": RULES },
      // The pull request names the package before anyone uploaded it.
      [THIRD]: { "appa.toml": `include = ["${entry}"]\n${RULES}` },
    },
  });
  await syncAppaGithubPolicy(org.id);
  const statuses: Array<{ state: string }> = [];
  server.use(
    http.get(`${REPO}/pulls`, () =>
      HttpResponse.json([
        { head: { sha: "9".repeat(40) }, merge_commit_sha: THIRD },
      ]),
    ),
    http.post(`${REPO}/check-runs`, async ({ request }) => {
      const run = (await request.json()) as { conclusion: string };
      statuses.push({ state: run.conclusion });
      return HttpResponse.json({ id: 1 }, { status: 201 });
    }),
  );
  const validate = vi.spyOn(guardrailsPolicyService, "validate");

  await checkDueAppaGithubSyncs();
  expect(statuses).toEqual([expect.objectContaining({ state: "failure" })]);
  const checks = validate.mock.calls.length;
  await checkDueAppaGithubSyncs();
  expect(validate.mock.calls.length).toBe(checks);
  // Fifteen minutes on, the refusal is checked again; still refused, it
  // posts nothing new.
  const now = Date.now();
  const later = vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
  await checkDueAppaGithubSyncs();
  later.mockRestore();
  expect(validate.mock.calls.length).toBe(checks + 1);
  expect(statuses).toHaveLength(1);

  // Uploading the package changes neither commit nor the served policy,
  // and the next pass passes the pull request.
  await openappaBatteriesService.uploadPackage({
    userId: admin.id,
    organizationId: org.id,
    name: "acme",
    files,
  });
  await checkDueAppaGithubSyncs();
  expect(statuses).toEqual([
    expect.objectContaining({ state: "failure" }),
    expect.objectContaining({ state: "success" }),
  ]);
});

test("a server's editors propose its rules as a pull request; readers and outsiders cannot", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  const payments = await makeTeam(org.id, admin.id, { name: "Payments" });
  const pat = await makeUser({ name: "Pat" });
  await makeTeamMember(payments.id, pat.id);
  const sam = await makeUser({ name: "Sam" });
  await makeMember(sam.id, org.id);
  const catalog = await InternalMcpCatalogModel.create(
    {
      name: "payments_api",
      serverType: "remote",
      serverUrl: "https://payments.example.com/mcp",
      scope: "org",
    },
    {
      organizationId: org.id,
      initialPermissionGrants: [
        {
          subject: { type: "team", id: payments.id },
          actions: ["read", "use", "update"],
        },
        {
          subject: { type: "organization", id: "*" },
          actions: ["read", "use"],
        },
      ],
    },
  );
  const hidden = await InternalMcpCatalogModel.create(
    {
      name: "ledger",
      serverType: "remote",
      serverUrl: "https://ledger.example.com/mcp",
      scope: "org",
    },
    {
      organizationId: org.id,
      initialPermissionGrants: [
        {
          subject: { type: "team", id: payments.id },
          actions: ["read", "use", "update"],
        },
      ],
    },
  );
  for (const name of ["refund_payment", "get_invoice"])
    await ToolModel.createToolIfNotExists({
      name: `payments_api__${name}`,
      description: name,
      parameters: {},
      catalogId: catalog.id,
    });

  // A server whose name puts another server's prefix in its tools' names.
  const shadow = await InternalMcpCatalogModel.create(
    {
      name: "payments_api__shadow",
      serverType: "remote",
      serverUrl: "https://shadow.example.com/mcp",
      scope: "org",
    },
    {
      organizationId: org.id,
      initialPermissionGrants: [
        {
          subject: { type: "team", id: payments.id },
          actions: ["read", "use", "update"],
        },
      ],
    },
  );
  await ToolModel.createToolIfNotExists({
    name: "payments_api__shadow__export_all",
    description: "export_all",
    parameters: {},
    catalogId: shadow.id,
  });

  await connectApp({ organizationId: org.id });
  serveRepository({ head: FIRST, files: { [FIRST]: { "appa.toml": RULES } } });
  await syncAppaGithubPolicy(org.id);

  const read = await getServerRules({
    organizationId: org.id,
    userId: pat.id,
    catalogId: catalog.id,
  });
  expect(read).toMatchObject({
    canEdit: true,
    path: "mcp/payments_api.toml",
    included: false,
    content: null,
    expectedCommit: FIRST,
    tools: ["payments_api__get_invoice", "payments_api__refund_payment"],
    organizationHelpers: { authorities: [], sanitizers: [] },
  });
  // No file yet: a starter names every tool, and is itself a valid file.
  expect(read.starter).toContain('# name = "payments_api__refund_payment"');
  expect(read.starter).toContain("[policy]\nversion = 2");
  expect(
    await previewServerRulesChange({
      organizationId: org.id,
      userId: pat.id,
      catalogId: catalog.id,
      content: read.starter ?? "",
      expectedCommit: FIRST,
    }),
  ).toMatchObject({ valid: true });
  // Sam may use the server, and read its rules, but not edit it.
  expect(
    await getServerRules({
      organizationId: org.id,
      userId: sam.id,
      catalogId: catalog.id,
    }),
  ).toMatchObject({ canEdit: false });
  const change = {
    organizationId: org.id,
    catalogId: catalog.id,
    content: REFUNDS,
    expectedCommit: FIRST,
  };
  await expect(
    previewServerRulesChange({ ...change, userId: sam.id }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    getServerRules({
      organizationId: org.id,
      userId: sam.id,
      catalogId: hidden.id,
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(
    previewServerRulesChange({
      ...change,
      userId: pat.id,
      content: `${REFUNDS}\n[[policy.tool]]\nname = "helpdesk__close_ticket"\ndelta = {}\n`,
    }),
  ).rejects.toThrow(
    /^mcp\/payments_api\.toml may hold only rules for the tools of the MCP server it is named for .*; it sets helpdesk__close_ticket$/,
  );

  await expect(
    getServerRules({
      organizationId: org.id,
      userId: pat.id,
      catalogId: shadow.id,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await expect(
    previewServerRulesChange({
      ...change,
      userId: pat.id,
      content: `${REFUNDS}\n[[policy.authority]]\nname = "payments_api.anyone"\n`,
    }),
  ).rejects.toThrow(/it sets \[\[policy\.authority\]\] payments_api\.anyone$/);

  const preview = await previewServerRulesChange({ ...change, userId: pat.id });
  expect(preview).toMatchObject({
    stage: "preview",
    valid: true,
    path: "mcp/payments_api.toml",
    before: "",
    after: REFUNDS,
  });
  // The first server file brings every server's in, so no later one needs
  // its own line in appa.toml.
  expect(preview.rootChange).toContain('+include = ["mcp/*.toml"]');

  const trees: Array<{ tree: Array<{ path: string; content: string }> }> = [];
  const commits: Array<{ message: string; author?: unknown }> = [];
  const refs: Array<{ ref: string }> = [];
  const pulls: Array<{ body: string; head: string; base: string }> = [];
  server.use(
    http.get(`${REPO}/git/commits/${FIRST}`, () =>
      HttpResponse.json({ tree: { sha: TREE } }),
    ),
    http.post(`${REPO}/git/trees`, async ({ request }) => {
      trees.push((await request.json()) as (typeof trees)[number]);
      return HttpResponse.json({ sha: "4".repeat(40) });
    }),
    http.post(`${REPO}/git/commits`, async ({ request }) => {
      commits.push((await request.json()) as (typeof commits)[number]);
      return HttpResponse.json({ sha: "5".repeat(40) });
    }),
    http.post(`${REPO}/git/refs`, async ({ request }) => {
      refs.push((await request.json()) as (typeof refs)[number]);
      return HttpResponse.json({});
    }),
    http.post(`${REPO}/pulls`, async ({ request }) => {
      pulls.push((await request.json()) as (typeof pulls)[number]);
      return HttpResponse.json({
        number: 7,
        html_url: "https://github.com/example/policies/pull/7",
      });
    }),
  );
  await expect(
    proposeServerRulesChange({
      ...change,
      userId: sam.id,
      summary: "Refunds need a trusted session",
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  expect(pulls).toHaveLength(0);

  const proposed = await proposeServerRulesChange({
    ...change,
    userId: pat.id,
    summary: "Refunds need a trusted session",
  });
  expect(proposed).toMatchObject({
    delivery: "pull_request",
    number: 7,
    url: "https://github.com/example/policies/pull/7",
  });
  // One commit: the server's file, and appa.toml including every server's.
  expect(trees[0]?.tree.map((file) => file.path)).toEqual([
    "mcp/payments_api.toml",
    "appa.toml",
  ]);
  expect(trees[0]?.tree[0]?.content).toBe(REFUNDS);
  expect(trees[0]?.tree[1]?.content).toContain('"mcp/*.toml"');
  expect(refs[0]?.ref).toMatch(
    /^refs\/heads\/archestra\/openappa-server-payments_api-/,
  );
  // The commit names who asked in its message, which GitHub's signature for
  // the App covers, and sets no author of its own, which would leave it unsigned.
  expect(commits[0]?.message).toMatch(
    new RegExp(`^\\S.*\\n\\nRequested-by: ${pat.email}$`),
  );
  expect(commits[0]).not.toHaveProperty("author");
  expect(pulls[0]).toMatchObject({ base: "main" });
  expect(pulls[0]?.body).toContain("Requested in Archestra by Pat");

  // GitHub refused the pull request: the branch made for it goes too.
  const deleted: string[] = [];
  server.use(
    http.post(`${REPO}/pulls`, () =>
      HttpResponse.json({ message: "Validation Failed" }, { status: 422 }),
    ),
    http.delete(
      ({ request }) => request.url.startsWith(`${REPO}/git/refs/heads/`),
      ({ request }) => {
        deleted.push(
          new URL(request.url).pathname.split("/refs/heads/")[1] ?? "",
        );
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );
  await expect(
    proposeServerRulesChange({
      ...change,
      userId: pat.id,
      summary: "Refunds need a trusted session",
    }),
  ).rejects.toMatchObject({ statusCode: 502 });
  expect(deleted).toEqual([refs[1]?.ref.replace("refs/heads/", "")]);
  // No answer at all: the pull request opened all the same, so it is the
  // proposal, and its branch stays.
  server.use(
    http.post(`${REPO}/pulls`, () => HttpResponse.error()),
    http.get(`${REPO}/pulls`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("head") ===
          `example:${refs[2]?.ref.replace("refs/heads/", "")}`
          ? [
              {
                number: 8,
                html_url: "https://github.com/example/policies/pull/8",
              },
            ]
          : [],
      ),
    ),
  );
  expect(
    await proposeServerRulesChange({
      ...change,
      userId: pat.id,
      summary: "Refunds need a trusted session",
    }),
  ).toMatchObject({ number: 8 });
  expect(deleted).toHaveLength(1);

  server.use(
    http.get(`${REPO}/pulls/7`, () =>
      HttpResponse.json({
        number: 7,
        html_url: "https://github.com/example/policies/pull/7",
        state: "closed",
        merged: true,
        merge_commit_sha: "6".repeat(40),
        head: { ref: refs[0]?.ref.replace("refs/heads/", "") },
      }),
    ),
    // The accepted commit is still the base: it does not contain the merge.
    http.get(`${REPO}/compare/${"6".repeat(40)}...${FIRST}`, () =>
      HttpResponse.json({ status: "behind" }),
    ),
  );
  expect(
    await getServerRulesChangeStatus({
      organizationId: org.id,
      userId: pat.id,
      catalogId: catalog.id,
      number: 7,
    }),
  ).toMatchObject({ state: "merged", applied: false });
  // Merged and not pulled yet: a sync is queued instead of waiting an hour.
  const queued = await db
    .select()
    .from(schema.tasksTable)
    .where(eq(schema.tasksTable.taskType, "openappa_github_sync"));
  expect(queued.map((task) => task.payload)).toContainEqual({
    organizationId: org.id,
  });
});

test("each job's GitHub App token covers the policy repository and its own permissions only, and a permission the App lacks is reported", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const { tokens } = await connectApp({
    organizationId: org.id,
    refuse: ["administration", "checks"],
  });
  serveRepository({
    head: FIRST,
    files: {
      [FIRST]: {
        "appa.toml": `include = ["mcp/*.toml"]\n${RULES}`,
        "mcp/payments_api.toml": REFUNDS,
      },
    },
  });
  server.use(http.get(`${REPO}/pulls`, () => HttpResponse.json([])));

  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError).toBe(
    null,
  );
  // Every token names the policy repository alone and the job's permissions.
  expect(
    tokens.every((token) => token.repositories?.join() === "policies"),
  ).toBe(true);
  expect(tokens.map((token) => token.permissions)).toEqual(
    expect.arrayContaining([
      { contents: "read", pull_requests: "read" },
      { contents: "read" },
      { administration: "write" },
    ]),
  );
  const protection = await getRepositoryProtection(org.id);
  expect(protection?.branchRules).toMatchObject({
    state: "needs_permission",
    detail: expect.stringContaining("Administration (read and write)"),
  });

  // A check token the App was not granted backs off instead of failing.
  await checkDueAppaGithubSyncs();
  expect(tokens.at(-1)?.permissions).toEqual({
    checks: "write",
    pull_requests: "read",
  });
});

test("Archestra keeps one ruleset on the synced branch that requires the policy check: it creates it, restores the rule, keeps what an administrator added, renames its own, and turns one back on", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  await connectApp({ organizationId: org.id });
  serveRepository({
    head: FIRST,
    files: { [FIRST]: { "appa.toml": RULES } },
  });
  let existing: Record<string, unknown> | null = null;
  let listed: Array<Record<string, unknown>> = [];
  const written: Array<{ method: string; body: Record<string, unknown> }> = [];
  server.use(
    http.get(`${REPO}/pulls`, () => HttpResponse.json([])),
    http.get(`${REPO}/rulesets`, () => HttpResponse.json(listed)),
    http.post(`${REPO}/rulesets`, async ({ request }) => {
      written.push({ method: "POST", body: (await request.json()) as never });
      return HttpResponse.json({ id: 5 }, { status: 201 });
    }),
    http.get(`${REPO}/rulesets/5`, () => HttpResponse.json(existing)),
    http.put(`${REPO}/rulesets/5`, async ({ request }) => {
      written.push({ method: "PUT", body: (await request.json()) as never });
      return HttpResponse.json({ id: 5 });
    }),
  );
  const ourRule = {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: [{ context: CHECK, integration_id: 123 }],
    },
  };

  // Missing: created, with the one rule and nothing else.
  await syncAppaGithubPolicy(org.id);
  expect(written).toEqual([
    {
      method: "POST",
      body: {
        name: CHECK,
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        bypass_actors: [],
        rules: [ourRule],
      },
    },
  ]);

  // Read back as GitHub stores it, with its own defaults added: complete.
  listed = [{ id: 5, name: CHECK, source_type: "Repository" }];
  existing = {
    id: 5,
    name: CHECK,
    target: "branch",
    source_type: "Repository",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: CHECK, integration_id: 123 }],
          strict_required_status_checks_policy: false,
        },
      },
    ],
  };
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
  });
  expect(written).toHaveLength(1);

  // An administrator added rules, a bypass entry and made the check strict,
  // then someone took the check out: the check comes back; the rest stays.
  existing = {
    ...existing,
    bypass_actors: [
      { actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" },
    ],
    rules: [
      { type: "deletion" },
      {
        type: "pull_request",
        parameters: { required_approving_review_count: 2 },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "ci" }],
        },
      },
    ],
  };
  written.length = 0;
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
    bypassActors: 1,
  });
  expect(written).toEqual([
    {
      method: "PUT",
      body: {
        name: CHECK,
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        bypass_actors: [
          { actor_id: 1, actor_type: "RepositoryRole", bypass_mode: "always" },
        ],
        rules: [
          { type: "deletion" },
          {
            type: "pull_request",
            parameters: { required_approving_review_count: 2 },
          },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "ci" },
                { context: CHECK, integration_id: 123 },
              ],
            },
          },
        ],
      },
    },
  ]);

  // The deployment's check was renamed: its ruleset, found by its shape, is
  // renamed too, and the required context with it.
  listed = [{ id: 5, name: "Guardrails policy", source_type: "Repository" }];
  existing = {
    id: 5,
    name: "Guardrails policy",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [
            { context: "Guardrails policy", integration_id: 123 },
          ],
        },
      },
    ],
  };
  written.length = 0;
  await syncAndProtect(org.id);
  expect(written).toEqual([
    {
      method: "PUT",
      body: expect.objectContaining({
        name: CHECK,
        rules: [ourRule],
      }),
    },
  ]);

  // A ruleset of the repository's own that requires the check among other
  // things is not adopted: ours is created beside it.
  listed = [{ id: 7, name: "Release rules", source_type: "Repository" }];
  server.use(
    http.get(`${REPO}/rulesets/7`, () =>
      HttpResponse.json({
        id: 7,
        name: "Release rules",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        rules: [
          { type: "deletion" },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [{ context: CHECK, integration_id: 123 }],
            },
          },
        ],
      }),
    ),
  );
  written.length = 0;
  await syncAndProtect(org.id);
  expect(written).toEqual([
    { method: "POST", body: expect.objectContaining({ rules: [ourRule] }) },
  ]);

  // Turned off on GitHub: turned back on, with its rule. Only turning
  // self-service off takes the ruleset away.
  listed = [{ id: 5, name: CHECK, source_type: "Repository" }];
  existing = {
    ...existing,
    name: CHECK,
    enforcement: "disabled",
  };
  written.length = 0;
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
  });
  expect(written).toEqual([
    {
      method: "PUT",
      body: expect.objectContaining({
        enforcement: "active",
        rules: [ourRule],
      }),
    },
  ]);
});

test("self-service is opt-in: off, no check is posted, no ruleset is kept and server rules are not read; on brings the ruleset at once; the environment variable locks the setting; off again takes the ruleset away, and so does stopping the sync", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  const catalog = await InternalMcpCatalogModel.create(
    {
      name: "payments_api",
      serverType: "remote",
      serverUrl: "https://payments.example.com/mcp",
      scope: "org",
    },
    { organizationId: org.id },
  );
  await ToolModel.createToolIfNotExists({
    name: "payments_api__refund_payment",
    description: "refund_payment",
    parameters: {},
    catalogId: catalog.id,
  });
  await connectApp({ organizationId: org.id, selfService: false });
  serveRepository({ head: FIRST, files: { [FIRST]: { "appa.toml": RULES } } });
  const ourCheck = {
    context: CHECK,
    integration_id: 123,
  };
  const ours = {
    id: 5,
    name: CHECK,
    target: "branch",
    source_type: "Repository",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [ourCheck],
        },
      },
    ],
  };
  // The repository's own ruleset, which an administrator made require the check too.
  const theirs = {
    id: 7,
    name: "Release rules",
    target: "branch",
    source_type: "Repository",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "ci" }, ourCheck],
        },
      },
    ],
  };
  let listed: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  let written: unknown = null;
  server.use(
    http.get(`${REPO}/pulls`, () => {
      calls.push("GET pulls");
      return HttpResponse.json([]);
    }),
    http.get(`${REPO}/rulesets`, () => HttpResponse.json(listed)),
    http.post(`${REPO}/rulesets`, () => {
      calls.push("POST rulesets");
      return HttpResponse.json({ id: 5 }, { status: 201 });
    }),
    http.get(`${REPO}/rulesets/5`, () => HttpResponse.json(ours)),
    http.get(`${REPO}/rulesets/7`, () => HttpResponse.json(theirs)),
    http.put(`${REPO}/rulesets/:id`, async ({ params, request }) => {
      calls.push(`PUT ${params.id}`);
      written = await request.json();
      return HttpResponse.json({ id: Number(params.id) });
    }),
    http.delete(`${REPO}/rulesets/:id`, ({ params }) => {
      calls.push(`DELETE ${params.id}`);
      return new HttpResponse(null, { status: 204 });
    }),
  );

  // Off: the sync keeps no ruleset, the minute's check reads no pull
  // request, the registry shows no action, and the Keeper's tools refuse.
  await syncAppaGithubPolicy(org.id);
  expect(await getRepositoryProtection(org.id)).toBeNull();
  await checkDueAppaGithubSyncs();
  expect(calls).toEqual([]);
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: false });
  expect((await getAppaGithubSync(org.id)).selfService).toEqual({
    enabled: false,
    setting: false,
    directory: "mcp",
  });
  await expect(
    getServerRules({
      organizationId: org.id,
      userId: admin.id,
      catalogId: catalog.id,
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining("Self-service MCP Guardrails is off"),
  });

  // On: the ruleset comes at once, and the checks with it.
  const on = await updateAppaGithubSync({
    organizationId: org.id,
    action: "self_service",
    enabled: true,
  });
  expect(on.selfService).toEqual({
    enabled: true,
    setting: true,
    directory: "mcp",
  });
  expect(calls).toEqual(["POST rulesets"]);
  listed = [
    { id: 5, name: CHECK, source_type: "Repository" },
    { id: 7, name: "Release rules", source_type: "Repository" },
  ];
  expect((await getRepositoryProtection(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
  });
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: true });
  await checkDueAppaGithubSyncs();
  expect(calls).toEqual(["POST rulesets", "GET pulls"]);

  // The environment variable, while set, decides, and the setting cannot
  // be edited; unset, the saved setting applies again.
  config.openappa.selfService = "disabled";
  try {
    expect((await getAppaGithubSync(org.id)).selfService).toEqual({
      enabled: false,
      setting: true,
      directory: "mcp",
      environment: {
        variable: "ARCHESTRA_OPENAPPA_SELF_SERVICE",
        value: "disabled",
      },
    });
    expect(await getAppaSelfService(org.id)).toEqual({ enabled: false });
    await expect(
      updateAppaGithubSync({
        organizationId: org.id,
        action: "self_service",
        enabled: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining("ARCHESTRA_OPENAPPA_SELF_SERVICE"),
    });
    // Off by the variable: the next sync takes the ruleset away, and the
    // check out of the repository's own, as the setting would.
    calls.length = 0;
    await syncAppaGithubPolicy(org.id);
    expect(calls).toEqual(["DELETE 5", "PUT 7"]);
    expect(await getRepositoryProtection(org.id)).toBeNull();
    config.openappa.selfService = "enabled";
    await OpenAppaGithubSyncModel.setSelfService(org.id, false);
    expect((await getAppaGithubSync(org.id)).selfService).toMatchObject({
      enabled: true,
      setting: false,
    });
    expect(await getAppaSelfService(org.id)).toEqual({ enabled: true });
  } finally {
    delete config.openappa.selfService;
  }
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: false });
  await OpenAppaGithubSyncModel.setSelfService(org.id, true);

  // Off again: Archestra's ruleset is deleted, and its check leaves the
  // repository's own ruleset, which keeps the rest.
  calls.length = 0;
  const off = await updateAppaGithubSync({
    organizationId: org.id,
    action: "self_service",
    enabled: false,
  });
  expect(off.selfService).toEqual({
    enabled: false,
    setting: false,
    directory: "mcp",
  });
  expect(calls).toEqual(["DELETE 5", "PUT 7"]);
  expect(written).toEqual({
    name: "Release rules",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "ci" }],
        },
      },
    ],
  });
  expect(await getRepositoryProtection(org.id)).toBeNull();

  // Stopping the sync takes the ruleset away too: nothing posts the check then.
  await updateAppaGithubSync({
    organizationId: org.id,
    action: "self_service",
    enabled: true,
  });
  listed = [{ id: 5, name: CHECK, source_type: "Repository" }];
  calls.length = 0;
  await updateAppaGithubSync({ organizationId: org.id, action: "disconnect" });
  expect(calls).toEqual(["DELETE 5"]);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.interval).toBeNull();
});

test("without the Checks permission no ruleset is created, one that already requires the check is reported as holding pull requests, and the grant brings it", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const refuse = ["checks"];
  await connectApp({ organizationId: org.id, refuse });
  serveRepository({
    head: FIRST,
    files: { [FIRST]: { "appa.toml": RULES } },
  });
  let listed: Array<Record<string, unknown>> = [];
  const written: string[] = [];
  const withCheck = {
    id: 5,
    name: CHECK,
    target: "branch",
    source_type: "Repository",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [{ context: CHECK, integration_id: 123 }],
        },
      },
    ],
  };
  server.use(
    http.get(`${REPO}/pulls`, () => HttpResponse.json([])),
    http.get(`${REPO}/rulesets`, () => HttpResponse.json(listed)),
    http.get(`${REPO}/rulesets/5`, () => HttpResponse.json(withCheck)),
    http.post(`${REPO}/rulesets`, () => {
      written.push("POST");
      return HttpResponse.json({ id: 5 }, { status: 201 });
    }),
  );
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "needs_permission",
    detail: expect.stringContaining("Checks (read and write)"),
  });
  expect(written).toEqual([]);

  listed = [{ id: 5, name: CHECK, source_type: "Repository" }];
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
    checkRule: "unposted",
    detail: expect.stringContaining("Checks (read and write)"),
  });
  expect(written).toEqual([]);

  refuse.length = 0;
  listed = [];
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
  });
  expect(written).toEqual(["POST"]);
});

test("the policy check judges who asked for a pull request Archestra opened, reads the policy alone for one a person opened, and skips one that changes nothing it reads", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
  makeTeamMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser({ email: "admin@example.com" });
  await makeMember(admin.id, org.id, { role: "admin" });
  const payments = await makeTeam(org.id, admin.id, { name: "Payments" });
  const pat = await makeUser({ email: "pat@example.com" });
  await makeTeamMember(payments.id, pat.id);
  const sam = await makeUser({ email: "sam@example.com" });
  await makeMember(sam.id, org.id);
  const riley = await makeUser({ email: "riley@example.com" });
  await makeMember(riley.id, org.id);
  const servers = [
    { name: "payments_api", grant: { type: "team", id: payments.id } },
    { name: "helpdesk", grant: { type: "user", id: sam.id } },
  ] as const;
  for (const { name, grant } of servers) {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name,
        serverType: "remote",
        serverUrl: `https://${name}.example.com/mcp`,
        scope: "org",
      },
      {
        organizationId: org.id,
        initialPermissionGrants: [
          { subject: { ...grant }, actions: ["read", "use", "update"] },
          {
            subject: { type: "organization", id: "*" },
            actions: ["read", "use"],
          },
        ],
      },
    );
    await ToolModel.createToolIfNotExists({
      name: `${name}__read`,
      description: "read",
      parameters: {},
      catalogId: catalog.id,
    });
  }
  await connectApp({ organizationId: org.id });
  const root = `include = ["mcp/*.toml"]\n${RULES}`;
  const results = Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((number) => [number, String(number).repeat(40)]),
  ) as Record<number, string>;
  serveRepository({
    head: FIRST,
    files: {
      [FIRST]: { "appa.toml": root, "mcp/payments_api.toml": REFUNDS },
      // Every result is a valid policy: only who asked tells them apart.
      ...Object.fromEntries(
        Object.values(results).map((sha) => [
          sha,
          { "appa.toml": root, "mcp/payments_api.toml": INVOICES },
        ]),
      ),
    },
  });
  await syncAppaGithubPolicy(org.id);

  const bot = { id: 900, login: "acme-guardrails[bot]", type: "Bot" };
  // A commit the App made through its API: GitHub signed it, the App is its
  // author, and the committer is the App or GitHub's web-flow (Contents API).
  const signed = (email: string, sha: string, committer = bot.login) => ({
    sha,
    commit: {
      message: `Guardrails rules for Payments API\n\nRequested-by: ${email}`,
      verification: { verified: true, reason: "valid" },
    },
    author: bot,
    committer: {
      login: committer,
      type: committer === bot.login ? "Bot" : "User",
    },
  });
  const pulls: Record<
    number,
    { user: typeof bot; files: string[]; commits: unknown[] }
  > = {
    // Opened by the App for Pat, an editor of Payments API.
    1: {
      user: bot,
      files: ["mcp/payments_api.toml"],
      commits: [signed(pat.email, results[1] as string, "web-flow")],
    },
    // Opened by the App for Sam, who may not edit Payments API.
    2: {
      user: bot,
      files: ["mcp/payments_api.toml"],
      commits: [signed(sam.email, results[2] as string)],
    },
    // The App's branch, with a commit someone else pushed.
    3: {
      user: bot,
      files: ["mcp/payments_api.toml"],
      commits: [
        signed(pat.email, "c".repeat(40)),
        {
          sha: results[3],
          commit: {
            message: `Also mine\n\nRequested-by: ${pat.email}`,
            verification: { verified: false, reason: "unsigned" },
          },
          author: { login: "mallory", type: "User" },
          committer: { login: "mallory", type: "User" },
        },
      ],
    },
    // Opened by a person on GitHub, changing the policy file: GitHub's own
    // permissions and reviews decide; the policy alone is checked.
    4: {
      user: { id: 1004, login: "riley-gh", type: "User" },
      files: ["appa.toml"],
      commits: [],
    },
    // Opened by a person on GitHub, changing a server file: the same.
    5: {
      user: { id: 1002, login: "sam-gh", type: "User" },
      files: ["mcp/helpdesk.toml"],
      commits: [],
    },
    // Changing nothing Git sync reads: skipped, not held.
    6: {
      user: { id: 1004, login: "riley-gh", type: "User" },
      files: ["README.md", ".github/workflows/validate.yml"],
      commits: [],
    },
  };
  const runs: Array<{
    head_sha: string;
    conclusion: string;
    output: { title: string; summary: string };
  }> = [];
  server.use(
    http.get("https://api.github.com/app", () =>
      HttpResponse.json({ slug: "acme-guardrails", name: "Policy App" }),
    ),
    http.get(`${REPO}/pulls`, () =>
      HttpResponse.json(
        Object.entries(pulls).map(([number, pull]) => ({
          number: Number(number),
          head: { sha: results[Number(number)] },
          merge_commit_sha: null,
          user: pull.user,
        })),
      ),
    ),
    http.get(`${REPO}/pulls/:number/files`, ({ params }) =>
      HttpResponse.json(
        pulls[Number(params.number)]?.files.map((filename) => ({ filename })),
      ),
    ),
    http.get(`${REPO}/pulls/:number/commits`, ({ params }) =>
      HttpResponse.json(pulls[Number(params.number)]?.commits),
    ),
    http.post(`${REPO}/check-runs`, async ({ request }) => {
      runs.push((await request.json()) as (typeof runs)[number]);
      return HttpResponse.json({ id: 1 }, { status: 201 });
    }),
  );
  await checkDueAppaGithubSyncs();
  const posted = Object.fromEntries(
    runs.map((run) => [
      run.head_sha,
      { conclusion: run.conclusion, ...run.output },
    ]),
  );
  expect(posted[results[1] as string]).toMatchObject({ conclusion: "success" });
  expect(posted[results[2] as string]).toEqual({
    conclusion: "failure",
    title: "The requester may not change these rules",
    summary:
      "sam@example.com may not change mcp/payments_api.toml: that takes edit access to the MCP server payments_api in the MCP registry.",
  });
  expect(posted[results[3] as string]).toMatchObject({
    conclusion: "failure",
    title: "Could not tell who asked for this change",
    summary: expect.stringContaining("commits Archestra did not make"),
  });
  // A person's pull request is the repository's business: the policy alone is checked.
  expect(posted[results[4] as string]).toMatchObject({
    conclusion: "success",
    title: "Git sync would accept this policy",
  });
  expect(posted[results[5] as string]).toMatchObject({
    conclusion: "success",
  });
  expect(posted[results[6] as string]).toMatchObject({
    conclusion: "skipped",
    title: "No policy files changed",
  });
  expect(runs).toHaveLength(6);
  // Nothing moved: nothing is posted again.
  await checkDueAppaGithubSyncs();
  expect(runs).toHaveLength(6);
});

test("a policy in a folder of a repository that holds other work gets the same one-rule ruleset, and a pull request that changes no policy file gets the check as skipped at once", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  await connectApp({ organizationId: org.id, path: "guardrails/appa.toml" });
  const rulesetWrites: unknown[] = [];
  const runs: Array<{ head_sha: string; conclusion: string }> = [];
  const head = "a".repeat(40);
  server.use(
    http.get("https://api.github.com/app", () =>
      HttpResponse.json({ slug: "acme-guardrails", name: "Policy App" }),
    ),
    http.get(`${REPO}/commits/:ref`, () => HttpResponse.json({ sha: FIRST })),
    http.get(`${REPO}/contents/guardrails`, () =>
      HttpResponse.json([
        {
          type: "file",
          name: "appa.toml",
          path: "guardrails/appa.toml",
          sha: createHash("sha1").update(RULES).digest("hex"),
        },
      ]),
    ),
    http.get(`${REPO}/contents/guardrails/appa.toml`, () =>
      HttpResponse.text(RULES),
    ),
    http.get(`${REPO}/rulesets`, () => HttpResponse.json([])),
    http.post(`${REPO}/rulesets`, async ({ request }) => {
      rulesetWrites.push(await request.json());
      return HttpResponse.json({ id: 5 }, { status: 201 });
    }),
    http.get(`${REPO}/pulls`, () =>
      HttpResponse.json([
        {
          number: 1,
          head: { sha: head },
          merge_commit_sha: null,
          user: { id: 1, login: "dev", type: "User" },
        },
      ]),
    ),
    http.get(`${REPO}/pulls/:number/files`, () =>
      HttpResponse.json([{ filename: "src/app/main.ts" }]),
    ),
    http.post(`${REPO}/check-runs`, async ({ request }) => {
      runs.push((await request.json()) as (typeof runs)[number]);
      return HttpResponse.json({ id: 1 }, { status: 201 });
    }),
  );
  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.sourceCommit).toBe(
    FIRST,
  );
  // The one rule, and nothing else about the branch.
  expect(rulesetWrites).toEqual([
    expect.objectContaining({
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: CHECK, integration_id: 123 }],
          },
        },
      ],
    }),
  ]);
  // A product pull request: the check is posted as skipped, once, and no
  // policy is read for it.
  await checkDueAppaGithubSyncs();
  await checkDueAppaGithubSyncs();
  expect(runs).toEqual([
    expect.objectContaining({ head_sha: head, conclusion: "skipped" }),
  ]);
});

test("the self-service folder is chosen when turning on: the servers' files live there, one pull request in the administrator's name includes it, an include already in place or on its way needs none, a stale one is closed, and the folder cannot move while on", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser({ name: "Alex" });
  await makeMember(admin.id, org.id, { role: "admin" });
  const catalog = await InternalMcpCatalogModel.create(
    {
      name: "payments_api",
      serverType: "remote",
      serverUrl: "https://payments.example.com/mcp",
      scope: "org",
    },
    { organizationId: org.id },
  );
  await ToolModel.createToolIfNotExists({
    name: "payments_api__refund_payment",
    description: "refund_payment",
    parameters: {},
    catalogId: catalog.id,
  });
  await connectApp({ organizationId: org.id, selfService: false });
  const INCLUDED = `include = ["rules/servers/*.toml"]\n${RULES}`;
  const PULL_HEAD = "6".repeat(40);
  const STALE_HEAD = "7".repeat(40);
  const files: Record<string, Record<string, string>> = {
    [FIRST]: { "appa.toml": RULES },
    [SECOND]: { "appa.toml": INCLUDED },
    main: { "appa.toml": RULES },
    [PULL_HEAD]: { "appa.toml": INCLUDED },
    // Our earlier pull request, for the default folder.
    [STALE_HEAD]: { "appa.toml": `include = ["mcp/*.toml"]\n${RULES}` },
  };
  serveRepository({ head: FIRST, files });
  let openPulls: Array<{
    number: number;
    html_url: string;
    head: { sha: string };
  }> = [];
  const trees: Array<{ tree: Array<{ path: string; content: string }> }> = [];
  const commits: Array<{ message: string }> = [];
  const refs: Array<{ ref: string }> = [];
  const pulls: Array<{ title: string; body: string; head: string }> = [];
  const patched: Array<{ number: string; body: Record<string, unknown> }> = [];
  const deleted: string[] = [];
  server.use(
    http.get(`${REPO}/rulesets`, () => HttpResponse.json([])),
    http.post(`${REPO}/rulesets`, () =>
      HttpResponse.json({ id: 5 }, { status: 201 }),
    ),
    http.delete(
      `${REPO}/rulesets/:id`,
      () => new HttpResponse(null, { status: 204 }),
    ),
    // The chosen folder holds no file yet.
    http.get(`${REPO}/contents/rules/servers`, () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
    http.get(`${REPO}/pulls`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("head") ===
          "example:archestra/openappa-self-service"
          ? openPulls
          : [],
      ),
    ),
    http.patch(`${REPO}/pulls/:number`, async ({ params, request }) => {
      patched.push({
        number: String(params.number),
        body: (await request.json()) as Record<string, unknown>,
      });
      return HttpResponse.json({});
    }),
    http.get(`${REPO}/git/commits/${FIRST}`, () =>
      HttpResponse.json({ tree: { sha: TREE } }),
    ),
    http.post(`${REPO}/git/trees`, async ({ request }) => {
      trees.push((await request.json()) as (typeof trees)[number]);
      return HttpResponse.json({ sha: "4".repeat(40) });
    }),
    http.post(`${REPO}/git/commits`, async ({ request }) => {
      commits.push((await request.json()) as (typeof commits)[number]);
      return HttpResponse.json({ sha: "5".repeat(40) });
    }),
    http.post(`${REPO}/git/refs`, async ({ request }) => {
      refs.push((await request.json()) as (typeof refs)[number]);
      return HttpResponse.json({});
    }),
    http.delete(
      `${REPO}/git/refs/heads/archestra/openappa-self-service`,
      ({ request }) => {
        deleted.push(new URL(request.url).pathname);
        return new HttpResponse(null, { status: 422 });
      },
    ),
    http.post(`${REPO}/pulls`, async ({ request }) => {
      pulls.push((await request.json()) as (typeof pulls)[number]);
      return HttpResponse.json({
        number: 9,
        html_url: "https://github.com/example/policies/pull/9",
      });
    }),
  );
  await syncAppaGithubPolicy(org.id);

  // A folder the servers' files cannot live in is refused before anything changes.
  const turnOn = (directory: string) =>
    updateAppaGithubSync({
      organizationId: org.id,
      action: "self_service",
      enabled: true,
      directory,
    });
  await expect(turnOn("traces")).rejects.toMatchObject({ statusCode: 400 });
  await expect(turnOn("batteries/mine")).rejects.toMatchObject({
    statusCode: 400,
  });
  expect((await getAppaGithubSync(org.id)).selfService).toMatchObject({
    enabled: false,
    directory: "mcp",
  });

  const on = await turnOn("rules/servers");
  expect(on.selfService).toEqual({
    enabled: true,
    setting: true,
    directory: "rules/servers",
  });
  // Moving the folder while on would turn the servers' files into
  // organization policy: that takes off and on again.
  await expect(turnOn("mcp")).rejects.toMatchObject({ statusCode: 409 });
  expect((await getAppaGithubSync(org.id)).selfService.directory).toBe(
    "rules/servers",
  );
  // Turning on again with the same folder changes nothing.
  expect((await turnOn("rules/servers")).selfService.directory).toBe(
    "rules/servers",
  );

  // Our pull request from an earlier folder waits: it is not this one's,
  // so it is closed and a new one opened. The policy lacks the include and
  // the folder does not exist: the pull request adds the line and a README,
  // in the name of whoever asked, from a fixed branch.
  openPulls = [
    {
      number: 8,
      html_url: "https://github.com/example/policies/pull/8",
      head: { sha: STALE_HEAD },
    },
  ];
  expect(await selfServiceIncludeState(org.id)).toEqual({
    folder: "rules/servers",
    state: "missing",
  });
  expect(
    await ensureSelfServiceInclude({
      organizationId: org.id,
      userId: admin.id,
    }),
  ).toEqual({ number: 9, url: "https://github.com/example/policies/pull/9" });
  expect(patched).toEqual([
    {
      number: "8",
      body: {
        state: "closed",
        body: expect.stringContaining("rules/servers/"),
      },
    },
  ]);
  expect(trees[0]?.tree.map((file) => file.path)).toEqual([
    "appa.toml",
    "rules/servers/README.md",
  ]);
  expect(trees[0]?.tree[0]?.content).toContain('"rules/servers/*.toml"');
  expect(trees[0]?.tree[1]?.content).toContain("rules/servers/*.toml");
  expect(refs.map((entry) => entry.ref)).toEqual([
    "refs/heads/archestra/openappa-self-service",
  ]);
  expect(deleted).toEqual([
    "/repos/example/policies/git/refs/heads/archestra/openappa-self-service",
  ]);
  expect(commits[0]?.message).toMatch(
    new RegExp(`\\n\\nRequested-by: ${admin.email}$`),
  );
  expect(pulls[0]).toMatchObject({
    head: "archestra/openappa-self-service",
    body: expect.stringContaining(admin.email),
  });

  // The pull request for this folder waits: nothing more is opened.
  openPulls = [
    {
      number: 9,
      html_url: "https://github.com/example/policies/pull/9",
      head: { sha: PULL_HEAD },
    },
  ];
  expect(await selfServiceIncludeState(org.id)).toEqual({
    folder: "rules/servers",
    state: "pull_open",
    pull: { number: 9, url: "https://github.com/example/policies/pull/9" },
  });
  expect(
    await ensureSelfServiceInclude({
      organizationId: org.id,
      userId: admin.id,
    }),
  ).toBeNull();
  expect(pulls).toHaveLength(1);

  // Merged on the branch but not pulled yet: included, and no pull request.
  openPulls = [];
  files.main = { "appa.toml": INCLUDED };
  expect(await selfServiceIncludeState(org.id)).toEqual({
    folder: "rules/servers",
    state: "included",
  });
  expect(
    await ensureSelfServiceInclude({
      organizationId: org.id,
      userId: admin.id,
    }),
  ).toBeNull();
  expect(pulls).toHaveLength(1);
  files.main = { "appa.toml": RULES };

  // The servers' files live in the chosen folder, and are held to their
  // server there, as they were under mcp/.
  const read = await getServerRules({
    organizationId: org.id,
    userId: admin.id,
    catalogId: catalog.id,
  });
  expect(read).toMatchObject({
    path: "rules/servers/payments_api.toml",
    included: false,
    content: null,
  });
  expect(read.starter).toContain("through rules/servers/*.toml");
  const change = {
    organizationId: org.id,
    userId: admin.id,
    catalogId: catalog.id,
    expectedCommit: FIRST,
  };
  const preview = await previewServerRulesChange({
    ...change,
    content: REFUNDS,
  });
  expect(preview).toMatchObject({
    valid: true,
    path: "rules/servers/payments_api.toml",
  });
  expect(preview.rootChange).toContain('"rules/servers/*.toml"');
  await expect(
    previewServerRulesChange({
      ...change,
      content: `${REFUNDS}\n[[policy.tool]]\nname = "helpdesk__close_ticket"\ndelta = {}\n`,
    }),
  ).rejects.toThrow(
    /^rules\/servers\/payments_api\.toml may hold only rules for the tools of the MCP server it is named for/,
  );

  // Once the include is pulled, it is in place for good: off and on again
  // with the same folder opens nothing.
  serveRepository({ head: SECOND, files });
  await syncAppaGithubPolicy(org.id);
  expect(
    (await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError,
  ).toBeNull();
  expect(await selfServiceIncludeState(org.id)).toEqual({
    folder: "rules/servers",
    state: "included",
  });
  await updateAppaGithubSync({
    organizationId: org.id,
    action: "self_service",
    enabled: false,
  });
  expect((await turnOn("rules/servers")).selfService.directory).toBe(
    "rules/servers",
  );
  expect(
    await ensureSelfServiceInclude({
      organizationId: org.id,
      userId: admin.id,
    }),
  ).toBeNull();
  expect(pulls).toHaveLength(1);

  // Off, then on with another folder.
  await updateAppaGithubSync({
    organizationId: org.id,
    action: "self_service",
    enabled: false,
  });
  expect((await turnOn("mcp")).selfService.directory).toBe("mcp");

  // A source saved again has no accepted commit until the next pull: the
  // include pull request pulls first rather than wait for the schedule.
  await OpenAppaGithubSyncModel.save(org.id, {
    repo: "example/policies",
    ref: "main",
    path: "appa.toml",
    interval: "1h",
    githubAppConfigId: (await OpenAppaGithubSyncModel.find(org.id))
      ?.githubAppConfigId,
    githubPatId: null,
    validationDirectory: "",
    selfService: true,
    selfServiceDirectory: "mcp",
  });
  expect((await OpenAppaGithubSyncModel.find(org.id))?.sourceCommit).toBeNull();
  server.use(
    http.get(`${REPO}/git/commits/${SECOND}`, () =>
      HttpResponse.json({ tree: { sha: TREE } }),
    ),
  );
  expect(
    await ensureSelfServiceInclude({
      organizationId: org.id,
      userId: admin.id,
    }),
  ).toEqual({ number: 9, url: "https://github.com/example/policies/pull/9" });
  expect((await OpenAppaGithubSyncModel.find(org.id))?.sourceCommit).toBe(
    SECOND,
  );
  expect(trees.at(-1)?.tree.map((file) => file.path)).toEqual([
    "appa.toml",
    "mcp/README.md",
  ]);
});
