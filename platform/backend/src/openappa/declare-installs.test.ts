import { createHash } from "node:crypto";
import { vi } from "vitest";
import db, { schema } from "@/database";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { describe, expect, test } from "@/test";
import type {
  BatteryCredentialBindings,
  BatteryPackageFile,
} from "@/types/openappa-batteries";
import { packageContentHash, uploadedEntry } from "./declarations";
import { declareExistingInstalls } from "./declare-installs";

describe("declaring the legacy battery installs", () => {
  test("declares a bundled battery with its catalog's prefix and its owner's credential", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: catalog.id, name: "github_prod__list" });
    await legacyInstall({
      organizationId,
      batteryName: "github",
      catalogId: catalog.id,
      credentialBindings: { APPA_PROVIDER_GITHUB_TOKEN: "github_prod_token" },
    });

    const summary = await declareExistingInstalls();

    expect(summary).toEqual({
      declared: [organizationId],
      unchanged: [],
      failed: [],
    });
    const declared = await declarationsOf(organizationId);
    expect(declared.include.map((entry) => entry.entry)).toEqual([
      "batteries/github/appa.toml",
    ]);
    expect(
      declared.serverAliases.map(({ namespace, servers }) => ({
        namespace,
        servers,
      })),
    ).toEqual([{ namespace: "github", servers: ["github_prod"] }]);
    expect(
      declared.credentials.map(({ variable, key }) => [variable, key]),
    ).toEqual([["APPA_PROVIDER_GITHUB_TOKEN", "github_prod_token"]]);
  });

  test("declares the stored package's hashed spelling when one shadows the bundled battery", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: catalog.id, name: "github_prod__list" });
    const contentHash = await storePackage({ organizationId, name: "github" });
    await legacyInstall({
      organizationId,
      batteryName: "github",
      catalogId: catalog.id,
    });

    await declareExistingInstalls();

    const declared = await declarationsOf(organizationId);
    expect(declared.include.map((entry) => entry.entry)).toEqual([
      uploadedEntry({ name: "github", contentHash }),
    ]);
  });

  test("leaves a variable two owners bind to different keys unbound", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const github = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: github.id, name: "github_prod__list" });
    const linear = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: linear.id, name: "linear_prod__list" });
    await legacyInstall({
      organizationId,
      batteryName: "github",
      catalogId: github.id,
      credentialBindings: { APPA_PROVIDER_GITHUB_TOKEN: "github_prod_token" },
    });
    await legacyInstall({
      organizationId,
      batteryName: "linear",
      catalogId: linear.id,
      credentialBindings: {
        APPA_PROVIDER_GITHUB_TOKEN: "github_backup_token",
        APPA_PROVIDER_LINEAR_TOKEN: "linear_prod_token",
      },
    });

    await declareExistingInstalls();

    const declared = await declarationsOf(organizationId);
    expect(declared.include.map((entry) => entry.entry)).toEqual([
      "batteries/github/appa.toml",
      "batteries/linear/appa.toml",
    ]);
    expect(
      declared.credentials.map(({ variable, key }) => [variable, key]),
    ).toEqual([["APPA_PROVIDER_LINEAR_TOKEN", "linear_prod_token"]]);
  });

  test("declares neither a disabled install nor one of an unknown battery, and touches no row", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: catalog.id, name: "github_prod__list" });
    const disabled = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: disabled.id, name: "linear_prod__list" });
    const unknown = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: unknown.id, name: "ghost_prod__list" });
    await legacyInstall({
      organizationId,
      batteryName: "github",
      catalogId: catalog.id,
    });
    await legacyInstall({
      organizationId,
      batteryName: "linear",
      catalogId: disabled.id,
      enabled: false,
      credentialBindings: { APPA_PROVIDER_LINEAR_TOKEN: "linear_prod_token" },
    });
    await legacyInstall({
      organizationId,
      batteryName: "ghost",
      catalogId: unknown.id,
    });
    const before = await OpenAppaBatteryInstallModel.list(organizationId);

    await declareExistingInstalls();

    const declared = await declarationsOf(organizationId);
    expect(declared.include.map((entry) => entry.entry)).toEqual([
      "batteries/github/appa.toml",
    ]);
    expect(declared.serverAliases.map((alias) => alias.namespace)).toEqual([
      "github",
    ]);
    expect(declared.credentials).toEqual([]);
    expect(await OpenAppaBatteryInstallModel.list(organizationId)).toEqual(
      before,
    );
  });

  test("writes no second revision when it runs again", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: catalog.id, name: "github_prod__list" });
    await legacyInstall({
      organizationId,
      batteryName: "github",
      catalogId: catalog.id,
      credentialBindings: { APPA_PROVIDER_GITHUB_TOKEN: "github_prod_token" },
    });

    await declareExistingInstalls();
    const first = await declarationsOf(organizationId);
    const second = await declareExistingInstalls();

    expect(second).toEqual({
      declared: [],
      unchanged: [organizationId],
      failed: [],
    });
    expect((await declarationsOf(organizationId)).revision).toEqual(
      first.revision,
    );
  });

  test("declares an organization whose policy GitHub sync owns, and marks it pending", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: catalog.id, name: "github_prod__list" });
    await legacyInstall({
      organizationId,
      batteryName: "github",
      catalogId: catalog.id,
    });
    await OpenAppaGithubSyncModel.save(organizationId, {
      repo: "acme/policies",
      ref: null,
      path: "organization.appa.toml",
      interval: "1h",
      githubPatId: null,
      githubAppConfigId: null,
    });

    const summary = await declareExistingInstalls();

    expect(summary.declared).toEqual([organizationId]);
    const declared = await declarationsOf(organizationId);
    expect(declared.include.map((entry) => entry.entry)).toEqual([
      "batteries/github/appa.toml",
    ]);
    expect(
      (await OpenAppaGithubSyncModel.find(organizationId))
        ?.declarationsPendingPublish,
    ).toBe(true);
  });

  test("retries a save that lost the revision race", async ({
    makeOrganization,
    makeUser,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({ catalogId: catalog.id, name: "github_prod__list" });
    await legacyInstall({
      organizationId,
      batteryName: "github",
      catalogId: catalog.id,
    });
    const save = GuardrailsPolicyModel.saveDeclarationMigration;
    const spy = vi
      .spyOn(GuardrailsPolicyModel, "saveDeclarationMigration")
      .mockImplementationOnce(async (params) => {
        // Someone else's revision lands between this step's read and its save.
        const raced = "# edited elsewhere\n[policy]\nversion = 2\n";
        await GuardrailsPolicyModel.save({
          organizationId,
          updatedBy: userId,
          content: raced,
          contentHash: createHash("sha256").update(raced).digest("hex"),
          expectedRevision: params.expectedRevision,
        });
        return save(params);
      });

    try {
      const summary = await declareExistingInstalls();

      expect(summary.declared).toEqual([organizationId]);
    } finally {
      spy.mockRestore();
    }
    const declared = await declarationsOf(organizationId);
    expect(declared.revision).toBe(2);
    expect(declared.include.map((entry) => entry.entry)).toEqual([
      "batteries/github/appa.toml",
    ]);
  });
});

/**
 * A row as the panel wrote it before batteries became declarations. Rows are
 * written one second apart: the step reads them in `createdAt` order, which is
 * how the helper owner of a battery and the order of the entries are settled.
 */
let written = 0;
async function legacyInstall(params: {
  organizationId: string;
  batteryName: string;
  catalogId: string;
  enabled?: boolean;
  credentialBindings?: BatteryCredentialBindings;
}) {
  const [row] = await db
    .insert(schema.openappaBatteryInstallsTable)
    .values({
      organizationId: params.organizationId,
      batteryName: params.batteryName,
      catalogId: params.catalogId,
      createdAt: new Date(Date.UTC(2026, 0, 1) + written++ * 1000),
      enabled: params.enabled ?? true,
      credentialBindings: params.credentialBindings ?? {},
    })
    .returning();
  return row;
}

/** An uploaded package of `name`, stored as the upload route stores one. */
async function storePackage(params: {
  organizationId: string;
  name: string;
}): Promise<string> {
  const files: BatteryPackageFile[] = [
    {
      path: "appa-package.toml",
      text: `schema = 1
name = "${params.name}"
description = "An organization's own ${params.name} battery"

[battery]
policy = "appa.toml"
hosts = ["claude-code"]
namespaces = ["${params.name}"]
`,
    },
    {
      path: "appa.toml",
      text: `[policy]
version = 2

[[policy.tool]]
name = "mcp/${params.name}/list"
delta = {}
`,
    },
  ];
  const contentHash = packageContentHash(files);
  await OpenAppaBatteryPackageModel.insert({
    organizationId: params.organizationId,
    name: params.name,
    description: `An organization's own ${params.name} battery`,
    contentHash,
    files,
  });
  return contentHash;
}

/** The declarations of the organization's latest revision, as the parser reads them. */
async function declarationsOf(organizationId: string) {
  const latest = await GuardrailsPolicyModel.findLatest(organizationId);
  if (!latest) throw new Error(`No policy revision for ${organizationId}`);
  const native = await import("@archestra/openappa-rs");
  const parsed = await native.parseOpenappaDeclarations(latest.content);
  expect(parsed.errors).toEqual([]);
  return { revision: latest.revision, ...parsed };
}
