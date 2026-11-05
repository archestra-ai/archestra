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
import { syncAppaGithubPolicy } from "@/services/openappa-github-sync";
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

/** A repository whose branch head and files the test moves. */
function serveRepository(state: {
  head: string;
  files: Record<string, Record<string, string>>;
}) {
  const paths = ["appa.toml", "mcp/payments_api.toml"];
  server.use(
    http.get(`${REPO}/commits/:ref`, () =>
      HttpResponse.json({ sha: state.head }),
    ),
    ...paths.map((path) =>
      http.get(`${REPO}/contents/${path}`, ({ request }) => {
        const ref = new URL(request.url).searchParams.get("ref") ?? "";
        const text = state.files[ref]?.[path];
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

  state.files[FIRST] = {
    "appa.toml": INCLUDING,
    "mcp/payments_api.toml": "[externals]\ntimeout_ms = 1\n",
  };
  await syncAppaGithubPolicy(org.id);
  expect((await OpenAppaGithubSyncModel.find(org.id))?.lastSyncError).toMatch(
    /^mcp\/payments_api\.toml: an included file may set only .*it sets externals$/,
  );
  expect(await GuardrailsPolicyModel.findLatest(org.id)).toBeNull();
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
  ).rejects.toThrow(/Rename or remove: helpdesk__close_ticket$/);

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
  ).rejects.toThrow(
    /Rename or remove: \[\[policy\.authority\]\] payments_api\.anyone$/,
  );

  const preview = await previewServerRulesChange({ ...change, userId: pat.id });
  expect(preview).toMatchObject({
    stage: "preview",
    valid: true,
    path: "mcp/payments_api.toml",
    before: "",
    after: REFUNDS,
  });
  expect(preview.rootChange).toContain('+include = ["mcp/payments_api.toml"]');

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
  // One commit: the server's file, and appa.toml including it the first time.
  expect(trees[0]?.tree.map((file) => file.path)).toEqual([
    "mcp/payments_api.toml",
    "appa.toml",
  ]);
  expect(trees[0]?.tree[0]?.content).toBe(REFUNDS);
  expect(trees[0]?.tree[1]?.content).toContain('"mcp/payments_api.toml"');
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
