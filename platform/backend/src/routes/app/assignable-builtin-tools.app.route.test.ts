import {
  ADMIN_ROLE_NAME,
  ARCHESTRA_MCP_CATALOG_ID,
  TOOL_READ_FILE_FULL_NAME,
  TOOL_SEARCH_FILES_FULL_NAME,
} from "@archestra/shared";
import config from "@/config";
import ToolModel from "@/models/tool";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/apps/assignable-builtin-tools", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns exactly the two read-only file tools when the flag is on", async () => {
    (config.skillsSandbox as { enabled: boolean }).enabled = true;
    // Registration of the file tools is flag-gated, so seeding happens with
    // the flag already on.
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

    const response = await app.inject({
      method: "GET",
      url: "/api/apps/assignable-builtin-tools",
    });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .map((tool: { name: string }) => tool.name)
        .sort(),
    ).toEqual([TOOL_READ_FILE_FULL_NAME, TOOL_SEARCH_FILES_FULL_NAME].sort());
  });

  test("returns an empty list when the sandbox flag is off", async () => {
    (config.skillsSandbox as { enabled: boolean }).enabled = false;

    const response = await app.inject({
      method: "GET",
      url: "/api/apps/assignable-builtin-tools",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
});
