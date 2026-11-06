import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import config from "@/config";
import db, { schema } from "@/database";
import {
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import ToolModel from "@/models/tool";
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  checkDueAppaGithubSyncs,
  syncAppaGithubPolicy,
} from "@/services/openappa-github-sync";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  getServerRules,
  getServerRulesChangeStatus,
  previewServerRulesChange,
  proposeServerRulesChange,
} from "./openappa-server-rules";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture
const server = useMswServer();
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
    "mcp/payments_api.toml",
    "mcp/helpdesk.toml",
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
    'mcp/README.toml: mcp/ holds one file per MCP server, named by its tools\' prefix; "README" is not one Archestra gives a server',
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
      name: "Archestra Guardrails policy",
      head_sha: goodHead,
      conclusion: "success",
    }),
  ]);
  expect(statuses).toEqual([
    {
      sha: badHead,
      state: "failure",
      context: "Archestra Guardrails policy",
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
