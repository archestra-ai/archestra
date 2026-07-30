import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { AppLabelModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { AppListItem, User } from "@/types";

type AppListResponse = {
  data: AppListItem[];
  pagination: { total: number };
};

describe("app labels over REST", () => {
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

  describe("GET /api/apps?labels=", () => {
    test("keeps only apps matching every key, ORing a key's values", async ({
      makeApp,
    }) => {
      const both = await makeApp({
        organizationId,
        scope: "org",
        authorId: user.id,
        name: "Both",
      });
      const envOnly = await makeApp({
        organizationId,
        scope: "org",
        authorId: user.id,
        name: "EnvOnly",
      });
      await makeApp({
        organizationId,
        scope: "org",
        authorId: user.id,
        name: "Unlabelled",
      });

      await AppLabelModel.syncAppLabels(both.id, [
        { key: "env", value: "prod" },
        { key: "team", value: "platform" },
      ]);
      await AppLabelModel.syncAppLabels(envOnly.id, [
        { key: "env", value: "prod" },
      ]);

      const response = await app.inject({
        method: "GET",
        url: "/api/apps?labels=env:prod;team:platform",
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<AppListResponse>();
      expect(body.data.map((item) => item.name)).toEqual(["Both"]);
    });

    test("returns each app's labels on the list item", async ({ makeApp }) => {
      const owned = await makeApp({
        organizationId,
        scope: "org",
        authorId: user.id,
        name: "Labelled",
      });
      await AppLabelModel.syncAppLabels(owned.id, [
        { key: "env", value: "prod" },
      ]);

      const response = await app.inject({ method: "GET", url: "/api/apps" });
      const body = response.json<AppListResponse>();
      const item = body.data.find((entry) => entry.name === "Labelled");
      expect(item?.labels).toEqual([
        expect.objectContaining({ key: "env", value: "prod" }),
      ]);
    });

    test("an unmatched filter yields no apps rather than everything", async ({
      makeApp,
    }) => {
      const owned = await makeApp({
        organizationId,
        scope: "org",
        authorId: user.id,
      });
      await AppLabelModel.syncAppLabels(owned.id, [
        { key: "env", value: "prod" },
      ]);

      const response = await app.inject({
        method: "GET",
        url: "/api/apps?labels=env:staging",
      });
      expect(response.json<AppListResponse>().data).toEqual([]);
    });
  });

  describe("PATCH /api/apps/:appId", () => {
    test("replaces labels and echoes the persisted set", async ({
      makeApp,
    }) => {
      const owned = await makeApp({
        organizationId,
        scope: "org",
        authorId: user.id,
      });
      await AppLabelModel.syncAppLabels(owned.id, [
        { key: "env", value: "prod" },
      ]);

      const response = await app.inject({
        method: "PATCH",
        url: `/api/apps/${owned.id}`,
        payload: { labels: [{ key: "tier", value: "gold" }] },
      });

      expect(response.statusCode).toBe(200);
      expect(
        response.json<{ labels: { key: string; value: string }[] }>().labels,
      ).toEqual([expect.objectContaining({ key: "tier", value: "gold" })]);
      expect(await AppLabelModel.getLabelsForApp(owned.id)).toEqual([
        expect.objectContaining({ key: "tier", value: "gold" }),
      ]);
    });

    test("an empty array clears labels, omitting the field leaves them", async ({
      makeApp,
    }) => {
      const owned = await makeApp({
        organizationId,
        scope: "org",
        authorId: user.id,
      });
      await AppLabelModel.syncAppLabels(owned.id, [
        { key: "env", value: "prod" },
      ]);

      // Omitted → untouched.
      await app.inject({
        method: "PATCH",
        url: `/api/apps/${owned.id}`,
        payload: { description: "still labelled" },
      });
      expect(await AppLabelModel.getLabelsForApp(owned.id)).toHaveLength(1);

      // [] → cleared.
      await app.inject({
        method: "PATCH",
        url: `/api/apps/${owned.id}`,
        payload: { labels: [] },
      });
      expect(await AppLabelModel.getLabelsForApp(owned.id)).toEqual([]);
    });
  });

  describe("GET /api/apps/labels/{keys,values}", () => {
    test("lists the org's app label keys and values", async ({ makeApp }) => {
      const owned = await makeApp({
        organizationId,
        scope: "org",
        authorId: user.id,
      });
      await AppLabelModel.syncAppLabels(owned.id, [
        { key: "env", value: "prod" },
        { key: "team", value: "platform" },
      ]);

      const keys = await app.inject({
        method: "GET",
        url: "/api/apps/labels/keys",
      });
      expect(keys.statusCode).toBe(200);
      expect(keys.json<string[]>()).toEqual(["env", "team"]);

      const filtered = await app.inject({
        method: "GET",
        url: "/api/apps/labels/values?key=env",
      });
      expect(filtered.json<string[]>()).toEqual(["prod"]);

      const all = await app.inject({
        method: "GET",
        url: "/api/apps/labels/values",
      });
      expect(all.json<string[]>()).toEqual(["platform", "prod"]);
    });

    test("the label routes are not shadowed by /api/apps/:appId", async () => {
      // "labels" is a static segment, so it must not be captured as an app id.
      const response = await app.inject({
        method: "GET",
        url: "/api/apps/labels/keys",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<string[]>()).toEqual([]);
    });
  });
});
