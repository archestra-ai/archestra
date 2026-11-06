import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import {
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import GithubAppConfigModel from "@/models/github-app-config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import ToolModel from "@/models/tool";
import { openappaBatteriesService } from "@/openappa/batteries";
import { secretManager } from "@/secrets-manager";
import { createGitlabToken } from "@/services/git-credentials";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import {
  checkDueAppaGithubSyncs,
  getRepositoryProtection,
  syncAppaGithubPolicy,
} from "@/services/openappa-github-sync";
import { expect, test, vi } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import { FakeGitlab } from "@/test/fake-gitlab";
import { useMswServer } from "@/test/msw";
import {
  getServerRules,
  getServerRulesChangeStatus,
  previewServerRulesChange,
  proposeServerRulesChange,
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
    "code-owners.toml",
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
    path: "appa.toml",
    interval: "1h",
    githubAppConfigId: app.id,
    githubPatId: null,
    validationDirectory: "",
  });
  const tokens: Array<{
    repositories?: string[];
    permissions?: Record<string, string>;
  }> = [];
  server.use(
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

async function connect(params: {
  organizationId: string;
  writerUserId?: string;
}) {
  let githubPatId: string | null = null;
  if (params.writerUserId) {
    const pat = await RuntimeCredentialDefinitionModel.create({
      organizationId: params.organizationId,
      createdBy: params.writerUserId,
      definition: {
        key: "policy-pat",
        name: "Policy token",
        kind: "secret",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    await RuntimeCredentialConnectionModel.upsert({
      organizationId: params.organizationId,
      scope: "organization",
      userId: null,
      credentialId: pat.key,
      value: "test-policy-pat",
    });
    githubPatId = pat.id;
  }
  await OpenAppaGithubSyncModel.save(params.organizationId, {
    repo: "example/policies",
    ref: "main",
    path: "appa.toml",
    interval: "1h",
    githubAppConfigId: null,
    githubPatId,
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
  await connect({ organizationId: org.id, writerUserId: admin.id });
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
  server.use(
    http.get(`${REPO}/pulls`, ({ request }) => {
      expect(new URL(request.url).searchParams.get("base")).toBe("main");
      return HttpResponse.json([
        { head: { sha: goodHead }, merge_commit_sha: THIRD },
        { head: { sha: badHead }, merge_commit_sha: null },
      ]);
    }),
    // A check run where the credential may create one; a personal access
    // token may not, and posts a commit status instead.
    http.post(`${REPO}/check-runs`, async ({ request }) => {
      const run = (await request.json()) as (typeof runs)[number];
      if (run.head_sha === badHead)
        return HttpResponse.json(
          { message: "Resource not accessible by personal access token" },
          { status: 403 },
        );
      runs.push(run);
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
      name: "Guardrails policy",
      head_sha: goodHead,
      conclusion: "success",
    }),
  ]);
  expect(statuses).toEqual([
    {
      sha: badHead,
      state: "failure",
      context: "Guardrails policy",
      description: expect.stringMatching(
        /^mcp\/payments_api\.toml may hold only rules for the tools of the MCP server it is named for/,
      ),
    },
  ]);
  // Checking again posts nothing until a commit moves.
  await checkDueAppaGithubSyncs();
  expect(runs).toHaveLength(1);
  expect(statuses).toHaveLength(1);
  // Nothing was applied: the accepted commit is still the first.
  expect((await OpenAppaGithubSyncModel.find(org.id))?.sourceCommit).toBe(
    FIRST,
  );

  // A credential that may post neither is not asked again every minute.
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
  await connect({ organizationId: org.id, writerUserId: admin.id });
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
    // A personal access token posts a commit status.
    http.post(`${REPO}/check-runs`, () =>
      HttpResponse.json({}, { status: 403 }),
    ),
    http.post(`${REPO}/statuses/:sha`, async ({ request }) => {
      if (failPost) {
        failPost = false;
        return HttpResponse.json({ message: "Server Error" }, { status: 502 });
      }
      statuses.push((await request.json()) as (typeof statuses)[number]);
      return HttpResponse.json({ id: 2 }, { status: 201 });
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
        "mcp/github.toml": `[policy]
version = 2

[[policy.annotator]]
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

test("on GitLab, a pull reads every page of mcp/, merge requests get the policy check as a commit status, and a merged request says when it is applied", async ({
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

  // Pat proposes Payments' rules; the merge request gets the check.
  const proposed = await proposeServerRulesChange({
    organizationId: org.id,
    userId: pat.id,
    catalogId: catalog.id,
    content: INVOICES,
    expectedCommit: accepted as string,
    summary: "Invoices are suspicious",
  });
  expect(proposed).toMatchObject({ delivery: "pull_request", number: 1 });
  await checkDueAppaGithubSyncs();
  expect(gitlab.statuses).toEqual([
    expect.objectContaining({
      state: "success",
      name: "Guardrails policy",
    }),
  ]);
  await checkDueAppaGithubSyncs();
  expect(gitlab.statuses).toHaveLength(1);

  const status = () =>
    getServerRulesChangeStatus({
      organizationId: org.id,
      userId: pat.id,
      catalogId: catalog.id,
      number: 1,
    });
  const queuedSyncs = async () =>
    (
      await db
        .select()
        .from(schema.tasksTable)
        .where(eq(schema.tasksTable.taskType, "openappa_github_sync"))
    ).length;
  expect(await status()).toMatchObject({ state: "open", applied: false });
  gitlab.merge(project, 1);
  // Merged, and the accepted commit does not hold it yet: a sync is queued.
  const before = await queuedSyncs();
  expect(await status()).toMatchObject({ state: "merged", applied: false });
  expect(await queuedSyncs()).toBe(before + 1);
  // Pulled, and later commits keep it: applied, and nothing more is queued.
  gitlab.commit(project, "main", { "README.md": "# Policies\n" });
  await syncAppaGithubPolicy(org.id);
  const queued = await queuedSyncs();
  expect(await status()).toMatchObject({ state: "merged", applied: true });
  expect(await queuedSyncs()).toBe(queued);
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

  await connect({ organizationId: org.id, writerUserId: admin.id });
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
    http.post(`${REPO}/git/commits`, () =>
      HttpResponse.json({ sha: "5".repeat(40) }),
    ),
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
      { contents: "write", pull_requests: "write" },
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

test("Archestra keeps one ruleset on the synced branch: it creates it, restores what is missing or weaker, and leaves one turned off alone", async ({
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
  const written: Array<{ method: string; body: Record<string, unknown> }> = [];
  server.use(
    http.get(`${REPO}/pulls`, () => HttpResponse.json([])),
    http.get(`${REPO}/rulesets`, () =>
      HttpResponse.json(
        existing
          ? [
              {
                id: 5,
                name: "Guardrails policy",
                source_type: "Repository",
              },
            ]
          : [],
      ),
    ),
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

  await syncAppaGithubPolicy(org.id);
  expect(written).toEqual([
    {
      method: "POST",
      body: {
        name: "Guardrails policy",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
        bypass_actors: [],
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          {
            type: "pull_request",
            parameters: {
              required_approving_review_count: 1,
              dismiss_stale_reviews_on_push: true,
              require_code_owner_review: true,
              require_last_push_approval: true,
              required_review_thread_resolution: false,
            },
          },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "Guardrails policy", integration_id: 123 },
              ],
            },
          },
        ],
      },
    },
  ]);
  // Read back as GitHub stores it, with its own defaults added: complete, so
  // nothing is written again.
  existing = {
    id: 5,
    name: "Guardrails policy",
    target: "branch",
    source_type: "Repository",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["merge", "squash", "rebase"],
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_extra_approval_for_unattributed_changes: true,
          require_last_push_approval: true,
          required_approving_review_count: 1,
          required_review_thread_resolution: false,
          required_reviewers: [],
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: "Guardrails policy", integration_id: 123 },
          ],
          strict_required_status_checks_policy: true,
        },
      },
    ],
  };
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
  });
  expect(written).toHaveLength(1);

  // A branch that need not be up to date lets a pull request merge on a
  // check of an older merge result: the rule is made strict again.
  const lax = structuredClone(existing) as {
    rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  };
  const checks = lax.rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  if (checks?.parameters)
    checks.parameters.strict_required_status_checks_policy = false;
  existing = lax;
  written.length = 0;
  await syncAndProtect(org.id);
  expect(written).toEqual([
    {
      method: "PUT",
      body: expect.objectContaining({
        rules: expect.arrayContaining([
          {
            type: "required_status_checks",
            parameters: {
              do_not_enforce_on_create: false,
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "Guardrails policy", integration_id: 123 },
              ],
            },
          },
        ]),
      }),
    },
  ]);

  // An exclusion that takes the synced branch out undoes the include: it is
  // dropped, and exclusions of other branches stay.
  existing = {
    ...(existing as Record<string, unknown>),
    rules: (existing as { rules: unknown[] }).rules.map((rule) =>
      (rule as { type: string }).type === "required_status_checks"
        ? {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "Guardrails policy", integration_id: 123 },
              ],
            },
          }
        : rule,
    ),
    conditions: {
      ref_name: {
        include: ["~ALL"],
        exclude: [
          "refs/heads/release/*",
          "refs/heads/ma?n",
          "~DEFAULT_BRANCH",
          "refs/heads/**",
        ],
      },
    },
  };
  server.use(
    http.get(REPO, () => HttpResponse.json({ default_branch: "main" })),
  );
  written.length = 0;
  await syncAndProtect(org.id);
  expect(written).toEqual([
    {
      method: "PUT",
      body: expect.objectContaining({
        conditions: {
          ref_name: { include: ["~ALL"], exclude: ["refs/heads/release/*"] },
        },
      }),
    },
  ]);

  // An administrator made some rules stricter and others weaker: the weaker
  // ones come back, the stricter ones and their own additions stay.
  existing = {
    id: 5,
    name: "Guardrails policy",
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
        parameters: {
          required_approving_review_count: 2,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_review_thread_resolution: true,
        },
      },
      { type: "required_signatures" },
    ],
  };
  written.length = 0;
  await syncAndProtect(org.id);
  expect(written).toEqual([
    {
      method: "PUT",
      body: {
        name: "Guardrails policy",
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
            parameters: {
              required_approving_review_count: 2,
              dismiss_stale_reviews_on_push: true,
              require_code_owner_review: true,
              require_last_push_approval: true,
              required_review_thread_resolution: true,
            },
          },
          { type: "required_signatures" },
          { type: "non_fast_forward" },
          {
            type: "required_status_checks",
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [
                { context: "Guardrails policy", integration_id: 123 },
              ],
            },
          },
        ],
      },
    },
  ]);
  // The bypass an administrator added stays, and the status says so.
  expect((await getRepositoryProtection(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
    bypassActors: 1,
  });

  // Turned off on GitHub: an administrator's choice, left as it is.
  existing = { ...existing, enforcement: "disabled" };
  written.length = 0;
  expect((await syncAndProtect(org.id))?.branchRules).toMatchObject({
    state: "disabled",
  });
  expect(written).toEqual([]);
});

test("the code owners of each server's file follow who may edit the server, proposed in one pull request that is updated only when they change", async ({
  makeOrganization,
  makeUser,
  makeMember,
  makeTeam,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  const payments = await makeTeam(org.id, admin.id, { name: "Payments" });
  const data = await makeTeam(org.id, admin.id, { name: "Data" });
  const dana = await makeUser({ email: "dana@example.com" });
  await makeMember(dana.id, org.id);
  const servers = [
    { name: "payments_api", grant: { type: "team", id: payments.id } },
    { name: "helpdesk", grant: { type: "user", id: dana.id } },
    { name: "data_warehouse", grant: { type: "team", id: data.id } },
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
          { subject: grant, actions: ["read", "use", "update"] },
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
  await connectApp({ organizationId: org.id, refuse: ["administration"] });
  const files = {
    "appa.toml": `include = ["mcp/*.toml"]\n${RULES}`,
    "mcp/payments_api.toml": REFUNDS,
    "code-owners.toml": `[teams]\nPayments = "@acme/payments"\n\n[users]\n"Dana@Example.com" = "@dana-acme"\n`,
    ".github/CODEOWNERS": "* @acme/admins\n",
  };
  const proposedHead = "a".repeat(40);
  const state = {
    head: FIRST,
    files: { [FIRST]: files } as Record<string, Record<string, string>>,
  };
  serveRepository(state);
  let open: Array<Record<string, unknown>> = [];
  const trees: Array<{ tree: Array<{ path: string; content: string }> }> = [];
  const pulls: Array<{
    title: string;
    body: string;
    head: string;
    base: string;
  }> = [];
  server.use(
    http.get(`${REPO}/pulls`, ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("head") ===
          "example:archestra/openappa-code-owners"
          ? open
          : [],
      ),
    ),
    http.get(`${REPO}/git/commits/${FIRST}`, () =>
      HttpResponse.json({ tree: { sha: TREE } }),
    ),
    http.post(`${REPO}/git/trees`, async ({ request }) => {
      trees.push((await request.json()) as (typeof trees)[number]);
      return HttpResponse.json({ sha: "4".repeat(40) });
    }),
    http.post(`${REPO}/git/commits`, () =>
      HttpResponse.json({ sha: proposedHead }),
    ),
    http.get(`${REPO}/git/ref/heads/archestra/openappa-code-owners`, () =>
      HttpResponse.json({ message: "Not Found" }, { status: 404 }),
    ),
    http.post(`${REPO}/git/refs`, () => HttpResponse.json({})),
    http.get(`${REPO}/codeowners/errors`, () =>
      HttpResponse.json({
        errors: [
          {
            line: 6,
            kind: "Unknown owner",
            message:
              "Unknown owner on line 6: make sure @acme/payments exists and has write access to the repository",
          },
        ],
      }),
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
  const proposed = `* @acme/admins

# BEGIN Guardrails: MCP server rules owners
# Written from who may edit each MCP server in Archestra and code-owners.toml.
# Change those, not these lines: Archestra rewrites them.
/mcp/helpdesk.toml @dana-acme
/mcp/payments_api.toml @acme/payments
# END Guardrails: MCP server rules owners
`;
  expect(trees).toEqual([
    {
      base_tree: TREE,
      tree: [
        {
          path: ".github/CODEOWNERS",
          mode: "100644",
          type: "blob",
          content: proposed,
        },
      ],
    },
  ]);
  expect(pulls).toEqual([
    expect.objectContaining({
      title: "Code owners for MCP server rules files",
      head: "archestra/openappa-code-owners",
      base: "main",
    }),
  ]);
  expect(pulls[0]?.body).toContain("- data_warehouse: team Data");
  expect(pulls[0]?.body).toContain("line 6: Unknown owner on line 6");
  expect((await getRepositoryProtection(org.id))?.codeOwners).toEqual({
    state: "pull_request",
    url: "https://github.com/example/policies/pull/9",
    unowned: [{ server: "data_warehouse", editors: ["team Data"] }],
    mapErrors: [],
  });

  // The open pull request already proposes these owners: nothing is pushed.
  open = [
    {
      number: 9,
      html_url: "https://github.com/example/policies/pull/9",
      head: { sha: proposedHead },
    },
  ];
  state.files[proposedHead] = { ...files, ".github/CODEOWNERS": proposed };
  await syncAndProtect(org.id);
  expect(trees).toHaveLength(1);
  expect(pulls).toHaveLength(1);
});
