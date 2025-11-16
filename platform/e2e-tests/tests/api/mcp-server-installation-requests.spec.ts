import { expect, test } from "./fixtures";

test.describe("MCP Server Installation Requests API - CRUD Operations", () => {
  test("should get all installation requests", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/mcp_server_installation_requests",
    });

    const requests = await response.json();
    expect(Array.isArray(requests)).toBe(true);
  });

  test("should filter installation requests by status", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a pending request
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `test-catalog-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();
    expect(createdRequest.status).toBe("pending");

    // Filter by pending status
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/mcp_server_installation_requests?status=pending",
    });

    const requests = await response.json();
    expect(Array.isArray(requests)).toBe(true);
    const foundRequest = requests.find(
      (r: { id: string }) => r.id === createdRequest.id,
    );
    expect(foundRequest).toBeDefined();
    expect(foundRequest.status).toBe("pending");
  });

  test("should create an installation request for external catalog", async ({
    request,
    makeApiRequest,
  }) => {
    const requestData = {
      externalCatalogId: `test-external-catalog-${Date.now()}`,
      customServerConfig: null,
    };

    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: requestData,
    });

    const installationRequest = await response.json();
    expect(installationRequest).toHaveProperty("id");
    expect(installationRequest.externalCatalogId).toBe(
      requestData.externalCatalogId,
    );
    expect(installationRequest.status).toBe("pending");
    expect(installationRequest).toHaveProperty("requestedBy");
    expect(installationRequest).toHaveProperty("createdAt");
  });

  test("should create an installation request with custom server config", async ({
    request,
    makeApiRequest,
  }) => {
    const requestData = {
      externalCatalogId: null,
      customServerConfig: {
        type: "local" as const,
        label: "Test Local Server",
        name: `test-server-${Date.now()}`,
        serverType: "local" as const,
        localConfig: {
          command: "node",
          args: ["server.js"],
        },
      },
    };

    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: requestData,
    });

    const installationRequest = await response.json();
    expect(installationRequest).toHaveProperty("id");
    expect(installationRequest.customServerConfig).toBeDefined();
    expect(installationRequest.customServerConfig.label).toBe(
      "Test Local Server",
    );
    expect(installationRequest.status).toBe("pending");
  });

  test("should fail to create duplicate pending request for same external catalog", async ({
    request,
    makeApiRequest,
  }) => {
    const catalogId = `duplicate-test-${Date.now()}`;

    // Create first request
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: catalogId,
        customServerConfig: null,
      },
    });

    // Try to create duplicate
    const duplicateResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: catalogId,
        customServerConfig: null,
      },
      ignoreStatusCheck: true,
    });

    expect(duplicateResponse.status()).toBe(400);
    const error = await duplicateResponse.json();
    expect(error.error.message).toContain(
      "pending installation request already exists",
    );
  });

  test("should get a specific installation request by ID", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a request first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `get-test-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();

    // Get the request by ID
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}`,
    });

    const installationRequest = await response.json();
    expect(installationRequest.id).toBe(createdRequest.id);
    expect(installationRequest.externalCatalogId).toBe(
      createdRequest.externalCatalogId,
    );
  });

  test("should return 404 for non-existent request", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "get",
      urlSuffix:
        "/api/mcp_server_installation_requests/c7528140-07b0-4870-841d-6886a6daeb32",
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });

  test("should update installation request (non-admin fields)", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a request first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `update-test-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();

    // Update the request
    const updateResponse = await makeApiRequest({
      request,
      method: "patch",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}`,
      data: {
        customServerConfig: {
          type: "remote" as const,
          label: "Updated Remote Server",
          name: `updated-server-${Date.now()}`,
          serverType: "remote",
          serverUrl: "https://example.com/mcp",
        },
      },
    });

    const updatedRequest = await updateResponse.json();
    expect(updatedRequest.id).toBe(createdRequest.id);
    expect(updatedRequest.customServerConfig).toBeDefined();
    expect(updatedRequest.customServerConfig.label).toBe(
      "Updated Remote Server",
    );
  });

  test("should delete installation request", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a request first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `delete-test-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();

    // Delete the request
    const deleteResponse = await makeApiRequest({
      request,
      method: "delete",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}`,
    });

    const result = await deleteResponse.json();
    expect(result.success).toBe(true);

    // Verify request is deleted
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}`,
      ignoreStatusCheck: true,
    });
    expect(getResponse.status()).toBe(404);
  });
});

test.describe("MCP Server Installation Requests API - Approve/Decline", () => {
  test("should approve installation request", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a request first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `approve-test-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();
    expect(createdRequest.status).toBe("pending");

    // Approve the request
    const approveResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}/approve`,
      data: {
        adminResponse: "Approved for testing purposes",
      },
    });

    const approvedRequest = await approveResponse.json();
    expect(approvedRequest.id).toBe(createdRequest.id);
    expect(approvedRequest.status).toBe("approved");
    expect(approvedRequest.adminResponse).toBe("Approved for testing purposes");
    expect(approvedRequest.reviewedBy).toBeDefined();
    expect(approvedRequest.reviewedAt).toBeDefined();
  });

  test("should approve installation request without admin response", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a request first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `approve-no-msg-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();

    // Approve without message
    const approveResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}/approve`,
      data: {},
    });

    const approvedRequest = await approveResponse.json();
    expect(approvedRequest.status).toBe("approved");
    expect(approvedRequest.reviewedBy).toBeDefined();
  });

  test("should decline installation request", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a request first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `decline-test-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();
    expect(createdRequest.status).toBe("pending");

    // Decline the request
    const declineResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}/decline`,
      data: {
        adminResponse: "Does not meet security requirements",
      },
    });

    const declinedRequest = await declineResponse.json();
    expect(declinedRequest.id).toBe(createdRequest.id);
    expect(declinedRequest.status).toBe("declined");
    expect(declinedRequest.adminResponse).toBe(
      "Does not meet security requirements",
    );
    expect(declinedRequest.reviewedBy).toBeDefined();
    expect(declinedRequest.reviewedAt).toBeDefined();
  });

  test("should return 404 when approving non-existent request", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix:
        "/api/mcp_server_installation_requests/c7528140-07b0-4870-841d-6886a6daeb33/approve",
      data: {},
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });

  test("should return 404 when declining non-existent request", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix:
        "/api/mcp_server_installation_requests/c7528140-07b0-4870-841d-6886a6daeb34/decline",
      data: {},
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });
});

test.describe("MCP Server Installation Requests API - Notes", () => {
  test("should add note to installation request", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a request first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `notes-test-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();

    // Add a note
    const noteContent = "This is a test note";
    const noteResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}/notes`,
      data: {
        content: noteContent,
      },
    });

    const requestWithNote = await noteResponse.json();
    expect(requestWithNote.id).toBe(createdRequest.id);
    expect(requestWithNote.notes).toBeDefined();
    expect(Array.isArray(requestWithNote.notes)).toBe(true);
    expect(requestWithNote.notes.length).toBeGreaterThan(0);

    const lastNote = requestWithNote.notes[requestWithNote.notes.length - 1];
    expect(lastNote.content).toBe(noteContent);
    expect(lastNote).toHaveProperty("userId");
    expect(lastNote).toHaveProperty("userName");
    expect(lastNote).toHaveProperty("createdAt");
  });

  test("should add multiple notes to installation request", async ({
    request,
    makeApiRequest,
  }) => {
    // Create a request first
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `multi-notes-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();

    // Add first note
    await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}/notes`,
      data: { content: "First note" },
    });

    // Add second note
    const secondNoteResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}/notes`,
      data: { content: "Second note" },
    });

    const requestWithNotes = await secondNoteResponse.json();
    expect(requestWithNotes.notes.length).toBeGreaterThanOrEqual(2);

    const noteContents = requestWithNotes.notes.map(
      (n: { content: string }) => n.content,
    );
    expect(noteContents).toContain("First note");
    expect(noteContents).toContain("Second note");
  });

  test("should fail to add note to non-existent request", async ({
    request,
    makeApiRequest,
  }) => {
    const response = await makeApiRequest({
      request,
      method: "post",
      urlSuffix:
        "/api/mcp_server_installation_requests/c7528140-07b0-4870-841d-6886a6daeb35/notes",
      data: { content: "Test note" },
      ignoreStatusCheck: true,
    });

    expect(response.status()).toBe(404);
  });
});

test.describe("MCP Server Installation Requests API - Complete Workflow", () => {
  test("should handle complete workflow: create -> add notes -> approve -> verify", async ({
    request,
    makeApiRequest,
  }) => {
    const catalogId = `workflow-test-${Date.now()}`;

    // 1. Create request
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: catalogId,
        customServerConfig: null,
      },
    });
    const request1 = await createResponse.json();
    expect(request1.status).toBe("pending");

    // 2. Add note
    const noteResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${request1.id}/notes`,
      data: { content: "Reviewing this request" },
    });
    const request2 = await noteResponse.json();
    expect(request2.notes.length).toBeGreaterThan(0);

    // 3. Approve request
    const approveResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${request1.id}/approve`,
      data: { adminResponse: "Looks good!" },
    });
    const request3 = await approveResponse.json();
    expect(request3.status).toBe("approved");
    expect(request3.adminResponse).toBe("Looks good!");

    // 4. Verify through GET
    const getResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: `/api/mcp_server_installation_requests/${request1.id}`,
    });
    const finalRequest = await getResponse.json();
    expect(finalRequest.status).toBe("approved");
    expect(finalRequest.notes.length).toBeGreaterThan(0);
    expect(finalRequest.reviewedBy).toBeDefined();
  });

  test("should handle create -> decline workflow", async ({
    request,
    makeApiRequest,
  }) => {
    // Create request
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: `decline-workflow-${Date.now()}`,
        customServerConfig: null,
      },
    });
    const createdRequest = await createResponse.json();

    // Decline immediately
    const declineResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}/decline`,
      data: { adminResponse: "Not approved" },
    });
    const declinedRequest = await declineResponse.json();
    expect(declinedRequest.status).toBe("declined");

    // Verify it shows in declined filter
    const listResponse = await makeApiRequest({
      request,
      method: "get",
      urlSuffix: "/api/mcp_server_installation_requests?status=declined",
    });
    const declinedRequests = await listResponse.json();
    const found = declinedRequests.find(
      (r: { id: string }) => r.id === createdRequest.id,
    );
    expect(found).toBeDefined();
  });

  test("should create request with remote server config and approve", async ({
    request,
    makeApiRequest,
  }) => {
    // Create request with remote config
    const createResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: "/api/mcp_server_installation_requests",
      data: {
        externalCatalogId: null,
        customServerConfig: {
          type: "remote" as const,
          label: "Custom API Server",
          name: `custom-api-${Date.now()}`,
          serverType: "remote",
          serverUrl: "https://api.example.com/mcp",
          docsUrl: "https://docs.example.com",
        },
      },
    });
    const createdRequest = await createResponse.json();
    expect(createdRequest.customServerConfig.serverType).toBe("remote");

    // Approve it
    const approveResponse = await makeApiRequest({
      request,
      method: "post",
      urlSuffix: `/api/mcp_server_installation_requests/${createdRequest.id}/approve`,
      data: { adminResponse: "Remote server approved" },
    });
    const approvedRequest = await approveResponse.json();
    expect(approvedRequest.status).toBe("approved");
    expect(approvedRequest.customServerConfig.serverType).toBe("remote");
  });
});
