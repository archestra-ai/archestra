import { ADMIN_ROLE_NAME, ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import ToolModel from "@/models/tool";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import type { User } from "@/types";
import routes from "./openappa-batteries.routes";

const GITHUB_TOKEN = "APPA_PROVIDER_GITHUB_TOKEN";
const TOKEN_VALUE = "ghp_read_back_under_test";

describe("reading battery credential bindings", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let actor: User;
  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    actor = admin;
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: actor, organizationId });
    });
    registerRoutePermissions(app);
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });

  const bindGithubToken = async () => {
    await RuntimeCredentialDefinitionModel.create({
      initialPermissionGrants: [],
      organizationId,
      createdBy: admin.id,
      definition: {
        key: "github-token",
        name: "GitHub token",
        kind: "secret",
        description: "",
        icon: null,
        allowPersonal: false,
        allowOrganization: true,
      },
    });
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "organization",
      userId: null,
      credentialId: "github-token",
      value: TOKEN_VALUE,
    });
    const bound = await app.inject({
      method: "PUT",
      url: `/api/openappa/credential-bindings/${GITHUB_TOKEN}`,
      payload: { key: "github-token" },
    });
    expect(bound.statusCode, bound.body).toBe(200);
  };

  test("reads a binding back by list and by variable without the credential value", async () => {
    await bindGithubToken();

    const listed = await app.inject({
      method: "GET",
      url: "/api/openappa/credential-bindings",
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual([
      expect.objectContaining({
        variable: GITHUB_TOKEN,
        credentialKey: "github-token",
        hasValue: true,
        updatedBy: admin.id,
      }),
    ]);
    expect(listed.body).not.toContain(TOKEN_VALUE);

    const single = await app.inject({
      method: "GET",
      url: `/api/openappa/credential-bindings/${GITHUB_TOKEN}`,
    });
    expect(single.statusCode, single.body).toBe(200);
    expect(single.json()).toEqual(listed.json()[0]);
    expect(single.body).not.toContain(TOKEN_VALUE);
  });

  test("reports a binding whose credential lost its organization value", async () => {
    await bindGithubToken();
    await RuntimeCredentialConnectionModel.delete({
      organizationId,
      scope: "organization",
      credentialId: "github-token",
    });

    const single = await app.inject({
      method: "GET",
      url: `/api/openappa/credential-bindings/${GITHUB_TOKEN}`,
    });
    expect(single.statusCode, single.body).toBe(200);
    expect(single.json()).toMatchObject({
      credentialKey: "github-token",
      hasValue: false,
    });
  });

  test("404s for a variable with no binding and 400s outside the provider namespace", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/openappa/credential-bindings/${GITHUB_TOKEN}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/openappa/credential-bindings/HOME",
        })
      ).statusCode,
    ).toBe(400);
  });

  test("takes the same policy update permission as binding", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    await bindGithubToken();
    const reader = await makeCustomRole(organizationId, {
      permission: { guardrailsPolicy: ["read"] },
    });
    actor = await makeUser();
    await makeMember(actor.id, organizationId, { role: reader.role });

    for (const url of [
      "/api/openappa/credential-bindings",
      `/api/openappa/credential-bindings/${GITHUB_TOKEN}`,
    ])
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(403);
  });
});
