import { expect, test } from "./fixtures";

test.describe("Knowledge Graphs API", () => {
  test.describe("Knowledge Graph CRUD", () => {
    test("should create a knowledge graph", async ({
      request,
      createKnowledgeGraph,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const name = `E2E KG Create ${uniqueSuffix}`;

      const response = await createKnowledgeGraph(request, name);
      const kg = await response.json();

      expect(kg).toHaveProperty("id");
      expect(kg.name).toBe(name);
      expect(kg.provider).toBe("lightrag");
      expect(kg.config).toEqual({ apiUrl: "http://localhost:9100" });
      expect(kg).toHaveProperty("createdAt");
      expect(kg).toHaveProperty("updatedAt");

      // Cleanup
      await deleteKnowledgeGraph(request, kg.id);
    });

    test("should get a knowledge graph by ID", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const name = `E2E KG Get ${uniqueSuffix}`;

      const createResponse = await createKnowledgeGraph(request, name);
      const created = await createResponse.json();

      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${created.id}`,
      });
      const kg = await response.json();

      expect(kg.id).toBe(created.id);
      expect(kg.name).toBe(name);
      expect(kg.provider).toBe("lightrag");
      expect(kg.config).toEqual({ apiUrl: "http://localhost:9100" });

      // Cleanup
      await deleteKnowledgeGraph(request, kg.id);
    });

    test("should list knowledge graphs with pagination", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const name1 = `E2E KG List A ${uniqueSuffix}`;
      const name2 = `E2E KG List B ${uniqueSuffix}`;

      const res1 = await createKnowledgeGraph(request, name1);
      const kg1 = await res1.json();
      const res2 = await createKnowledgeGraph(request, name2);
      const kg2 = await res2.json();

      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: "/api/knowledge-graphs?limit=50&offset=0",
      });
      const body = await response.json();

      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination).toHaveProperty("total");
      expect(body.pagination).toHaveProperty("currentPage");
      expect(body.pagination).toHaveProperty("totalPages");
      expect(body.pagination).toHaveProperty("hasNext");
      expect(body.pagination).toHaveProperty("hasPrev");

      const ids = body.data.map((kg: { id: string }) => kg.id);
      expect(ids).toContain(kg1.id);
      expect(ids).toContain(kg2.id);

      // Cleanup
      await deleteKnowledgeGraph(request, kg1.id);
      await deleteKnowledgeGraph(request, kg2.id);
    });

    test("should update a knowledge graph", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const createResponse = await createKnowledgeGraph(
        request,
        `E2E KG Update ${uniqueSuffix}`,
      );
      const created = await createResponse.json();

      const updatedName = `E2E KG Updated ${uniqueSuffix}`;
      const updatedConfig = { apiUrl: "http://localhost:9200" };

      const updateResponse = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/knowledge-graphs/${created.id}`,
        data: { name: updatedName, config: updatedConfig },
      });
      const updated = await updateResponse.json();

      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe(updatedName);
      expect(updated.config).toEqual(updatedConfig);

      // Verify changes persisted
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${created.id}`,
      });
      const fetched = await getResponse.json();
      expect(fetched.name).toBe(updatedName);
      expect(fetched.config).toEqual(updatedConfig);

      // Cleanup
      await deleteKnowledgeGraph(request, created.id);
    });

    test("should delete a knowledge graph", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const createResponse = await createKnowledgeGraph(
        request,
        `E2E KG Delete ${uniqueSuffix}`,
      );
      const created = await createResponse.json();

      const deleteResponse = await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/knowledge-graphs/${created.id}`,
      });
      const result = await deleteResponse.json();
      expect(result.success).toBe(true);

      // Verify 404 on re-fetch
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${created.id}`,
        ignoreStatusCheck: true,
      });
      expect(getResponse.status()).toBe(404);
    });

    test("should return 400 when creating with missing required fields", async ({
      request,
      makeApiRequest,
    }) => {
      // Missing name
      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: "/api/knowledge-graphs",
        data: {
          provider: "lightrag",
          config: { apiUrl: "http://localhost:9100" },
        },
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(400);
    });

    test("should return 404 for non-existent knowledge graph", async ({
      request,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${crypto.randomUUID()}`,
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(404);
    });
  });

  test.describe("Knowledge Graph RBAC", () => {
    test("member can list knowledge graphs", async ({
      memberRequest,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request: memberRequest,
        method: "get",
        urlSuffix: "/api/knowledge-graphs?limit=10&offset=0",
      });
      expect(response.status()).toBe(200);

      const body = await response.json();
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
    });

    test("member cannot create a knowledge graph", async ({
      memberRequest,
      makeApiRequest,
    }) => {
      const response = await makeApiRequest({
        request: memberRequest,
        method: "post",
        urlSuffix: "/api/knowledge-graphs",
        data: {
          name: "Member KG Attempt",
          provider: "lightrag",
          config: { apiUrl: "http://localhost:9100" },
        },
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(403);
    });

    test("member cannot delete a knowledge graph", async ({
      request,
      memberRequest,
      makeApiRequest,
      createKnowledgeGraph,
      deleteKnowledgeGraph,
    }) => {
      // Create as admin
      const createResponse = await createKnowledgeGraph(
        request,
        `E2E KG RBAC Delete ${crypto.randomUUID().slice(0, 8)}`,
      );
      const kg = await createResponse.json();

      // Try to delete as member
      const deleteResponse = await makeApiRequest({
        request: memberRequest,
        method: "delete",
        urlSuffix: `/api/knowledge-graphs/${kg.id}`,
        ignoreStatusCheck: true,
      });
      expect(deleteResponse.status()).toBe(403);

      // Cleanup as admin
      await deleteKnowledgeGraph(request, kg.id);
    });
  });

  test.describe("Connector CRUD", () => {
    test("should create a connector", async ({
      request,
      createKnowledgeGraph,
      createConnector,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeGraph(
        request,
        `E2E KG Connector Create ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connectorName = `E2E Connector ${uniqueSuffix}`;
      const connectorRes = await createConnector(request, kg.id, connectorName);
      const connector = await connectorRes.json();

      expect(connector).toHaveProperty("id");
      expect(connector.name).toBe(connectorName);
      expect(connector.connectorType).toBe("jira");
      expect(connector.knowledgeGraphId).toBe(kg.id);
      expect(connector).toHaveProperty("config");
      expect(connector).toHaveProperty("schedule");
      expect(connector.enabled).toBe(true);
      expect(connector).toHaveProperty("createdAt");
      expect(connector).toHaveProperty("updatedAt");

      // Cleanup
      await deleteKnowledgeGraph(request, kg.id);
    });

    test("should get a connector by ID", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      createConnector,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeGraph(
        request,
        `E2E KG Connector Get ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connectorName = `E2E Connector Get ${uniqueSuffix}`;
      const connectorRes = await createConnector(request, kg.id, connectorName);
      const connector = await connectorRes.json();

      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${kg.id}/connectors/${connector.id}`,
      });
      const fetched = await getResponse.json();

      expect(fetched.id).toBe(connector.id);
      expect(fetched.name).toBe(connectorName);
      expect(fetched.connectorType).toBe("jira");

      // Cleanup
      await deleteKnowledgeGraph(request, kg.id);
    });

    test("should list connectors for a knowledge graph", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      createConnector,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeGraph(
        request,
        `E2E KG Connector List ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connRes1 = await createConnector(
        request,
        kg.id,
        `E2E Conn List A ${uniqueSuffix}`,
      );
      const conn1 = await connRes1.json();
      const connRes2 = await createConnector(
        request,
        kg.id,
        `E2E Conn List B ${uniqueSuffix}`,
      );
      const conn2 = await connRes2.json();

      const listResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${kg.id}/connectors?limit=50&offset=0`,
      });
      const body = await listResponse.json();

      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);

      const ids = body.data.map((c: { id: string }) => c.id);
      expect(ids).toContain(conn1.id);
      expect(ids).toContain(conn2.id);

      // Cleanup
      await deleteKnowledgeGraph(request, kg.id);
    });

    test("should update a connector", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      createConnector,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeGraph(
        request,
        `E2E KG Connector Update ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connRes = await createConnector(
        request,
        kg.id,
        `E2E Conn Update ${uniqueSuffix}`,
      );
      const connector = await connRes.json();

      const updatedName = `E2E Conn Updated ${uniqueSuffix}`;
      const updateResponse = await makeApiRequest({
        request,
        method: "put",
        urlSuffix: `/api/knowledge-graphs/${kg.id}/connectors/${connector.id}`,
        data: {
          name: updatedName,
          enabled: false,
          schedule: "0 0 * * *",
        },
      });
      const updated = await updateResponse.json();

      expect(updated.id).toBe(connector.id);
      expect(updated.name).toBe(updatedName);
      expect(updated.enabled).toBe(false);
      expect(updated.schedule).toBe("0 0 * * *");

      // Verify changes persisted
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${kg.id}/connectors/${connector.id}`,
      });
      const fetched = await getResponse.json();
      expect(fetched.name).toBe(updatedName);
      expect(fetched.enabled).toBe(false);

      // Cleanup
      await deleteKnowledgeGraph(request, kg.id);
    });

    test("should delete a connector", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      createConnector,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeGraph(
        request,
        `E2E KG Connector Delete ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connRes = await createConnector(
        request,
        kg.id,
        `E2E Conn Delete ${uniqueSuffix}`,
      );
      const connector = await connRes.json();

      const deleteResponse = await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/knowledge-graphs/${kg.id}/connectors/${connector.id}`,
      });
      const result = await deleteResponse.json();
      expect(result.success).toBe(true);

      // Verify 404 on re-fetch
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${kg.id}/connectors/${connector.id}`,
        ignoreStatusCheck: true,
      });
      expect(getResponse.status()).toBe(404);

      // Cleanup
      await deleteKnowledgeGraph(request, kg.id);
    });

    test("should return 400 when creating connector with invalid type", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeGraph(
        request,
        `E2E KG Connector Invalid ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const response = await makeApiRequest({
        request,
        method: "post",
        urlSuffix: `/api/knowledge-graphs/${kg.id}/connectors`,
        data: {
          name: "Invalid Connector",
          connectorType: "invalid_type",
          config: { baseUrl: "https://test.atlassian.net" },
          credentials: { email: "test@example.com", apiToken: "tok" },
        },
        ignoreStatusCheck: true,
      });
      expect(response.status()).toBe(400);

      // Cleanup
      await deleteKnowledgeGraph(request, kg.id);
    });

    test("connectors are cascade-deleted when KG is deleted", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      createConnector,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeGraph(
        request,
        `E2E KG Cascade ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connRes = await createConnector(
        request,
        kg.id,
        `E2E Conn Cascade ${uniqueSuffix}`,
      );
      const connector = await connRes.json();

      // Delete the KG
      const deleteResponse = await makeApiRequest({
        request,
        method: "delete",
        urlSuffix: `/api/knowledge-graphs/${kg.id}`,
      });
      const result = await deleteResponse.json();
      expect(result.success).toBe(true);

      // Verify connector is gone (KG is gone, so fetching connector via KG returns 404)
      const getResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${kg.id}/connectors/${connector.id}`,
        ignoreStatusCheck: true,
      });
      expect(getResponse.status()).toBe(404);
    });
  });

  test.describe("Connector Runs", () => {
    test("should list connector runs (empty initially)", async ({
      request,
      makeApiRequest,
      createKnowledgeGraph,
      createConnector,
      deleteKnowledgeGraph,
    }) => {
      const uniqueSuffix = crypto.randomUUID().slice(0, 8);
      const kgRes = await createKnowledgeGraph(
        request,
        `E2E KG Runs ${uniqueSuffix}`,
      );
      const kg = await kgRes.json();

      const connRes = await createConnector(
        request,
        kg.id,
        `E2E Conn Runs ${uniqueSuffix}`,
      );
      const connector = await connRes.json();

      const runsResponse = await makeApiRequest({
        request,
        method: "get",
        urlSuffix: `/api/knowledge-graphs/${kg.id}/connectors/${connector.id}/runs?limit=10&offset=0`,
      });
      const body = await runsResponse.json();

      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("pagination");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.pagination.total).toBe(0);

      // Cleanup
      await deleteKnowledgeGraph(request, kg.id);
    });
  });
});
