import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import {
  EnvironmentModel,
  InternalMcpCatalogModel,
  OrganizationModel,
} from "@/models";
import { assertInstallAllowedOrBlock } from "@/services/mcp-install-policy";
import { describe, expect, test } from "@/test";
import type { CatalogItemApprovalStatus } from "@/types";

const UNTRUSTED_IMAGE = "ghcr.io/evil/x:1";
const TRUSTED_IMAGE = "ghcr.io/acme/server:1";

async function approvalStatus(catalogId: string): Promise<string | null> {
  const item = await InternalMcpCatalogModel.findById(catalogId);
  return item?.catalogItemApprovalStatus ?? null;
}

async function setApproval(
  catalogId: string,
  status: CatalogItemApprovalStatus,
  reason: string | null = null,
): Promise<void> {
  await db
    .update(schema.internalMcpCatalogTable)
    .set({
      catalogItemApprovalStatus: status,
      catalogItemApprovalReason: reason,
    })
    .where(eq(schema.internalMcpCatalogTable.id, catalogId));
}

describe("assertInstallAllowedOrBlock", () => {
  test("allows when the environment has no trusted registries", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });

    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: catalog,
        organizationId: org.id,
      }),
    ).resolves.toBeUndefined();
    expect(await approvalStatus(catalog.id)).toBeNull();
  });

  test("blocks an untrusted image and records pending", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });

    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: catalog,
        organizationId: org.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await approvalStatus(catalog.id)).toBe("pending");
  });

  test("allows when the image matches a trusted registry", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: TRUSTED_IMAGE },
    });

    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: catalog,
        organizationId: org.id,
      }),
    ).resolves.toBeUndefined();
    expect(await approvalStatus(catalog.id)).toBeNull();
  });

  test("does not gate non-personal catalog items", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    for (const scope of ["team", "org"] as const) {
      const catalog = await makeInternalMcpCatalog({
        organizationId: org.id,
        scope,
        serverType: "local",
        localConfig: { dockerImage: UNTRUSTED_IMAGE },
      });
      await expect(
        assertInstallAllowedOrBlock({
          catalogItem: catalog,
          organizationId: org.id,
        }),
      ).resolves.toBeUndefined();
    }
  });

  test("does not gate non-local server types", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "remote",
      serverUrl: "https://example.com/mcp/",
    });
    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: catalog,
        organizationId: org.id,
      }),
    ).resolves.toBeUndefined();
  });

  test("does not gate when there is no custom image (uses base image)", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { command: "node server.js" },
    });
    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: catalog,
        organizationId: org.id,
      }),
    ).resolves.toBeUndefined();
  });

  test("does not gate the platform default base image", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: config.orchestrator.mcpServerBaseImage },
    });
    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: catalog,
        organizationId: org.id,
      }),
    ).resolves.toBeUndefined();
  });

  test("allows an already-approved catalog item without re-gating", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });
    await setApproval(catalog.id, "approved");
    const approved = await InternalMcpCatalogModel.findById(catalog.id);

    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: approved!,
        organizationId: org.id,
      }),
    ).resolves.toBeUndefined();
  });

  test("blocks a declined catalog item and surfaces the reason", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });
    await setApproval(catalog.id, "declined", "unvetted publisher");
    const declined = await InternalMcpCatalogModel.findById(catalog.id);

    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: declined!,
        organizationId: org.id,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("unvetted publisher"),
    });
  });

  test("resolves a named environment's trusted registries", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    // Org default trusts acme, but the catalog's environment trusts only beta.
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const environment = await EnvironmentModel.create({
      organizationId: org.id,
      name: "staging",
      trustedImageRegistries: ["ghcr.io/beta"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      environmentId: environment.id,
      localConfig: { dockerImage: "ghcr.io/acme/server:1" },
    });

    // acme is trusted by the org default but NOT by the catalog's environment,
    // so the install is blocked.
    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: catalog,
        organizationId: org.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  test("clears a stale pending flag when no longer gated", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });
    // First attempt blocks and records pending.
    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: catalog,
        organizationId: org.id,
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await approvalStatus(catalog.id)).toBe("pending");

    // Admin widens the trusted list to include the image's registry.
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: [
        "ghcr.io/acme",
        "ghcr.io/evil",
      ],
    });
    const stalePending = await InternalMcpCatalogModel.findById(catalog.id);
    await expect(
      assertInstallAllowedOrBlock({
        catalogItem: stalePending!,
        organizationId: org.id,
      }),
    ).resolves.toBeUndefined();
    expect(await approvalStatus(catalog.id)).toBeNull();
  });
});
