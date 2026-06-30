import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { type Mock, vi } from "vitest";
import { hasPermission } from "@/auth";
import {
  InternalMcpCatalogModel,
  McpServerModel,
  OrganizationModel,
} from "@/models";
import { autoReinstallServer } from "@/services/mcp-reinstall";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError, type User } from "@/types";
import internalMcpCatalogRoutes from "./internal-mcp-catalog";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

// Keep the real diff helpers; stub the pod-recreating reinstall so the
// approval-triggered cascade is observable without touching Kubernetes.
vi.mock("@/services/mcp-reinstall", async (importActual) => ({
  ...(await importActual<typeof import("@/services/mcp-reinstall")>()),
  autoReinstallServer: vi.fn().mockResolvedValue(undefined),
}));

const mockHasPermission = hasPermission as Mock;
const mockAutoReinstall = autoReinstallServer as Mock;
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000099";

describe("internal MCP catalog image approval", () => {
  let app: FastifyInstance;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeMember, makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    mockHasPermission.mockResolvedValue({ success: true, error: null });
    mockAutoReinstall.mockResolvedValue(undefined);

    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organization.id, { role: "admin" });

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) {
        return reply.status(error.statusCode).send({
          error: { message: error.message, type: error.type },
        });
      }
      const err = error as Error & { statusCode?: number };
      return reply.status(err.statusCode ?? 500).send({
        error: { message: err.message },
      });
    });
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: User; organizationId: string }
      ).user = user;
      (
        request as typeof request & { user: User; organizationId: string }
      ).organizationId = organization.id;
    });
    await app.register(internalMcpCatalogRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  function makePersonalLocalCatalog(dockerImage = "ghcr.io/evil/x:1") {
    return InternalMcpCatalogModel.create(
      {
        name: `approval-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "local",
        scope: "personal",
        localConfig: { dockerImage },
      },
      { organizationId, authorId: user.id },
    );
  }

  test("approve sets the catalog item's image to approved", async () => {
    const catalog = await makePersonalLocalCatalog();
    await InternalMcpCatalogModel.markImageApprovalPending(catalog.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/approve`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().catalogItemApprovalStatus).toBe("approved");
    const stored = await InternalMcpCatalogModel.findById(catalog.id);
    expect(stored?.catalogItemApprovalStatus).toBe("approved");
    expect(stored?.catalogItemApprovalReviewedBy).toBe(user.id);
  });

  test("approval rolls a single-tenant install onto the now-approved image", async ({
    makeMcpServer,
  }) => {
    const catalog = await makePersonalLocalCatalog();
    await InternalMcpCatalogModel.markImageApprovalPending(catalog.id);
    const install = await makeMcpServer({ catalogId: catalog.id });

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/approve`,
    });
    expect(response.statusCode).toBe(200);

    // The reinstall runs in a background setImmediate; wait for it.
    await vi.waitFor(() => {
      expect(mockAutoReinstall).toHaveBeenCalledTimes(1);
    });
    expect(mockAutoReinstall.mock.calls[0]?.[0]?.id).toBe(install.id);
  });

  test("approval flags a multi-tenant catalog for reinstall instead of auto-reinstalling", async ({
    makeMcpServer,
  }) => {
    const catalog = await InternalMcpCatalogModel.create(
      {
        name: `mt-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "local",
        scope: "org",
        multitenant: true,
        localConfig: { dockerImage: "ghcr.io/evil/x:1" },
      },
      { organizationId, authorId: user.id },
    );
    await InternalMcpCatalogModel.markImageApprovalPending(catalog.id);
    await makeMcpServer({ catalogId: catalog.id });

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${catalog.id}/approve`,
    });
    expect(response.statusCode).toBe(200);

    const stored = await InternalMcpCatalogModel.findById(catalog.id);
    expect(stored?.catalogReinstallRequired).toBe(true);
    expect(mockAutoReinstall).not.toHaveBeenCalled();
  });

  test("approve rejects a catalog item not subject to image approval", async () => {
    // A remote server has no image, so it is never gated regardless of scope.
    const remoteCatalog = await InternalMcpCatalogModel.create(
      {
        name: `remote-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "remote",
        scope: "personal",
        serverUrl: "https://example.com/mcp/",
      },
      { organizationId, authorId: user.id },
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${remoteCatalog.id}/approve`,
    });
    expect(response.statusCode).toBe(400);
  });

  test("approve returns 404 for an unknown catalog id", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${UNKNOWN_ID}/approve`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("approve returns 404 for a catalog item in another org", async ({
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreign = await InternalMcpCatalogModel.create(
      {
        name: `foreign-${crypto.randomUUID().slice(0, 8)}`,
        serverType: "local",
        scope: "personal",
        localConfig: { dockerImage: "ghcr.io/evil/x:1" },
      },
      { organizationId: otherOrg.id, authorId: user.id },
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${foreign.id}/approve`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("pending-image-approval lists pending personal items in the org", async () => {
    const pending = await makePersonalLocalCatalog();
    await InternalMcpCatalogModel.markImageApprovalPending(pending.id);
    // A second, approved item should not appear.
    const approved = await makePersonalLocalCatalog();
    await InternalMcpCatalogModel.approveImage({
      id: approved.id,
      reviewedBy: user.id,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/internal_mcp_catalog/pending-image-approval",
    });

    expect(response.statusCode).toBe(200);
    const ids = (response.json() as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(approved.id);
  });

  test("editing the catalog image resets a prior approval", async () => {
    const catalog = await makePersonalLocalCatalog("ghcr.io/acme/foo:1");
    await InternalMcpCatalogModel.approveImage({
      id: catalog.id,
      reviewedBy: user.id,
    });

    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: { dockerImage: "ghcr.io/evil/x:1" },
    });

    const after = await InternalMcpCatalogModel.findById(catalog.id);
    expect(after?.catalogItemApprovalStatus).toBeNull();
  });

  test("editing non-image fields preserves a prior approval", async () => {
    const catalog = await makePersonalLocalCatalog("ghcr.io/acme/foo:1");
    await InternalMcpCatalogModel.approveImage({
      id: catalog.id,
      reviewedBy: user.id,
    });

    await InternalMcpCatalogModel.update(catalog.id, {
      description: "updated description",
    });

    const after = await InternalMcpCatalogModel.findById(catalog.id);
    expect(after?.catalogItemApprovalStatus).toBe("approved");
  });

  test("a catalog edit cannot set the image-approval fields", async () => {
    const catalog = await makePersonalLocalCatalog();

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: {
        description: "updated",
        catalogItemApprovalStatus: "approved",
        catalogItemApprovalReason: "self-approved",
      },
    });

    expect(response.statusCode).toBe(200);
    const stored = await InternalMcpCatalogModel.findById(catalog.id);
    expect(stored?.catalogItemApprovalStatus).toBeNull();
    expect(stored?.description).toBe("updated");
  });
});
