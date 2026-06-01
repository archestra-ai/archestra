import { describe, expect } from "vitest";
import { EnvironmentModel, InternalMcpCatalogModel } from "@/models";
import { test } from "@/test";

describe("EnvironmentModel", () => {
  test("create persists fields", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Production EU",
      description: "Primary EU deployment target",
      namespace: "prod-eu",
    });

    expect(env.name).toBe("Production EU");
    expect(env.description).toBe("Primary EU deployment target");
    expect(env.namespace).toBe("prod-eu");
  });

  test("listForOrganization returns assignedCatalogCount", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Sandbox",
    });
    const list = await EnvironmentModel.listForOrganization(org.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(env.id);
    expect(list[0].description).toBeNull();
    expect(list[0].assignedCatalogCount).toBe(0);
  });

  test("listForOrganization returns the description", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    await EnvironmentModel.create({
      organizationId: org.id,
      name: "Sandbox",
      description: "Throwaway environment",
    });
    const list = await EnvironmentModel.listForOrganization(org.id);
    expect(list[0].description).toBe("Throwaway environment");
  });

  test("listForOrganization counts assigned catalog items per environment", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const envA = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Env A",
    });
    const envB = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Env B",
    });

    const createItem = (name: string, environmentId: string | null) =>
      InternalMcpCatalogModel.create(
        {
          name,
          serverType: "remote",
          serverUrl: "https://api.example.com/mcp/",
          scope: "org",
          environmentId,
        },
        { organizationId: org.id, authorId: user.id },
      );

    await createItem("a-1", envA.id);
    await createItem("a-2", envA.id);
    await createItem("b-1", envB.id);
    await createItem("no-env", null);

    const list = await EnvironmentModel.listForOrganization(org.id);
    const byId = new Map(list.map((e) => [e.id, e]));
    expect(byId.get(envA.id)?.assignedCatalogCount).toBe(2);
    expect(byId.get(envB.id)?.assignedCatalogCount).toBe(1);
  });

  test("update changes the name and namespace", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Staging",
    });
    const updated = await EnvironmentModel.update({
      id: env.id,
      organizationId: org.id,
      name: "Staging EU",
      namespace: "stg",
    });
    expect(updated?.namespace).toBe("stg");
    expect(updated?.name).toBe("Staging EU");
  });

  test("update changes the description", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Staging",
      description: "Initial description",
    });
    const updated = await EnvironmentModel.update({
      id: env.id,
      organizationId: org.id,
      description: "Updated description",
    });
    expect(updated?.description).toBe("Updated description");
    expect(updated?.name).toBe("Staging");

    // Omitting description leaves it unchanged.
    const namespaceOnly = await EnvironmentModel.update({
      id: env.id,
      organizationId: org.id,
      namespace: "stg",
    });
    expect(namespaceOnly?.description).toBe("Updated description");

    // Explicit null clears it.
    const cleared = await EnvironmentModel.update({
      id: env.id,
      organizationId: org.id,
      description: null,
    });
    expect(cleared?.description).toBeNull();
  });

  test("delete removes the row", async ({ makeOrganization }) => {
    const org = await makeOrganization();
    const env = await EnvironmentModel.create({
      organizationId: org.id,
      name: "Temp",
    });
    expect(await EnvironmentModel.delete(env.id, org.id)).toBe(true);
    expect(
      await EnvironmentModel.findByIdForOrganization(env.id, org.id),
    ).toBeNull();
  });
});
