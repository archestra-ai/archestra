import { createHash } from "node:crypto";
import { vi } from "vitest";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import { openappaBatteriesService } from "@/openappa/batteries";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { openappaRepositoryIncludes } from "@/services/openappa-github-access";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { seedCoverage } from "@/test/openappa-coverage";
import { useRouteTestApp } from "@/test/route-test-app";
import routes from "./openappa-batteries.routes";

describe("GET /api/openappa/battery-policy-source", () => {
  const ctx = useRouteTestApp(routes);
  beforeEach(async ({ makeMember }) => {
    config.openappa.enabled = true;
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
  });

  test("reads the exact included battery TOML and rejects stale entries", async ({
    makeInternalMcpCatalog,
    makeTool,
    makeAgent,
    makeAgentTool,
  }) => {
    const { content } = await seedCoverage({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      fixtures: { makeInternalMcpCatalog, makeTool, makeAgent, makeAgentTool },
    });
    const entry = /batteries\/acme@sha256-[a-f0-9]+\/appa\.toml/.exec(
      content,
    )?.[0];
    expect(entry).toBeTruthy();
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/openappa/battery-policy-source?entry=${encodeURIComponent(entry ?? "")}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      entry,
      name: "acme",
      kind: "battery",
      content: expect.stringContaining('name = "mcp/acme/list_items"'),
    });
    expect(response.json().content.split("\n")[3]).toBe("[[policy.tool]]");

    const stale = await ctx.app.inject({
      method: "GET",
      url: "/api/openappa/battery-policy-source?entry=batteries%2Facme%2Fappa.toml",
    });
    expect(stale.statusCode).toBe(404);
  });

  describe("files of the policy repository", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    test("lists the files the root folds in, reads each at the accepted commit, and rejects one it does not include", async () => {
      const files = new Map([
        [
          "mcp/payments_api.toml",
          '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "payments_api__refund_payment"\nrequires = { trust = "trusted" }\n',
        ],
        [
          "mcp/helpdesk.toml",
          '[policy]\nversion = 2\n\n[[policy.tool]]\nname = "helpdesk__close_ticket"\nrequires = { trust = "trusted" }\n',
        ],
      ]);
      // What the repository holds at the accepted commit, by include entry.
      vi.spyOn(openappaRepositoryIncludes, "readAccepted").mockImplementation(
        async ({ paths }) =>
          new Map(
            [...files].filter(
              ([path]) =>
                paths.includes(path) ||
                (paths.includes("mcp/*.toml") &&
                  /^mcp\/[^/]+\.toml$/.test(path)),
            ),
          ),
      );
      const content =
        'include = ["mcp/*.toml"]\n\n[policy]\nversion = 2\n\n[[policy.tool]]\nname = "read"\ndelta = {}\n';
      const latest = await guardrailsPolicyService.get(ctx.organizationId);
      await GuardrailsPolicyModel.save({
        organizationId: ctx.organizationId,
        updatedBy: ctx.user.id,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        expectedRevision: latest.revision,
      });
      await openappaBatteriesService.recompile(ctx.organizationId);

      const declarations = await ctx.app.inject({
        method: "GET",
        url: "/api/openappa/policy-declarations",
      });
      expect(declarations.statusCode, declarations.body).toBe(200);
      expect(declarations.json().repositoryFiles).toEqual(
        [...files.keys()].sort().map((path) => ({ path })),
      );

      const file = await ctx.app.inject({
        method: "GET",
        url: "/api/openappa/battery-policy-source?entry=mcp%2Fpayments_api.toml",
      });
      expect(file.statusCode, file.body).toBe(200);
      expect(file.json()).toEqual({
        entry: "mcp/payments_api.toml",
        name: "mcp/payments_api.toml",
        kind: "repository",
        content: files.get("mcp/payments_api.toml"),
      });

      const elsewhere = await ctx.app.inject({
        method: "GET",
        url: "/api/openappa/battery-policy-source?entry=rules%2Fother.toml",
      });
      expect(elsewhere.statusCode).toBe(404);
    });
  });
});
