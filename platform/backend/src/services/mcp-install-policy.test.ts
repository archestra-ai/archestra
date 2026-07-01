import { eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import {
  EnvironmentModel,
  InternalMcpCatalogModel,
  OrganizationModel,
} from "@/models";
import {
  assertInstallAllowedOrBlock,
  flagImageApprovalRequired,
  holdInstallIfImageGated,
} from "@/services/mcp-install-policy";
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

  test("gates local items of any scope authored by a non-admin", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    for (const scope of ["personal", "team", "org"] as const) {
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
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(await approvalStatus(catalog.id)).toBe("pending");
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

describe("flagImageApprovalRequired", () => {
  test("flags untrusted local images of any scope that aren't approved", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });

    const gated = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: "ghcr.io/evil/x:1" },
    });
    const trusted = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: "ghcr.io/acme/server:1" },
    });
    const teamScoped = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "team",
      serverType: "local",
      localConfig: { dockerImage: "ghcr.io/evil/x:1" },
    });
    const approved = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: "ghcr.io/evil/x:1" },
    });
    await setApproval(approved.id, "approved");

    const items = [gated, trusted, teamScoped, approved].map((c) => ({
      ...c,
      catalogItemApprovalStatus:
        c.id === approved.id ? "approved" : c.catalogItemApprovalStatus,
    }));
    const required = await flagImageApprovalRequired(items, org.id);

    expect(required.has(gated.id)).toBe(true);
    expect(required.has(trusted.id)).toBe(false);
    // Team/org scope is now gated too — only admins are exempt, not scope.
    expect(required.has(teamScoped.id)).toBe(true);
    expect(required.has(approved.id)).toBe(false);
  });

  test("flags nothing when the environment has no trusted registries", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const item = await makeInternalMcpCatalog({
      organizationId: org.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: "ghcr.io/evil/x:1" },
    });
    const required = await flagImageApprovalRequired([item], org.id);
    expect(required.size).toBe(0);
  });

  test("does not flag an untrusted image authored by a privileged user", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });

    const byAdmin = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: admin.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });
    const byMember = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: member.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });

    const required = await flagImageApprovalRequired(
      [byAdmin, byMember],
      org.id,
    );
    expect(required.has(byAdmin.id)).toBe(false);
    expect(required.has(byMember.id)).toBe(true);
  });
});

describe("author privilege exemption", () => {
  test("does not gate an untrusted image authored by an admin", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: admin.id,
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

  test("gates an untrusted image authored by an editor (only admins are exempt)", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const editor = await makeUser();
    await makeMember(editor.id, org.id, { role: "editor" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: editor.id,
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

  test("gates an untrusted image authored by a plain member", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: member.id,
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
});

describe("holdInstallIfImageGated", () => {
  test("holds (pending) a non-privileged author's untrusted image edit", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: member.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });

    await expect(
      holdInstallIfImageGated({ catalogItem: catalog, organizationId: org.id }),
    ).resolves.toBe(true);
    expect(await approvalStatus(catalog.id)).toBe("pending");
  });

  test("does not hold a privileged author's untrusted image edit", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: "admin" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: admin.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });

    await expect(
      holdInstallIfImageGated({ catalogItem: catalog, organizationId: org.id }),
    ).resolves.toBe(false);
    expect(await approvalStatus(catalog.id)).toBeNull();
  });

  test("does not re-hold an already-approved item", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    await OrganizationModel.patch(org.id, {
      defaultEnvironmentTrustedImageRegistries: ["ghcr.io/acme"],
    });
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      authorId: member.id,
      scope: "personal",
      serverType: "local",
      localConfig: { dockerImage: UNTRUSTED_IMAGE },
    });
    await setApproval(catalog.id, "approved");
    const approved = await InternalMcpCatalogModel.findById(catalog.id);

    await expect(
      holdInstallIfImageGated({
        catalogItem: approved!,
        organizationId: org.id,
      }),
    ).resolves.toBe(false);
    expect(await approvalStatus(catalog.id)).toBe("approved");
  });
});
