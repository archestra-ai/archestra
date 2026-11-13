import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { cacheManager } from "@/cache-manager";
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
  configureAppaGithubSync,
  createAppaGithubRepository,
  getAppaGithubSync,
  getAppaSelfService,
  getRepositoryProtection,
  rulesFileRefusal,
  syncAppaGithubPolicy,
  updateAppaGithubSync,
} from "@/services/openappa-github-sync";
import { afterEach, expect, test, vi } from "@/test";
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
/** The one-rule ruleset the sync keeps on main for the tests' App (id 123). */
/** The branch's rules as GitHub lists them with a ruleset that requires the check. */
const REQUIRING_RULES = [
  {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: [{ context: CHECK, integration_id: 123 }],
    },
    ruleset_id: 5,
    ruleset_source_type: "Repository",
    ruleset_source: "example/policies",
  },
];
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
    "teams/support.toml",
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
    http.get(`${REPO}/contents/teams`, ({ request }) => {
      const listed = Object.entries(at(request) ?? {}).filter(([path]) =>
        path.startsWith("teams/"),
      );
      return listed.length === 0
        ? new HttpResponse(null, { status: 404 })
        : HttpResponse.json(
            listed.map(([path, text]) => ({
              type: "file",
              name: path.slice("teams/".length),
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

/** Release 1.4: MCP Guardrails Self-Service is the deployment's variables. */
afterEach(() => {
  config.openappa.selfService = "disabled";
  config.openappa.selfServiceDirectory = "mcp";
});

/** The status reports the deployment's variables, as Settings shows them. */
function selfServiceSetting(enabled: boolean, directory = "mcp") {
  return {
    enabled,
    directory,
    environment: {
      variable: "ARCHESTRA_OPENAPPA_SELF_SERVICE",
      value: enabled ? "enabled" : "disabled",
    },
    directoryEnvironment: {
      variable: "ARCHESTRA_OPENAPPA_SELF_SERVICE_DIRECTORY",
      value: directory,
    },
  };
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
  // Release 1.4: the deployment's variable is the switch.
  config.openappa.selfService =
    params.selfService === false ? "disabled" : "enabled";
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
    // A branch rule that requires the check, in place: self-service in full
    // needs it. A test that serves its own rules registers them over this.
    http.get(`${REPO}/rules/branches/:branch`, () =>
      HttpResponse.json(REQUIRING_RULES),
    ),
    http.get(`https://api.github.com/app/installations/${installationId}`, () =>
      HttpResponse.json({
        html_url: `https://github.com/settings/installations/${installationId}`,
      }),
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
  serveRepository({
    head: FIRST,
    files: { [FIRST]: { "appa.toml": `include = ["mcp/*.toml"]\n${RULES}` } },
  });
  await syncAppaGithubPolicy(org.id);

  const read = await getServerRules({
    organizationId: org.id,
    userId: pat.id,
    catalogId: catalog.id,
  });
  expect(read).toMatchObject({
    canEdit: true,
    path: "mcp/payments_api.toml",
    included: true,
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
  // The include is in place, as self-service needs: nothing changes in appa.toml.
  expect(preview.rootChange).toBeUndefined();

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
  // One commit with the server's file alone: appa.toml includes the folder already.
  expect(trees[0]?.tree.map((file) => file.path)).toEqual([
    "mcp/payments_api.toml",
  ]);
  expect(trees[0]?.tree[0]?.content).toBe(REFUNDS);
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

test("MCP servers whose tools share a prefix share one rules file: a change takes edit access to each shared server, and members' personal copies follow it", async ({
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
  const billing = await makeTeam(org.id, admin.id, { name: "Billing" });
  // Pat may edit both shared servers, Bea only payments_api, Cody neither.
  const pat = await makeUser({ name: "Pat" });
  await makeTeamMember(payments.id, pat.id);
  await makeTeamMember(billing.id, pat.id);
  const bea = await makeUser({ name: "Bea" });
  await makeTeamMember(payments.id, bea.id);
  const cody = await makeUser({ name: "Cody" });
  await makeMember(cody.id, org.id);
  const addServer = async (params: {
    name: string;
    tools: string[];
    scope?: "org" | "personal";
    editors?: string;
    authorId?: string;
  }) => {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: params.name,
        serverType: "remote",
        serverUrl: "https://payments.example.com/mcp",
        scope: params.scope ?? "org",
      },
      {
        organizationId: org.id,
        authorId: params.authorId,
        initialPermissionGrants: params.editors
          ? [
              {
                subject: { type: "team", id: params.editors },
                actions: ["read", "use", "update"],
              },
              {
                subject: { type: "organization", id: "*" },
                actions: ["read", "use"],
              },
            ]
          : undefined,
      },
    );
    for (const name of params.tools)
      await ToolModel.createToolIfNotExists({
        name,
        description: name,
        parameters: {},
        catalogId: catalog.id,
      });
    return catalog;
  };
  const paymentsApi = await addServer({
    name: "payments_api",
    tools: ["payments_api__refund_payment"],
    editors: payments.id,
  });
  const billingApi = await addServer({
    name: "Payments API",
    tools: ["payments_api__get_invoice"],
    editors: billing.id,
  });
  // Cody's personal copy of payments_api, with the same tool.
  const copy = await addServer({
    name: "payments_api",
    tools: ["payments_api__refund_payment"],
    scope: "personal",
    authorId: cody.id,
  });
  const doubled = await addServer({
    name: "pay__ments",
    tools: ["pay__ments__export"],
    editors: payments.id,
  });
  const mixed = await addServer({
    name: "helpdesk",
    tools: ["helpdesk__close_ticket", "crm__find_contact"],
    editors: payments.id,
  });

  await connectApp({ organizationId: org.id });
  serveRepository({
    head: FIRST,
    files: { [FIRST]: { "appa.toml": `include = ["mcp/*.toml"]\n${RULES}` } },
  });
  await syncAppaGithubPolicy(org.id);

  const read = (userId: string, catalogId: string) =>
    getServerRules({ organizationId: org.id, userId, catalogId });
  const shared = {
    id: billingApi.id,
    name: "Payments API",
    scope: "org",
    owner: true,
  };
  // Pat may edit both, so either server's file is Pat's to change; Cody's
  // copy is one Pat cannot see, and does not gate the file.
  for (const catalog of [paymentsApi, billingApi])
    expect(await read(pat.id, catalog.id)).toMatchObject({
      canEdit: true,
      path: "mcp/payments_api.toml",
    });
  const forPat = await read(pat.id, paymentsApi.id);
  expect(forPat.sharedWith).toEqual([shared]);
  expect(forPat.hiddenCopies).toBe(1);
  expect(forPat.instruction).toContain(
    "its rules also govern Payments API and 1 personal copy the user cannot see",
  );

  // Bea may edit payments_api only: the change also needs Payments API.
  const forBea = await read(bea.id, paymentsApi.id);
  expect(forBea).toMatchObject({
    canEdit: false,
    path: "mcp/payments_api.toml",
    sharedWith: [shared],
    hiddenCopies: 1,
  });
  expect(forBea.instruction).toContain(
    "that takes edit access to Payments API in the MCP registry",
  );

  // Cody reads the same file through the copy, which follows the shared
  // servers' editors.
  const forCody = await read(cody.id, copy.id);
  expect(forCody).toMatchObject({
    canEdit: false,
    path: "mcp/payments_api.toml",
    hiddenCopies: 0,
  });
  expect(forCody.sharedWith).toEqual(
    expect.arrayContaining([
      shared,
      { id: paymentsApi.id, name: "payments_api", scope: "org", owner: true },
    ]),
  );
  expect(forCody.instruction).toContain(
    "takes edit access to Payments API and payments_api in the MCP registry",
  );

  // A server that cannot have a file says why.
  await expect(read(pat.id, doubled.id)).rejects.toMatchObject({
    statusCode: 409,
    message:
      'pay__ments has no rules file: its tool prefix, pay__ments, is not a safe file name or holds "__".',
  });
  await expect(read(pat.id, mixed.id)).rejects.toMatchObject({
    statusCode: 409,
    message:
      "helpdesk has no rules file: some of its tools carry other prefixes than helpdesk__ (crm__).",
  });
  // A catalog from before the API refused the built-in tools' name: its file
  // would govern the built-in tools too, so it stays the policy's.
  const builtIn = archestraMcpBranding.serverName;
  const legacy = await addServer({
    name: builtIn,
    tools: [`${builtIn}__custom`],
    editors: payments.id,
  });
  await expect(read(pat.id, legacy.id)).rejects.toMatchObject({
    statusCode: 409,
    message: `${builtIn} has no rules file: its tools carry the prefix ${builtIn}__ of the built-in ${archestraMcpBranding.catalogName} tools, which only the organization's own policy governs.`,
  });

  const change = {
    organizationId: org.id,
    catalogId: paymentsApi.id,
    content: INVOICES,
    expectedCommit: FIRST,
    summary: "Invoices are suspicious",
  };
  expect(
    await previewServerRulesChange({ ...change, userId: pat.id }),
  ).toMatchObject({ valid: true, path: "mcp/payments_api.toml" });
  await expect(
    previewServerRulesChange({ ...change, userId: bea.id }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    proposeServerRulesChange({ ...change, userId: bea.id }),
  ).rejects.toMatchObject({
    statusCode: 403,
    message:
      "You may propose payments_api's Guardrails rules only if you may edit Payments API in the MCP registry",
  });

  const pulls: Array<{ body: string }> = [];
  server.use(
    http.get(`${REPO}/git/commits/${FIRST}`, () =>
      HttpResponse.json({ tree: { sha: TREE } }),
    ),
    http.post(`${REPO}/git/trees`, () =>
      HttpResponse.json({ sha: "4".repeat(40) }),
    ),
    http.post(`${REPO}/git/commits`, () =>
      HttpResponse.json({ sha: "5".repeat(40) }),
    ),
    http.post(`${REPO}/git/refs`, () => HttpResponse.json({})),
    http.post(`${REPO}/pulls`, async ({ request }) => {
      pulls.push((await request.json()) as (typeof pulls)[number]);
      return HttpResponse.json({
        number: 7,
        html_url: "https://github.com/example/policies/pull/7",
      });
    }),
  );
  expect(
    await proposeServerRulesChange({ ...change, userId: pat.id }),
  ).toMatchObject({ delivery: "pull_request", number: 7 });
  expect(pulls).toHaveLength(1);
  expect(pulls[0]?.body).toContain(
    "who may edit the MCP servers Payments API and payments_api in the MCP registry",
  );
});

test("each job's GitHub App token covers the policy repository and its own permissions only, and a permission the App lacks is reported", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const { tokens } = await connectApp({
    organizationId: org.id,
    refuse: ["checks"],
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
  server.use(
    http.get(`${REPO}/pulls`, () => HttpResponse.json([])),
    // No rule yet: the import waits for the permission.
    http.get(`${REPO}/rules/branches/:branch`, () => HttpResponse.json([])),
  );

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
      { metadata: "read" },
    ]),
  );
  const protection = await getRepositoryProtection(org.id);
  expect(protection?.branchRules).toMatchObject({
    state: "needs_permission",
    detail: expect.stringContaining("Checks (read and write)"),
  });

  // A check token the App was not granted backs off instead of failing.
  await checkDueAppaGithubSyncs();
  expect(tokens.at(-1)?.permissions).toEqual({
    checks: "write",
    pull_requests: "read",
  });
});

test("Archestra reads the branch's rules and writes none: a missing rule comes with the ruleset to import and the Rulesets page, a rule from any source or from another app is incomplete, and the imported rule, in a repository or an organization ruleset, is active and linked", async ({
  makeOrganization,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const { tokens } = await connectApp({ organizationId: org.id });
  serveRepository({
    head: FIRST,
    files: { [FIRST]: { "appa.toml": RULES } },
  });
  let rules: Array<Record<string, unknown>> = [];
  const written: string[] = [];
  server.use(
    http.get(`${REPO}/pulls`, () => HttpResponse.json([])),
    http.get(`${REPO}/rules/branches/main`, () => HttpResponse.json(rules)),
    http.get(`${REPO}/rulesets`, () => {
      written.push("GET rulesets");
      return HttpResponse.json([]);
    }),
    http.post(`${REPO}/rulesets`, () => {
      written.push("POST");
      return HttpResponse.json({ id: 5 }, { status: 201 });
    }),
    http.put(`${REPO}/rulesets/:id`, () => {
      written.push("PUT");
      return HttpResponse.json({});
    }),
    http.delete(`${REPO}/rulesets/:id`, () => {
      written.push("DELETE");
      return new HttpResponse(null, { status: 204 });
    }),
  );
  // The file an administrator imports: one rule, the check from this App.
  const ruleset = {
    name: CHECK,
    target: "branch",
    source_type: "Repository",
    source: "example/policies",
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
  const settingsUrl = "https://github.com/example/policies/settings/rules";

  // Missing: the file to import, and where.
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "missing",
    settingsUrl,
    ruleset,
  });
  // The rules are read with Metadata, which every App has.
  expect(tokens).toContainEqual({
    repositories: ["policies"],
    permissions: { metadata: "read" },
  });

  // Imported, in a repository ruleset: active, linked to that ruleset. The
  // branch's rules come as GitHub evaluates them, with its own defaults.
  const check = (
    entry: Record<string, unknown>,
    from: Record<string, unknown>,
  ) => ({
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [entry],
    },
    ...from,
  });
  const repository = {
    ruleset_id: 5,
    ruleset_source_type: "Repository",
    ruleset_source: "example/policies",
  };
  const organization = {
    ruleset_id: 9,
    ruleset_source_type: "Organization",
    ruleset_source: "example",
  };
  rules = [
    { type: "deletion", ...repository },
    check({ context: CHECK, integration_id: 123 }, repository),
  ];
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
  });

  // An organization ruleset counts the same, linked to the organization's page.
  rules = [check({ context: CHECK, integration_id: 123 }, organization)];
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/organizations/example/settings/rules/9",
  });

  // A rule that takes the check from any source: anyone could post a passing
  // one, so it is incomplete, with the fix and the file beside it.
  rules = [check({ context: CHECK }, repository)];
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "incomplete",
    url: "https://github.com/example/policies/rules/5",
    settingsUrl,
    ruleset,
    detail: expect.stringContaining("from any source"),
  });

  // From another app: the check this App posts would not count.
  rules = [check({ context: CHECK, integration_id: 999 }, repository)];
  expect((await syncAndProtect(org.id))?.branchRules).toMatchObject({
    state: "incomplete",
    detail: expect.stringContaining("another app"),
  });

  // Both: the rule for this App is the one that matters.
  rules = [
    check({ context: CHECK, integration_id: 999 }, organization),
    check({ context: CHECK, integration_id: 123 }, repository),
  ];
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
  });

  // Through it all, no ruleset was read, written or deleted.
  expect(written).toEqual([]);
  expect(tokens.map((token) => token.permissions)).not.toContainEqual(
    expect.objectContaining({ administration: expect.anything() }),
  );
});

test("self-service is opt-in: off, no check is posted and server rules are not read; on reads the branch rules at once; the environment variable locks the setting; off again with the rule still in place names it and posts the check as skipped; a move or a stop waits for its removal", async ({
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
  const requiring = [
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [{ context: CHECK, integration_id: 123 }],
      },
      ruleset_id: 5,
      ruleset_source_type: "Repository",
      ruleset_source: "example/policies",
    },
  ];
  const rulesetUrl = "https://github.com/example/policies/rules/5";
  let rules: Array<Record<string, unknown>> = [];
  let pulls: Array<Record<string, unknown>> = [];
  const calls: string[] = [];
  const runs: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${REPO}/pulls`, () => {
      calls.push("GET pulls");
      return HttpResponse.json(pulls);
    }),
    http.get(`${REPO}/rules/branches/:branch`, ({ params }) => {
      calls.push(`GET rules ${params.branch}`);
      return HttpResponse.json(rules);
    }),
    http.get(`${REPO}/commits/:sha/check-runs`, () =>
      HttpResponse.json({ check_runs: [] }),
    ),
    http.post(`${REPO}/check-runs`, async ({ request }) => {
      runs.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id: 1 }, { status: 201 });
    }),
  );

  // Off from the start: the sync reads no branch rules, since a rule left
  // behind takes self-service having been on; the minute's check reads no
  // pull request, the registry shows no action, and the Keeper's tools
  // refuse.
  await syncAppaGithubPolicy(org.id);
  expect(await getRepositoryProtection(org.id)).toBeNull();
  expect(calls).toEqual([]);
  await checkDueAppaGithubSyncs();
  expect(calls).toEqual([]);
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: false });
  expect((await getAppaGithubSync(org.id)).selfService).toEqual(
    selfServiceSetting(false),
  );
  await expect(
    getServerRules({
      organizationId: org.id,
      userId: admin.id,
      catalogId: catalog.id,
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining("MCP Guardrails Self-Service is off"),
  });

  // On, by the deployment's variable: Finish setup reads the branch rules at
  // once and offers the ruleset to import; each sync reads them again, and
  // the checks come with it.
  config.openappa.selfService = "enabled";
  calls.length = 0;
  await updateAppaGithubSync({ organizationId: org.id, action: "protect" });
  expect(calls).toEqual(["GET rules main"]);
  expect((await getAppaGithubSync(org.id)).selfService).toEqual(
    selfServiceSetting(true),
  );
  expect((await getRepositoryProtection(org.id))?.branchRules).toMatchObject({
    state: "missing",
    settingsUrl: "https://github.com/example/policies/settings/rules",
    ruleset: expect.objectContaining({ name: CHECK }),
  });
  // The ruleset alone is not the whole setup: until the accepted policy
  // includes the servers' folder and the ruleset is in place, the registry
  // offers nothing and the Keeper's tools point at Finish setup.
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: false });
  await expect(
    getServerRules({
      organizationId: org.id,
      userId: admin.id,
      catalogId: catalog.id,
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining("not set up yet"),
  });
  serveRepository({
    head: SECOND,
    files: { [SECOND]: { "appa.toml": `include = ["mcp/*.toml"]\n${RULES}` } },
  });
  await syncAppaGithubPolicy(org.id);
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: false });
  await checkDueAppaGithubSyncs();
  expect(calls).toEqual(["GET rules main", "GET rules main", "GET pulls"]);
  // The administrator imported it: the next sync finds it, and self-service
  // is on in full.
  rules = requiring;
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: rulesetUrl,
  });
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: true });
  // A shared cache that misses and then refuses the write leaves the live
  // read to answer, as the in-memory cache it replaced did.
  const cacheGet = vi
    .spyOn(cacheManager, "get")
    .mockResolvedValueOnce(undefined);
  const cacheSet = vi
    .spyOn(cacheManager, "set")
    .mockRejectedValueOnce(new Error("cache down"));
  expect((await getRepositoryProtection(org.id))?.branchRules).toEqual({
    state: "active",
    url: rulesetUrl,
  });
  expect(cacheSet).toHaveBeenCalledTimes(1);
  cacheGet.mockRestore();
  cacheSet.mockRestore();

  // An open pull request gets its verdict while on. A pull request GitHub
  // numbers not: the policy at its head is checked, and nothing judged.
  pulls = [{ head: { sha: SECOND } }];
  await checkDueAppaGithubSyncs();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ head_sha: SECOND });
  expect(runs[0]?.conclusion).not.toBe("skipped");
  const verdict = runs[0]?.conclusion;

  // Off by the variable: the next sync takes the ruleset away, and the
  // check out of the repository's own ruleset, which keeps the rest.
  config.openappa.selfService = "disabled";
  expect((await getAppaGithubSync(org.id)).selfService).toEqual(
    selfServiceSetting(false),
  );
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: false });
  // With the rule still in place: Archestra cannot take it off, so the next
  // sync records it, the settings name it, and the minute's round posts the
  // check as skipped on every open pull request, once each, so none waits
  // on a check nobody judges any more.
  calls.length = 0;
  await syncAppaGithubPolicy(org.id);
  expect(calls).toEqual(["GET rules main"]);
  expect(await getRepositoryProtection(org.id)).toBeNull();
  expect((await getAppaGithubSync(org.id)).selfService).toEqual({
    ...selfServiceSetting(false),
    leftoverRule: { checkName: CHECK, url: rulesetUrl },
  });
  await checkDueAppaGithubSyncs();
  expect(runs).toHaveLength(2);
  expect(runs[1]).toEqual({
    name: CHECK,
    head_sha: SECOND,
    status: "completed",
    conclusion: "skipped",
    output: {
      title: "MCP Guardrails Self-Service is off",
      summary: expect.stringContaining(rulesetUrl),
    },
  });
  await checkDueAppaGithubSyncs();
  expect(runs).toHaveLength(2);
  // Off, the recorded rule holds a stop: nothing would post the check it
  // requires once the sync is gone.
  await expect(
    updateAppaGithubSync({ organizationId: org.id, action: "disconnect" }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect((await OpenAppaGithubSyncModel.find(org.id))?.interval).toBe("1h");
  // The rule removed: nothing left to name, and nothing more is posted.
  rules = [];
  calls.length = 0;
  await syncAppaGithubPolicy(org.id);
  expect((await getAppaGithubSync(org.id)).selfService).toEqual(
    selfServiceSetting(false),
  );
  await checkDueAppaGithubSyncs();
  expect(calls).toEqual(["GET rules main"]);
  // On again: the verdict skipped stood over is posted afresh, unchanged
  // as it is, so the skipped result does not pass for it.
  config.openappa.selfService = "enabled";
  await checkDueAppaGithubSyncs();
  expect(runs).toHaveLength(3);
  expect(runs[2]).toMatchObject({ head_sha: SECOND, conclusion: verdict });
  // The ruleset imported again: on in full.
  rules = requiring;
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: rulesetUrl,
  });
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: true });

  // Another branch of the same repository while the rule stands: refused,
  // since nothing would post the check on the branch left behind. The rule
  // removed, the move goes through; the same branch saved again asks nothing.
  const moved = {
    repo: "example/policies",
    path: "appa.toml",
    interval: "1h" as const,
    validationDirectory: "",
    githubPatId: null,
    githubAppConfigId:
      (await OpenAppaGithubSyncModel.find(org.id))?.githubAppConfigId ?? null,
    gitlabTokenId: null,
  };
  // The servers' folder is the deployment's: a saved source keeps its
  // validations apart from it, as a created repository must.
  await expect(
    configureAppaGithubSync({
      organizationId: org.id,
      userId: admin.id,
      source: { ...moved, ref: "main", validationDirectory: "mcp" },
    }),
  ).rejects.toMatchObject({
    statusCode: 400,
    message: expect.stringContaining("validations folder"),
  });
  // An omitted validations folder keeps the saved one, which the check
  // reads too: a suite saved in the servers' folder refuses the save.
  const suites = schema.openappaPolicyTestSuitesTable;
  await db
    .update(suites)
    .set({ directory: "mcp" })
    .where(eq(suites.organizationId, org.id));
  const { validationDirectory: _kept, ...inherits } = moved;
  await expect(
    configureAppaGithubSync({
      organizationId: org.id,
      userId: admin.id,
      source: { ...inherits, ref: "main" },
    }),
  ).rejects.toMatchObject({
    statusCode: 400,
    message: expect.stringContaining("validations folder"),
  });
  await db
    .update(suites)
    .set({ directory: "" })
    .where(eq(suites.organizationId, org.id));
  await expect(
    configureAppaGithubSync({
      organizationId: org.id,
      userId: admin.id,
      source: { ...moved, ref: "policy-v2" },
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining(rulesetUrl),
  });
  expect((await OpenAppaGithubSyncModel.find(org.id))?.ref).toBe("main");
  // A move to another repository, or to a GitLab project, is refused
  // before anything is created there: no GitHub call but the rules' read.
  calls.length = 0;
  await expect(
    createAppaGithubRepository({
      organizationId: org.id,
      userId: admin.id,
      owner: "example",
      name: "other",
      githubAppConfigId: moved.githubAppConfigId ?? undefined,
      interval: "1h",
      existing: true,
      replace: true,
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining(rulesetUrl),
  });
  await expect(
    createAppaGithubRepository({
      organizationId: org.id,
      userId: admin.id,
      owner: "platform",
      name: "policy",
      gitlabTokenId: "11111111-1111-4111-8111-111111111111",
      interval: "1h",
      replace: true,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(calls).toEqual(["GET rules main", "GET rules main"]);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.repo).toBe(
    "example/policies",
  );
  rules = [];
  await configureAppaGithubSync({
    organizationId: org.id,
    userId: admin.id,
    source: { ...moved, ref: "policy-v2" },
  });
  expect((await OpenAppaGithubSyncModel.find(org.id))?.ref).toBe("policy-v2");
  calls.length = 0;
  await configureAppaGithubSync({
    organizationId: org.id,
    userId: admin.id,
    source: { ...moved, ref: "policy-v2" },
  });
  expect(calls).toEqual([]);

  // Stopping the sync waits for the rule's removal the same way.
  rules = requiring;
  await expect(
    updateAppaGithubSync({ organizationId: org.id, action: "disconnect" }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect((await OpenAppaGithubSyncModel.find(org.id))?.interval).toBe("1h");
  rules = [];
  await updateAppaGithubSync({ organizationId: org.id, action: "disconnect" });
  expect((await OpenAppaGithubSyncModel.find(org.id))?.interval).toBeNull();
});

test("without the Checks permission the import waits, a rule already in place is reported as holding pull requests, and the grant makes it active", async ({
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
  let rules: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`${REPO}/pulls`, () => HttpResponse.json([])),
    http.get(`${REPO}/rules/branches/main`, () => HttpResponse.json(rules)),
  );
  // A required check nobody posts would hold every pull request: the
  // import waits for the permission, the file ready all the same.
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "needs_permission",
    detail: expect.stringContaining("Checks (read and write)"),
    settingsUrl: "https://github.com/example/policies/settings/rules",
    ruleset: expect.objectContaining({ name: CHECK }),
  });

  rules = [
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [{ context: CHECK, integration_id: 123 }],
      },
      ruleset_id: 5,
      ruleset_source_type: "Repository",
      ruleset_source: "example/policies",
    },
  ];
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
    checkRule: "unposted",
    detail: expect.stringContaining("Checks (read and write)"),
  });

  refuse.length = 0;
  expect((await syncAndProtect(org.id))?.branchRules).toEqual({
    state: "active",
    url: "https://github.com/example/policies/rules/5",
  });
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

test("under white-labeling, a server named like the built-in tools' default name has no rules file either", () => {
  const fullWhiteLabeling = config.enterpriseFeatures.fullWhiteLabeling;
  config.enterpriseFeatures.fullWhiteLabeling = true;
  archestraMcpBranding.syncFromOrganization({
    appName: "Acme Hub",
    iconLogo: null,
  });
  try {
    expect(archestraMcpBranding.serverName).not.toBe("archestra");
    const catalog = { id: "legacy-catalog", name: "Archestra" };
    expect(
      rulesFileRefusal({
        catalog,
        tools: ["archestra__custom"],
        prefixes: {
          byCatalog: new Map([[catalog.id, new Set(["archestra"])]]),
          byPrefix: new Map([["archestra", new Set([catalog.id])]]),
          conflicting: new Set(),
        },
      }),
    ).toContain("of the built-in");
  } finally {
    config.enterpriseFeatures.fullWhiteLabeling = fullWhiteLabeling;
    archestraMcpBranding.syncFromOrganization(null);
  }
});

test("the policy check asks for edit access to each shared server a rules file governs; a member's personal copy changes nothing", async ({
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
  const billing = await makeTeam(org.id, admin.id, { name: "Billing" });
  const pat = await makeUser({ email: "pat@example.com" });
  await makeTeamMember(payments.id, pat.id);
  await makeTeamMember(billing.id, pat.id);
  const bea = await makeUser({ email: "bea@example.com" });
  await makeTeamMember(payments.id, bea.id);
  const cody = await makeUser({ email: "cody@example.com" });
  await makeMember(cody.id, org.id);
  // Every member may open Payments API in the registry; payments_api only
  // its team's members.
  const servers = [
    { name: "payments_api", scope: "org", editors: payments.id, open: false },
    { name: "Payments API", scope: "org", editors: billing.id, open: true },
    // Cody's personal copy: it follows the file, and gates nothing.
    { name: "payments_api", scope: "personal", editors: null, open: false },
  ] as const;
  for (const { name, scope, editors, open } of servers) {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name,
        serverType: "remote",
        serverUrl: "https://payments.example.com/mcp",
        scope,
      },
      {
        organizationId: org.id,
        authorId: editors ? admin.id : cody.id,
        initialPermissionGrants: editors
          ? [
              {
                subject: { type: "team", id: editors },
                actions: ["read", "use", "update"],
              },
              ...(open
                ? [
                    {
                      subject: {
                        type: "organization" as const,
                        id: "*" as const,
                      },
                      actions: ["read" as const, "use" as const],
                    },
                  ]
                : []),
            ]
          : undefined,
      },
    );
    await ToolModel.createToolIfNotExists({
      name: "payments_api__refund_payment",
      description: "refund_payment",
      parameters: {},
      catalogId: catalog.id,
    });
  }
  await connectApp({ organizationId: org.id });
  const root = `include = ["mcp/*.toml"]\n${RULES}`;
  // A catalog from before the API refused the built-in tools' name, which
  // Pat may edit: a file for its prefix stays the policy's own matter.
  const builtIn = archestraMcpBranding.serverName;
  const legacy = await InternalMcpCatalogModel.create(
    {
      name: builtIn,
      serverType: "remote",
      serverUrl: "https://legacy.example.com/mcp",
      scope: "org",
    },
    {
      organizationId: org.id,
      authorId: admin.id,
      initialPermissionGrants: [
        {
          subject: { type: "team", id: payments.id },
          actions: ["read", "use", "update"],
        },
      ],
    },
  );
  await ToolModel.createToolIfNotExists({
    name: `${builtIn}__custom`,
    description: "custom",
    parameters: {},
    catalogId: legacy.id,
  });
  const results = {
    1: "a".repeat(40),
    2: "b".repeat(40),
    3: "c".repeat(40),
    4: "d".repeat(40),
  };
  serveRepository({
    head: FIRST,
    files: {
      [FIRST]: { "appa.toml": root, "mcp/payments_api.toml": REFUNDS },
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
  const signed = (email: string, sha: string) => ({
    sha,
    commit: {
      message: `Guardrails rules for payments_api\n\nRequested-by: ${email}`,
      verification: { verified: true, reason: "valid" },
    },
    author: bot,
    committer: { login: bot.login, type: "Bot" },
  });
  // Opened by the App for Pat, who may edit both shared servers; for Bea,
  // who may edit payments_api only; and for Cody, who owns only the copy.
  // Everyone who reads the repository reads a check's summary, so it names
  // only the servers the requester may open in the registry.
  const requesters = {
    1: pat.email,
    2: bea.email,
    3: cody.email,
    4: pat.email,
  };
  const runs: Array<{
    head_sha: string;
    conclusion: string;
    output: { title: string; summary: string };
  }> = [];
  server.use(
    http.get(`${REPO}/pulls`, () =>
      HttpResponse.json(
        Object.entries(results).map(([number, sha]) => ({
          number: Number(number),
          head: { sha },
          merge_commit_sha: null,
          user: bot,
        })),
      ),
    ),
    http.get(`${REPO}/pulls/:number/files`, ({ params }) =>
      HttpResponse.json([
        {
          filename:
            Number(params.number) === 4
              ? `mcp/${builtIn}.toml`
              : "mcp/payments_api.toml",
        },
      ]),
    ),
    http.get(`${REPO}/pulls/:number/commits`, ({ params }) => {
      const number = Number(params.number) as keyof typeof results;
      return HttpResponse.json([signed(requesters[number], results[number])]);
    }),
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
  expect(posted[results[1]]).toMatchObject({ conclusion: "success" });
  expect(posted[results[2]]).toEqual({
    conclusion: "failure",
    title: "The requester may not change these rules",
    summary:
      "bea@example.com may not change mcp/payments_api.toml: that takes edit access to the MCP server Payments API in the MCP registry.",
  });
  expect(posted[results[3]]).toEqual({
    conclusion: "failure",
    title: "The requester may not change these rules",
    summary:
      "cody@example.com may not change mcp/payments_api.toml: that takes edit access to the MCP servers Payments API and an MCP server they cannot see in the MCP registry.",
  });
  expect(posted[results[4]]).toEqual({
    conclusion: "failure",
    title: "The requester may not change the policy",
    summary: `pat@example.com may not change mcp/${builtIn}.toml: that takes the guardrailsPolicy:update permission.`,
  });
});

test("a policy in a folder of a repository that holds other work gets the same one-rule ruleset to import, and a pull request that changes no policy file gets the check as skipped at once", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  config.openappa.enabled = true;
  const org = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, org.id, { role: "admin" });
  await connectApp({ organizationId: org.id, path: "guardrails/appa.toml" });
  const runs: Array<{ head_sha: string; conclusion: string }> = [];
  const head = "a".repeat(40);
  server.use(
    http.get("https://api.github.com/app", () =>
      HttpResponse.json({ slug: "acme-guardrails", name: "Policy App" }),
    ),
    // No rule yet: the ruleset to import is offered.
    http.get(`${REPO}/rules/branches/:branch`, () => HttpResponse.json([])),
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
      HttpResponse.json([{ filename: "other/appa.toml" }]),
    ),
    http.get(`${REPO}/contents/other`, () =>
      HttpResponse.json([
        {
          type: "file",
          name: "appa.toml",
          path: "other/appa.toml",
          sha: createHash("sha1").update(RULES).digest("hex"),
        },
      ]),
    ),
    http.get(`${REPO}/contents/other/appa.toml`, () =>
      HttpResponse.text(RULES),
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
  // The one rule on the branch, and nothing about the folder.
  expect((await getRepositoryProtection(org.id))?.branchRules).toMatchObject({
    state: "missing",
    ruleset: {
      conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
      rules: [
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: CHECK, integration_id: 123 }],
          },
        },
      ],
    },
  });
  // A product pull request: the check is posted as skipped, once, and no
  // policy is read for it.
  await checkDueAppaGithubSyncs();
  await checkDueAppaGithubSyncs();
  expect(runs).toEqual([
    expect.objectContaining({ head_sha: head, conclusion: "skipped" }),
  ]);

  // The policy file moves to the very file that pull request changes: the
  // result stored for the old source does not stand in for the new one, so
  // the pull request is judged again, and now its policy is checked.
  const row = await OpenAppaGithubSyncModel.find(org.id);
  await configureAppaGithubSync({
    organizationId: org.id,
    userId: admin.id,
    source: {
      repo: "example/policies",
      ref: "main",
      path: "other/appa.toml",
      interval: "1h",
      validationDirectory: "",
      githubPatId: null,
      githubAppConfigId: row?.githubAppConfigId ?? null,
      gitlabTokenId: null,
    },
  });
  // A saved source has no accepted commit until it is pulled again.
  await syncAppaGithubPolicy(org.id);
  await checkDueAppaGithubSyncs();
  expect(runs).toEqual([
    expect.objectContaining({ head_sha: head, conclusion: "skipped" }),
    expect.objectContaining({ head_sha: head, conclusion: "success" }),
  ]);
});

test("the self-service folder is the deployment's: the servers' files live there, one pull request in the administrator's name includes it, an include already in place or on its way needs none, and a stale one is closed", async ({
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

  // Release 1.4: the folder is the deployment's variable, read at startup.
  const turnOn = async (directory: string) => {
    config.openappa.selfService = "enabled";
    config.openappa.selfServiceDirectory = directory;
    return getAppaGithubSync(org.id);
  };
  expect((await getAppaGithubSync(org.id)).selfService).toMatchObject({
    enabled: false,
    directory: "mcp",
  });
  const on = await turnOn("rules/servers");
  expect(on.selfService).toEqual(selfServiceSetting(true, "rules/servers"));

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

  // GitHub failing to answer is not "no pull request": nothing is closed,
  // no branch is deleted and no pull request is opened on such a reading.
  server.use(
    http.get(
      `${REPO}/pulls`,
      () => HttpResponse.json({ message: "bad gateway" }, { status: 502 }),
      { once: true },
    ),
  );
  expect(await selfServiceIncludeState(org.id)).toEqual({
    folder: "rules/servers",
    state: "unknown",
  });
  server.use(
    http.get(
      `${REPO}/pulls`,
      () => HttpResponse.json({ message: "bad gateway" }, { status: 502 }),
      { once: true },
    ),
  );
  await expect(
    ensureSelfServiceInclude({ organizationId: org.id, userId: admin.id }),
  ).rejects.toMatchObject({ statusCode: 502 });
  // Nor is the policy file at the branch head unreadable the same as absent.
  server.use(
    http.get(`${REPO}/contents/appa.toml`, () => HttpResponse.error(), {
      once: true,
    }),
  );
  expect(await selfServiceIncludeState(org.id)).toEqual({
    folder: "rules/servers",
    state: "unknown",
  });
  expect(patched).toHaveLength(1);
  expect(deleted).toHaveLength(1);
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

  // Until the include is pulled, self-service is not set up in full: the
  // registry offers nothing, and the Keeper's tools point at Finish setup.
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: false });
  await expect(
    getServerRules({
      organizationId: org.id,
      userId: admin.id,
      catalogId: catalog.id,
    }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringContaining("not set up yet"),
  });

  // Once the include is pulled, it is in place for good: off and on again
  // with the same folder opens nothing.
  serveRepository({ head: SECOND, files });
  await syncAppaGithubPolicy(org.id);
  expect(
    (await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError,
  ).toBeNull();
  // The servers' files live in the chosen folder, and are held to their
  // server there, as they were under mcp/.
  expect(await getAppaSelfService(org.id)).toEqual({ enabled: true });
  const read = await getServerRules({
    organizationId: org.id,
    userId: admin.id,
    catalogId: catalog.id,
  });
  expect(read).toMatchObject({
    path: "rules/servers/payments_api.toml",
    included: true,
    content: null,
  });
  expect(read.starter).toContain("through rules/servers/*.toml");
  const change = {
    organizationId: org.id,
    userId: admin.id,
    catalogId: catalog.id,
    expectedCommit: SECOND,
  };
  const preview = await previewServerRulesChange({
    ...change,
    content: REFUNDS,
  });
  expect(preview).toMatchObject({
    valid: true,
    path: "rules/servers/payments_api.toml",
  });
  expect(preview.rootChange).toBeUndefined();
  await expect(
    previewServerRulesChange({
      ...change,
      content: `${REFUNDS}\n[[policy.tool]]\nname = "helpdesk__close_ticket"\ndelta = {}\n`,
    }),
  ).rejects.toThrow(
    /^rules\/servers\/payments_api\.toml may hold only rules for the tools of the MCP server it is named for/,
  );
  expect(await selfServiceIncludeState(org.id)).toEqual({
    folder: "rules/servers",
    state: "included",
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

  // Another folder, by the variable.
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

test("a read lists every rule for the server's tools across the policy, the root's first, with the file each comes from", async ({
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
  for (const name of ["refund_payment", "get_invoice", "export_ledger"])
    await ToolModel.createToolIfNotExists({
      name: `payments_api__${name}`,
      description: name,
      parameters: {},
      catalogId: catalog.id,
    });
  // The root keeps one rule for the server and includes a team's file that
  // keeps another; the server has no file of its own yet.
  const team =
    '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "payments_api__refund_payment"\nrequires = { trust = "trusted" }\ndelta = {}\n\n[[policy.tool]]\nname = "helpdesk__read_ticket"\ndelta = {}\n';
  await connectApp({ organizationId: org.id });
  serveRepository({
    head: FIRST,
    files: {
      [FIRST]: {
        // Release 1.4 reads server rules only once setup is complete: the
        // servers' folder included, and the ruleset the App keeps in place.
        "appa.toml": `include = ["teams/*.toml", "mcp/*.toml"]\n\n${RULES}`,
        "teams/support.toml": team,
      },
    },
  });
  await syncAppaGithubPolicy(org.id);
  expect(
    (await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError,
  ).toBeNull();

  const read = await getServerRules({
    organizationId: org.id,
    userId: admin.id,
    catalogId: catalog.id,
  });
  expect(read).toMatchObject({ content: null, path: "mcp/payments_api.toml" });
  expect(read.rules).toEqual([
    {
      file: "appa.toml",
      name: "payments_api__export_ledger",
      rule: { name: "payments_api__export_ledger", delta: {} },
    },
    {
      file: "teams/support.toml",
      name: "payments_api__refund_payment",
      rule: {
        name: "payments_api__refund_payment",
        requires: { trust: "trusted" },
        delta: {},
      },
    },
  ]);
  expect(read.instruction).toContain("other files of the policy keep");
});
