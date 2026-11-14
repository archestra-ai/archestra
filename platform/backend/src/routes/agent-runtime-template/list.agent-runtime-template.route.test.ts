import AgentRuntimeTemplateModel from "@/models/agent-runtime-template";
import OrganizationModel from "@/models/organization";
import { describe, expect, test } from "@/test";
import { SelectOrganizationSchema } from "@/types";
import {
  makeTemplate,
  useTemplateRouteTestApp,
} from "./runtime-template.test-data";

describe("GET /api/agent-runtime-templates", () => {
  const ctx = useTemplateRouteTestApp();
  test("scopes summaries to the organization and never lists private runtime values", async ({
    makeOrganization,
  }) => {
    const template = makeTemplate();
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: ctx.organizationId,
      settings: { revision: 0, templates: [template] },
      popularAgentOverrides: null,
    });
    const other = await makeOrganization();
    await AgentRuntimeTemplateModel.saveSettings({
      organizationId: other.id,
      settings: {
        revision: 0,
        templates: [makeTemplate({ name: "Other workspace" })],
      },
      popularAgentOverrides: null,
    });
    ctx.caller = ctx.viewer;
    const response = await ctx.app.inject({
      url: "/api/agent-runtime-templates",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual([
      {
        id: template.id,
        name: template.name,
        description: template.description,
        icon: null,
        hidden: false,
        position: 1,
        image: template.runtime.image,
      },
    ]);
    expect(response.body).not.toContain("test-private-setting");
    const organization = await OrganizationModel.getById(ctx.organizationId);
    expect(SelectOrganizationSchema.parse(organization)).not.toHaveProperty(
      "runtimeTemplateSettings",
    );
  });
});
