import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-policy-tests.routes";

describe("policy test authorization", () => {
  const ctx = useRouteTestApp(async (app) => {
    registerRoutePermissions(app);
    await app.register(routes);
  });
  beforeEach(() => {
    config.openappa.enabled = true;
  });
  test("members can read but cannot save or execute checks", async ({
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
    const read = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/policy-tests",
    });
    expect(read.statusCode, read.body).toBe(200);
    for (const [method, url, payload] of [
      [
        "PUT",
        "/api/openappa/policy-tests",
        { files: [], expectedVersion: "empty" },
      ],
      [
        "POST",
        "/api/openappa/policy-tests/run",
        {
          files: [
            { path: "read.appa", content: "mcp/files/read {}\nexpect allow" },
          ],
          sourceVersion: "empty",
        },
      ],
      [
        "POST",
        "/api/openappa/policy-tests/preview",
        {
          files: [
            { path: "read.appa", content: "mcp/files/read {}\nexpect allow" },
          ],
          sourceVersion: "empty",
        },
      ],
    ] as const) {
      const denied = await ctx.app.inject({ method, url, payload });
      expect(denied.statusCode, denied.body).toBe(403);
    }
  });
  test("admins can persist local tests", async ({ makeMember }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const save = await ctx.app.inject({
      method: "PUT",
      url: "/api/openappa/policy-tests",
      payload: {
        files: [
          { path: "read.appa", content: "mcp/files/read {}\nexpect allow" },
        ],
        expectedVersion: "empty",
      },
    });
    expect(save.statusCode, save.body).toBe(200);
  });
});
