import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { vi } from "vitest";
import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin/plugin";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import ToolModel from "@/models/tool";
import { GUARDRAILS_NOOP_ANNOTATOR_PATH } from "@/routes/route-paths";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import routes from "./guardrails-policy.routes";

describe("catch-all tool annotations", () => {
  let app: FastifyInstanceWithZod;
  beforeEach(async () => {
    config.openappa.enabled = true;
    app = createFastifyInstance();
    await app.register(authPlugin);
    await app.register(routes);
    vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
      response: null,
      headers: new Headers(),
    } as never);
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  test("an unconfigured organization gets a valid catch-all with rules for run_command and the control tools", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    // The starter's archestra battery governs the built-in catalog, which
    // startup seeds; without it this deployment would hold the battery back.
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const policy = await guardrailsPolicyService.get(organizationId);
    expect(policy.revision).toBe(0);
    expect(policy.content).toContain('name = "*"');
    expect(policy.content.match(/name = "archestra__[^"]*"/g)).toEqual([
      'name = "archestra__run_command"',
      'name = "archestra__ask_user"',
    ]);
    expect(
      await guardrailsPolicyService.validate(policy.content, {
        organizationId,
      }),
    ).toEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
  });

  test("the runtime can get an empty annotation without a browser session, but cannot read or edit policies", async () => {
    const response = await app.inject({
      method: "POST",
      url: GUARDRAILS_NOOP_ANNOTATOR_PATH,
      payload: {
        version: 1,
        kind: "annotation",
        name: "noop",
        artifact: {
          args: {
            name: "unlisted_tool",
            arguments: { body: "untrusted input" },
          },
        },
        declaration: {},
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      version: 1,
      answer: {
        delta: {},
        requires: { history: [], attention: [] },
        emits: [],
      },
    });
    for (const method of ["GET", "PUT"] as const) {
      const denied = await app.inject({
        method,
        url: "/api/guardrails-policy",
        ...(method === "PUT"
          ? {
              payload: {
                content: "[policy]\nversion = 2",
                expectedRevision: 0,
              },
            }
          : {}),
      });
      expect(denied.statusCode).toBe(401);
    }
    const invalid = await app.inject({
      method: "POST",
      url: GUARDRAILS_NOOP_ANNOTATOR_PATH,
      payload: { version: 1, kind: "authority" },
    });
    expect(invalid.statusCode).toBe(400);
    config.openappa.enabled = false;
    const disabled = await app.inject({
      method: "POST",
      url: GUARDRAILS_NOOP_ANNOTATOR_PATH,
      payload: { version: 1, kind: "annotation" },
    });
    expect(disabled.statusCode).toBe(404);
  });
});
