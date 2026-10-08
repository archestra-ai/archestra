import { createHash } from "node:crypto";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-policy-tests.routes";

describe("parse-only policy test inspection", () => {
  const ctx = useRouteTestApp(async (app) => {
    registerRoutePermissions(app);
    await app.register(routes);
  });
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "member" });
  });

  test("read-only members can inspect independent of a live model policy without saving checks or runs", async () => {
    const content = `[policy]\nversion = 2\n[[policy.annotator]]\nname = 'model'\nbuiltin = 'archestra'\n`;
    await GuardrailsPolicyModel.save({
      organizationId: ctx.organizationId,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      updatedBy: ctx.user.id,
      expectedRevision: 0,
    });
    const priorPolicy = await GuardrailsPolicyModel.findLatest(
      ctx.organizationId,
    );
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/inspect",
      payload: {
        files: [
          {
            path: "scenario.appa",
            content:
              "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect deny\nmcp/files/read {}\nexpect allow",
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      files: [
        {
          path: "scenario.appa",
          tools: ["mcp/files/read", "mcp/mail/send"],
          assertionCount: 3,
          error: null,
        },
      ],
    });
    expect(await GuardrailsPolicyModel.findLatest(ctx.organizationId)).toEqual(
      priorPolicy,
    );
    expect(await OpenAppaPolicyTestsModel.find(ctx.organizationId)).toBeNull();
    expect(await OpenAppaPolicyTestsModel.listRuns(ctx.organizationId)).toEqual(
      [],
    );
  });

  test("reports complete parse failures, zero-assertion files and an empty collection honestly", async () => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/inspect",
      payload: {
        files: [
          {
            path: "bad.appa",
            content:
              "mcp/files/read {}\nexpect allow\nmcp/mail/send {}\nexpect maybe",
          },
          { path: "empty.appa", content: "# no assertions" },
          {
            path: "other-host.appa",
            content: "host/shell/read {}\nexpect allow",
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().files[0]).toMatchObject({
      path: "bad.appa",
      tools: [],
      assertionCount: null,
    });
    expect(response.json().files[0].error).toContain("bad.appa:4:");
    expect(response.json().files[1]).toEqual({
      path: "empty.appa",
      tools: [],
      assertionCount: 0,
      error: null,
    });
    expect(response.json().files[2]).toEqual({
      path: "other-host.appa",
      tools: ["host/shell/read"],
      assertionCount: 1,
      error: null,
    });
    const empty = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/inspect",
      payload: { files: [] },
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({ files: [] });
  });

  test("rejects collection, duplicate-path and UTF-8 byte limits before native parsing", async () => {
    for (const files of [
      [{ path: "large.appa", content: "é".repeat(32769) }],
      [
        { path: "same.appa", content: "" },
        { path: "same.appa", content: "" },
      ],
      Array.from({ length: 33 }, (_, index) => ({
        path: `${index}.appa`,
        content: "",
      })),
      Array.from({ length: 9 }, (_, index) => ({
        path: `${index}.appa`,
        content: "x".repeat(65536),
      })),
    ]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/openappa/policy-tests/inspect",
        payload: { files },
      });
      expect(response.statusCode, response.body).toBe(400);
    }
  });

  test("denies callers without organization read access", async ({
    makeUser,
  }) => {
    ctx.user = await makeUser();
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/openappa/policy-tests/inspect",
      payload: { files: [] },
    });
    expect(response.statusCode, response.body).toBe(403);
  });
});
