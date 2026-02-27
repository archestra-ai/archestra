import { expect, test } from "./fixtures";

test.describe("MCP Catalog Labels", () => {
  test("create catalog item with labels", async ({
    request,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
  }) => {
    const response = await createMcpCatalogItem(request, {
      name: `label-test-${Date.now()}`,
      description: "Test catalog item with labels",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      labels: [
        { key: "category", value: "database" },
        { key: "tier", value: "premium" },
      ],
    });

    const catalogItem = await response.json();

    expect(catalogItem.labels).toHaveLength(2);
    // Labels are returned sorted by key
    expect(catalogItem.labels[0].key).toBe("category");
    expect(catalogItem.labels[0].value).toBe("database");
    expect(catalogItem.labels[1].key).toBe("tier");
    expect(catalogItem.labels[1].value).toBe("premium");

    await deleteMcpCatalogItem(request, catalogItem.id);
  });

  test("get catalog item returns labels", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
  }) => {
    const createResponse = await createMcpCatalogItem(request, {
      name: `label-get-test-${Date.now()}`,
      description: "Test get with labels",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      labels: [{ key: "env", value: "production" }],
    });

    const created = await createResponse.json();

    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/internal_mcp_catalog/${created.id}`,
    });

    const fetched = await getResponse.json();

    expect(fetched.labels).toHaveLength(1);
    expect(fetched.labels[0].key).toBe("env");
    expect(fetched.labels[0].value).toBe("production");

    await deleteMcpCatalogItem(request, created.id);
  });

  test("update catalog item labels", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
  }) => {
    const createResponse = await createMcpCatalogItem(request, {
      name: `label-update-test-${Date.now()}`,
      description: "Test label update",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      labels: [{ key: "category", value: "database" }],
    });

    const created = await createResponse.json();

    // Update with new labels
    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/internal_mcp_catalog/${created.id}`,
      data: {
        name: created.name,
        serverType: "remote",
        labels: [
          { key: "category", value: "ai" },
          { key: "tier", value: "free" },
        ],
      },
    });

    const updated = await updateResponse.json();

    expect(updated.labels).toHaveLength(2);
    expect(updated.labels[0].key).toBe("category");
    expect(updated.labels[0].value).toBe("ai");
    expect(updated.labels[1].key).toBe("tier");
    expect(updated.labels[1].value).toBe("free");

    await deleteMcpCatalogItem(request, created.id);
  });

  test("remove all labels", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
  }) => {
    const createResponse = await createMcpCatalogItem(request, {
      name: `label-remove-test-${Date.now()}`,
      description: "Test label removal",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      labels: [
        { key: "category", value: "database" },
        { key: "tier", value: "premium" },
      ],
    });

    const created = await createResponse.json();

    // Update with empty labels
    const updateResponse = await makeApiRequest({
      request,
      method: "put",
      urlSuffix: `/api/internal_mcp_catalog/${created.id}`,
      data: {
        name: created.name,
        serverType: "remote",
        labels: [],
      },
    });

    const updated = await updateResponse.json();
    expect(updated.labels).toHaveLength(0);

    await deleteMcpCatalogItem(request, created.id);
  });

  test("labels returned in list endpoint", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
  }) => {
    const createResponse = await createMcpCatalogItem(request, {
      name: `label-list-test-${Date.now()}`,
      description: "Test labels in list",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      labels: [{ key: "env", value: "staging" }],
    });

    const created = await createResponse.json();

    const listResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/internal_mcp_catalog",
    });

    const items = await listResponse.json();
    const foundItem = items.find(
      (item: { id: string }) => item.id === created.id,
    );

    expect(foundItem).toBeDefined();
    expect(foundItem.labels).toHaveLength(1);
    expect(foundItem.labels[0].key).toBe("env");
    expect(foundItem.labels[0].value).toBe("staging");

    await deleteMcpCatalogItem(request, created.id);
  });

  test("label keys endpoint", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
  }) => {
    const createResponse = await createMcpCatalogItem(request, {
      name: `label-keys-test-${Date.now()}`,
      description: "Test label keys endpoint",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      labels: [
        { key: "category", value: "database" },
        { key: "tier", value: "premium" },
      ],
    });

    const created = await createResponse.json();

    const keysResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/internal_mcp_catalog/labels/keys",
    });

    const keys = await keysResponse.json();

    expect(keys).toContain("category");
    expect(keys).toContain("tier");

    await deleteMcpCatalogItem(request, created.id);
  });

  test("label values endpoint with key filter", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
  }) => {
    const ts = Date.now();
    const createResponse1 = await createMcpCatalogItem(request, {
      name: `label-values-test-1-${ts}`,
      description: "Test label values endpoint",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      labels: [{ key: "category", value: "database" }],
    });

    const createResponse2 = await createMcpCatalogItem(request, {
      name: `label-values-test-2-${ts}`,
      description: "Test label values endpoint",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      labels: [{ key: "category", value: "ai" }],
    });

    const created1 = await createResponse1.json();
    const created2 = await createResponse2.json();

    const valuesResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/internal_mcp_catalog/labels/values?key=category",
    });

    const values = await valuesResponse.json();

    expect(values).toContain("database");
    expect(values).toContain("ai");

    await deleteMcpCatalogItem(request, created1.id);
    await deleteMcpCatalogItem(request, created2.id);
  });

  test("delete catalog item cascades labels", async ({
    request,
    makeApiRequest,
    createMcpCatalogItem,
    deleteMcpCatalogItem,
  }) => {
    const createResponse = await createMcpCatalogItem(request, {
      name: `label-cascade-test-${Date.now()}`,
      description: "Test cascade delete",
      serverType: "remote",
      serverUrl: "https://example.com/mcp",
      labels: [{ key: "cascade-test-key", value: "cascade-test-value" }],
    });

    const created = await createResponse.json();
    expect(created.labels).toHaveLength(1);

    // Delete the catalog item
    await deleteMcpCatalogItem(request, created.id);

    // Verify the catalog item is gone
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/internal_mcp_catalog/${created.id}`,
      ignoreStatusCheck: true,
    });

    expect(getResponse.status()).toBe(404);
  });
});
