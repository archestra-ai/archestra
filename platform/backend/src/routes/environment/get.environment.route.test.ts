import { randomUUID } from "node:crypto";
import EnvironmentModel from "@/models/environment";
import environmentRoutes from "@/routes/environment";
import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";

describe("GET /api/environments/:id", () => {
  const ctx = useRouteTestApp(environmentRoutes);

  test("returns current persisted values so readers observe drift", async () => {
    const environment = await EnvironmentModel.create({
      organizationId: ctx.organizationId,
      name: "Provider test environment",
      description: "Initial description",
    });
    const read = () => ctx.app.inject(`/api/environments/${environment.id}`);
    const initial = await read();
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      id: environment.id,
      name: "Provider test environment",
      description: "Initial description",
    });

    await EnvironmentModel.update({
      id: environment.id,
      organizationId: ctx.organizationId,
      description: "Changed outside the provider",
    });
    const updated = await read();
    expect(updated.statusCode).toBe(200);
    expect(updated.json().description).toBe("Changed outside the provider");
  });

  test("returns the same 404 for absent and foreign environments", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const foreign = await EnvironmentModel.create({
      organizationId: other.id,
      name: "Other organization environment",
    });
    const missing = await ctx.app.inject(`/api/environments/${randomUUID()}`);
    const denied = await ctx.app.inject(`/api/environments/${foreign.id}`);
    expect(missing.statusCode).toBe(404);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual(missing.json());
  });

  test("rejects an invalid environment ID", async () => {
    const response = await ctx.app.inject("/api/environments/not-a-uuid");
    expect(response.statusCode).toBe(400);
  });
});
