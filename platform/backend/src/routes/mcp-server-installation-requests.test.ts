import { type Mock, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// Mock hasPermission - admin by default
vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

// Mock archestraCatalogSdk to prevent external catalog calls during approve
vi.mock("@shared", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    archestraCatalogSdk: {
      getMcpServer: vi.fn().mockResolvedValue({ data: null }),
    },
  };
});

function grantAdminPermissions() {
  mockHasPermission.mockResolvedValue({ success: true, error: null });
}

describe("MCP server installation request routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    grantAdminPermissions();

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import(
      "./mcp-server-installation-requests"
    );
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  // ====== CRUD Operations ======

  describe("GET /api/mcp_server_installation_requests", () => {
    test("returns all installation requests", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/mcp_server_installation_requests",
      });

      expect(response.statusCode).toBe(200);
      expect(Array.isArray(response.json())).toBe(true);
    });

    test("filters installation requests by status", async () => {
      // Create a pending request
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `test-filter-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();
      expect(created.status).toBe("pending");

      // Filter by pending
      const response = await app.inject({
        method: "GET",
        url: "/api/mcp_server_installation_requests?status=pending",
      });

      expect(response.statusCode).toBe(200);
      const requests = response.json();
      expect(Array.isArray(requests)).toBe(true);
      const found = requests.find((r: { id: string }) => r.id === created.id);
      expect(found).toBeDefined();
      expect(found.status).toBe("pending");
    });
  });

  describe("POST /api/mcp_server_installation_requests", () => {
    test("creates an installation request for external catalog", async () => {
      const externalCatalogId = `test-external-${Date.now()}`;

      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId,
          customServerConfig: null,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("id");
      expect(body.externalCatalogId).toBe(externalCatalogId);
      expect(body.status).toBe("pending");
      expect(body.requestedBy).toBe(user.id);
      expect(body).toHaveProperty("createdAt");
    });

    test("creates an installation request with custom local server config", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: null,
          customServerConfig: {
            type: "local",
            label: "Test Local Server",
            name: `test-server-${Date.now()}`,
            serverType: "local",
            localConfig: {
              command: "node",
              args: ["server.js"],
            },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty("id");
      expect(body.customServerConfig).toBeDefined();
      expect(body.customServerConfig.label).toBe("Test Local Server");
      expect(body.status).toBe("pending");
    });

    test("rejects duplicate pending request for same external catalog", async () => {
      const catalogId = `duplicate-test-${Date.now()}`;

      // Create first request
      await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: catalogId,
          customServerConfig: null,
        },
      });

      // Try to create duplicate
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: catalogId,
          customServerConfig: null,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain(
        "pending installation request already exists",
      );
    });
  });

  describe("GET /api/mcp_server_installation_requests/:id", () => {
    test("returns a specific installation request by ID", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `get-test-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();

      const response = await app.inject({
        method: "GET",
        url: `/api/mcp_server_installation_requests/${created.id}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(created.id);
      expect(body.externalCatalogId).toBe(created.externalCatalogId);
    });

    test("returns 404 for non-existent request", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/mcp_server_installation_requests/c7528140-07b0-4870-841d-6886a6daeb32",
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("PATCH /api/mcp_server_installation_requests/:id", () => {
    test("updates installation request with custom server config", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `update-test-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/mcp_server_installation_requests/${created.id}`,
        payload: {
          customServerConfig: {
            type: "remote",
            label: "Updated Remote Server",
            name: `updated-server-${Date.now()}`,
            serverType: "remote",
            serverUrl: "https://example.com/mcp",
          },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(created.id);
      expect(body.customServerConfig).toBeDefined();
      expect(body.customServerConfig.label).toBe("Updated Remote Server");
    });
  });

  describe("DELETE /api/mcp_server_installation_requests/:id", () => {
    test("deletes an installation request", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `delete-test-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();

      await app.inject({
        method: "DELETE",
        url: `/api/mcp_server_installation_requests/${created.id}`,
      });

      // Verify it is gone (PGlite may not return accurate rowCount,
      // so we verify deletion by checking the record no longer exists)
      const getResponse = await app.inject({
        method: "GET",
        url: `/api/mcp_server_installation_requests/${created.id}`,
      });
      expect(getResponse.statusCode).toBe(404);
    });
  });

  // ====== Approve / Decline ======

  describe("POST /api/mcp_server_installation_requests/:id/approve", () => {
    test("approves an installation request with admin response", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `approve-test-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();
      expect(created.status).toBe("pending");

      const approveResponse = await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/approve`,
        payload: {
          adminResponse: "Approved for testing purposes",
        },
      });

      expect(approveResponse.statusCode).toBe(200);
      const body = approveResponse.json();
      expect(body.id).toBe(created.id);
      expect(body.status).toBe("approved");
      expect(body.adminResponse).toBe("Approved for testing purposes");
      expect(body.reviewedBy).toBeDefined();
      expect(body.reviewedAt).toBeDefined();
    });

    test("approves an installation request without admin response", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `approve-no-msg-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();

      const approveResponse = await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/approve`,
        payload: {},
      });

      expect(approveResponse.statusCode).toBe(200);
      const body = approveResponse.json();
      expect(body.status).toBe("approved");
      expect(body.reviewedBy).toBeDefined();
    });

    test("returns 404 when approving non-existent request", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests/c7528140-07b0-4870-841d-6886a6daeb33/approve",
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("POST /api/mcp_server_installation_requests/:id/decline", () => {
    test("declines an installation request", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `decline-test-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();
      expect(created.status).toBe("pending");

      const declineResponse = await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/decline`,
        payload: {
          adminResponse: "Does not meet security requirements",
        },
      });

      expect(declineResponse.statusCode).toBe(200);
      const body = declineResponse.json();
      expect(body.id).toBe(created.id);
      expect(body.status).toBe("declined");
      expect(body.adminResponse).toBe("Does not meet security requirements");
      expect(body.reviewedBy).toBeDefined();
      expect(body.reviewedAt).toBeDefined();
    });

    test("returns 404 when declining non-existent request", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests/c7528140-07b0-4870-841d-6886a6daeb34/decline",
        payload: {},
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ====== Notes ======

  describe("POST /api/mcp_server_installation_requests/:id/notes", () => {
    test("adds a note to an installation request", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `notes-test-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();

      const noteResponse = await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/notes`,
        payload: { content: "This is a test note" },
      });

      expect(noteResponse.statusCode).toBe(200);
      const body = noteResponse.json();
      expect(body.id).toBe(created.id);
      expect(body.notes).toBeDefined();
      expect(Array.isArray(body.notes)).toBe(true);
      expect(body.notes.length).toBeGreaterThan(0);

      const lastNote = body.notes[body.notes.length - 1];
      expect(lastNote.content).toBe("This is a test note");
      expect(lastNote).toHaveProperty("userId");
      expect(lastNote).toHaveProperty("userName");
      expect(lastNote).toHaveProperty("createdAt");
    });

    test("adds multiple notes to an installation request", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `multi-notes-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();

      // Add first note
      await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/notes`,
        payload: { content: "First note" },
      });

      // Add second note
      const secondResponse = await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/notes`,
        payload: { content: "Second note" },
      });

      const body = secondResponse.json();
      expect(body.notes.length).toBeGreaterThanOrEqual(2);

      const noteContents = body.notes.map(
        (n: { content: string }) => n.content,
      );
      expect(noteContents).toContain("First note");
      expect(noteContents).toContain("Second note");
    });

    test("returns 404 when adding note to non-existent request", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests/c7528140-07b0-4870-841d-6886a6daeb35/notes",
        payload: { content: "Test note" },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ====== Complete Workflows ======

  describe("complete workflows", () => {
    test("create -> add notes -> approve -> verify", async () => {
      const catalogId = `workflow-test-${Date.now()}`;

      // 1. Create request
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: catalogId,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();
      expect(created.status).toBe("pending");

      // 2. Add note
      const noteResponse = await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/notes`,
        payload: { content: "Reviewing this request" },
      });
      expect(noteResponse.json().notes.length).toBeGreaterThan(0);

      // 3. Approve request
      const approveResponse = await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/approve`,
        payload: { adminResponse: "Looks good!" },
      });
      const approved = approveResponse.json();
      expect(approved.status).toBe("approved");
      expect(approved.adminResponse).toBe("Looks good!");

      // 4. Verify through GET
      const getResponse = await app.inject({
        method: "GET",
        url: `/api/mcp_server_installation_requests/${created.id}`,
      });
      const final = getResponse.json();
      expect(final.status).toBe("approved");
      expect(final.notes.length).toBeGreaterThan(0);
      expect(final.reviewedBy).toBeDefined();
    });

    test("create -> decline -> verify in declined filter", async () => {
      // Create request
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: `decline-workflow-${Date.now()}`,
          customServerConfig: null,
        },
      });
      const created = createResponse.json();

      // Decline immediately
      const declineResponse = await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/decline`,
        payload: { adminResponse: "Not approved" },
      });
      expect(declineResponse.json().status).toBe("declined");

      // Verify it shows in declined filter
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/mcp_server_installation_requests?status=declined",
      });
      const declinedRequests = listResponse.json();
      const found = declinedRequests.find(
        (r: { id: string }) => r.id === created.id,
      );
      expect(found).toBeDefined();
    });

    test("create with remote server config and approve", async () => {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/mcp_server_installation_requests",
        payload: {
          externalCatalogId: null,
          customServerConfig: {
            type: "remote",
            label: "Custom API Server",
            name: `custom-api-${Date.now()}`,
            serverType: "remote",
            serverUrl: "https://api.example.com/mcp",
            docsUrl: "https://docs.example.com",
          },
        },
      });
      const created = createResponse.json();
      expect(created.customServerConfig.serverType).toBe("remote");

      // Approve it
      const approveResponse = await app.inject({
        method: "POST",
        url: `/api/mcp_server_installation_requests/${created.id}/approve`,
        payload: { adminResponse: "Remote server approved" },
      });
      const approved = approveResponse.json();
      expect(approved.status).toBe("approved");
      expect(approved.customServerConfig.serverType).toBe("remote");
    });
  });
});
