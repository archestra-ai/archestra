import db, { schema } from "@/database";
import { K8sClusterModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

const VALID_KUBECONFIG = `
apiVersion: v1
kind: Config
clusters:
- cluster:
    server: https://test-cluster.example.com
  name: test-cluster
contexts:
- context:
    cluster: test-cluster
    user: test-user
  name: test-context
current-context: test-context
users:
- name: test-user
  user:
    token: test-token
`;

describe("K8sClusterModel", () => {
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    const org = await makeOrganization();
    organizationId = org.id;
  });

  afterEach(async () => {
    // cleanup handled by PGlite rollback
  });

  describe("create", () => {
    test("creates a cluster and returns it", async () => {
      const cluster = await K8sClusterModel.create({
        organizationId,
        name: "My Cluster",
        kubeconfig: VALID_KUBECONFIG,
      });

      expect(cluster.id).toBeDefined();
      expect(cluster.organizationId).toBe(organizationId);
      expect(cluster.name).toBe("My Cluster");
      expect(cluster.kubeconfig).toBe(VALID_KUBECONFIG);
    });
  });

  describe("findAll", () => {
    test("returns clusters for the organization in creation order", async () => {
      await K8sClusterModel.create({
        organizationId,
        name: "Cluster A",
        kubeconfig: VALID_KUBECONFIG,
      });
      await K8sClusterModel.create({
        organizationId,
        name: "Cluster B",
        kubeconfig: VALID_KUBECONFIG,
      });

      const clusters = await K8sClusterModel.findAll(organizationId);

      expect(clusters).toHaveLength(2);
      expect(clusters[0]?.name).toBe("Cluster A");
      expect(clusters[1]?.name).toBe("Cluster B");
    });

    test("does not return clusters from other organizations", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      await K8sClusterModel.create({
        organizationId: otherOrg.id,
        name: "Other Org Cluster",
        kubeconfig: VALID_KUBECONFIG,
      });

      const clusters = await K8sClusterModel.findAll(organizationId);
      expect(clusters).toHaveLength(0);
    });
  });

  describe("findById", () => {
    test("returns the cluster when found in the organization", async () => {
      const created = await K8sClusterModel.create({
        organizationId,
        name: "Test",
        kubeconfig: VALID_KUBECONFIG,
      });

      const found = await K8sClusterModel.findById(created.id, organizationId);
      expect(found?.id).toBe(created.id);
    });

    test("returns null when cluster belongs to a different organization", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const created = await K8sClusterModel.create({
        organizationId: otherOrg.id,
        name: "Test",
        kubeconfig: VALID_KUBECONFIG,
      });

      const found = await K8sClusterModel.findById(created.id, organizationId);
      expect(found).toBeNull();
    });

    test("returns null for non-existent id", async () => {
      const found = await K8sClusterModel.findById(
        "00000000-0000-0000-0000-000000000000",
        organizationId,
      );
      expect(found).toBeNull();
    });
  });

  describe("delete", () => {
    test("deletes a cluster that is not in use", async () => {
      const cluster = await K8sClusterModel.create({
        organizationId,
        name: "To Delete",
        kubeconfig: VALID_KUBECONFIG,
      });

      await expect(
        K8sClusterModel.delete(cluster.id, organizationId),
      ).resolves.toBeUndefined();

      const found = await K8sClusterModel.findById(cluster.id, organizationId);
      expect(found).toBeNull();
    });

    test("does not delete cluster from a different organization", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const cluster = await K8sClusterModel.create({
        organizationId: otherOrg.id,
        name: "Other",
        kubeconfig: VALID_KUBECONFIG,
      });

      await K8sClusterModel.delete(cluster.id, organizationId);

      // cluster should still exist
      const found = await K8sClusterModel.findById(cluster.id, otherOrg.id);
      expect(found).not.toBeNull();
    });

    test("throws ApiError when cluster is referenced by an MCP server", async () => {
      const cluster = await K8sClusterModel.create({
        organizationId,
        name: "In Use",
        kubeconfig: VALID_KUBECONFIG,
      });

      // Directly insert an MCP server referencing the cluster
      const catalog = await db
        .insert(schema.internalMcpCatalogTable)
        .values({
          name: "test-catalog",
          serverType: "local",
          localConfig: { command: "node", arguments: [] },
        })
        .returning();
      await db.insert(schema.mcpServersTable).values({
        name: "server-using-cluster",
        serverType: "local",
        catalogId: catalog[0]?.id,
        k8sClusterId: cluster.id,
      });

      await expect(
        K8sClusterModel.delete(cluster.id, organizationId),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
