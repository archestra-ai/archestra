import type { Permissions } from "@archestra/shared";
import { type Mock, vi } from "vitest";
import { InternalMcpCatalogModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";
import { createEnvironment } from "@/services/environments/environment";

const mockHasPermission = hasPermission as Mock;

/**
 * POST /api/internal_mcp_catalog must refuse to assign a *restricted*
 * environment unless the caller can deploy to restricted environments — i.e.
 * holds `environment:deploy-to-restricted` (or `environment:admin`, which
 * implies it). The route ORs both probes into `canDeployToRestricted` and feeds
 * it into `assertCanAssignEnvironment`, which throws 403 for a restricted env
 * the caller can't touch.
 *
 * The harness mirrors internal-mcp-catalog.headers.test.ts (real PGlite via
 * `@/test`, identity injected on the onRequest hook, mocked `hasPermission`),
 * but the mock here is *resource-aware*: it answers any `environment` probe
 * (admin or deploy-to-restricted) from a per-test flag so we can model a caller
 * who can deploy to restricted envs vs. one who can't. Every other permission
 * probe (e.g. the `mcpServerInstallation:["admin"]` scope check) stays
 * `success: true` so the test isolates the environment gate.
 */
describe("Internal MCP Catalog - Restricted Environment Assignment Guard", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  // Toggles the answer to the environment permission probes (admin / deploy).
  let canDeployToRestricted: boolean;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    vi.clearAllMocks();
    canDeployToRestricted = false;
    mockHasPermission.mockImplementation(async (permissions: Permissions) => {
      // The environment gate is the only probe whose answer varies per test.
      // Both the `admin` and `deploy-to-restricted` probes resolve to the flag.
      if (permissions.environment?.length) {
        return { success: canDeployToRestricted, error: null };
      }
      // Everything else (scope check, etc.) is granted so this suite isolates
      // the environment guard.
      return { success: true, error: null };
    });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function createBody(environmentId: string | null) {
    return {
      name: `restricted-env-${crypto.randomUUID().slice(0, 8)}`,
      serverType: "remote" as const,
      serverUrl: "https://example.com/mcp",
      environmentId,
    };
  }

  test("a non-env-admin member assigning a RESTRICTED env is rejected (403) and nothing is created", async () => {
    canDeployToRestricted = false;
    const restricted = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: true },
    });

    const before = await InternalMcpCatalogModel.findAll({
      expandSecrets: false,
      userId: user.id,
      isAdmin: true,
      organizationId,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(restricted.id),
    });

    expect(response.statusCode).toBe(403);

    const after = await InternalMcpCatalogModel.findAll({
      expandSecrets: false,
      userId: user.id,
      isAdmin: true,
      organizationId,
    });
    expect(after.length).toBe(before.length);
  });

  test("an env-admin (built-in Admin holds environment:admin) assigning a RESTRICTED env succeeds", async () => {
    canDeployToRestricted = true;
    const restricted = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: true },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(restricted.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(restricted.id);
  });

  test("a non-env-admin member assigning an UNRESTRICTED env succeeds", async () => {
    canDeployToRestricted = false;
    const open = await createEnvironment({
      organizationId,
      data: { name: "Staging", restricted: false },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(open.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(open.id);
  });

  // PUT /api/internal_mcp_catalog/:id — environment is editable after creation
  // and the same assignment guard applies. Name is reused across create + update
  // so the model's name-immutability check passes.
  function bodyWith(name: string, environmentId: string | null) {
    return {
      name,
      serverType: "remote" as const,
      serverUrl: "https://example.com/mcp",
      environmentId,
    };
  }

  async function createWith(name: string, environmentId: string | null) {
    const res = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: bodyWith(name, environmentId),
    });
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  }

  test("updating environmentId on an existing catalog item persists, and clearing to default works", async () => {
    canDeployToRestricted = false;
    const open = await createEnvironment({
      organizationId,
      data: { name: "Staging", restricted: false },
    });
    const name = `edit-env-${crypto.randomUUID().slice(0, 8)}`;
    const id = await createWith(name, null);

    const assigned = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${id}`,
      payload: bodyWith(name, open.id),
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().environmentId).toBe(open.id);

    const cleared = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${id}`,
      payload: bodyWith(name, null),
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().environmentId).toBeNull();
  });

  test("a non-env-admin updating to a RESTRICTED env is rejected (403) and the assignment is unchanged", async () => {
    canDeployToRestricted = false;
    const restricted = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: true },
    });
    const name = `edit-env-${crypto.randomUUID().slice(0, 8)}`;
    const id = await createWith(name, null);

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${id}`,
      payload: bodyWith(name, restricted.id),
    });
    expect(response.statusCode).toBe(403);

    const item = await InternalMcpCatalogModel.findById(id, {
      expandSecrets: false,
    });
    expect(item?.environmentId ?? null).toBeNull();
  });

  test("an env-admin updating to a RESTRICTED env succeeds", async () => {
    canDeployToRestricted = true;
    const restricted = await createEnvironment({
      organizationId,
      data: { name: "Prod", restricted: true },
    });
    const name = `edit-env-${crypto.randomUUID().slice(0, 8)}`;
    const id = await createWith(name, null);

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${id}`,
      payload: bodyWith(name, restricted.id),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(restricted.id);
  });
});
