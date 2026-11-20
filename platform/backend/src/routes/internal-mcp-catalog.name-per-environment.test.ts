import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import { vi } from "vitest";
import { executeArchestraTool } from "@/archestra-mcp-server";
import config from "@/config";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { InternalMcpCatalogModel } from "@/models";
import { createEnvironment } from "@/services/environments/environment";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

/**
 * A server name is unique per environment. Two live root servers conflict when
 * they share an environment, their tools would carry the same prefix, and
 * either both are shared or both are personal servers of one author.
 */
describe("MCP server names are unique per environment", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let actor: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    vi.clearAllMocks();
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });
    config.enterpriseFeatures.core = true;
    enterpriseTier.setUserCountForTesting(0);
    user = await makeUser();
    actor = user;
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = actor;
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

  // The create form starts with no extra grants, so a new server is personal
  // to its author until someone shares it.
  const personal = { initialGrants: [] as unknown[] };
  const shared = {
    initialGrants: [
      {
        subject: { type: "organization" as const, id: "*" as const },
        actions: ["read", "use"],
      },
    ],
  };
  const remote = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    serverType: "remote" as const,
    serverUrl: "https://example.com/mcp",
    ...personal,
    ...extra,
  });

  async function create(payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload,
    });
  }

  async function countNamed(name: string) {
    const rows = await db
      .select({ id: schema.internalMcpCatalogTable.id })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.name, name));
    return rows.length;
  }

  test("refuses a slug-equivalent name in the same environment and writes no row", async () => {
    const first = await create(remote("My Server", shared));
    expect(first.statusCode).toBe(200);

    const response = await create(remote("my_server", shared));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
    expect(response.json().error.message).toBe(
      'An MCP server named "my_server" already exists in Default environment. Rename it first.',
    );
    expect(await countNamed("my_server")).toBe(0);
  });

  test("refuses a name that differs only by case", async () => {
    expect((await create(remote("Weather", shared))).statusCode).toBe(200);

    const response = await create(remote("WEATHER", shared));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
    expect(await countNamed("WEATHER")).toBe(0);
  });

  test("accepts the same name in another environment, including Default", async () => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    expect((await create(remote("Weather", shared))).statusCode).toBe(200);

    const response = await create(
      remote("Weather", { ...shared, environmentId: staging.id }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(staging.id);
    expect(await countNamed("Weather")).toBe(2);
  });

  test("refuses a clone that keeps the source name in the same environment", async () => {
    const source = await create(remote("Weather", shared));
    expect(source.statusCode).toBe(200);

    const response = await create(
      remote("Weather", { ...shared, clonedFrom: source.json().id }),
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
    expect(await countNamed("Weather")).toBe(1);
  });

  test("accepts a clone that keeps the source name in another environment", async () => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    const source = await create(remote("Weather", shared));
    expect(source.statusCode).toBe(200);

    const response = await create(
      remote("Weather", {
        ...shared,
        clonedFrom: source.json().id,
        environmentId: staging.id,
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().clonedFrom).toBe(source.json().id);
    expect(response.json().environmentId).toBe(staging.id);
  });

  test("accepts a personal server with the name of a shared server", async () => {
    expect((await create(remote("Weather", shared))).statusCode).toBe(200);

    // No grants beyond the author's own: that is a personal server.
    const response = await create(remote("Weather"));

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().scope).toBe("personal");
  });

  test("refuses a second personal server of the same author", async () => {
    expect((await create(remote("Weather"))).statusCode).toBe(200);

    const response = await create(remote("Weather"));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
  });

  test("accepts personal servers of the same name from two authors", async ({
    makeUser,
    makeMember,
  }) => {
    const other = await makeUser();
    await makeMember(other.id, organizationId, { role: "admin" });
    // The request user is signed in, so this server is personal to them.
    expect((await create(remote("Weather"))).statusCode).toBe(200);

    // A server created as the other member is personal to that member.
    actor = other;
    const response = await create(remote("Weather"));

    expect(response.statusCode).toBe(200);
  });

  test("refuses the built-in tools' prefix in every environment", async () => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });

    const response = await create(
      remote("Archestra", { ...shared, environmentId: staging.id }),
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
    expect(response.json().error.message).toContain("built-in");
    expect(await countNamed("Archestra")).toBe(0);
  });

  test("rename follows the environment rule", async () => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    const weather = await create(remote("Weather", shared));
    const other = await create(
      remote("Other", { ...shared, environmentId: staging.id }),
    );
    expect(weather.statusCode).toBe(200);
    expect(other.statusCode).toBe(200);

    const across = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${other.json().id}`,
      payload: { name: "Weather" },
    });
    expect(across.statusCode).toBe(200);

    const same = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${other.json().id}`,
      payload: { name: "Reports", environmentId: null },
    });
    expect(same.statusCode).toBe(200);
    const blocked = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${same.json().id}`,
      payload: { name: "Weather" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.internal_code).toBe("catalog_name_conflict");
    expect(blocked.json().error.message).toContain("in Default environment");
  });

  test("the refusal names the environment, with the organization's name for Default", async () => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    const inStaging = remote("Weather", {
      ...shared,
      environmentId: staging.id,
    });
    expect((await create(inStaging)).statusCode).toBe(200);
    expect((await create(inStaging)).json().error.message).toBe(
      'An MCP server named "Weather" already exists in Staging environment. Rename it first.',
    );

    await db
      .update(schema.organizationsTable)
      .set({ defaultEnvironmentName: "Sandbox" })
      .where(eq(schema.organizationsTable.id, organizationId));
    expect((await create(remote("Weather", shared))).statusCode).toBe(200);
    expect((await create(remote("Weather", shared))).json().error.message).toBe(
      'An MCP server named "Weather" already exists in Sandbox environment. Rename it first.',
    );
  });

  test("refuses a rename with a move when the current environment has the name", async () => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    expect((await create(remote("Weather", shared))).statusCode).toBe(200);
    const reports = await create(remote("Reports", shared));
    expect(reports.statusCode).toBe(200);

    // Staging has no Weather. The rename is committed before the move, so a
    // move refused later would leave two Weather servers in Default.
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${reports.json().id}`,
      payload: { name: "Weather", environmentId: staging.id },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
    const [row] = await db
      .select({
        name: schema.internalMcpCatalogTable.name,
        environmentId: schema.internalMcpCatalogTable.environmentId,
      })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, reports.json().id));
    expect(row).toEqual({ name: "Reports", environmentId: null });
  });

  test("keeps the name when the destination environment refuses a rename with a move", async () => {
    // Staging does not let a server reach example.com.
    const staging = await createEnvironment({
      organizationId,
      data: {
        name: "Staging",
        networkPolicy: {
          egressMode: "restricted",
          domainPreset: "none",
          allowedDomains: ["registry.npmjs.org"],
          allowedCidrs: [],
        },
      },
    });
    const reports = await create(remote("Reports", shared));
    expect(reports.statusCode).toBe(200);

    // The new name is free in both environments. The move is refused, so the
    // rename must not be saved either.
    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${reports.json().id}`,
      payload: { name: "Weather", environmentId: staging.id },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.internal_code).toBe(
      "remote_server_url_not_allowed",
    );
    const [row] = await db
      .select({
        name: schema.internalMcpCatalogTable.name,
        environmentId: schema.internalMcpCatalogTable.environmentId,
      })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, reports.json().id));
    expect(row).toEqual({ name: "Reports", environmentId: null });
  });

  test("refuses a move into an environment that already has the name", async () => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    const home = await create(remote("Weather", shared));
    const away = await create(
      remote("Weather", { ...shared, environmentId: staging.id }),
    );
    expect(home.statusCode).toBe(200);
    expect(away.statusCode).toBe(200);

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${away.json().id}`,
      payload: { environmentId: null },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
    const [row] = await db
      .select({ environmentId: schema.internalMcpCatalogTable.environmentId })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, away.json().id));
    expect(row.environmentId).toBe(staging.id);
  });

  test("refuses a move that also sends the unchanged name, as the edit form does", async () => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    const home = await create(remote("Weather", shared));
    const away = await create(
      remote("Weather", { ...shared, environmentId: staging.id }),
    );
    expect(home.statusCode).toBe(200);
    expect(away.statusCode).toBe(200);

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${away.json().id}`,
      payload: { name: "Weather", environmentId: null },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
    const [row] = await db
      .select({
        name: schema.internalMcpCatalogTable.name,
        environmentId: schema.internalMcpCatalogTable.environmentId,
      })
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, away.json().id));
    expect(row).toEqual({ name: "Weather", environmentId: staging.id });
  });

  test("refuses a name whose slug an app in the same environment already carries", async ({
    makeInternalMcpCatalog,
  }) => {
    const planner = await makeInternalMcpCatalog({
      organizationId,
      name: "Planning App",
      serverType: "app",
      authorId: user.id,
    });
    // The app's tools carry `planner`, not its display-name slug.
    await InternalMcpCatalogModel.applyToolPrefix({
      catalogIds: [planner.id],
      toolPrefix: "planner",
    });

    const response = await create(remote("Planner", shared));

    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("catalog_name_conflict");
    // The app keeps its own name. The refused create wrote no Planner row.
    expect(await countNamed("Planner")).toBe(0);
    expect(await countNamed("Planning App")).toBe(1);
  });

  test("refuses a rename onto an app's prefix in the same environment and accepts it in another", async ({
    makeInternalMcpCatalog,
  }) => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    // The app is in Default. Its tools carry `planner`, not its display name.
    const planner = await makeInternalMcpCatalog({
      organizationId,
      name: "Planning App",
      serverType: "app",
      authorId: user.id,
    });
    await InternalMcpCatalogModel.applyToolPrefix({
      catalogIds: [planner.id],
      toolPrefix: "planner",
    });
    const home = await create(remote("Notes", shared));
    expect(home.statusCode).toBe(200);

    const same = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${home.json().id}`,
      payload: { name: "Planner" },
    });
    expect(same.statusCode).toBe(409);
    expect(same.json().error.internal_code).toBe("catalog_name_conflict");

    const away = await create(
      remote("Notes", { ...shared, environmentId: staging.id }),
    );
    expect(away.statusCode).toBe(200);
    const other = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${away.json().id}`,
      payload: { name: "Planner" },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({
      name: "Planner",
      environmentId: staging.id,
    });
  });

  test("the organization-wide name lookup still finds an app's prefix", async ({
    makeInternalMcpCatalog,
  }) => {
    const appCatalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Planning App",
      serverType: "app",
      authorId: user.id,
    });
    await InternalMcpCatalogModel.applyToolPrefix({
      catalogIds: [appCatalog.id],
      toolPrefix: "planner",
    });

    const found = await InternalMcpCatalogModel.findRootByNameInOrg({
      name: "planner",
      organizationId,
    });

    expect(found?.id).toBe(appCatalog.id);
  });

  test("allows a metadata edit of a legacy duplicate", async ({
    makeInternalMcpCatalog,
  }) => {
    await makeInternalMcpCatalog({
      organizationId,
      name: "Weather",
      authorId: user.id,
    });
    const duplicate = await makeInternalMcpCatalog({
      organizationId,
      name: "Weather",
      authorId: user.id,
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${duplicate.id}`,
      payload: { description: "Still the second Weather" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().description).toBe("Still the second Weather");
  });

  test("restore uses the environment rule", async ({
    makeInternalMcpCatalog,
  }) => {
    const staging = await createEnvironment({
      organizationId,
      data: { name: "Staging" },
    });
    const original = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      name: "Weather",
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/internal_mcp_catalog/${original.id}`,
        })
      ).statusCode,
    ).toBe(200);
    await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      name: "Weather",
      environmentId: staging.id,
    });

    const otherEnvironment = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${original.id}/restore`,
    });
    expect(otherEnvironment.statusCode).toBe(200);

    const again = await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      name: "Reports",
    });
    await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${again.id}`,
    });
    await makeInternalMcpCatalog({
      organizationId,
      authorId: user.id,
      name: "Reports",
    });
    const blocked = await app.inject({
      method: "POST",
      url: `/api/internal_mcp_catalog/${again.id}/restore`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.internal_code).toBe("catalog_name_conflict");
    expect(blocked.json().error.message).toContain("in this environment");
  });

  test("the Keeper create tool refuses a taken name and writes no row", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    expect((await create(remote("Weather", shared))).statusCode).toBe(200);

    const result = await executeArchestraTool(
      `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}create_mcp_server`,
      {
        name: "Weather",
        serverType: "remote",
        serverUrl: "https://example.com/mcp",
        initialGrants: shared.initialGrants,
      },
      {
        agent: { id: agent.id, name: agent.name },
        userId: user.id,
        organizationId,
      },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      "in Default environment",
    );
    expect(
      await InternalMcpCatalogModel.findByName("Weather", { organizationId }),
    ).toBeTruthy();
    expect(await countNamed("Weather")).toBe(1);
  });
});
