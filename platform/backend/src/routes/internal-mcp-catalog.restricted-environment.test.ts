import { type Mock, vi } from "vitest";
import { InternalMcpCatalogModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  createRestrictedEnvironment,
  grantEnvironmentUse,
} from "@/test/environments";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";
import { createEnvironment } from "@/services/environments/environment";

const mockHasPermission = hasPermission as Mock;

/**
 * POST /api/internal_mcp_catalog must refuse to assign a *restricted*
 * environment unless the caller holds a `use` grant on that environment.
 * `assertCanAssignEnvironment` throws 403 for a restricted env the caller
 * cannot reach.
 *
 * The harness mirrors internal-mcp-catalog.headers.test.ts (real PGlite via
 * `@/test`, identity injected on the onRequest hook, mocked `hasPermission`).
 * Every role probe stays `success: true` so the test isolates the environment
 * gate; the caller is a plain member, so the only way into a restricted
 * environment is a grant the test writes.
 */
describe("Internal MCP Catalog - Restricted Environment Assignment Guard", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    // Every role probe (scope check, etc.) is granted so this suite isolates
    // the environment guard.
    mockHasPermission.mockResolvedValue({ success: true, error: null });

    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(user.id, organizationId, { role: "member" });

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

  /** Let this user deploy into exactly one environment. */
  async function grantDeploy(environmentId: string) {
    await grantEnvironmentUse({
      organizationId,
      environmentId: environmentId,
      userId: user.id,
    });
  }

  function createBody(environmentId: string | null) {
    return {
      name: `restricted-env-${crypto.randomUUID().slice(0, 8)}`,
      serverType: "remote" as const,
      serverUrl: "https://example.com/mcp",
      environmentId,
    };
  }

  test("a member without a grant on a RESTRICTED env is rejected (403) and nothing is created", async () => {
    const restricted = await createRestrictedEnvironment({
      organizationId,
      data: { name: "Prod" },
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

  test("a caller granted use on that environment assigning a RESTRICTED env succeeds", async () => {
    const restricted = await createRestrictedEnvironment({
      organizationId,
      data: { name: "Prod" },
    });
    await grantDeploy(restricted.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload: createBody(restricted.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(restricted.id);
  });

  test("a member with no grant assigning an UNRESTRICTED env succeeds", async () => {
    const open = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
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
    const open = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
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

  test("updating to a RESTRICTED env without a grant on it is rejected (403) and the assignment is unchanged", async () => {
    const restricted = await createRestrictedEnvironment({
      organizationId,
      data: { name: "Prod" },
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

  test("updating to a RESTRICTED env with a grant on it succeeds", async () => {
    const restricted = await createRestrictedEnvironment({
      organizationId,
      data: { name: "Prod" },
    });
    await grantDeploy(restricted.id);
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
