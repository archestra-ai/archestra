import { eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import InternalMcpCatalogVersionModel from "@/models/internal-mcp-catalog-version";
import { describe, expect, test } from "@/test";
import type {
  InternalMcpCatalogVersion,
  McpCatalogConfigSnapshot,
} from "@/types/internal-mcp-catalog-version";

type CatalogRef = { id: string };

/** Newest-first version list. */
async function listVersions(
  catalog: CatalogRef,
): Promise<InternalMcpCatalogVersion[]> {
  const { data } = await InternalMcpCatalogVersionModel.listForCatalog({
    catalogId: catalog.id,
    pagination: { limit: 200, offset: 0 },
  });
  return data;
}

async function getVersion(
  catalog: CatalogRef,
  version: number,
): Promise<InternalMcpCatalogVersion | null> {
  return await InternalMcpCatalogVersionModel.findByCatalogAndVersion({
    catalogId: catalog.id,
    version,
  });
}

describe("InternalMcpCatalogVersionModel", () => {
  test("create forks version 1 with a config-only snapshot", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      description: "first draft",
    });

    expect(catalog.latestVersion).toBe(1);

    const versions = await listVersions(catalog);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].snapshot.name).toBe(catalog.name);
    expect(versions[0].snapshot.description).toBe("first draft");
    expect(versions[0].snapshot.serverType).toBe("remote");

    // Sharing, frozen identity, and operational state are deliberately not
    // versioned.
    expect(versions[0].snapshot).not.toHaveProperty("scope");
    expect(versions[0].snapshot).not.toHaveProperty("teams");
    expect(versions[0].snapshot).not.toHaveProperty("labels");
    expect(versions[0].snapshot).not.toHaveProperty("multitenant");
    expect(versions[0].snapshot).not.toHaveProperty("deploymentName");
    expect(versions[0].snapshot).not.toHaveProperty("organizationId");
    expect(versions[0].snapshot).not.toHaveProperty("catalogReinstallRequired");
    expect(versions[0].snapshot).not.toHaveProperty(
      "catalogItemApprovalStatus",
    );
  });

  test("scalar config change forks a new head; old versions stay immutable", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();

    const updated = await InternalMcpCatalogModel.update(catalog.id, {
      description: "second draft",
    });

    expect(updated?.latestVersion).toBe(2);
    const head = await getVersion(catalog, 2);
    expect(head?.snapshot.description).toBe("second draft");
    const v1 = await getVersion(catalog, 1);
    expect(v1?.snapshot.description).toBeNull();
  });

  test("update producing identical config does not fork", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({ description: "same" });

    const updated = await InternalMcpCatalogModel.update(catalog.id, {
      description: "same",
    });

    expect(updated?.latestVersion).toBe(1);
    expect(await listVersions(catalog)).toHaveLength(1);
  });

  test("sharing-only change (labels) does not fork", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();

    const updated = await InternalMcpCatalogModel.update(catalog.id, {
      labels: [{ key: "env", value: "prod" }],
    });

    expect(updated?.labels).toMatchObject([{ key: "env", value: "prod" }]);
    expect(updated?.latestVersion).toBe(1);
    expect(await listVersions(catalog)).toHaveLength(1);
  });

  test("rename forks a version carrying the new name", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();

    await InternalMcpCatalogModel.renameCascade({
      id: catalog.id,
      newName: "renamed-catalog",
      flagReinstallRequired: false,
      freezeDeploymentNames: false,
    });

    const versions = await listVersions(catalog);
    expect(versions).toHaveLength(2);
    expect(versions[0].snapshot.name).toBe("renamed-catalog");
    expect(versions[1].snapshot.name).toBe(catalog.name);
  });

  test("rename composed with a follow-up update records one version (skipVersionFork)", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();

    // The PUT route's shape for a rename+edit save: the cascade defers its
    // fork to the generic update that always follows in the same request.
    await InternalMcpCatalogModel.renameCascade({
      id: catalog.id,
      newName: "renamed-composed",
      flagReinstallRequired: false,
      freezeDeploymentNames: false,
      skipVersionFork: true,
    });
    expect(await listVersions(catalog)).toHaveLength(1);

    const updated = await InternalMcpCatalogModel.update(catalog.id, {
      description: "edited in the same save",
    });

    expect(updated?.latestVersion).toBe(2);
    const head = await getVersion(catalog, 2);
    expect(head?.snapshot.name).toBe("renamed-composed");
    expect(head?.snapshot.description).toBe("edited in the same save");
  });

  test("snapshot carries secret-bundle IDs, never secret material", async ({
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const secretValue = `super-secret-${crypto.randomUUID()}`;
    const secret = await makeSecret({ secret: { TOKEN: secretValue } });
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      serverUrl: null,
      localConfigSecretId: secret.id,
      localConfig: {
        dockerImage: "example/image:1",
        environment: [
          {
            key: "TOKEN",
            type: "secret",
            promptOnInstallation: false,
            required: true,
          },
        ],
      },
    });

    const head = await getVersion(catalog, 1);
    expect(head?.snapshot.localConfigSecretId).toBe(secret.id);
    expect(JSON.stringify(head?.snapshot)).not.toContain(secretValue);
  });

  test("app-backed catalog rows never fork", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "app",
      serverUrl: null,
    });

    expect(catalog.latestVersion).toBe(0);
    expect(await listVersions(catalog)).toHaveLength(0);

    const updated = await InternalMcpCatalogModel.update(catalog.id, {
      description: "still not versioned",
    });
    expect(updated?.latestVersion).toBe(0);
    expect(await listVersions(catalog)).toHaveLength(0);
  });

  test("legacy row (latestVersion 0) forks version 1 on first config write", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    // Rewind to the pre-versioning state: no history, head pointer 0.
    await db
      .delete(schema.internalMcpCatalogVersionsTable)
      .where(eq(schema.internalMcpCatalogVersionsTable.catalogId, catalog.id));
    await db
      .update(schema.internalMcpCatalogTable)
      .set({ latestVersion: 0 })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));

    const updated = await InternalMcpCatalogModel.update(catalog.id, {
      description: "first post-versioning write",
    });

    expect(updated?.latestVersion).toBe(1);
    const versions = await listVersions(catalog);
    expect(versions).toHaveLength(1);
    expect(versions[0].snapshot.description).toBe(
      "first post-versioning write",
    );
  });

  test("soft delete + restore leaves history intact without a spurious fork", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();

    await InternalMcpCatalogModel.delete(catalog.id);
    expect(await InternalMcpCatalogModel.restore(catalog.id)).toBe(true);

    const versions = await listVersions(catalog);
    expect(versions).toHaveLength(1);
  });

  test("environment and dynamic-connection referents snapshot as id + name pairs", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const [environment] = await db
      .insert(schema.environmentsTable)
      .values({ name: "staging", organizationId: org.id })
      .returning();
    const install = await makeMcpServer({ catalogId: catalog.id });

    const updated = await InternalMcpCatalogModel.update(catalog.id, {
      environmentId: environment.id,
      dynamicConnectionMcpServerId: install.id,
    });

    expect(updated?.latestVersion).toBe(2);
    const head = await getVersion(catalog, 2);
    expect(head?.snapshot.environment).toEqual({
      id: environment.id,
      name: "staging",
    });
    expect(head?.snapshot.dynamicConnectionMcpServer).toEqual({
      id: install.id,
      name: install.name,
    });
  });

  test("renaming a referent does not fork on the next otherwise-no-op write", async ({
    makeInternalMcpCatalog,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const catalog = await makeInternalMcpCatalog({ organizationId: org.id });
    const [environment] = await db
      .insert(schema.environmentsTable)
      .values({ name: "staging", organizationId: org.id })
      .returning();
    await InternalMcpCatalogModel.update(catalog.id, {
      environmentId: environment.id,
    });
    expect(await listVersions(catalog)).toHaveLength(2);

    // The environment's name is live data owned by its own row; renaming it
    // runs no fork hook, and must not drift the catalog's content hash.
    await db
      .update(schema.environmentsTable)
      .set({ name: "staging-renamed" })
      .where(eq(schema.environmentsTable.id, environment.id));

    const fork = await InternalMcpCatalogVersionModel.forkIfChanged(catalog.id);
    expect(fork).toEqual({ version: 2, forked: false });
  });

  test("legacy imagePullSecrets rewrite in the modern shape does not fork", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      serverUrl: null,
      localConfig: { dockerImage: "example/image:1" },
    });

    // Seed the legacy on-disk shape directly (predates the normalization era).
    await db
      .update(schema.internalMcpCatalogTable)
      .set({
        localConfig: {
          dockerImage: "example/image:1",
          imagePullSecrets: [{ name: "pull-secret" }],
        } as (typeof schema.internalMcpCatalogTable.$inferSelect)["localConfig"],
      })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    const legacyFork = await InternalMcpCatalogVersionModel.forkIfChanged(
      catalog.id,
    );
    expect(legacyFork).toEqual({ version: 2, forked: true });
    const head = await getVersion(catalog, 2);
    expect(
      (head?.snapshot.localConfig as { imagePullSecrets: unknown[] })
        .imagePullSecrets,
    ).toEqual([{ source: "existing", name: "pull-secret" }]);

    // Rewriting the same config in the modern shape hashes identically.
    await db
      .update(schema.internalMcpCatalogTable)
      .set({
        localConfig: {
          dockerImage: "example/image:1",
          imagePullSecrets: [{ source: "existing", name: "pull-secret" }],
        },
      })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    const modernFork = await InternalMcpCatalogVersionModel.forkIfChanged(
      catalog.id,
    );
    expect(modernFork).toEqual({ version: 2, forked: false });
  });

  test("a fork failure never fails the surrounding write (best-effort)", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    const spy = vi
      .spyOn(InternalMcpCatalogVersionModel, "forkIfChanged")
      .mockRejectedValueOnce(new Error("fork exploded"));

    const updated = await InternalMcpCatalogModel.update(catalog.id, {
      description: "edited",
    });

    expect(updated?.description).toBe("edited");
    expect(spy).toHaveBeenCalledTimes(1);
    // Fork was swallowed → head pointer stays where it was.
    expect(updated?.latestVersion).toBe(1);

    spy.mockRestore();
  });

  test("forking past the retention window drops the oldest versions", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    // Stand in for a long edit history without paying 100 real forks: seed
    // filler rows and point the head at them, then fork once for real.
    const filler = Array.from({ length: 99 }, (_, index) => ({
      catalogId: catalog.id,
      version: index + 2,
      snapshot: {} as McpCatalogConfigSnapshot,
      contentHash: `filler-${index + 2}`,
    }));
    await db.insert(schema.internalMcpCatalogVersionsTable).values(filler);
    await db
      .update(schema.internalMcpCatalogTable)
      .set({ latestVersion: 100 })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));
    await db
      .update(schema.internalMcpCatalogTable)
      .set({ description: "forces a new head" })
      .where(eq(schema.internalMcpCatalogTable.id, catalog.id));

    const fork = await InternalMcpCatalogVersionModel.forkIfChanged(catalog.id);

    expect(fork).toEqual({ version: 101, forked: true });
    const versions = await listVersions(catalog);
    // 100 kept: the new head back to version 2; version 1 aged out.
    expect(versions).toHaveLength(100);
    expect(versions[0].version).toBe(101);
    expect(versions[versions.length - 1].version).toBe(2);
    expect(await getVersion(catalog, 1)).toBeNull();
  });

  test("list pagination returns newest first with a stable total", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    await InternalMcpCatalogModel.update(catalog.id, { description: "two" });
    await InternalMcpCatalogModel.update(catalog.id, { description: "three" });

    const firstPage = await InternalMcpCatalogVersionModel.listForCatalog({
      catalogId: catalog.id,
      pagination: { limit: 2, offset: 0 },
    });
    expect(firstPage.pagination.total).toBe(3);
    expect(firstPage.data.map((v) => v.version)).toEqual([3, 2]);

    const secondPage = await InternalMcpCatalogVersionModel.listForCatalog({
      catalogId: catalog.id,
      pagination: { limit: 2, offset: 2 },
    });
    expect(secondPage.data.map((v) => v.version)).toEqual([1]);
  });
});
