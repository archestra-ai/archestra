import { EnvironmentModel, InternalMcpCatalogModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("catalog environment assignment", () => {
  test("create persists environmentId and delete nulls it", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Production",
    });

    const item = await InternalMcpCatalogModel.create(
      {
        name: "my-server",
        serverType: "remote",
        serverUrl: "https://api.example.com/mcp/",
        scope: "org",
        environmentId: env.id,
      },
      { organizationId: org.id, authorId: user.id },
    );
    expect(item.environmentId).toBe(env.id);

    await EnvironmentModel.delete(env.id, org.id);
    const reloaded = await InternalMcpCatalogModel.findById(item.id);
    expect(reloaded?.environmentId).toBeNull();
  });
});
