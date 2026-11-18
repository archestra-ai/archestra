import { eq } from "drizzle-orm";
import { describe, expect } from "vitest";
import db, { schema } from "@/database";
import { EnvironmentModel, InternalMcpCatalogModel } from "@/models";
import { ENVIRONMENT_CLUSTER_WRITE_LIFETIME_MS } from "@/models/environment";
import { test } from "@/test";

const ALL_USES = ["catalogItems", "agents", "workspaces"] as const;

describe("EnvironmentModel: writes to an environment's own cluster", () => {
  test("an environment with a write in progress is not marked as being deleted", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const environment = await makeBoundEnvironment({
      makeOrganization,
      makeSecret,
    });
    const writeId = await EnvironmentModel.beginClusterWrite(environment.id);
    expect(writeId).not.toBeNull();

    await expect(mark(environment)).resolves.toEqual({
      outcome: "busy",
      writes: 1,
    });
    expect((await reload(environment)).deletingAt).toBeNull();

    await EnvironmentModel.endClusterWrite(writeId as string);
    await expect(mark(environment)).resolves.toMatchObject({
      outcome: "marked",
    });
    expect((await reload(environment)).deletingAt).not.toBeNull();
  });

  test("an environment that is being deleted refuses a new write", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const environment = await makeBoundEnvironment({
      makeOrganization,
      makeSecret,
    });
    await mark(environment);

    await expect(
      EnvironmentModel.beginClusterWrite(environment.id),
    ).resolves.toBeNull();
    await expect(
      db
        .select()
        .from(schema.environmentClusterWritesTable)
        .where(
          eq(
            schema.environmentClusterWritesTable.environmentId,
            environment.id,
          ),
        ),
    ).resolves.toHaveLength(0);
  });

  test("a write of an environment that does not exist is refused", async () => {
    await expect(
      EnvironmentModel.beginClusterWrite(
        "00000000-0000-4000-8000-00000000dead",
      ),
    ).resolves.toBeNull();
  });

  test("a write left behind by a stopped process stops holding off the delete once it is old", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const environment = await makeBoundEnvironment({
      makeOrganization,
      makeSecret,
    });
    const writeId = (await EnvironmentModel.beginClusterWrite(
      environment.id,
    )) as string;
    await db
      .update(schema.environmentClusterWritesTable)
      .set({
        createdAt: new Date(
          Date.now() - ENVIRONMENT_CLUSTER_WRITE_LIFETIME_MS - 1000,
        ),
      })
      .where(eq(schema.environmentClusterWritesTable.id, writeId));

    await expect(mark(environment)).resolves.toMatchObject({
      outcome: "marked",
    });
    await expect(
      db
        .select()
        .from(schema.environmentClusterWritesTable)
        .where(eq(schema.environmentClusterWritesTable.id, writeId)),
    ).resolves.toHaveLength(0);
  });

  test("an environment in use is not marked, and reports the uses", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const environment = await makeBoundEnvironment({
      makeOrganization,
      makeSecret,
    });
    await assignCatalogItem(environment);

    const outcome = await mark(environment);
    expect(outcome).toMatchObject({
      outcome: "in-use",
      uses: { catalogItems: 1 },
    });
    expect((await reload(environment)).deletingAt).toBeNull();
  });

  test("deleting a marked environment returns the kubeconfig secret it named", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const environment = await makeBoundEnvironment({
      makeOrganization,
      makeSecret,
    });
    await mark(environment);

    await expect(
      EnvironmentModel.deleteMarked({
        id: environment.id,
        organizationId: environment.organizationId,
        blocking: ["catalogItems", "agents"],
      }),
    ).resolves.toEqual({
      outcome: "deleted",
      kubeconfigSecretId: environment.kubeconfigSecretId,
    });
    await expect(
      EnvironmentModel.findById(environment.id),
    ).resolves.toBeFalsy();
  });

  test("something assigned to a marked environment stops its delete and puts it back in service", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const environment = await makeBoundEnvironment({
      makeOrganization,
      makeSecret,
    });
    await mark(environment);
    await assignCatalogItem(environment);

    const outcome = await EnvironmentModel.deleteMarked({
      id: environment.id,
      organizationId: environment.organizationId,
      blocking: ["catalogItems", "agents"],
    });

    expect(outcome).toMatchObject({
      outcome: "restored",
      uses: { catalogItems: 1 },
    });
    const restored = await reload(environment);
    expect(restored.deletingAt).toBeNull();
    await expect(
      EnvironmentModel.beginClusterWrite(environment.id),
    ).resolves.not.toBeNull();
  });

  test("an environment that is being deleted is not changed by an update", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const environment = await makeBoundEnvironment({
      makeOrganization,
      makeSecret,
    });
    await mark(environment);

    await expect(
      EnvironmentModel.update({
        id: environment.id,
        organizationId: environment.organizationId,
        namespace: "another-namespace",
      }),
    ).resolves.toBeNull();
    expect((await reload(environment)).namespace).toBe(environment.namespace);
  });
});

async function makeBoundEnvironment(fixtures: {
  makeOrganization: () => Promise<{ id: string }>;
  makeSecret: () => Promise<{ id: string }>;
}) {
  const organization = await fixtures.makeOrganization();
  const secret = await fixtures.makeSecret();
  return EnvironmentModel.create({
    organizationId: organization.id,
    name: "Workloads cluster",
    namespace: "workloads",
    kubeconfig: { secretId: secret.id, server: "https://cluster.example:6443" },
  });
}

function mark(environment: { id: string; organizationId: string }) {
  return EnvironmentModel.markDeleting({
    id: environment.id,
    organizationId: environment.organizationId,
    blocking: [...ALL_USES],
  });
}

async function reload(environment: { id: string }) {
  const row = await EnvironmentModel.findById(environment.id);
  if (!row) throw new Error("environment is gone");
  return row;
}

async function assignCatalogItem(environment: { id: string }) {
  await InternalMcpCatalogModel.create({
    name: "assigned-server",
    serverType: "remote",
    serverUrl: "https://mcp.example/mcp",
    environmentId: environment.id,
  });
}

describe("EnvironmentModel: one environment per namespace of a cluster", () => {
  test("finds the environment that deploys into a namespace of a cluster", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const environment = await makeBoundEnvironment({
      makeOrganization,
      makeSecret,
    });

    await expect(
      EnvironmentModel.findByClusterNamespace({
        server: "https://cluster.example:6443",
        namespace: "workloads",
      }),
    ).resolves.toMatchObject({ id: environment.id });
    await expect(
      EnvironmentModel.findByClusterNamespace({
        server: "https://cluster.example:6443",
        namespace: "another",
      }),
    ).resolves.toBeNull();
  });

  test("a second environment cannot take the same namespace of the same cluster", async ({
    makeOrganization,
    makeSecret,
  }) => {
    await makeBoundEnvironment({ makeOrganization, makeSecret });

    await expect(
      makeBoundEnvironment({ makeOrganization, makeSecret }),
    ).rejects.toThrow();
  });
});

describe("EnvironmentModel: replacing the kubeconfig", () => {
  test("of two rotations that saw the same credential, only the first changes the environment", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const environment = await makeBoundEnvironment({
      makeOrganization,
      makeSecret,
    });
    const seen = environment.kubeconfigSecretId as string;
    const first = await makeSecret();
    const second = await makeSecret();
    const rotate = (secretId: string) =>
      EnvironmentModel.update({
        id: environment.id,
        organizationId: environment.organizationId,
        rotatedKubeconfigSecretId: secretId,
        replacedKubeconfigSecretId: seen,
      });

    await expect(rotate(first.id)).resolves.toMatchObject({
      kubeconfigSecretId: first.id,
      kubeconfigVersion: environment.kubeconfigVersion + 1,
    });
    await expect(rotate(second.id)).resolves.toBeNull();
    expect((await reload(environment)).kubeconfigSecretId).toBe(first.id);
  });
});
