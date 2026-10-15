// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise

import { topResourcePermissionPreset } from "@archestra/shared";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { InternalMcpCatalogModel } from "@/models";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { createRuntimeCredentialDefinition } from "@/services/agent-runtime/runtime-credentials";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import routes from "./internal-mcp-catalog";

/**
 * A server's environment can read a saved credential, and every install then
 * runs with its value. Attaching one therefore takes `use` on it: editing a
 * server must not hand it a credential its editor could never see.
 */
describe("attaching a saved credential to an MCP server", () => {
  let app: FastifyInstanceWithZod;
  let member: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    const admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: "admin" });
    member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    const define = (key: string, initialGrants?: []) =>
      createRuntimeCredentialDefinition({
        organizationId,
        userId: admin.id,
        definition: {
          key,
          name: key === "shared" ? "Shared key" : "Restricted key",
          kind: "secret",
          description: "",
          icon: null,
          allowPersonal: false,
          allowOrganization: true,
        },
        initialGrants,
      });
    // Shared with the organization, as a new credential is by default.
    await define("shared");
    // Kept to admins.
    await define("restricted", []);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.user = member;
      request.organizationId = organizationId;
    });
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  const bound = (credentialId: string) => ({
    command: "node",
    environment: [
      {
        key: "TOKEN",
        type: "secret" as const,
        credentialId,
        credentialScope: "organization" as const,
        promptOnInstallation: false,
        required: true,
      },
    ],
  });

  test("refuses a credential the editor cannot use, and allows one they can", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: member.id,
      access: "personal",
      serverType: "local",
      localConfig: { command: "node" },
    });
    // Binding a credential changes what the server runs with. A member, who
    // cannot add entries to the registry, needs the deploy permission on it.
    const entry = {
      organizationId,
      resource: "mcpRegistry" as const,
      scope: catalog.id,
    };
    const policy = await ResourcePermissionPolicyModel.find(entry);
    await ResourcePermissionPolicyModel.replace({
      ...entry,
      revision: policy?.revision ?? 0,
      grants: [
        {
          subject: { type: "user", id: member.id },
          actions: [...topResourcePermissionPreset("mcpRegistry").actions],
        },
      ],
    });
    const attach = (credentialId: string) =>
      app.inject({
        method: "PUT",
        url: `/api/internal_mcp_catalog/${catalog.id}`,
        payload: { localConfig: bound(credentialId) },
      });

    const refused = await attach("restricted");
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe(
      `You don't have access to the "Restricted key" credential, so you can't attach it. Ask an admin to share it with you.`,
    );
    expect(
      (await InternalMcpCatalogModel.findById(catalog.id))?.localConfig
        ?.environment ?? [],
    ).toEqual([]);

    const allowed = await attach("shared");
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  test("leaves a credential an admin already attached in place on other edits", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      authorId: member.id,
      access: "personal",
      serverType: "local",
      localConfig: bound("restricted"),
    });

    const edited = await app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${catalog.id}`,
      payload: { description: "Renamed", localConfig: bound("restricted") },
    });

    expect(edited.statusCode, edited.body).toBe(200);
  });
});
