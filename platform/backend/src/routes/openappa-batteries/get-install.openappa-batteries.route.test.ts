import { randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME, ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import ToolModel from "@/models/tool";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import type { User } from "@/types";
import routes from "./openappa-batteries.routes";

describe("reading one battery install", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let actor: User;
  let actorOrganizationId: string;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    actorOrganizationId = organizationId;
    actor = await makeUser();
    await makeMember(actor.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, {
        user: actor,
        organizationId: actorOrganizationId,
      });
    });
    registerRoutePermissions(app);
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });

  const installGithub = async (
    makeInternalMcpCatalog: (params: {
      organizationId: string;
      name: string;
    }) => Promise<{ id: string }>,
    makeTool: (params: {
      catalogId: string;
      name: string;
      rawName: string;
    }) => Promise<unknown>,
  ) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub Prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github_prod__get_me",
      rawName: "get_me",
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/openappa/battery-installs",
      payload: { batteryName: "github", catalogId: catalog.id },
    });
    expect(created.statusCode, created.body).toBe(200);
    const listed = await app.inject({
      method: "GET",
      url: "/api/openappa/batteries",
    });
    const github = listed
      .json()
      .find((battery: { name: string }) => battery.name === "github");
    expect(github.installs).toHaveLength(1);
    return { catalogId: catalog.id, listedInstall: github.installs[0] };
  };

  test("returns the install as the battery list shows it", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { catalogId, listedInstall } = await installGithub(
      makeInternalMcpCatalog,
      makeTool,
    );

    const response = await app.inject({
      method: "GET",
      url: `/api/openappa/battery-installs/${listedInstall.id}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(listedInstall);
    expect(response.json()).toMatchObject({
      batteryName: "github",
      catalogId,
      status: "missing_credentials",
    });
  });

  test("reads the stored row without recomposing a stale composition", async ({
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { listedInstall } = await installGithub(
      makeInternalMcpCatalog,
      makeTool,
    );
    // A stale composition is what a list read would recompose on the spot.
    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    const stale = await OpenAppaEffectivePolicyModel.find(organizationId);

    const response = await app.inject({
      method: "GET",
      url: `/api/openappa/battery-installs/${listedInstall.id}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(await OpenAppaEffectivePolicyModel.find(organizationId)).toEqual(
      stale,
    );
  });

  test("returns an install whose battery is no longer available, which the list omits", async () => {
    const [retired] = await OpenAppaBatteryInstallModel.replaceAll({
      organizationId,
      rows: [
        {
          batteryName: "retired-battery",
          catalogId: null,
          status: "unavailable",
          target: null,
          packageHash: null,
          lastError: null,
          credentialBindings: {},
        },
      ],
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/openappa/battery-installs/${retired.id}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: retired.id,
      batteryName: "retired-battery",
      status: "unavailable",
    });

    const listed = await app.inject({
      method: "GET",
      url: "/api/openappa/batteries",
    });
    expect(
      listed
        .json()
        .some(
          (battery: { name: string }) => battery.name === "retired-battery",
        ),
    ).toBe(false);
  });

  test("404s for an unknown id and for another organization's install", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeOrganization,
    makeMember,
  }) => {
    const { listedInstall } = await installGithub(
      makeInternalMcpCatalog,
      makeTool,
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/openappa/battery-installs/${randomUUID()}`,
        })
      ).statusCode,
    ).toBe(404);

    actorOrganizationId = (await makeOrganization()).id;
    await makeMember(actor.id, actorOrganizationId, { role: ADMIN_ROLE_NAME });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/openappa/battery-installs/${listedInstall.id}`,
        })
      ).statusCode,
    ).toBe(404);
  });

  test("a policy reader can read an install", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const { listedInstall } = await installGithub(
      makeInternalMcpCatalog,
      makeTool,
    );
    const reader = await makeCustomRole(organizationId, {
      permission: { guardrailsPolicy: ["read"] },
    });
    actor = await makeUser();
    await makeMember(actor.id, organizationId, { role: reader.role });

    const response = await app.inject({
      method: "GET",
      url: `/api/openappa/battery-installs/${listedInstall.id}`,
    });
    expect(response.statusCode, response.body).toBe(200);
  });
});
